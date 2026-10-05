import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import { AvalancheRpcScanner } from '@rosen-bridge/evm-scanner';
import { ChainMinimumFee } from '@rosen-bridge/minimum-fee';
import {
  EventTrigger,
  ImpossibleBehavior,
  NotEnoughAssetsError,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ERGO_CHAIN, ErgoChain } from '@rosen-chains/ergo';

import TxAgreement from '../agreement/txAgreement';
import Configs from '../configs/configs';
import { rosenConfig } from '../configs/rosenConfig';
import { DatabaseAction } from '../db/databaseAction';
import ChainHandler from '../handlers/chainHandler';
import GuardPkHandler from '../handlers/guardPkHandler';
import MinimumFeeHandler from '../handlers/minimumFeeHandler';
import { NotificationHandler } from '../handlers/notificationHandler';
import { getAvalancheScanner } from '../jobs/initScanner';
import * as TransactionSerializer from '../transaction/transactionSerializer';
import { EventStatus, EventUnexpectedFailsLimit } from '../utils/constants';
import GuardTurn from '../utils/guardTurn';
import EventVerifier from '../verification/eventVerifier';
import RewardAuthorization from '../verification/rewardAuthorization';
import EventBoxes from './eventBoxes';
import EventOrder from './eventOrder';
import EventSerializer from './eventSerializer';

const logger = DefaultLogger.getInstance().child(import.meta.url);

class EventProcessor {
  /**
   * processes scanned events and insert new confirmed ones to ConfirmedEvents table
   */
  static processScannedEvents = async (): Promise<void> => {
    logger.info('Processing scanned events');
    const dbAction = DatabaseAction.getInstance();
    const rawEvents = await dbAction.getUnconfirmedEvents();
    for (const event of rawEvents) {
      try {
        // Keep one protocol and database identity across the asynchronous checks.
        const eventData = Object.freeze({ ...event });
        const protocolEvent = Object.freeze(
          EventSerializer.fromEntity(eventData),
        );
        if (
          [protocolEvent.fromChain, protocolEvent.toChain].some(
            (chain) =>
              chain.trim().toLowerCase() === 'avalanche' &&
              chain !== 'avalanche',
          )
        )
          throw new Error('Avalanche event chain identity is not canonical');
        /** Rejects changes to the scanned event captured for this admission. */
        const assertUnchanged = () => {
          if (
            event.id !== eventData.id ||
            event.eventId !== eventData.eventId ||
            event.txId !== eventData.txId ||
            Object.entries(protocolEvent).some(
              ([field, value]) => event[field as keyof EventTrigger] !== value,
            )
          )
            throw new Error('Scanned event changed during admission');
        };
        /** Runs event admission with the captured source observation checks. */
        const admit = async () => {
          assertUnchanged();
          // Check confirmation and verification under the same scanner lease.
          if (await EventVerifier.isEventConfirmedEnough(protocolEvent)) {
            const eventEntity = await dbAction.getEventById(eventData.eventId);
            if (eventEntity && eventEntity.eventData.id !== eventData.id) {
              assertUnchanged();
              logger.warn(
                `Event [${eventData.eventId}] is already confirmed and verified in tx [${eventEntity.eventData.txId}]. Marking trigger tx [${eventData.txId}] as rejected`,
              );
              await dbAction.insertRejectedEvent(
                eventData,
                'duplicate-trigger',
              );
            } else {
              const feeConfig =
                MinimumFeeHandler.getEventFeeConfig(protocolEvent);
              if (
                await EventVerifier.verifyEvent(
                  protocolEvent,
                  eventData.txId,
                  feeConfig,
                )
              ) {
                assertUnchanged();
                logger.info(
                  `Event [${eventData.eventId}] with txId [${protocolEvent.sourceTxId}] is confirmed and verified`,
                );
                await dbAction.insertConfirmedEvent(eventData);
              } else {
                assertUnchanged();
                logger.warn(`Event [${eventData.eventId}] hasn't verified`);
                await dbAction.insertRejectedEvent(
                  eventData,
                  'unknown', // TODO: update rosen-chains to return reason
                );
              }
            }
          } else
            logger.debug(`Event [${eventData.eventId}] is not confirmed yet`);
        };
        const source = protocolEvent.fromChain === 'avalanche';
        const destination = protocolEvent.toChain === 'avalanche';
        if (source || destination) {
          if (EventSerializer.getId(protocolEvent) !== eventData.eventId)
            throw new Error(
              'Avalanche event identity does not match source tx',
            );
          const scanner = getAvalancheScanner();
          if (!(scanner instanceof AvalancheRpcScanner))
            throw new Error('Avalanche event requires its dedicated scanner');
          if (source)
            await scanner.withObservation(
              protocolEvent.sourceChainHeight,
              protocolEvent.sourceBlockId,
              admit,
            );
          else await scanner.withSafety(admit);
        } else await admit();
      } catch (e) {
        logger.warn(
          `An error occurred while processing event triggered in tx [${event.sourceTxId}]: ${e}`,
        );
        logger.warn(e.stack);
      }
    }
    logger.info(`Processed [${rawEvents.length}] scanned events`);
  };

