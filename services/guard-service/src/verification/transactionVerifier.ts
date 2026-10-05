import { isEqual } from 'lodash-es';

import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import JsonBigInt from '@rosen-bridge/json-bigint';
import {
  ChainUtils,
  EventTrigger,
  ImpossibleBehavior,
  PaymentOrder,
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AVALANCHE_CHAIN, AvalancheChain } from '@rosen-chains/avalanche';

import Configs from '../configs/configs';
import { DatabaseAction } from '../db/databaseAction';
import DatabaseHandler from '../db/databaseHandler';
import EventOrder from '../event/eventOrder';
import EventSerializer from '../event/eventSerializer';
import ChainHandler from '../handlers/chainHandler';
import MinimumFeeHandler from '../handlers/minimumFeeHandler';
import { getPreparedAvalancheInputs } from '../jobs/initScanner';
import * as TransactionSerializer from '../transaction/transactionSerializer';
import { isAvalancheManagementRouteEnabled } from '../utils/avalancheManagementRoutes';
import { ChainNativeToken } from '../utils/constants';
import { assertAvalancheColdReserve } from './avalancheManagementAuthorization';
import { resolveAvalancheColdPolicy } from './avalancheManagementDependencies';
import RewardAuthorization from './rewardAuthorization';

const logger = DefaultLogger.getInstance().child(import.meta.url);

/** Captures admission bytes before asynchronous checks and refuses caller drift. */
const captureAvalancheRequest = (source: PaymentTransaction) => {
  const tx = new PaymentTransaction(
    source.network,
    source.txId,
    source.eventId,
    Buffer.from(source.txBytes),
    source.txType,
  );
  return {
    tx,
    unchanged: () =>
      source.network === tx.network &&
      source.txId === tx.txId &&
      source.eventId === tx.eventId &&
      source.txType === tx.txType &&
      Buffer.from(source.txBytes).equals(Buffer.from(tx.txBytes)),
  };
};

class TransactionVerifier {
  /**
   * verifies the transaction
   * conditions:
   * - PaymentTransaction object consistency is verified
   * - fee is verified
   * - verify no token is burned
   * - chain extra conditions are verified
   * @param tx the created payment transaction
   */
  static verifyTxCommonConditions = async (
    tx: PaymentTransaction,
  ): Promise<boolean> => {
    const chain = ChainHandler.getInstance().getChain(tx.network);

    // verify PaymentTransaction object consistency
    if (!(await chain.verifyPaymentTransaction(tx))) {
      logger.debug(
        `Transaction [${tx.txId}] is invalid: tx object has inconsistency`,
      );
      return false;
    }

    // verify tx fee
    if (!(await chain.verifyTransactionFee(tx))) {
      logger.debug(`Transaction [${tx.txId}] is invalid: Fee is not verified`);
      return false;
    }

    // verify no token is burned
    if (!(await chain.verifyNoTokenBurned(tx))) {
      logger.debug(
        `Transaction [${tx.txId}] is invalid: Some token are burned`,
      );
      return false;
    }

    // verify extra conditions
    if (!chain.verifyTransactionExtraConditions(tx, SigningStatus.UnSigned)) {
      logger.debug(
        `Transaction [${tx.txId}] is invalid: Extra conditions are not verified`,
      );
      return false;
    }

    return true;
  };

