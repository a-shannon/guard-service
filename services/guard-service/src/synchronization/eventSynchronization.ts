import { Transaction } from 'ethers';
import { isEqual, sampleSize, shuffle } from 'lodash-es';

import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import { Communicator } from '@rosen-bridge/communication';
import { GuardDetection } from '@rosen-bridge/detection';
import { RosenDialerNode } from '@rosen-bridge/dialer';
import { Semaphore } from '@rosen-bridge/semaphore';
import {
  ConfirmationStatus,
  ImpossibleBehavior,
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ErgoChain } from '@rosen-chains/ergo';

import RosenDialer from '../communication/rosenDialer';
import Configs from '../configs/configs';
import { DatabaseAction } from '../db/databaseAction';
import EventBoxes from '../event/eventBoxes';
import EventOrder from '../event/eventOrder';
import EventSerializer from '../event/eventSerializer';
import ChainHandler from '../handlers/chainHandler';
import DetectionHandler from '../handlers/detectionHandler';
import GuardPkHandler from '../handlers/guardPkHandler';
import MinimumFeeHandler from '../handlers/minimumFeeHandler';
import * as TransactionSerializer from '../transaction/transactionSerializer';
import { TransactionStatus } from '../utils/constants';
import GuardTurn from '../utils/guardTurn';
import {
  ActiveSync,
  SynchronizationMessageTypes,
  SyncRequest,
  SyncResponse,
} from './interfaces';

const logger = DefaultLogger.getInstance().child(import.meta.url);

class EventSynchronization extends Communicator {
  private static instance: EventSynchronization;
  protected readonly protocolVersion = '1.0.0';
  protected static CHANNEL = 'event-synchronization';
  protected static dialer: RosenDialerNode;
  protected detection: GuardDetection;
  protected eventQueue: string[];
  protected activeSyncMap: Map<string, ActiveSync>;
  protected approvalSemaphore: Semaphore;
  protected parallelSyncLimit: number;
  protected parallelRequestCount: number;
  protected requiredApproval: number;
  private readonly guardAuthority: string;
  private readonly responseJson = new WeakMap<PaymentTransaction, string>();

  /** Captures signing and communication configuration for rotation checks. */
  private guardFingerprint = (): string => {
    const guards = GuardPkHandler.getInstance();
    return JSON.stringify({
      requiredSign: guards.requiredSign,
      publicKeys: guards.publicKeys,
      guardsLen: guards.guardsLen,
      guardId: guards.guardId,
      communicationKeys: this.guardPks,
    });
  };

  /** Configured communication identities require a restart after guard rotation. */
  private assertGuardAuthority = (): void => {
    if (this.guardFingerprint() !== this.guardAuthority)
      throw new Error(
        'Synchronization guard configuration changed; restart required',
      );
  };

  /** Copies a payment model and rejects a noncanonical JSON round trip. */
  private copyPayment = (json: string): PaymentTransaction => {
    const copy = TransactionSerializer.fromJson(
      json,
      ChainHandler.getInstance().getChain,
    );
    if (copy.toJson() !== json)
      throw new Error('Synchronization payment model did not round-trip');
    return copy;
  };

  /** EVM model IDs are unsigned hashes; settlement IDs commit to signed bytes. */
  private bindActualTransactionId = (
    tx: PaymentTransaction,
    actualTxId: string,
  ): string => {
    if (tx.network === 'ergo' && actualTxId !== tx.txId)
      throw new Error('Synchronization Ergo settlement identity mismatch');
    if (!['ethereum', 'binance'].includes(tx.network)) return actualTxId;
    const signed = Transaction.from(
      '0x' + Buffer.from(tx.txBytes).toString('hex'),
    );
    if (
      !signed.isSigned() ||
      signed.unsignedHash !== tx.txId ||
      typeof actualTxId !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(actualTxId) ||
      signed.hash !== actualTxId.toLowerCase()
    )
      throw new Error('Synchronization signed transaction identity mismatch');
    return signed.hash!;
  };