  /**
   * processes pending event triggers in the database
   */
  static processConfirmedEvents = async (): Promise<void> => {
    logger.info('Processing confirmed events');
    const confirmedEvents =
      await DatabaseAction.getInstance().getEventsByStatuses([
        EventStatus.pendingPayment,
        EventStatus.pendingReward,
      ]);
    for (const event of confirmedEvents) {
      if (GuardTurn.guardTurn() !== GuardPkHandler.getInstance().guardId) {
        logger.info(`Turn is over. Abort process of confirmed events`);
        break;
      }
      try {
        // check if event is active
        if (event.eventData.spendHeight) {
          logger.info(
            `Event [${event.id}] is spent at height [${event.eventData.spendHeight}]`,
          );
          await DatabaseAction.getInstance().setEventStatus(
            event.id,
            EventStatus.spent,
          );
          continue;
        }
        // check how many times event txs unexpectedly failed
        if (event.unexpectedFails >= EventUnexpectedFailsLimit) {
          logger.warn(
            `Event [${event.id}] will no longer be processed due to too much unexpected failures`,
          );
          await DatabaseAction.getInstance().setEventStatus(
            event.id,
            EventStatus.reachedLimit,
          );
          continue;
        }
        // process event
        if (event.status === EventStatus.pendingPayment)
          await this.processPaymentEvent(
            EventSerializer.fromConfirmedEntity(event),
            event.eventData.txId,
          );
        else if (event.status === EventStatus.pendingReward)
          await this.processRewardEvent(
            EventSerializer.fromConfirmedEntity(event),
            event.eventData.txId,
          );
        else
          logger.warn(
            `Impossible case, received event [${event.id}] with status [${event.status}]`,
          );
      } catch (e) {
        logger.warn(
          `An error occurred while processing event [${event.id}]: ${e}`,
        );
        logger.warn(e.stack);
      }
    }
    logger.info(`Processed [${confirmedEvents.length}] confirmed events`);
  };