  /**
   * verifies the transaction
   * conditions:
   * - tx order is equal to expected event order
   * @param tx the created payment transaction
   * @param event the event trigger
   * @param eventTxId the trigger transaction id
   * @returns true if conditions are met
   */
  static verifyEventTransaction = async (
    tx: PaymentTransaction,
    event: EventTrigger,
    eventTxId: string,
  ): Promise<boolean> => {
    if (
      tx.txType === TransactionType.reward &&
      RewardAuthorization.applies(event)
    ) {
      const captured = RewardAuthorization.captureReward(
        tx,
        EventSerializer.getId(event),
      );
      const authorization = await RewardAuthorization.getInstance().bind(
        event,
        eventTxId,
      );
      const reward = captured.payment;
      const chain = ChainHandler.getInstance().getChain(reward.network);
      const txOrder = chain.extractTransactionOrder(reward);
      const inputs = await RewardAuthorization.getInstance().captureOrderInputs(
        authorization.event,
        authorization.eventTxId,
      );
      const expectedOrder = await EventOrder.createEventRewardOrder(
        authorization.event,
        authorization.eventTxId,
        inputs.feeConfig,
        authorization.paymentTxId,
        [...inputs.eventWIDs],
      );
      let verified = false;
      await authorization.withAction(() => {
        inputs.assertFee();
        captured.assertUnchanged();
        verified = isEqual(txOrder, expectedOrder);
        if (verified) captured.retainAuthority(authorization);
      }, inputs.assertInputs);
      return verified;
    }
    const chain = ChainHandler.getInstance().getChain(tx.network);
    const dbAction = DatabaseAction.getInstance();

    // verify tx order
    const feeConfig = MinimumFeeHandler.getEventFeeConfig(event);
    const txOrder = chain.extractTransactionOrder(tx);
    const eventWIDs = (await dbAction.getEventCommitments(tx.eventId)).map(
      (commitment) => commitment.WID,
    );
    let expectedOrder: PaymentOrder = [];
    if (tx.txType === TransactionType.payment)
      expectedOrder = await EventOrder.createEventPaymentOrder(
        event,
        eventTxId,
        feeConfig,
        eventWIDs,
      );
    else {
      // get event payment transaction
      const eventTxs = await dbAction.getEventValidTxsByType(
        tx.eventId,
        TransactionType.payment,
      );
      if (eventTxs.length !== 1)
        throw new ImpossibleBehavior(
          `Received tx [${tx.txId}] for reward distribution of event [${tx.eventId}] but no payment tx found for the event in database`,
        );
      const paymentTxId = await ChainHandler.getInstance()
        .getChain(event.toChain)
        .getActualTxId(eventTxs[0].txId);
      expectedOrder = await EventOrder.createEventRewardOrder(
        event,
        eventTxId,
        feeConfig,
        paymentTxId,
        eventWIDs,
      );
    }
    if (!isEqual(txOrder, expectedOrder)) {
      logger.debug(
        `Transaction [${tx.txId}] is invalid: Tx extracted order is not verified`,
      );
      return false;
    }

    return true;
  };