  protected constructor(detection: GuardDetection) {
    super(
      logger,
      Configs.tssKeys.encryptor,
      EventSynchronization.sendMessageWrapper,
      Configs.tssKeys.pubs.map((pub) => pub.curvePub),
      GuardTurn.UP_TIME_LENGTH,
    );
    this.detection = detection;
    this.eventQueue = [];
    this.activeSyncMap = new Map();
    this.approvalSemaphore = new Semaphore(1);
    this.parallelSyncLimit = Configs.parallelSyncLimit;
    this.parallelRequestCount = Configs.parallelRequestCount;
    this.requiredApproval = GuardPkHandler.getInstance().requiredSign - 1;
    if (
      !Number.isSafeInteger(this.requiredApproval) ||
      this.requiredApproval < 0
    )
      throw new Error('Invalid synchronization quorum');
    this.guardAuthority = this.guardFingerprint();
  }

  /**
   * initializes EventSynchronization
   */
  static init = async () => {
    const detection = DetectionHandler.getInstance().getDetection();
    // TODO: Definition of the required guard in the detection is not in the duty of this module!
    //  local:ergo/rosen-bridge/guard-service#428
    detection.setNeedGuardThreshold(GuardPkHandler.getInstance().requiredSign);
    EventSynchronization.instance = new EventSynchronization(detection);
    this.dialer = RosenDialer.getInstance().getDialer();
    this.dialer.subscribeChannel(
      EventSynchronization.CHANNEL,
      EventSynchronization.instance.messageHandlerWrapper,
    );
  };

  /**
   * generates a EventSynchronization object if it doesn't exist
   * @returns EventSynchronization instance
   */
  static getInstance = () => {
    if (!EventSynchronization.instance)
      throw Error(`EventSynchronization instance doesn't exist`);
    return EventSynchronization.instance;
  };

  /**
   * wraps communicator send message to dialer
   * @param msg
   * @param peers
   */
  static sendMessageWrapper = async (msg: string, peers: Array<string>) => {
    if (peers.length === 0) {
      EventSynchronization.dialer.sendMessage(
        EventSynchronization.CHANNEL,
        msg,
      );
    } else {
      for (const peerId of peers) {
        EventSynchronization.dialer.sendMessage(
          EventSynchronization.CHANNEL,
          msg,
          peerId,
        );
      }
    }
  };

  /**
   * wraps dialer handle message to communicator
   * @param msg
   * @param channel
   * @param peerId
   */
  messageHandlerWrapper = async (
    msg: string,
    channel: string,
    peerId: string,
  ) => {
    this.handleMessage(msg, peerId);
  };

  /**
   * adds an event to synchronization queue
   * @param eventId
   */
  addEventToQueue = (eventId: string): void => {
    this.eventQueue.push(eventId);
    logger.info(`Added event [${eventId}] to synchronization queue`);
  };

  /**
   * verifies events in the queue and starts synchronization process for them
   */
  processSyncQueue = async (): Promise<void> => {
    this.assertGuardAuthority();
    if (this.eventQueue.length === 0) {
      logger.info(`No event to sync`);
      return;
    }

    if (this.activeSyncMap.size >= this.parallelSyncLimit) {
      logger.info(
        `Already syncing for [${this.activeSyncMap.size}] events, [${this.eventQueue.length}] events are waiting for sync in queue`,
      );
      return;
    }

    let eventId: string;
    this.eventQueue = shuffle(this.eventQueue);
    while (
      this.eventQueue.length &&
      this.activeSyncMap.size < this.parallelSyncLimit
    ) {
      eventId = this.eventQueue.pop()!;
      const baseError = `Received event [${eventId}] for synchronization but `;

      // check if event is already in synchronization process
      if (this.activeSyncMap.get(eventId)) {
        logger.debug(`event is [${eventId}] is already in synchronization`);
        continue;
      }

      // get event from database (ConfirmedEventEntity)
      const eventEntity =
        await DatabaseAction.getInstance().getEventById(eventId);
      if (eventEntity === null) {
        logger.warn(baseError + `event is not found`);
        continue;
      }

      // active synchronization for the event
      this.activeSyncMap.set(eventId, {
        timestamp: Math.floor(Date.now() / 1000),
        responses: Array(this.guardPks.length).fill(undefined),
      });
      logger.info(`Activated synchronization for event [${eventId}]`);
    }
  };

  /**
   * gets guard peerId by his index
   * @param index
   */
  protected getPeerIdByIndex = async (
    index: number,
  ): Promise<string | undefined> => {
    const activeGuards = await this.detection.activeGuards();
    return activeGuards.find((_) => _.index === index)?.peerId;
  };