  /**
   * processes the event trigger to create payment transaction
   *  1. verify event data with lock tx in source chain
   *  2. create transaction
   *  3. start agreement process on transaction
   * @param event the event trigger
   * @param eventTxId the trigger transaction id
   */
  static processPaymentEvent = async (
    event: EventTrigger,
    eventTxId: string,
  ): Promise<void> => {
    const eventId = EventSerializer.getId(event);
    logger.info(`Processing event [${eventId}] for payment`);

    // get minimum-fee and verify event
    const feeConfig = MinimumFeeHandler.getEventFeeConfig(event);

    // create payment
    try {
      const tx = await this.createEventPayment(event, eventTxId, feeConfig);
      if (GuardTurn.guardTurn() === GuardPkHandler.getInstance().guardId)
        (await TxAgreement.getInstance()).addTransactionToQueue(tx);
      else
        logger.info(
          `Tx [${tx.txId}] is generated but turn is over. No tx will be added to Agreement queue`,
        );
    } catch (e) {
      if (e instanceof NotEnoughAssetsError) {
        logger.warn(`Failed to create payment for event [${eventId}]: ${e}`);
        if (e.stack) logger.warn(e.stack);
        await NotificationHandler.getInstance().notify(
          'error',
          `Low Assets in ${event.toChain}`,
          `Failed to create payment for event [${eventId}] due to low assets: ${e}`,
        );
        await DatabaseAction.getInstance().setEventStatus(
          eventId,
          EventStatus.paymentWaiting,
        );
      } else throw e;
    }
  };

  /**
   * creates an unsigned transaction for payment on target chain
   * @param event the event trigger
   * @param eventTxId the trigger transaction id
   * @param feeConfig minimum fee and rsn ratio config for the event
   * @returns created unsigned transaction
   */
  protected static createEventPayment = async (
    event: EventTrigger,
    eventTxId: string,
    feeConfig: ChainMinimumFee,
  ): Promise<PaymentTransaction> => {
    const targetChain = ChainHandler.getInstance().getChain(event.toChain);

    const extra: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const eventWIDs: string[] = [];

    // add reward order if target chain is ergo
    let eventBox: string | undefined;
    if (event.toChain === ERGO_CHAIN) {
      const ergoChain = targetChain as ErgoChain;

      // get event and commitment boxes
      eventBox = await EventBoxes.getEventBox(eventTxId);
      const rwtCount = ergoChain.getBoxRWT(eventBox) / BigInt(event.WIDsCount);

      eventWIDs.push(...(await EventBoxes.getEventWIDs(event)));
      const commitmentBoxes = await EventBoxes.getEventValidCommitments(
        event,
        rwtCount,
        eventWIDs,
      );
      const guardsConfigBox = await ergoChain.getGuardsConfigBox(
        rosenConfig.guardNFT,
        rosenConfig.guardSignAddress,
      );

      // add event and commitment boxes to generateTransaction arguments
      extra.push([eventBox, ...commitmentBoxes], [guardsConfigBox]);
    }

    // add payment order
    const order = await EventOrder.createEventPaymentOrder(
      event,
      eventTxId,
      feeConfig,
      eventWIDs,
    );

    // get unsigned transactions in target chain
    const unsignedAgreementTransactions = (
      await TxAgreement.getInstance()
    ).getChainPendingTransactions(event.toChain);
    const unsignedQueueTransactions = (
      await DatabaseAction.getInstance().getUnsignedActiveTxsInChain(
        event.toChain,
      )
    ).map((txEntity) =>
      TransactionSerializer.fromJson(
        txEntity.txJson,
        ChainHandler.getInstance().getChain,
      ),
    );
    // get signed transactions in target chain
    const signedTransactions = (
      await DatabaseAction.getInstance().getSignedActiveTxsInChain(
        event.toChain,
      )
    ).map((txEntity) =>
      Buffer.from(
        TransactionSerializer.fromJson(
          txEntity.txJson,
          ChainHandler.getInstance().getChain,
        ).txBytes,
      ).toString('hex'),
    );

    // generate transaction
    return targetChain.generateTransaction(
      EventSerializer.getId(event),
      TransactionType.payment,
      order,
      [...unsignedAgreementTransactions, ...unsignedQueueTransactions],
      signedTransactions,
      ...extra,
    );
  };

