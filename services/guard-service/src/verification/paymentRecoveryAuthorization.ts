import * as wasm from 'ergo-lib-wasm-nodejs';
import { Transaction } from 'ethers';
import { isEqual } from 'lodash-es';

import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { EntityManager, IsNull } from '@rosen-bridge/extended-typeorm';
import JsonBigInt from '@rosen-bridge/json-bigint';
import { EventTriggerEntity } from '@rosen-bridge/watcher-data-extractor';
import {
  AbstractChain,
  ConfirmationStatus,
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import {
  AvalancheRpcNetwork,
  AVALANCHE_TX_EXTRACTOR,
  type SettledAvalancheTransactionReceiptEvidence,
} from '@rosen-chains/avalanche-rpc';
import { ErgoChain, ErgoTransaction } from '@rosen-chains/ergo';
import { EvmTxStatus } from '@rosen-chains/evm';

import { DatabaseAction, TransactionCheckPreimage } from '../db/databaseAction';
import { ConfirmedEventEntity } from '../db/entities/confirmedEventEntity';
import { TransactionEntity } from '../db/entities/transactionEntity';
import EventOrder from '../event/eventOrder';
import EventSerializer from '../event/eventSerializer';
import { EventStatus, TransactionStatus } from '../utils/constants';
import Utils from '../utils/utils';
import {
  assertCanonicalReducedErgo,
  assertReducedToSignedErgoSemantics,
} from './ergoSignedSemantics';
import type RewardAuthorization from './rewardAuthorization';

interface Dependencies {
  getDatabase(): DatabaseAction;
  getChain(network: string): AbstractChain<unknown>;
  decode(json: string): PaymentTransaction;
  captureOrderInputs: RewardAuthorization['captureOrderInputs'];
}
export interface PreparedPaymentRecovery {
  readonly signedJson: string;
  assertBefore(
    manager: EntityManager,
    expected: TransactionCheckPreimage,
  ): Promise<void>;
  assertAfter(
    manager: EntityManager,
    expected: TransactionCheckPreimage,
  ): Promise<void>;
}
export interface BoundPaymentRecovery {
  readonly purpose: 'recovery';
  readonly identity: string;
  /** Caller retains one scanner lease and a bounded lifetime through persistence. */
  prepareUnderScannerLease(
    assertActive: () => void,
  ): Promise<PreparedPaymentRecovery>;
}
/** Serializes captured values for authority equality checks. */
const fingerprint = (value: unknown) => JsonBigInt.stringify(value);
/** Encodes bytes as a lowercase hexadecimal string. */
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
/** Extracts the canonical box information used for recovery checks. */
const boxInfo = (bytes: Uint8Array) => {
  const box = wasm.ErgoBox.sigma_parse_bytes(bytes);
  try {
    if (hex(box.sigma_serialize_bytes()) !== hex(bytes))
      throw new Error('Noncanonical recovery input');
    const id = box.box_id(),
      tokens = box.tokens();
    try {
      const tokenIds: string[] = [];
      for (let index = 0; index < tokens.len(); index++) {
        const token = tokens.get(index),
          tokenId = token.id();
        try {
          tokenIds.push(tokenId.to_str());
        } finally {
          tokenId.free();
          token.free();
        }
      }
      return { id: id.to_str(), tokenIds };
    } finally {
      id.free();
      tokens.free();
    }
  } finally {
    box.free();
  }
};

/** Restore observed Signed bytes to their exact original unsigned/Reduced row. */
export class PaymentRecoveryAuthorization {
  /** Captures the dependencies used by subsequent authorization checks. */
  constructor(private readonly dependencies: Dependencies) {}

  /** Binds a persisted payment to the authority required for signed recovery. */
  async bindRecovery(
    input: TransactionCheckPreimage,
  ): Promise<BoundPaymentRecovery> {
    const expected = Object.freeze({ ...input });
    const originalFingerprint = fingerprint(expected);
    if (
      expected.status !== TransactionStatus.signFailed ||
      expected.type !== TransactionType.payment ||
      !expected.eventId ||
      expected.orderId !== null ||
      !['ergo', 'avalanche'].includes(expected.chain) ||
      !Number.isSafeInteger(expected.requiredSign) ||
      expected.requiredSign < 1 ||
      !Number.isSafeInteger(expected.lastCheck) ||
      expected.lastCheck < 0 ||
      (expected.lastStatusUpdate !== null &&
        typeof expected.lastStatusUpdate !== 'string') ||
      typeof expected.failedInSign !== 'boolean' ||
      !Number.isSafeInteger(expected.signFailedCount) ||
      expected.signFailedCount < 0
    )
      throw new Error('Payment recovery row is not eligible');
    const original = this.dependencies.decode(expected.txJson);
    if (
      !isEqual(JSON.parse(original.toJson()), JSON.parse(expected.txJson)) ||
      original.network !== expected.chain ||
      original.txId !== expected.txId ||
      original.eventId !== expected.eventId ||
      original.txType !== expected.type
    )
      throw new Error('Payment recovery model metadata mismatch');
    const unsignedAvalanche =
      expected.chain === 'avalanche'
        ? Transaction.from('0x' + hex(original.txBytes))
        : undefined;
    if (
      unsignedAvalanche &&
      (unsignedAvalanche.isSigned() ||
        unsignedAvalanche.type !== 2 ||
        unsignedAvalanche.unsignedSerialized !== '0x' + hex(original.txBytes) ||
        unsignedAvalanche.unsignedHash !== expected.txId)
    )
      throw new Error(
        'Payment recovery requires canonical unsigned Avalanche bytes',
      );
    if (expected.chain === 'ergo') {
      if (!(original instanceof ErgoTransaction))
        throw new Error('Recovery requires the Reduced Ergo model');
      assertCanonicalReducedErgo(original);
    }
    const originalModel = fingerprint({
      json: original.toJson(),
      bytes: hex(original.txBytes),
    });
    const database = this.dependencies.getDatabase();
    const chain = this.dependencies.getChain(expected.chain);
    if (!(chain instanceof ErgoChain) && !(chain instanceof AvalancheChain))
      throw new Error('Unsupported payment recovery chain');
    if (
      (expected.chain === 'ergo') !== chain instanceof ErgoChain ||
      (chain instanceof AvalancheChain &&
        !(chain.network instanceof AvalancheRpcNetwork))
    )
      throw new Error('Unsupported payment recovery network');
    const network = chain.network,
      policy = fingerprint(chain.getChainConfigs());
    const storedEvent = await database.getEventById(expected.eventId);
    if (
      !storedEvent?.eventData ||
      storedEvent.status !== EventStatus.inPayment ||
      storedEvent.id !== expected.eventId ||
      storedEvent.eventData.eventId !== expected.eventId
    )
      throw new Error('Payment recovery event is not in payment');
    const event = structuredClone(storedEvent),
      eventFingerprint = fingerprint(event);
    const protocol = Object.freeze(EventSerializer.fromConfirmedEntity(event));
    if (
      EventSerializer.getId(protocol) !== expected.eventId ||
      protocol.toChain !== expected.chain ||
      ![protocol.fromChain, protocol.toChain].includes('avalanche')
    )
      throw new Error('Payment recovery route mismatch');
    const source = this.dependencies.getChain(protocol.fromChain),
      sourcePolicy = fingerprint(source.getChainConfigs());
    const triggerMarkers = [
      event.eventData.spendHeight,
      event.eventData.spendBlock,
      event.eventData.spendTxId,
      event.eventData.paymentTxId,
      event.eventData.result,
    ];
    if (
      expected.chain === 'ergo'
        ? event.eventData.spendTxId !== expected.txId ||
          event.eventData.paymentTxId !== expected.txId ||
          event.eventData.result !== 'successful' ||
          !Number.isSafeInteger(event.eventData.spendHeight) ||
          event.eventData.spendHeight! < event.eventData.height ||
          typeof event.eventData.spendBlock !== 'string' ||
          !/^[0-9a-f]{64}$/.test(event.eventData.spendBlock)
        : triggerMarkers.some((value) => value != null)
    )
      throw new Error('Payment recovery trigger evidence mismatch');
    const addressPredicate = unsignedAvalanche
      ? {
          unsignedHash: expected.txId,
          address: chain.getChainConfigs().addresses.lock.toLowerCase(),
          extractor: AVALANCHE_TX_EXTRACTOR,
        }
      : undefined;
    const records = addressPredicate
      ? await database.dataSource
          .getRepository(AddressTxsEntity)
          .findBy(addressPredicate)
      : [];
    const record = records[0] ? structuredClone(records[0]) : undefined;
    if (
      unsignedAvalanche &&
      (records.length !== 1 ||
        !record ||
        !Number.isSafeInteger(record.id) ||
        record.id < 1 ||
        record.status !== EvmTxStatus.succeed ||
        record.nonce !== unsignedAvalanche.nonce ||
        record.unsignedHash !== expected.txId ||
        !/^0x[0-9a-f]{64}$/.test(record.signedHash) ||
        !/^0x[0-9a-f]{64}$/.test(record.blockId))
    )
      throw new Error(
        'Payment recovery requires unique successful Avalanche evidence',
      );
    const blocks = await database.dataSource.getRepository(BlockEntity).findBy({
      scanner: expected.chain,
      hash: record?.blockId ?? event.eventData.spendBlock!,
    });
    const block = blocks[0] ? structuredClone(blocks[0]) : undefined;
    if (
      blocks.length !== 1 ||
      !block ||
      block.status !== PROCEED ||
      !Number.isSafeInteger(block.height) ||
      block.height < 0 ||
      (expected.chain === 'ergo' &&
        block.height !== event.eventData.spendHeight)
    )
      throw new Error('Payment recovery block is not qualified');
    const inputs = await this.dependencies.captureOrderInputs(
      protocol,
      event.eventData.txId,
    );
    if (new Set(inputs.eventWIDs).size !== inputs.eventWIDs.length)
      throw new Error('Duplicate recovery merged WID');
    const commitments = structuredClone(inputs.commitments);
    const additional: { wid: string; boxValue: bigint }[] = [];
    let rwtCount = 0n,
      permitValue = 0n;
    if (original instanceof ErgoTransaction && chain instanceof ErgoChain) {
      // The explicit Reduced comparator validated every own auxiliary slot first.
      const info = original.inputBoxes.map(boxInfo),
        ids = info.map((item) => item.id);
      const triggerBytes = Buffer.from(event.eventData.serialized, 'base64'),
        trigger = boxInfo(triggerBytes);
      const triggerIndex = ids.indexOf(trigger.id);
      if (
        trigger.id !== event.eventData.identifier ||
        triggerIndex < 0 ||
        hex(original.inputBoxes[triggerIndex]) !== hex(triggerBytes) ||
        !Number.isSafeInteger(protocol.WIDsCount) ||
        protocol.WIDsCount <= 0 ||
        trigger.tokenIds[0] !== source.getRWTToken()
      )
        throw new Error('Recovery does not consume the exact trigger');
      rwtCount =
        chain.getBoxRWT(hex(triggerBytes)) / BigInt(protocol.WIDsCount);
      permitValue =
        chain.getSerializedBoxInfo(hex(triggerBytes)).assets.nativeToken /
        BigInt(protocol.WIDsCount);
      if (rwtCount <= 0n || permitValue <= 0n)
        throw new Error('Empty recovery trigger distribution');
      const merged = commitments.filter(
        (row) => row.spendTxId === event.eventData.txId,
      );
      if (
        new Set(merged.map((row) => row.spendIndex)).size !== merged.length ||
        merged.some(
          (row) =>
            !Number.isSafeInteger(row.spendIndex) ||
            row.spendIndex! < 0 ||
            row.spendBlock !== event.eventData.block ||
            row.spendHeight !== event.eventData.height ||
            ids.includes(row.identifier),
        )
      )
        throw new Error('Recovery merged provenance mismatch');
      const used = commitments.filter((row) => ids.includes(row.identifier));
      if (
        new Set(used.map((row) => row.identifier)).size !== used.length ||
        new Set(used.map((row) => row.WID)).size !== used.length ||
        commitments.some(
          (row) =>
            row.spendTxId === expected.txId && !ids.includes(row.identifier),
        ) ||
        info.some(
          (box, index) =>
            index !== triggerIndex &&
            box.tokenIds.includes(source.getRWTToken()) &&
            !used.some((row) => row.identifier === box.id),
        )
      )
        throw new Error('Ambiguous recovery commitment provenance');
      for (const row of used) {
        const bytes = Buffer.from(row.serialized, 'base64'),
          box = boxInfo(bytes);
        if (
          box.id !== row.identifier ||
          hex(bytes) !==
            hex(original.inputBoxes[ids.indexOf(row.identifier)]) ||
          row.height >= event.eventData.height ||
          row.spendTxId !== expected.txId ||
          row.spendIndex !== ids.indexOf(row.identifier) ||
          row.spendHeight !== block.height ||
          row.spendBlock !== block.hash ||
          !/^[0-9a-f]{64}$/.test(row.WID) ||
          inputs.eventWIDs.includes(row.WID) ||
          BigInt(row.rwtCount) !== rwtCount ||
          box.tokenIds[0] !== source.getRWTToken() ||
          chain.getBoxRWT(hex(bytes)) !== rwtCount ||
          chain.getBoxWID(hex(bytes)) !== row.WID ||
          row.commitment !== Utils.commitmentFromEvent(protocol, row.WID)
        )
          throw new Error('Recovery additional commitment mismatch');
        additional.push({
          wid: row.WID,
          boxValue: chain.getSerializedBoxInfo(hex(bytes)).assets.nativeToken,
        });
      }
    }
    /** Extracts the current event and order data required by this authorization. */
    const extract = (model: PaymentTransaction, status: SigningStatus) =>
      chain instanceof ErgoChain
        ? chain.extractTransactionOrder(model, status)
        : chain.extractTransactionOrder(model);
    const actualOrder = fingerprint(extract(original, SigningStatus.UnSigned));
    /** Reads the current payment order for comparison with the captured order. */
    const currentOrder = () => {
      const single = EventOrder.eventSinglePayment(
        protocol,
        chain.getMinimumNativeToken(),
        inputs.feeConfig,
      );
      if (!(chain instanceof ErgoChain)) return [single];
      const reward = EventOrder.eventRewardOrder(
        protocol,
        additional,
        inputs.feeConfig,
        '',
        source.getRWTToken(),
        rwtCount,
        permitValue,
        [...inputs.eventWIDs],
      );
      return [...reward.watchersOrder, single, ...reward.guardsOrder];
    };
    const verifySettlement =
      chain instanceof AvalancheChain
        ? chain.verifySettledPaymentEvidence
        : undefined;
    const readTokenReceipt =
      network instanceof AvalancheRpcNetwork
        ? network.getSettledTransactionReceiptEvidence
        : undefined;
    /** Rejects changes to the captured event, order or transaction authority. */
    const assertCurrent = () => {
      inputs.assertFee();
      if (original instanceof ErgoTransaction)
        assertCanonicalReducedErgo(original);
      if (
        fingerprint(input) !== originalFingerprint ||
        this.dependencies.getDatabase() !== database ||
        this.dependencies.getChain(protocol.toChain) !== chain ||
        this.dependencies.getChain(protocol.fromChain) !== source ||
        chain.network !== network ||
        (chain instanceof AvalancheChain &&
          chain.verifySettledPaymentEvidence !== verifySettlement) ||
        (network instanceof AvalancheRpcNetwork &&
          network.getSettledTransactionReceiptEvidence !== readTokenReceipt) ||
        fingerprint(chain.getChainConfigs()) !== policy ||
        fingerprint(source.getChainConfigs()) !== sourcePolicy ||
        fingerprint({
          json: original.toJson(),
          bytes: hex(original.txBytes),
        }) !== originalModel ||
        fingerprint(extract(original, SigningStatus.UnSigned)) !==
          actualOrder ||
        fingerprint(currentOrder()) !== actualOrder
      )
        throw new Error(
          'Payment recovery model, route, policy or order changed',
        );
    };
    assertCurrent();
    /** Checks that the captured authorization remains valid before the action. */
    const check = async (
      manager: EntityManager,
      row: TransactionCheckPreimage,
      active: () => void,
    ) => {
      active();
      assertCurrent();
      const current = await manager
        .getRepository(ConfirmedEventEntity)
        .findOne({
          where: { id: expected.eventId! },
          relations: ['eventData'],
        });
      const triggers = await manager
        .getRepository(EventTriggerEntity)
        .findBy({ txId: event.eventData.txId });
      const transactions = (
        await manager.getRepository(TransactionEntity).find({
          where: {
            event: { id: expected.eventId! },
            type: TransactionType.payment,
          },
          relations: ['event', 'order'],
        })
      ).filter((value) => value.status !== TransactionStatus.invalid);
      const tx = transactions[0];
      if (
        !current ||
        fingerprint(current) !== eventFingerprint ||
        triggers.length !== 1 ||
        triggers[0].id !== event.eventData.id ||
        transactions.length !== 1 ||
        !tx ||
        tx.txId !== row.txId ||
        tx.txJson !== row.txJson ||
        tx.chain !== row.chain ||
        tx.type !== row.type ||
        tx.status !== row.status ||
        tx.requiredSign !== row.requiredSign ||
        tx.lastCheck !== row.lastCheck ||
        tx.lastStatusUpdate !== row.lastStatusUpdate ||
        tx.failedInSign !== row.failedInSign ||
        tx.signFailedCount !== row.signFailedCount ||
        tx.event?.id !== row.eventId ||
        tx.order !== null ||
        !(await manager
          .getRepository(TransactionEntity)
          .existsBy({ txId: expected.txId, order: IsNull() }))
      )
        throw new Error('Payment recovery SQL authority changed');
      const currentBlocks = await manager
        .getRepository(BlockEntity)
        .findBy({ scanner: block.scanner, height: block.height });
      if (
        currentBlocks.length !== 1 ||
        fingerprint(currentBlocks[0]) !== fingerprint(block)
      )
        throw new Error('Payment recovery scanned block changed');
      if (
        addressPredicate &&
        fingerprint(
          await manager
            .getRepository(AddressTxsEntity)
            .findBy(addressPredicate),
        ) !== fingerprint(records)
      )
        throw new Error('Payment recovery scanner record changed');
      await inputs.assertInputs(manager);
      active();
      assertCurrent();
    };
    await database.dataSource.transaction((manager) =>
      check(manager, expected, () => {}),
    );
    let prepared = false;
    return Object.freeze({
      purpose: 'recovery' as const,
      identity: fingerprint({
        expected,
        event,
        inputs: inputs.authorityId,
        record,
        block,
        policy,
        sourcePolicy,
        actualOrder,
      }),
      prepareUnderScannerLease: async (assertActive: () => void) => {
        if (prepared)
          throw new Error('Payment recovery preparation is single use');
        prepared = true;
        /** Rejects an inactive or expired captured authorization. */
        const active = () => {
          assertActive();
          assertCurrent();
        };
        active();
        const required = chain.getTxRequiredConfirmation(
          TransactionType.payment,
        );
        if (!Number.isSafeInteger(required) || required < 1)
          throw new Error('Invalid recovery confirmation policy');
        /** Qualifies the payment model against the current execution evidence. */
        const qualify = async () => {
          const info = await network.getBlockInfo(block.hash);
          active();
          const header = Object.freeze({
            hash: info.hash,
            height: info.height,
            parentHash: info.parentHash,
          });
          if (
            info.hash !== block.hash ||
            info.height !== block.height ||
            info.parentHash !== block.parentHash
          )
            throw new Error('Payment recovery network block changed');
          /** Rejects a settlement header that differs from the captured observation. */
          const assertHeader = () => {
            if (
              info.hash !== header.hash ||
              info.height !== header.height ||
              info.parentHash !== header.parentHash
            )
              throw new Error('Payment recovery header mutated during lookup');
          };
          let signedBytes: Uint8Array, evidence: unknown;
          if (unsignedAvalanche) {
            const observed =
              unsignedAvalanche.value === 0n
                ? await readTokenReceipt!.call(
                    network,
                    record!.signedHash,
                    record!.blockId,
                  )
                : await (
                    network as AvalancheRpcNetwork
                  ).getSettledTransactionEvidence(
                    record!.signedHash,
                    record!.blockId,
                  );
            active();
            assertHeader();
            const signed = Transaction.from(observed.signedBytes);
            if (
              !signed.isSigned() ||
              signed.serialized !== observed.signedBytes ||
              signed.unsignedSerialized !==
                unsignedAvalanche.unsignedSerialized ||
              signed.hash !== observed.hash ||
              signed.unsignedHash !== expected.txId ||
              signed.from?.toLowerCase() !== observed.from ||
              observed.from !== addressPredicate!.address ||
              observed.chainId !== unsignedAvalanche.chainId ||
              signed.chainId !== observed.chainId ||
              signed.nonce !== unsignedAvalanche.nonce ||
              observed.nonce !== signed.nonce ||
              observed.hash !== record!.signedHash ||
              observed.unsignedHash !== record!.unsignedHash ||
              observed.blockHash !== block.hash ||
              observed.blockNumber !== block.height ||
              !Number.isSafeInteger(observed.index) ||
              observed.index < 0 ||
              observed.status !== EvmTxStatus.succeed ||
              !Number.isSafeInteger(observed.finalizedBlockNumber) ||
              observed.finalizedBlockNumber < block.height ||
              !/^0x[0-9a-f]{64}$/.test(observed.finalizedBlockHash) ||
              !Number.isSafeInteger(observed.confirmations) ||
              observed.confirmations !==
                observed.finalizedBlockNumber - block.height + 1 ||
              observed.confirmations < required
            )
              throw new Error(
                'Recovered Avalanche execution differs from unsigned authority',
              );
            signedBytes = Buffer.from(signed.serialized.slice(2), 'hex');
            evidence = Object.freeze({ ...observed });
          } else {
            // Release the public adapter's WASM response deterministically,
            // without waiting for garbage collection after string conversion.
            const observed = await (
              network as ErgoChain['network']
            ).getTransaction(expected.txId, block.hash);
            try {
              active();
              assertHeader();
              signedBytes = Uint8Array.from(observed.sigma_serialize_bytes());
            } finally {
              observed.free();
            }
            evidence = { bytes: hex(signedBytes), block: header };
          }
          const signed = this.dependencies.decode(expected.txJson);
          if (
            !isEqual(JSON.parse(signed.toJson()), JSON.parse(expected.txJson))
          )
            throw new Error('Recovery decoder changed original input');
          signed.txBytes = Uint8Array.from(signedBytes);
          if (expected.chain === 'ergo') {
            if (
              !(original instanceof ErgoTransaction) ||
              !(signed instanceof ErgoTransaction)
            )
              throw new Error('Recovery requires the Signed Ergo model');
            assertReducedToSignedErgoSemantics(original, signed);
          }
          if (
            signed.network !== expected.chain ||
            signed.eventId !== expected.eventId ||
            signed.txType !== expected.type ||
            signed.txId !== expected.txId ||
            fingerprint(extract(signed, SigningStatus.Signed)) !== actualOrder
          )
            throw new Error('Recovered payment model or order changed');
          if (
            unsignedAvalanche?.value === 0n &&
            !verifySettlement!.call(
              chain,
              signed,
              evidence as SettledAvalancheTransactionReceiptEvidence,
            )
          )
            throw new Error(
              'Recovered Avalanche token payment lacks exact Transfer evidence',
            );
          if (
            chain instanceof ErgoChain &&
            (await chain.getTxConfirmationStatus(
              expected.txId,
              TransactionType.payment,
            )) !== ConfirmationStatus.ConfirmedEnough
          )
            throw new Error('Recovered Ergo payment is not confirmed');
          assertHeader();
          active();
          return {
            signed,
            signedJson: signed.toJson(),
            evidence: fingerprint(evidence),
          };
        };
        const first = await qualify();
        const signedModel = first.signedJson;
        /** Checks that the signed model still belongs to the active recovery authorization. */
        const signedActive = () => {
          active();
          if (original instanceof ErgoTransaction) {
            if (!(first.signed instanceof ErgoTransaction))
              throw new Error('Recovered model changed class');
            assertReducedToSignedErgoSemantics(original, first.signed);
          }
          if (first.signed.toJson() !== signedModel)
            throw new Error('Recovered model mutated');
        };
        if (
          !(await (chain instanceof ErgoChain
            ? chain.verifyPaymentTransaction(first.signed, SigningStatus.Signed)
            : chain.verifyPaymentTransaction(first.signed)))
        )
          throw new Error('Recovered Signed payment rejected');
        signedActive();
        if (
          !(await (chain instanceof ErgoChain
            ? chain.verifyTransactionFee(first.signed, SigningStatus.Signed)
            : chain.verifyTransactionFee(first.signed)))
        )
          throw new Error('Recovered Signed payment fee rejected');
        signedActive();
        if (
          !(await (chain instanceof ErgoChain
            ? chain.verifyNoTokenBurned(first.signed, SigningStatus.Signed)
            : chain.verifyNoTokenBurned(first.signed)))
        )
          throw new Error('Recovered payment burns tokens');
        signedActive();
        if (
          !chain.verifyTransactionExtraConditions(
            first.signed,
            SigningStatus.Signed,
          )
        )
          throw new Error('Recovered payment extra conditions rejected');
        const again = await qualify();
        signedActive();
        if (
          again.evidence !== first.evidence ||
          again.signedJson !== signedModel
        )
          throw new Error('Recovery execution changed during preparation');
        await database.dataSource.transaction((manager) =>
          check(manager, expected, signedActive),
        );
        return Object.freeze({
          signedJson: signedModel,
          assertBefore: async (
            manager: EntityManager,
            row: TransactionCheckPreimage,
          ) => {
            if (fingerprint(row) !== originalFingerprint)
              throw new Error('Recovery original preimage changed');
            await check(manager, expected, signedActive);
          },
          assertAfter: async (
            manager: EntityManager,
            row: TransactionCheckPreimage,
          ) => {
            if (
              typeof row.lastStatusUpdate !== 'string' ||
              !/^(?:0|[1-9][0-9]*)$/.test(row.lastStatusUpdate) ||
              fingerprint(row) !==
                fingerprint({
                  ...expected,
                  txJson: signedModel,
                  status: TransactionStatus.sent,
                  lastStatusUpdate: row.lastStatusUpdate,
                })
            )
              throw new Error('Recovery after-preimage changed');
            await check(manager, row, signedActive);
          },
        });
      },
    });
  }
}