  /**
   * sends requests for all active syncs
   */
  sendSyncBatch = async (): Promise<void> => {
    logger.info(`Sending event synchronization batches`);
    for (const [eventId, activeSync] of this.activeSyncMap) {
      const restrictedIndex = await this.getIndex();
      const indexes = activeSync.responses.reduce(
        (
          indexes: number[],
          response: PaymentTransaction | undefined,
          index: number,
        ) => {
          if (response === undefined && index !== restrictedIndex)
            indexes.push(index);
          return indexes;
        },
        [],
      );
      const selectedIndexes = sampleSize(indexes, this.parallelRequestCount);
      logger.debug(
        `Sending sync request for event [${eventId}] to guards [${indexes.join(
          ',',
        )}]`,
      );

      const selectedPeers = (
        await Promise.all(selectedIndexes.map(this.getPeerIdByIndex))
      ).filter((_) => _) as string[];
      logger.info(
        `Sending sync request for event [${eventId}] to peers [${selectedPeers.join(
          ',',
        )}]`,
      );
      if (selectedPeers.length === 0) continue;

      const payload: SyncRequest = { eventId: eventId };
      await this.sendMessage(
        SynchronizationMessageTypes.request,
        payload,
        selectedPeers,
        Math.round(Date.now() / 1000),
      );
    }
  };

  /**
   * handles received message from event-synchronization channel
   * @param type
   * @param payload
   * @param signature
   * @param senderIndex
   * @param peerId
   * @param timestamp
   */
  processMessage = async (
    type: string,
    payload: unknown,
    signature: string,
    senderIndex: number,
    peerId: string,
    timestamp: number,
  ): Promise<void> => {
    try {
      switch (type) {
        case SynchronizationMessageTypes.request: {
          const request = payload as SyncRequest;
          await this.processSyncRequest(
            request.eventId,
            senderIndex,
            timestamp,
            peerId,
          );
          break;
        }
        case SynchronizationMessageTypes.response: {
          const response = payload as SyncResponse;
          const tx = TransactionSerializer.fromJson(
            response.txJson,
            ChainHandler.getInstance().getChain,
          );
          await this.processSyncResponse(tx, response.actualTxId, senderIndex);
          break;
        }
        default:
          logger.warn(
            `Received unexpected message type [${type}] in event-synchronization channel`,
          );
      }
    } catch (e) {
      logger.warn(
        `An error occurred while handling event-synchronization message: ${e}}`,
      );
      logger.warn(e.stack);
    }
  };

  /**
   * checks if such event exists and has a completed tx in type of payment
   * sends the tx if so, otherwise does nothing
   * @param eventId
   * @param senderIndex index of the guard that sent the request
   * @param timestamp
   * @param receiver the guard who will receive this response
   */
  protected processSyncRequest = async (
    eventId: string,
    senderIndex: number,
    timestamp: number,
    receiver: string,
  ): Promise<void> => {
    const baseError = `Sync request received for event [${eventId}] but `;
    // get event from database
    const eventEntity =
      await DatabaseAction.getInstance().getEventById(eventId);
    if (eventEntity === null) {
      logger.warn(baseError + `event is not found`);
      return;
    }

    // check if event has completed tx in type of payment
    const eventTxs = await DatabaseAction.getInstance().getEventValidTxsByType(
      eventId,
      TransactionType.payment,
    );
    if (eventTxs.length === 0) {
      logger.info(baseError + `event has no valid transaction`);
      return;
    } else if (eventTxs.length === 1) {
      const txEntity = eventTxs[0];
      if (txEntity.status === TransactionStatus.completed) {
        logger.info(
          `Sending tx [${txEntity.txId}] for syncing event [${eventId}] to guard [${senderIndex}]`,
        );

        const targetChain = ChainHandler.getInstance().getChain(txEntity.chain);
        const actualTxId = await targetChain.getActualTxId(txEntity.txId);

        // send response to sender guard
        const payload: SyncResponse = { txJson: txEntity.txJson, actualTxId };
        await this.sendMessage(
          SynchronizationMessageTypes.response,
          payload,
          [receiver],
          timestamp,
        );
      } else {
        logger.info(
          baseError +
            `tx [${txEntity.txId}] is not completed yet (in status [${txEntity.status}])`,
        );
        return;
      }
    } else {
      throw new ImpossibleBehavior(
        `event [${eventId}] has [${
          eventTxs.length
        }] valid transactions for type payment: [${eventTxs
          .map((_) => _.txId)
          .join(',')}]`,
      );
    }
  };