  /**
   * processes the event trigger to create reward distribution transaction
   * @param event the event trigger
   * @param eventTxId the trigger transaction id
   */
  static processRewardEvent = async (
    event: EventTrigger,
    eventTxId: string,
  ): Promise<void> => {
    if (RewardAuthorization.applies(event)) {
      const authorization = await RewardAuthorization.getInstance().bind(
        event,
        eventTxId,
      );
      const captured = authorization.event;
      const inputs = await RewardAuthorization.getInstance().captureOrderInputs(
        captured,
        authorization.eventTxId,
      );
      // Failed generation leaves the captured pending event unchanged.
      const tx = await this.createEventRewardDistribution(
        captured,
        authorization.eventTxId,
        inputs.feeConfig,
        authorization.paymentTxId,
        inputs.eventWIDs,
      );
      const reward = RewardAuthorization.captureReward(
        tx,
        EventSerializer.getId(captured),
      );
      const agreement = await TxAgreement.getInstance();
      await authorization.withAction(() => {
        inputs.assertFee();
        reward.assertUnchanged();
        if (GuardTurn.guardTurn() === GuardPkHandler.getInstance().guardId) {
          reward.retainAuthority(authorization);
          agreement.addTransactionToQueue(reward.payment);
        }
      }, inputs.assertInputs);
      return;
    }
    const eventId = EventSerializer.getId(event);
    logger.info(`Processing event [${eventId}] for reward distribution`);

    if (event.toChain === ERGO_CHAIN)
      throw new ImpossibleBehavior(
        'Events with Ergo as toChain will distribute rewards in a single transaction with payment',
      );

    // get event payment transaction
    const eventTxs = await DatabaseAction.getInstance().getEventValidTxsByType(
      eventId,
      TransactionType.payment,
    );
    if (eventTxs.length !== 1)
      throw new ImpossibleBehavior(
        `Processing event [${eventId}] for reward distribution but no payment tx found for it in database`,
      );

    const targetChain = ChainHandler.getInstance().getChain(event.toChain);
    const paymentTxId = await targetChain.getActualTxId(eventTxs[0].txId);

    // get minimum-fee and verify event
    const feeConfig = MinimumFeeHandler.getEventFeeConfig(event);

    try {
      const tx = await this.createEventRewardDistribution(
        event,
        eventTxId,
        feeConfig,
        paymentTxId,
      );
      if (GuardTurn.guardTurn() === GuardPkHandler.getInstance().guardId)
        (await TxAgreement.getInstance()).addTransactionToQueue(tx);
      else
        logger.info(
          `Tx [${tx.txId}] is generated but turn is over. No tx will be added to Agreement queue`,
        );
    } catch (e) {
      if (e instanceof NotEnoughAssetsError) {
        logger.warn(
          `Failed to create reward distribution for event [${eventId}]: ${e}`,
        );
        if (e.stack) logger.warn(e.stack);
        await NotificationHandler.getInstance().notify(
          'error',
          `Low Assets in Ergo`,
          `Failed to create reward distribution for event [${eventId}] due to low assets: ${e}`,
        );
        await DatabaseAction.getInstance().setEventStatus(
          eventId,
          EventStatus.rewardWaiting,
        );
      } else throw e;
    }
  };