  /**
   * verifies the cold storage transaction
   * conditions:
   * - tx order is to cold storage address
   * - at least one asset requires transfer
   * - no forbidden asset is transferred
   * - no active cold storage tx exist that is transferring the same token
   * - transferring assets remain more than low threshold in the lock address
   * @param tx the created payment transaction
   * @returns true if conditions are met
   */
  static verifyColdStorageTransaction = async (
    tx: PaymentTransaction,
  ): Promise<boolean> => {
    if (tx.network === AVALANCHE_CHAIN) {
      if (
        !isAvalancheManagementRouteEnabled('cold') ||
        tx.txType !== TransactionType.coldStorage ||
        tx.eventId !== ''
      )
        return false;
      try {
        const captured = captureAvalancheRequest(tx);
        const payment = captured.tx;
        const inputs = getPreparedAvalancheInputs();
        const chain = ChainHandler.getInstance().getChain(AVALANCHE_CHAIN);
        if (
          !inputs ||
          !(chain instanceof AvalancheChain) ||
          chain.CHAIN_ID !== BigInt(inputs.config.chainId) ||
          !(await this.verifyTxCommonConditions(payment))
        )
          return false;
        const order = chain.extractTransactionOrder(payment);
        const cold = inputs.contracts.addresses.cold;
        if (
          chain.getChainConfigs().addresses.cold.toLowerCase() !==
            cold.toLowerCase() ||
          order.length !== 1 ||
          order[0].address.toLowerCase() !== cold.toLowerCase()
        )
          return false;
        const threshold = resolveAvalancheColdPolicy(
          chain,
          payment,
          Configs.thresholds()[AVALANCHE_CHAIN],
        );
        const authority = JsonBigInt.stringify({
          config: inputs.config,
          contracts: inputs.contracts,
          chain: chain.getChainConfigs(),
          threshold,
        });
        const required = (await chain.getTransactionAssets(payment))
          .inputAssets;
        const locked = await chain.getLockAddressAssets();
        const forbiddenTokens =
          await DatabaseHandler.getWaitingEventsRequiredTokens();
        const activeTxIds = (
          await DatabaseAction.getInstance().getActiveColdStorageTxsInChain(
            AVALANCHE_CHAIN,
          )
        ).map((active) => active.txId);
        assertAvalancheColdReserve(
          { locked, required, forbiddenTokens, activeTxIds },
          threshold,
          payment.txId,
        );
        return (
          captured.unchanged() &&
          isAvalancheManagementRouteEnabled('cold') &&
          getPreparedAvalancheInputs() === inputs &&
          ChainHandler.getInstance().getChain(AVALANCHE_CHAIN) === chain &&
          chain.verifyTransactionExtraConditions(payment) &&
          JsonBigInt.stringify({
            config: inputs.config,
            contracts: inputs.contracts,
            chain: chain.getChainConfigs(),
            threshold: resolveAvalancheColdPolicy(
              chain,
              payment,
              Configs.thresholds()[AVALANCHE_CHAIN],
            ),
          }) === authority
        );
      } catch (error) {
        logger.debug(`Avalanche cold request is not admitted: ${error}`);
        return false;
      }
    }
    const chainHandler = ChainHandler.getInstance();
    const chain = chainHandler.getChain(tx.network);

    // verify target address
    const txOrder = chain.extractTransactionOrder(tx);
    const coldAddress = chain.getChainConfigs().addresses.cold;
    if (txOrder.length !== 1 || txOrder[0].address !== coldAddress) {
      logger.debug(
        `Transaction [${tx.txId}] is invalid: Tx extracted order is not verified`,
      );
      return false;
    }

    // verify transferring assets
    const forbiddenTokens =
      await DatabaseHandler.getWaitingEventsRequiredTokens();
    if (
      txOrder[0].assets.tokens.some((token) =>
        forbiddenTokens.includes(token.id),
      )
    ) {
      logger.debug(
        `Transaction [${
          tx.txId
        }] is invalid: Tx is transferring forbidden token. Forbidden tokens: ${JsonBigInt.stringify(
          forbiddenTokens,
        )}`,
      );
      return false;
    }
    const nativeTokenId = ChainNativeToken[tx.network];
    const isNativeTokenForbade = forbiddenTokens.includes(nativeTokenId);

    // no active cold storage tx exist that is transferring the same token
    const thresholdsConfig = Configs.thresholds()[tx.network];
    const transferringTokenIds = txOrder[0].assets.tokens.map(
      (token) => token.id,
    );
    const inProgressColdStorageTxs =
      await DatabaseAction.getInstance().getActiveColdStorageTxsInChain(
        tx.network,
      );
    for (const activeTx of inProgressColdStorageTxs) {
      if (activeTx.txId === tx.txId) continue;
      const activeTxOrder = chain.extractTransactionOrder(
        TransactionSerializer.fromJson(
          activeTx.txJson,
          ChainHandler.getInstance().getChain,
        ),
      );
      if (
        activeTxOrder[0].assets.tokens.some((token) =>
          transferringTokenIds.includes(token.id),
        )
      ) {
        logger.debug(
          `Transaction [${tx.txId}] is invalid: Tx is transferring a token that is in transfer by tx [${activeTx.txId}]`,
        );
        return false;
      }
      if (
        txOrder[0].assets.nativeToken > thresholdsConfig.maxNativeTransfer &&
        activeTxOrder[0].assets.nativeToken > thresholdsConfig.maxNativeTransfer
      ) {
        logger.debug(
          `Transaction [${tx.txId}] is invalid: Tx is transferring native token while it is also in transfer by tx [${activeTx.txId}]`,
        );
        return false;
      }
    }

    // verify address assets
    const lockedAssets = await chain.getLockAddressAssets();
    const remainingAssets = ChainUtils.subtractAssetBalance(
      lockedAssets,
      txOrder[0].assets,
    );
    const thresholds = thresholdsConfig.tokens;

    // verify transfer conditions for tokens
    let isTransferRequired = false;
    for (const orderToken of txOrder[0].assets.tokens) {
      const tokenId = orderToken.id;
      const lockedBalance = lockedAssets.tokens.find(
        (token) => token.id === tokenId,
      );
      if (lockedBalance === undefined) {
        throw new ImpossibleBehavior(
          `Tx [${tx.txId}] is transferring token [${tokenId}] which is not in the lock address`,
        );
      }
      if (lockedBalance.value > thresholds[tokenId].high) {
        isTransferRequired = true;
        const remainingBalance = remainingAssets.tokens.find(
          (token) => token.id === tokenId,
        );
        if (remainingBalance === undefined) {
          logger.debug(
            `Transaction [${tx.txId}] is invalid: Expected token [${tokenId}] remains in lock address but found none`,
          );
          return false;
        } else {
          if (
            remainingBalance.value > thresholds[tokenId].high ||
            remainingBalance.value < thresholds[tokenId].low
          ) {
            logger.debug(
              `Transaction [${tx.txId}] is invalid: Token [${tokenId}] condition does not satisfy. Expected: [${thresholds[tokenId].high} > ${remainingBalance.value} > ${thresholds[tokenId].low}]`,
            );
            return false;
          }
        }
      } else {
        logger.debug(
          `Transaction [${tx.txId}] is invalid: Transferring unexpected token [${tokenId}]`,
        );
        return false;
      }
    }

    // verify transfer conditions for native token
    if (
      isNativeTokenForbade === false &&
      lockedAssets.nativeToken > thresholds[nativeTokenId]?.high
    ) {
      if (
        remainingAssets.nativeToken > thresholds[nativeTokenId]?.high ||
        remainingAssets.nativeToken < thresholds[nativeTokenId]?.low
      ) {
        logger.debug(
          `Transaction [${tx.txId}] is invalid: Native token condition does not satisfy. Expected: [${thresholds[nativeTokenId]?.high} > ${remainingAssets.nativeToken} > ${thresholds[nativeTokenId]?.low}]`,
        );
        return false;
      }
    } else {
      if (isTransferRequired === false) {
        logger.debug(
          `Transaction [${tx.txId}] is invalid: No token nor native token require transfer`,
        );
        return false;
      }
      if (txOrder[0].assets.nativeToken > thresholdsConfig.maxNativeTransfer) {
        logger.debug(
          `Transaction [${tx.txId}] is invalid: Transferring unexpected amount of native token [${txOrder[0].assets.nativeToken} > ${thresholdsConfig.maxNativeTransfer}]`,
        );
        return false;
      }
    }

    return true;
  };