  /**
   * verifies the sync response sent by other guards, save the transaction if its verified
   * @param tx the payment transaction id
   * @param senderIndex index of the guard that sent the response
   */
  protected processSyncResponse = async (
    tx: PaymentTransaction,
    actualTxId: string,
    senderIndex: number,
  ): Promise<void> => {
    const json = tx.toJson();
    this.assertGuardAuthority();
    const candidate = this.copyPayment(json);
    const activeSync = this.activeSyncMap.get(candidate.eventId);
    if (
      !activeSync ||
      !Number.isSafeInteger(senderIndex) ||
      senderIndex < 0 ||
      senderIndex >= activeSync.responses.length ||
      senderIndex >= this.guardPks.length ||
      activeSync.responses[senderIndex] !== undefined
    )
      return;
    if (!(await this.verifySynchronizationResponse(candidate, actualTxId)))
      return;
    this.assertGuardAuthority();
    if (candidate.toJson() !== json)
      throw new Error('Synchronization candidate changed during verification');
    logger.info(
      `Guard [${senderIndex}] responded the sync request of event [${candidate.eventId}] with transaction [${candidate.txId}]`,
    );

    await this.approvalSemaphore.acquire().then(async (release) => {
      try {
        this.assertGuardAuthority();
        if (
          this.activeSyncMap.get(candidate.eventId) === activeSync &&
          activeSync.responses[senderIndex] === undefined
        ) {
          const response = this.copyPayment(json);
          this.responseJson.set(response, json);
          activeSync.responses[senderIndex] = response;
          const votes = activeSync.responses.filter(
            (previous) =>
              previous &&
              (this.responseJson.get(previous) ?? previous.toJson()) === json,
          ).length;

          if (votes >= this.requiredApproval) {
            logger.info(
              `The majority of guards responded the sync request of event [${candidate.eventId}] with transaction [${candidate.txId}]`,
            );
            await this.setTxAsApproved(this.copyPayment(json), actualTxId);
          } else {
            logger.debug(
              `event [${candidate.eventId}] sync status is: [${JSON.stringify(
                activeSync.responses.map((_) => _?.txId),
              )}]`,
            );
          }
        }
        release();
      } catch (e) {
        release();
        throw e;
      }
    });
  };

  /**
   * verifies the transaction sent by other guards for synchronization
   * conditions:
   * - there is a request for this event
   * - tx type is payment
   * - PaymentTransaction object consistency is verified
   * - tx order is equal to expected event order
   * - tx is confirmed enough
   * - tx satisfies the chain conditions
   * @param tx
   * @returns true if transaction verified
   */
  protected verifySynchronizationResponse = async (
    input: PaymentTransaction,
    actualTxId: string,
  ): Promise<boolean> => {
    this.assertGuardAuthority();
    const json = input.toJson();
    const tx = this.copyPayment(json);
    const baseError = `Received tx [${tx.txId}] for syncing event [${tx.eventId}] but `;
    // verify sync request
    const activeSync = this.activeSyncMap.get(tx.eventId);
    if (!activeSync) {
      logger.info(baseError + `sync request for this event is not active`);
      return false;
    }

    // get event from database
    const eventEntity = await DatabaseAction.getInstance().getEventById(
      tx.eventId,
    );
    if (eventEntity === null) {
      throw new ImpossibleBehavior(baseError + `event is not found`);
    }
    const event = EventSerializer.fromConfirmedEntity(eventEntity);

    if (tx.network !== event.toChain) {
      logger.warn(
        baseError + 'transaction network differs from event destination',
      );
      return false;
    }

    // verify tx type
    if (tx.txType !== TransactionType.payment) {
      logger.warn(baseError + `transaction type is unexpected (${tx.txType})`);
      return false;
    }

    // verify PaymentTransaction object consistency
    const chain = ChainHandler.getInstance().getChain(tx.network);
    const consistent =
      tx.network === 'ergo'
        ? await (chain as ErgoChain).verifyPaymentTransaction(
            tx,
            SigningStatus.Signed,
          )
        : await chain.verifyPaymentTransaction(tx);
    if (!consistent) {
      logger.warn(baseError + `tx object has inconsistency`);
      return false;
    }

    // verify tx order
    const feeConfig = MinimumFeeHandler.getEventFeeConfig(event);
    const txOrder =
      tx.network === 'ergo'
        ? (chain as ErgoChain).extractTransactionOrder(tx, SigningStatus.Signed)
        : chain.extractTransactionOrder(tx);
    const eventWIDs =
      tx.network === 'ergo' ? await EventBoxes.getEventWIDs(event) : [];
    const expectedOrder = await EventOrder.createEventPaymentOrder(
      event,
      eventEntity.eventData.txId,
      feeConfig,
      eventWIDs,
    );
    if (!isEqual(txOrder, expectedOrder)) {
      logger.warn(baseError + `tx extracted order is not verified`);
      return false;
    }

    // check if tx is confirmed enough
    let settlementId: string;
    try {
      settlementId = this.bindActualTransactionId(tx, actualTxId);
    } catch {
      logger.warn(baseError + 'signed transaction identity is not verified');
      return false;
    }
    const txConfirmation = await chain.getTxConfirmationStatus(
      settlementId,
      tx.txType,
    );
    if (txConfirmation !== ConfirmationStatus.ConfirmedEnough) {
      logger.warn(baseError + `tx is not confirmed enough`);
      return false;
    }

    // check chain-specific conditions
    if (!chain.verifyTransactionExtraConditions(tx, SigningStatus.Signed)) {
      logger.warn(baseError + `extra conditions are not verified`);
      return false;
    }

    this.assertGuardAuthority();
    return tx.toJson() === json;
  };