  /**
   * creates an unsigned transaction for event reward distribution on ergo chain
   * @param event the event trigger
   * @param eventTxId the trigger transaction id
   * @param feeConfig minimum fee and rsn ratio config for the event
   * @param paymentTxId the payment transaction of the event
   * @returns created unsigned transaction
   */
  protected static createEventRewardDistribution = async (
    event: EventTrigger,
    eventTxId: string,
    feeConfig: ChainMinimumFee,
    paymentTxId: string,
    capturedWIDs?: readonly string[],
  ): Promise<PaymentTransaction> => {
    const ergoChain = ChainHandler.getInstance().getErgoChain();

    // get event and commitment boxes
    const eventBox = await EventBoxes.getEventBox(eventTxId);
    const rwtCount = ergoChain.getBoxRWT(eventBox) / BigInt(event.WIDsCount);

    const eventWIDs = capturedWIDs
      ? [...capturedWIDs]
      : await EventBoxes.getEventWIDs(event);
    const commitmentBoxes = await EventBoxes.getEventValidCommitments(
      event,
      rwtCount,
      eventWIDs,
    );
    const guardsConfigBox = await ergoChain.getGuardsConfigBox(
      rosenConfig.guardNFT,
      rosenConfig.guardSignAddress,
    );

    // generate reward order
    const order = await EventOrder.createEventRewardOrder(
      event,
      eventTxId,
      feeConfig,
      paymentTxId,
      eventWIDs,
    );

    // get unsigned transactions in target chain
    const unsignedAgreementTransactions = (
      await TxAgreement.getInstance()
    ).getChainPendingTransactions(ERGO_CHAIN);
    const unsignedQueueTransactions = (
      await DatabaseAction.getInstance().getUnsignedActiveTxsInChain(ERGO_CHAIN)
    ).map((txEntity) =>
      TransactionSerializer.fromJson(
        txEntity.txJson,
        ChainHandler.getInstance().getChain,
      ),
    );
    // get signed transactions in target chain
    const signedTransactions = (
      await DatabaseAction.getInstance().getSignedActiveTxsInChain(ERGO_CHAIN)
    ).map((txEntity) =>
      Buffer.from(
        TransactionSerializer.fromJson(
          txEntity.txJson,
          ChainHandler.getInstance().getChain,
        ).txBytes,
      ).toString('hex'),
    );

    // generate transaction
    return ergoChain.generateTransaction(
      EventSerializer.getId(event),
      TransactionType.reward,
      order,
      [...unsignedAgreementTransactions, ...unsignedQueueTransactions],
      signedTransactions,
      [eventBox, ...commitmentBoxes],
      [guardsConfigBox],
    );
  };

  /**
   * searches event triggers in the database with more than leftover confirmation and timeout them
   */
  static TimeoutLeftoverEvents = async (): Promise<void> => {
    logger.info('Searching for leftover events');
    const pendingEvents =
      await DatabaseAction.getInstance().getEventsByStatuses([
        EventStatus.pendingPayment,
      ]);

    let timeoutEventsCount = 0;
    for (const event of pendingEvents) {
      try {
        if (
          Math.round(Date.now() / 1000) >
          Number(event.firstTry) + Configs.eventTimeout
        ) {
          await DatabaseAction.getInstance().setEventStatus(
            event.id,
            EventStatus.timeout,
          );
          timeoutEventsCount += 1;
        }
      } catch (e) {
        logger.warn(
          `An error occurred while processing leftover event [${event.id}]: ${e}`,
        );
        logger.warn(e.stack);
      }
    }
    logger.info(
      `Processed [${pendingEvents.length}] pending events, timeout [${timeoutEventsCount}] of them`,
    );
  };

  /**
   * updates all waiting events status to pending
   */
  static RequeueWaitingEvents = async (): Promise<void> => {
    logger.info('Processing waiting events');
    const waitingEvents = await DatabaseAction.getInstance().getWaitingEvents();

    let requeueEventsCount = 0;
    for (const event of waitingEvents) {
      try {
        if (event.status === EventStatus.paymentWaiting) {
          await DatabaseAction.getInstance().setEventStatusToPending(
            event.id,
            EventStatus.pendingPayment,
          );
          requeueEventsCount += 1;
        } else if (event.status === EventStatus.rewardWaiting) {
          await DatabaseAction.getInstance().setEventStatusToPending(
            event.id,
            EventStatus.pendingReward,
          );
          requeueEventsCount += 1;
        } else
          logger.warn(
            `Impossible case, received event [${event.id}] with status [${event.status}]`,
          );
      } catch (e) {
        logger.warn(
          `An error occurred while processing waiting event [${event.id}]: ${e}`,
        );
        logger.warn(e.stack);
      }
    }
    logger.info(
      `Processed [${waitingEvents.length}] waiting events, requeue [${requeueEventsCount}] of them`,
    );
  };
}

export default EventProcessor;