  /**
   * verifies the transaction
   * conditions:
   * - tx order is equal to the arbitrary order
   * @param tx the created payment transaction
   * @param orderJson encoded order
   * @returns true if conditions are met
   */
  static verifyArbitraryTransaction = async (
    tx: PaymentTransaction,
    orderJson: string,
  ): Promise<boolean> => {
    if (tx.network === AVALANCHE_CHAIN) {
      if (
        !isAvalancheManagementRouteEnabled('arbitrary') ||
        !Configs.isArbitraryOrderRequestActive ||
        tx.txType !== TransactionType.arbitrary ||
        typeof tx.eventId !== 'string' ||
        !/^[0-9a-f]{64}$/.test(tx.eventId)
      )
        return false;
      try {
        const captured = captureAvalancheRequest(tx),
          payment = captured.tx;
        const inputs = getPreparedAvalancheInputs();
        const chain = ChainHandler.getInstance().getChain(AVALANCHE_CHAIN);
        if (
          !inputs ||
          !(chain instanceof AvalancheChain) ||
          chain.CHAIN_ID !== BigInt(inputs.config.chainId)
        )
          return false;
        const authority = JsonBigInt.stringify({
          config: inputs.config,
          contracts: inputs.contracts,
          chain: chain.getChainConfigs(),
        });
        if (!(await this.verifyTxCommonConditions(payment))) return false;
        const expectedOrder = ChainUtils.decodeOrder(orderJson);
        const txOrder = chain.extractTransactionOrder(payment);
        return (
          expectedOrder.length === 1 &&
          ChainUtils.encodeOrder(expectedOrder) ===
            ChainUtils.encodeOrder(txOrder) &&
          captured.unchanged() &&
          isAvalancheManagementRouteEnabled('arbitrary') &&
          Configs.isArbitraryOrderRequestActive &&
          getPreparedAvalancheInputs() === inputs &&
          ChainHandler.getInstance().getChain(AVALANCHE_CHAIN) === chain &&
          chain.verifyTransactionExtraConditions(payment) &&
          JsonBigInt.stringify({
            config: inputs.config,
            contracts: inputs.contracts,
            chain: chain.getChainConfigs(),
          }) === authority
        );
      } catch (error) {
        logger.debug(`Avalanche arbitrary request is not admitted: ${error}`);
        return false;
      }
    }
    const chain = ChainHandler.getInstance().getChain(tx.network);

    // verify tx order
    const expectedOrder = ChainUtils.decodeOrder(orderJson);
    const txOrder = ChainUtils.decodeOrder(
      ChainUtils.encodeOrder(chain.extractTransactionOrder(tx)),
    );
    if (!isEqual(txOrder, expectedOrder)) {
      logger.debug(
        `Transaction [${tx.txId}] is invalid: Tx extracted order is not verified`,
      );
      return false;
    }

    return true;
  };
}

export default TransactionVerifier;