  /**
   * inserts the transaction as completed into db and updates the event
   * @param tx
   */
  protected setTxAsApproved = async (
    input: PaymentTransaction,
    actualTxId: string,
  ): Promise<void> => {
    const json = input.toJson();
    this.assertGuardAuthority();
    const tx = this.copyPayment(json);
    const active = this.activeSyncMap.get(tx.eventId);
    if (!active) throw new Error('Synchronization is no longer active');
    const dbAction = DatabaseAction.getInstance();
    const event = await dbAction.getEventById(tx.eventId);
    try {
      if (event === null) {
        throw new ImpossibleBehavior(
          `Tx [${tx.txId}] is approved as event [${tx.eventId}] payment but event is not found`,
        );
      }
      const expectedEvent = structuredClone(event);
      const requiredSign = this.requiredApproval + 1;

      this.assertGuardAuthority();

      // A quorum may have waited behind another approval.
      // Repeat verification before admitting the current payment.
      if (
        this.activeSyncMap.get(tx.eventId) !== active ||
        !(await this.verifySynchronizationResponse(tx, actualTxId))
      )
        throw new Error('Synchronization payment is no longer verified');

      const currentHeight = await ChainHandler.getInstance()
        .getChain(tx.network)
        .getHeight();

      this.assertGuardAuthority();

      if (
        tx.toJson() !== json ||
        this.activeSyncMap.get(tx.eventId) !== active ||
        !Number.isSafeInteger(currentHeight) ||
        currentHeight < 0
      )
        throw new Error('Synchronization context or height changed');

      if (
        !(await dbAction.insertSynchronizedPaymentIfUnchanged(
          tx,
          expectedEvent,
          requiredSign,
          currentHeight,
          this.assertGuardAuthority,
        ))
      )
        throw new Error('Synchronization persistence conflict');

      this.activeSyncMap.delete(tx.eventId);
    } catch (e) {
      logger.warn(
        `An error occurred while finalizing event [${tx.eventId}] synchronization: ${e}`,
      );
      logger.warn(e.stack);
    }
  };

  /**
   * deletes active event syncs that are timed out
   */
  timeoutActiveSyncs = async (): Promise<void> => {
    await this.approvalSemaphore.acquire().then(async (release) => {
      logger.info(`Clearing active event synchronizations`);
      try {
        for (const [eventId, activeSync] of this.activeSyncMap) {
          if (
            Math.floor(Date.now() / 1000) - activeSync.timestamp >=
            Configs.eventSyncTimeout
          ) {
            logger.info(`event [${eventId}] synchronization is timed out`);
            this.activeSyncMap.delete(eventId);
          }
        }
        release();
      } catch (e) {
        release();
        throw e;
      }
    });
  };
}

export default EventSynchronization;
