import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import {
  And,
  DataSource,
  In,
  IsNull,
  LessThan,
  MoreThan,
  MoreThanOrEqual,
  Not,
  Repository,
  UpdateResult,
} from '@rosen-bridge/extended-typeorm';
import { LastSavedBlock } from '@rosen-bridge/scanner-sync-check';
import { Semaphore } from '@rosen-bridge/semaphore';
import {
  CommitmentEntity,
  EventTriggerEntity,
} from '@rosen-bridge/watcher-data-extractor';
import {
  ImpossibleBehavior,
  NotFoundError,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import PublicStatusHandler from '../handlers/publicStatusHandler';
import { ReprocessStatus } from '../reprocess/interfaces';
import type {
  SigningRowPreimage,
  SigningPersistenceAuthorization,
} from '../signing/transactionSigningContext';
import { AddressType, Page, SortRequest } from '../types/api';
import { SupportedChain } from '../types/config';
import {
  EventStatus,
  OrderStatus,
  RevenuePeriod,
  TransactionStatus,
} from '../utils/constants';
import Utils from '../utils/utils';
import { AddressEntity } from './entities/addressEntity';
import { ArbitraryEntity } from './entities/arbitraryEntity';
import { ChainAddressBalanceEntity } from './entities/chainAddressBalanceEntity';
import { ConfirmedEventEntity } from './entities/confirmedEventEntity';
import { EventView } from './entities/eventView';
import { RejectedEventEntity } from './entities/rejectedEventEntity';
import { ReprocessEntity } from './entities/reprocessEntity';
import { RevenueChartView } from './entities/revenueChartView';
import { RevenueEntity } from './entities/revenueEntity';
import { RevenueView } from './entities/revenueView';
import { TransactionEntity } from './entities/transactionEntity';

const logger = DefaultLogger.getInstance().child(import.meta.url);

export interface TransactionCheckPreimage extends SigningRowPreimage {
  readonly lastCheck: number;
  readonly lastStatusUpdate: string | null;
  readonly failedInSign: boolean;
  readonly signFailedCount: number;
}

class DatabaseAction {
  private static instance: DatabaseAction;
  dataSource: DataSource;
  BlockRepository: Repository<BlockEntity>;
  CommitmentRepository: Repository<CommitmentEntity>;
  EventRepository: Repository<EventTriggerEntity>;
  ConfirmedEventRepository: Repository<ConfirmedEventEntity>;
  RejectedEventRepository: Repository<RejectedEventEntity>;
  TransactionRepository: Repository<TransactionEntity>;
  RevenueRepository: Repository<RevenueEntity>;
  RevenueView: Repository<RevenueView>;
  RevenueChartView: Repository<RevenueChartView>;
  EventView: Repository<EventView>;
  ArbitraryRepository: Repository<ArbitraryEntity>;
  ReprocessRepository: Repository<ReprocessEntity>;
  ChainAddressBalanceRepository: Repository<ChainAddressBalanceEntity>;
  AddressRepository: Repository<AddressEntity>;

  txSignSemaphore = new Semaphore(1);

  protected constructor(dataSource: DataSource) {
    this.dataSource = dataSource;
    this.BlockRepository = this.dataSource.getRepository(BlockEntity);
    this.CommitmentRepository = this.dataSource.getRepository(CommitmentEntity);
    this.EventRepository = this.dataSource.getRepository(EventTriggerEntity);
    this.ConfirmedEventRepository =
      this.dataSource.getRepository(ConfirmedEventEntity);
    this.RejectedEventRepository =
      this.dataSource.getRepository(RejectedEventEntity);
    this.TransactionRepository =
      this.dataSource.getRepository(TransactionEntity);
    this.RevenueRepository = this.dataSource.getRepository(RevenueEntity);
    this.RevenueView = this.dataSource.getRepository(RevenueView);
    this.RevenueChartView = this.dataSource.getRepository(RevenueChartView);
    this.EventView = this.dataSource.getRepository(EventView);
    this.ArbitraryRepository = this.dataSource.getRepository(ArbitraryEntity);
    this.ReprocessRepository = this.dataSource.getRepository(ReprocessEntity);
    this.ChainAddressBalanceRepository = this.dataSource.getRepository(
      ChainAddressBalanceEntity,
    );
    this.AddressRepository = this.dataSource.getRepository(AddressEntity);
  }

  /**
   * initiates data source
   * @param dataSource
   */
  static init = (dataSource: DataSource): DatabaseAction => {
    logger.debug("DatabaseAction instance didn't exist. Creating a new one");
    DatabaseAction.instance = new DatabaseAction(dataSource);
    return DatabaseAction.instance;
  };

  /**
   * gets instance of DatabaseAction (throws error if it doesn't exist)
   * @returns DatabaseAction instance
   */
  static getInstance = (): DatabaseAction => {
    if (!DatabaseAction.instance)
      throw Error(`Database is not instantiated yet`);
    return DatabaseAction.instance;
  };

  /**
   * updates the status of an event by id
   *  NOTE: this method does NOT update firstTry column
   * @param eventId the event trigger id
   * @param status the event trigger status
   * @param incrementUnexpectedFails if true, unexpectedFails column will be incremented
   */
  setEventStatus = async (
    eventId: string,
    status: string,
    incrementUnexpectedFails = false,
  ): Promise<void> => {
    let result: UpdateResult;

    if (incrementUnexpectedFails)
      result = await this.ConfirmedEventRepository.update(
        { id: eventId },
        {
          status: status,
          unexpectedFails: () => '"unexpectedFails" + 1',
        },
      );
    else
      result = await this.ConfirmedEventRepository.update(
        { id: eventId },
        { status: status },
      );

    if ((result.affected ?? 0) === 0) return;
    PublicStatusHandler.getInstance().updatePublicEventStatus(eventId, status);
  };

  /**
   * @param eventId the event trigger id
   * @return the event trigger
   */
  getEventById = async (
    eventId: string,
  ): Promise<ConfirmedEventEntity | null> => {
    return await this.ConfirmedEventRepository.findOne({
      relations: ['eventData'],
      where: {
        id: eventId,
      },
    });
  };

  /**
   * @param statuses list of statuses
   * @return the event triggers with status
   */
  getEventsByStatuses = async (
    statuses: string[],
  ): Promise<ConfirmedEventEntity[]> => {
    return await this.ConfirmedEventRepository.find({
      relations: ['eventData'],
      where: statuses.map((eventStatus) => ({
        status: eventStatus,
      })),
    });
  };

  /**
   * @return the event triggers with waiting status
   */
  getWaitingEvents = async (): Promise<ConfirmedEventEntity[]> => {
    return await this.ConfirmedEventRepository.find({
      relations: ['eventData'],
      where: [
        {
          status: EventStatus.paymentWaiting,
        },
        {
          status: EventStatus.rewardWaiting,
        },
      ],
    });
  };

  /**
   * @return incomplete the transaction
   */
  getActiveTransactions = async (): Promise<TransactionEntity[]> => {
    return await this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: {
        status: In([
          TransactionStatus.sent,
          TransactionStatus.signed,
          TransactionStatus.approved,
          TransactionStatus.signFailed,
          TransactionStatus.inSign,
        ]),
      },
    });
  };

  /**
   * updates the status of a tx with its id
   * @param txId the transaction id
   * @param status tx status
   */
  setTxStatus = async (txId: string, status: string): Promise<void> => {
    const result: UpdateResult = await this.TransactionRepository.update(
      { txId: txId },
      {
        status: status,
        lastStatusUpdate: String(Math.round(Date.now() / 1000)),
      },
    );
    if ((result.affected ?? 0) === 0) return;
    PublicStatusHandler.getInstance().updatePublicTxStatus(txId, status);
  };

  /**
   * updates tx info when failed in sign process
   * @param txId the transaction id
   */
  setTxAsSignFailed = async (txId: string): Promise<void> => {
    const result: UpdateResult = await this.TransactionRepository.update(
      {
        txId: txId,
        status: TransactionStatus.inSign,
      },
      {
        status: TransactionStatus.signFailed,
        lastStatusUpdate: String(Math.round(Date.now() / 1000)),
        signFailedCount: () => '"signFailedCount" + 1',
        failedInSign: true,
      },
    );
    if ((result.affected ?? 0) === 0) return;
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      txId,
      TransactionStatus.signFailed,
    );
  };

  /**
   * updates the status of a tx with its id
   * @param txId the transaction id
   * @param currentHeight current height of the blockchain
   */
  updateTxLastCheck = async (
    txId: string,
    currentHeight: number,
  ): Promise<void> => {
    await this.TransactionRepository.update(
      { txId: txId },
      { lastCheck: currentHeight },
    );
  };

  /** Capture before RPC waits; the returned primitive fields cannot follow caller mutation. */
  captureTxCheckPreimage = (
    row: TransactionEntity,
  ): TransactionCheckPreimage => {
    const expected = Object.freeze({
      txId: row.txId,
      txJson: row.txJson,
      chain: row.chain,
      type: row.type,
      status: row.status,
      requiredSign: row.requiredSign,
      eventId: row.event?.id ?? null,
      orderId: row.order?.id ?? null,
      lastCheck: row.lastCheck,
      lastStatusUpdate: row.lastStatusUpdate,
      failedInSign: row.failedInSign,
      signFailedCount: row.signFailedCount,
    });
    this.txCheckPredicate(expected);
    return expected;
  };

  /** Builds the exact transaction preimage predicate for a last-check update. */
  private txCheckPredicate = (expected: TransactionCheckPreimage) => {
    const base = this.signingRowPredicate(expected);
    if (
      ![TransactionStatus.sent, TransactionStatus.signFailed].includes(
        expected.status,
      ) ||
      !Number.isSafeInteger(expected.lastCheck) ||
      expected.lastCheck < 0 ||
      (expected.lastStatusUpdate !== null &&
        typeof expected.lastStatusUpdate !== 'string') ||
      typeof expected.failedInSign !== 'boolean' ||
      !Number.isSafeInteger(expected.signFailedCount) ||
      expected.signFailedCount < 0
    )
      throw new Error('Invalid transaction last-check preimage');
    return {
      ...base,
      lastCheck: expected.lastCheck,
      lastStatusUpdate:
        expected.lastStatusUpdate === null
          ? IsNull()
          : expected.lastStatusUpdate,
      failedInSign: expected.failedInSign,
      signFailedCount: expected.signFailedCount,
    };
  };

  /** Records liveness only; this does not authorize signing or reopen an event. */
  updateTxLastCheckIfUnchanged = async (
    input: TransactionCheckPreimage,
    currentHeight: number,
  ): Promise<boolean> => {
    const expected = Object.freeze({ ...input });
    const predicate = this.txCheckPredicate(expected);
    if (
      !Number.isSafeInteger(currentHeight) ||
      currentHeight < expected.lastCheck
    )
      throw new Error('Invalid or regressing transaction check height');
    const conflict = new Error('Transaction last-check CAS conflict');
    try {
      return await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(TransactionEntity);
        if (!(await repository.existsBy(predicate))) return false;
        const result = await repository.update(predicate, {
          lastCheck: currentHeight,
        });
        if (result.affected !== 1) throw conflict;
        if (
          !(await repository.existsBy({
            ...predicate,
            lastCheck: currentHeight,
          }))
        )
          throw new Error('Transaction last-check postcondition failed');
        return true;
      });
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
  };

  /**
   * updates the status of an event and sets firstTry columns with current timestamp
   * @param eventId the event trigger id
   * @param status status of the process
   */
  setEventStatusToPending = async (
    eventId: string,
    status: string,
  ): Promise<void> => {
    const result: UpdateResult = await this.ConfirmedEventRepository.update(
      { id: eventId },
      { status: status, firstTry: String(Math.round(Date.now() / 1000)) },
    );
    if ((result.affected ?? 0) === 0) return;
    PublicStatusHandler.getInstance().updatePublicEventStatus(eventId, status);
  };

  /**
   * @param txId the transaction id
   * @return the transaction
   */
  getTxById = async (txId: string): Promise<TransactionEntity | null> => {
    return await this.TransactionRepository.findOne({
      relations: ['event', 'order'],
      where: {
        txId: txId,
      },
    });
  };

  /**
   * updates the tx and set status as signed
   * @param txId the transaction id
   * @param txJson tx json
   */
  updateWithSignedTx = async (txId: string, txJson: string): Promise<void> => {
    const result: UpdateResult = await this.TransactionRepository.update(
      { txId: txId },
      {
        txJson: txJson,
        status: TransactionStatus.signed,
        lastStatusUpdate: String(Math.round(Date.now() / 1000)),
      },
    );
    if ((result.affected ?? 0) === 0) return;
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      txId,
      TransactionStatus.signed,
    );
  };

  /** Validates every field before TypeORM can omit an undefined predicate. */
  private signingRowPredicate = (expected: SigningRowPreimage) => {
    const {
      txId,
      txJson,
      chain,
      type,
      status,
      requiredSign,
      eventId,
      orderId,
    } = expected;
    if (
      [txId, txJson, chain, type].some(
        (value) => typeof value !== 'string' || value.length === 0,
      ) ||
      !Object.values(TransactionStatus).includes(status) ||
      !Number.isSafeInteger(requiredSign) ||
      requiredSign < 1 ||
      [eventId, orderId].some(
        (id) => id !== null && (typeof id !== 'string' || id.length === 0),
      )
    )
      throw new Error('Invalid signed transaction preimage');

    return {
      txId,
      txJson,
      chain,
      type,
      status,
      requiredSign,
      event: eventId === null ? IsNull() : { id: eventId },
      order: orderId === null ? IsNull() : { id: orderId },
    };
  };

  /** Changes status only while every captured transaction field still matches. */
  setTxStatusIfUnchanged = async (
    expected: SigningRowPreimage,
    status: string,
    authorization?: SigningPersistenceAuthorization,
  ): Promise<boolean> => {
    const predicate = this.signingRowPredicate(expected);
    if (
      !Object.values(TransactionStatus).includes(status) ||
      (status === TransactionStatus.signFailed &&
        predicate.status !== TransactionStatus.inSign)
    )
      throw new Error('Invalid transaction status transition');
    const changes = {
      status,
      lastStatusUpdate: String(Math.round(Date.now() / 1000)),
      ...(status === TransactionStatus.signFailed
        ? {
            signFailedCount: () => '"signFailedCount" + 1',
            failedInSign: true,
          }
        : {}),
    };
    const result = authorization
      ? await this.persistSigningTransition(expected, changes, authorization)
      : await this.TransactionRepository.update(predicate, changes);
    if (result.affected !== 1) return false;
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      predicate.txId,
      status,
    );
    return true;
  };

  /** Persists a qualified result only while its exact signing row still exists. */
  updateWithSignedTxIfUnchanged = async (
    expected: SigningRowPreimage,
    signedJson: string,
    authorization?: SigningPersistenceAuthorization,
  ): Promise<boolean> => {
    const predicate = this.signingRowPredicate(expected);
    if (
      predicate.status !== TransactionStatus.inSign ||
      typeof signedJson !== 'string' ||
      signedJson.length === 0
    )
      throw new Error('Invalid signed transaction preimage');
    const changes = {
      txJson: signedJson,
      status: TransactionStatus.signed,
      lastStatusUpdate: String(Math.round(Date.now() / 1000)),
    };
    const result = authorization
      ? await this.persistSigningTransition(expected, changes, authorization)
      : await this.TransactionRepository.update(predicate, changes);
    if (result.affected !== 1) return false;
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      predicate.txId,
      TransactionStatus.signed,
    );
    return true;
  };

  /** Reconciles actual signed reward bytes; the internal caller supplies spent authority. */
  recoverSignedRewardIfUnchanged = async (
    input: SigningRowPreimage,
    signedJson: string,
    authorization: SigningPersistenceAuthorization,
  ): Promise<boolean> => {
    const expected = Object.freeze({ ...input });
    this.signingRowPredicate(expected);
    if (
      expected.status !== TransactionStatus.signFailed ||
      expected.type !== TransactionType.reward ||
      expected.chain !== 'ergo' ||
      expected.eventId === null ||
      expected.orderId !== null ||
      typeof signedJson !== 'string' ||
      !signedJson ||
      !authorization ||
      typeof authorization.assertActive !== 'function' ||
      typeof authorization.assertBefore !== 'function' ||
      typeof authorization.assertAfter !== 'function'
    )
      throw new Error('Invalid reward recovery preimage or authority');
    const result = await this.persistSigningTransition(
      expected,
      {
        txJson: signedJson,
        status: TransactionStatus.sent,
        lastStatusUpdate: String(Math.round(Date.now() / 1000)),
      },
      authorization,
    );
    if (result.affected !== 1) return false;
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      expected.txId,
      TransactionStatus.sent,
    );
    return true;
  };

  /**
   * Persists a qualified observed payment without reopening its event. The caller
   * supplies execution authority; this method only enforces the atomic preimage.
   */
  recoverSignedPaymentIfUnchanged = async (
    input: TransactionCheckPreimage,
    signedJson: string,
    authorization: SigningPersistenceAuthorization,
  ): Promise<boolean> => {
    const expected = Object.freeze({ ...input });
    const predicate = this.txCheckPredicate(expected);
    if (
      expected.status !== TransactionStatus.signFailed ||
      expected.type !== TransactionType.payment ||
      !['ergo', 'avalanche'].includes(expected.chain) ||
      expected.eventId === null ||
      expected.orderId !== null ||
      typeof signedJson !== 'string' ||
      !authorization ||
      typeof authorization.assertActive !== 'function' ||
      typeof authorization.assertBefore !== 'function' ||
      typeof authorization.assertAfter !== 'function'
    )
      throw new Error('Invalid payment recovery preimage or authority');
    // Structural identity only; canonical signed semantics belong to the caller.
    const model = JSON.parse(signedJson);
    if (
      !model ||
      typeof model !== 'object' ||
      Array.isArray(model) ||
      model.network !== expected.chain ||
      model.txId !== expected.txId ||
      model.eventId !== expected.eventId ||
      model.txType !== expected.type ||
      typeof model.txBytes !== 'string' ||
      !/^(?:[0-9a-f]{2})+$/.test(model.txBytes)
    )
      throw new Error('Invalid payment recovery signed model');
    const assertActive = authorization.assertActive.bind(authorization);
    const assertBefore = authorization.assertBefore.bind(authorization);
    const assertAfter = authorization.assertAfter.bind(authorization);
    const conflict = new Error('Payment recovery CAS conflict');
    let recovered: boolean;
    try {
      recovered = await this.dataSource.transaction(async (manager) => {
        assertActive();
        const repository = manager.getRepository(TransactionEntity);
        if (!(await repository.existsBy(predicate))) return false;
        const events = manager.getRepository(ConfirmedEventEntity);
        const event = await events.findOne({
          where: { id: expected.eventId! },
          relations: ['eventData'],
        });
        if (
          !event ||
          event.status !== EventStatus.inPayment ||
          !event.eventData
        )
          throw new Error('Invalid payment recovery event');
        const eventSnapshot = JSON.stringify(event);
        await assertBefore(manager, expected);
        assertActive();
        const after = Object.freeze({
          ...expected,
          txJson: signedJson,
          status: TransactionStatus.sent,
          lastStatusUpdate: String(Math.round(Date.now() / 1000)),
        });
        const result = await repository.update(predicate, {
          txJson: after.txJson,
          status: after.status,
          lastStatusUpdate: after.lastStatusUpdate,
        });
        if (result.affected !== 1) throw conflict;
        await assertAfter(manager, after);
        if (!(await repository.existsBy(this.txCheckPredicate(after))))
          throw new Error('Payment recovery row postcondition failed');
        const currentEvent = await events.findOne({
          where: { id: expected.eventId! },
          relations: ['eventData'],
        });
        if (JSON.stringify(currentEvent) !== eventSnapshot)
          throw new Error('Payment recovery event postcondition failed');
        assertActive();
        return true;
      });
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
    if (recovered)
      PublicStatusHandler.getInstance().updatePublicTxStatus(
        expected.txId,
        TransactionStatus.sent,
      );
    return recovered;
  };

  /** Restores exact signed native management bytes after qualified observed execution. */
  recoverSignedManagementIfUnchanged = async (
    input: TransactionCheckPreimage,
    signedJson: string,
    authorization: SigningPersistenceAuthorization,
  ): Promise<boolean> => {
    const expected = Object.freeze({ ...input });
    const predicate = this.txCheckPredicate(expected);
    const arbitrary = expected.type === TransactionType.arbitrary;
    if (
      expected.chain !== 'avalanche' ||
      expected.status !== TransactionStatus.signFailed ||
      ![
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].includes(expected.type as TransactionType) ||
      expected.eventId !== null ||
      (arbitrary ? !expected.orderId : expected.orderId !== null) ||
      typeof signedJson !== 'string' ||
      !authorization ||
      typeof authorization.assertActive !== 'function' ||
      typeof authorization.assertBefore !== 'function' ||
      typeof authorization.assertAfter !== 'function'
    )
      throw new Error(
        'Invalid native management recovery preimage or authority',
      );
    const model = JSON.parse(signedJson);
    if (
      !model ||
      typeof model !== 'object' ||
      Array.isArray(model) ||
      model.network !== expected.chain ||
      model.txId !== expected.txId ||
      model.txType !== expected.type ||
      model.eventId !== (arbitrary ? expected.orderId : '') ||
      typeof model.txBytes !== 'string' ||
      !/^(?:[0-9a-f]{2})+$/.test(model.txBytes)
    )
      throw new Error('Invalid native management recovery signed model');
    const assertActive = authorization.assertActive.bind(authorization);
    const assertBefore = authorization.assertBefore.bind(authorization);
    const assertAfter = authorization.assertAfter.bind(authorization);
    const conflict = new Error('Native management recovery CAS conflict');
    let recovered: boolean;
    try {
      recovered = await this.dataSource.transaction(async (manager) => {
        assertActive();
        const repository = manager.getRepository(TransactionEntity);
        if (!(await repository.existsBy(predicate))) return false;
        const orders = manager.getRepository(ArbitraryEntity);
        const order = arbitrary
          ? await orders.findOneBy({ id: expected.orderId! })
          : null;
        if (
          arbitrary &&
          (!order ||
            order.chain !== expected.chain ||
            order.status !== OrderStatus.inProcess)
        )
          throw new Error('Invalid native management recovery order');
        const orderSnapshot = JSON.stringify(order);
        await assertBefore(manager, expected);
        assertActive();
        const after = Object.freeze({
          ...expected,
          txJson: signedJson,
          status: TransactionStatus.sent,
          lastStatusUpdate: String(Math.round(Date.now() / 1000)),
        });
        const result = await repository.update(predicate, {
          txJson: after.txJson,
          status: after.status,
          lastStatusUpdate: after.lastStatusUpdate,
        });
        if (result.affected !== 1) throw conflict;
        await assertAfter(manager, after);
        if (!(await repository.existsBy(this.txCheckPredicate(after))))
          throw new Error(
            'Native management recovery row postcondition failed',
          );
        if (
          arbitrary &&
          JSON.stringify(await orders.findOneBy({ id: expected.orderId! })) !==
            orderSnapshot
        )
          throw new Error(
            'Native management recovery order postcondition failed',
          );
        assertActive();
        return true;
      });
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
    if (recovered)
      PublicStatusHandler.getInstance().updatePublicTxStatus(
        expected.txId,
        TransactionStatus.sent,
      );
    return recovered;
  };

  /** Internal qualified callers supply checks that use only this owned manager. */
  private persistSigningTransition = async (
    input: SigningRowPreimage,
    changes: QueryDeepPartialEntity<TransactionEntity>,
    authorization: SigningPersistenceAuthorization,
  ): Promise<UpdateResult> => {
    const expected = Object.freeze({ ...input });
    const predicate = this.signingRowPredicate(expected);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(TransactionEntity);
      authorization.assertActive();
      const before = await repository.findOne({ where: predicate });
      if (!before) return { affected: 0, raw: [], generatedMaps: [] };
      await authorization.assertBefore(manager, expected);
      authorization.assertActive();
      const result = await repository.update(predicate, changes);
      if (result.affected !== 1)
        throw new Error('Signing persistence update conflict');
      const after = Object.freeze({
        ...expected,
        status: changes.status as string,
        txJson:
          typeof changes.txJson === 'string' ? changes.txJson : expected.txJson,
      });
      await authorization.assertAfter(manager, after);
      const current = await repository.findOne({
        where: this.signingRowPredicate(after),
      });
      const failed = after.status === TransactionStatus.signFailed;
      if (
        !current ||
        current.lastCheck !== before.lastCheck ||
        current.lastStatusUpdate !== changes.lastStatusUpdate ||
        current.failedInSign !== (failed ? true : before.failedInSign) ||
        current.signFailedCount !== before.signFailedCount + (failed ? 1 : 0)
      )
        throw new Error('Signing persistence postcondition failed');
      // No await between the last ownership check and returning to commit.
      authorization.assertActive();
      return result;
    });
  };

  /** Completes the captured sent row and its related process in one commit. */
  finalizeTxIfUnchanged = async (
    expected: SigningRowPreimage,
    authorization?: SigningPersistenceAuthorization,
  ): Promise<boolean> => {
    const predicate = this.signingRowPredicate(expected);
    const { eventId, orderId } = expected;
    const isEvent = [TransactionType.payment, TransactionType.reward].includes(
      predicate.type as TransactionType,
    );
    const isOrder = predicate.type === TransactionType.arbitrary;
    const isManagement = [
      TransactionType.coldStorage,
      TransactionType.manual,
    ].includes(predicate.type as TransactionType);
    if (
      predicate.status !== TransactionStatus.sent ||
      (isEvent && (eventId === null || orderId !== null)) ||
      (isOrder && (orderId === null || eventId !== null)) ||
      (isManagement && (eventId !== null || orderId !== null)) ||
      (!isEvent && !isOrder && !isManagement)
    )
      throw new Error('Invalid transaction finalization preimage');
    const eventPhase =
      predicate.type === TransactionType.reward
        ? EventStatus.inReward
        : EventStatus.inPayment;
    const eventStatus =
      predicate.type === TransactionType.payment && predicate.chain !== 'ergo'
        ? EventStatus.pendingReward
        : EventStatus.completed;
    const now = String(Math.round(Date.now() / 1000));
    const conflict = new Error('Transaction finalization CAS conflict');
    try {
      await this.dataSource.transaction(async (manager) => {
        authorization?.assertActive();
        const transactions = manager.getRepository(TransactionEntity);
        const before = authorization
          ? await transactions.findOne({ where: predicate })
          : undefined;
        if (authorization && !before) throw conflict;
        if (authorization) await authorization.assertBefore(manager, expected);
        // Resolve the required association before changing either row.
        const events = manager.getRepository(ConfirmedEventEntity);
        const orders = manager.getRepository(ArbitraryEntity);
        if (
          isEvent &&
          !(await events.findOneBy({ id: eventId!, status: eventPhase }))
        )
          throw conflict;
        if (
          isOrder &&
          !(await orders.findOneBy({
            id: orderId!,
            status: OrderStatus.inProcess,
          }))
        )
          throw conflict;
        authorization?.assertActive();
        const tx = await manager
          .getRepository(TransactionEntity)
          .update(predicate, {
            status: TransactionStatus.completed,
            lastStatusUpdate: now,
          });
        if (tx.affected !== 1) throw conflict;
        if (isEvent) {
          const event = await events.update(
            { id: eventId!, status: eventPhase },
            {
              status: eventStatus,
              ...(eventStatus === EventStatus.pendingReward
                ? { firstTry: now }
                : {}),
            },
          );
          if (event.affected !== 1) throw conflict;
        } else if (isOrder) {
          const order = await orders.update(
            { id: orderId!, status: OrderStatus.inProcess },
            {
              status: OrderStatus.completed,
            },
          );
          if (order.affected !== 1) throw conflict;
        }
        if (authorization) {
          const after = Object.freeze({
            ...expected,
            status: TransactionStatus.completed,
          });
          await authorization.assertAfter(manager, after);
          const current = await transactions.findOne({
            where: this.signingRowPredicate(after),
          });
          if (
            !current ||
            current.lastStatusUpdate !== now ||
            current.lastCheck !== before!.lastCheck ||
            current.failedInSign !== before!.failedInSign ||
            current.signFailedCount !== before!.signFailedCount
          )
            throw new Error('Completion persistence postcondition failed');
          authorization.assertActive();
        }
      });
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      predicate.txId,
      TransactionStatus.completed,
    );
    if (isEvent)
      PublicStatusHandler.getInstance().updatePublicEventStatus(
        eventId!,
        eventStatus,
      );
    return true;
  };

  /** Invalidates an unchanged checked row and reopens its process atomically. */
  invalidateTxIfUnchanged = async (
    expected: SigningRowPreimage | TransactionCheckPreimage,
    lastCheck: number,
    unexpected: boolean,
    authorization?: SigningPersistenceAuthorization,
  ): Promise<boolean> => {
    expected = Object.freeze({ ...expected });
    const predicate = {
      ...('lastCheck' in expected
        ? this.txCheckPredicate(expected)
        : this.signingRowPredicate(expected)),
      lastCheck,
    };
    if ('lastCheck' in expected && expected.lastCheck !== lastCheck)
      throw new Error('Invalid invalidation check height');
    const { eventId, orderId } = expected;
    const isEvent = [TransactionType.payment, TransactionType.reward].includes(
      predicate.type as TransactionType,
    );
    const isOrder = predicate.type === TransactionType.arbitrary;
    const isManagement = [
      TransactionType.coldStorage,
      TransactionType.manual,
    ].includes(predicate.type as TransactionType);
    if (
      ![TransactionStatus.sent, TransactionStatus.signFailed].includes(
        predicate.status,
      ) ||
      !Number.isSafeInteger(lastCheck) ||
      lastCheck < 0 ||
      typeof unexpected !== 'boolean' ||
      (isEvent && (eventId === null || orderId !== null)) ||
      (isOrder && (orderId === null || eventId !== null)) ||
      (isManagement && (eventId !== null || orderId !== null)) ||
      (!isEvent && !isOrder && !isManagement)
    )
      throw new Error('Invalid transaction invalidation preimage');
    const isReward = predicate.type === TransactionType.reward;
    const eventPhase = isReward ? EventStatus.inReward : EventStatus.inPayment;
    const eventStatus = isReward
      ? EventStatus.pendingReward
      : EventStatus.pendingPayment;
    const now = String(Math.round(Date.now() / 1000));
    const conflict = new Error('Transaction invalidation CAS conflict');
    try {
      await this.dataSource.transaction(async (manager) => {
        authorization?.assertActive();
        const transactions = manager.getRepository(TransactionEntity);
        const before = authorization
          ? await transactions.findOne({ where: predicate })
          : undefined;
        if (authorization && !before) throw conflict;
        if (authorization) await authorization.assertBefore(manager, expected);
        const events = manager.getRepository(ConfirmedEventEntity);
        const orders = manager.getRepository(ArbitraryEntity);
        const eventBefore = isEvent
          ? await events.findOneBy({ id: eventId!, status: eventPhase })
          : undefined;
        if (isEvent && !eventBefore) throw conflict;
        if (
          isOrder &&
          !(await orders.findOneBy({
            id: orderId!,
            status: OrderStatus.inProcess,
          }))
        )
          throw conflict;
        authorization?.assertActive();
        const tx = await manager
          .getRepository(TransactionEntity)
          .update(predicate, {
            status: TransactionStatus.invalid,
            lastStatusUpdate: now,
          });
        if (tx.affected !== 1) throw conflict;
        const increment = unexpected
          ? { unexpectedFails: () => '"unexpectedFails" + 1' }
          : {};
        if (isEvent) {
          const event = await events.update(
            { id: eventId!, status: eventPhase },
            { status: eventStatus, ...increment },
          );
          if (event.affected !== 1) throw conflict;
        } else if (isOrder) {
          const order = await orders.update(
            { id: orderId!, status: OrderStatus.inProcess },
            { status: OrderStatus.pending, ...increment },
          );
          if (order.affected !== 1) throw conflict;
        }
        if (authorization) {
          const after = Object.freeze({
            ...expected,
            status: TransactionStatus.invalid,
          });
          await authorization.assertAfter(manager, after, { unexpected });
          const current = await transactions.findOne({
            where: { ...this.signingRowPredicate(after), lastCheck },
          });
          const eventAfter = isEvent
            ? await events.findOneBy({ id: eventId! })
            : undefined;
          if (
            !current ||
            current.lastStatusUpdate !== now ||
            current.failedInSign !== before!.failedInSign ||
            current.signFailedCount !== before!.signFailedCount ||
            (isEvent &&
              (!eventAfter ||
                JSON.stringify({
                  ...eventAfter,
                  status: eventBefore!.status,
                  unexpectedFails:
                    eventAfter.unexpectedFails - (unexpected ? 1 : 0),
                }) !== JSON.stringify(eventBefore)))
          )
            throw new Error('Transaction invalidation postcondition failed');
          if (isEvent && eventAfter!.status !== eventStatus)
            throw new Error('Transaction invalidation event phase changed');
          authorization.assertActive();
        }
      });
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      predicate.txId,
      TransactionStatus.invalid,
    );
    if (isEvent)
      PublicStatusHandler.getInstance().updatePublicEventStatus(
        eventId!,
        eventStatus,
      );
    return true;
  };

  /**
   * returns all valid transaction for corresponding event
   * @param eventId the event trigger id
   * @param type the transaction type
   */
  getEventValidTxsByType = async (
    eventId: string,
    type: string,
  ): Promise<TransactionEntity[]> => {
    const event = await this.getEventById(eventId);
    if (event === null) throw Error(`Event [${eventId}] not found`);
    return await this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: {
        event: { id: event.id },
        type: type,
        status: Not(TransactionStatus.invalid),
      },
    });
  };

  /**
   * replaces a transaction with a new one
   * @param previousTxId the previous transaction id
   * @param tx the new transaction
   * @param currentHeight current height of the blockchain
   */
  replaceTx = async (
    previousTxId: string,
    tx: PaymentTransaction,
    currentHeight: number,
  ): Promise<void> => {
    const result: UpdateResult = await this.TransactionRepository.update(
      { txId: previousTxId },
      {
        txId: tx.txId,
        txJson: tx.toJson(),
        type: tx.txType,
        chain: tx.network,
        status: TransactionStatus.approved,
        lastStatusUpdate: String(Math.round(Date.now() / 1000)),
        lastCheck: currentHeight,
        failedInSign: false,
      },
    );
    if ((result.affected ?? 0) === 0) return;
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      tx.txId,
      TransactionStatus.approved,
    );
  };

  /**
   * updates failedInSign field of a transaction to false
   * @param txId
   */
  resetFailedInSign = async (txId: string): Promise<void> => {
    await this.TransactionRepository.update(
      { txId: txId },
      {
        failedInSign: false,
      },
    );
  };

  /**
   * updates requiredSign field of a transaction
   * @param txId
   * @param requiredSign
   */
  updateRequiredSign = async (
    txId: string,
    requiredSign: number,
  ): Promise<void> => {
    await this.TransactionRepository.update(
      { txId: txId },
      {
        requiredSign: requiredSign,
      },
    );
  };

  /**
   * inserts a tx record into transactions table
   * @param currentHeight current height of the blockchain
   */
  insertNewTx = async (
    paymentTx: PaymentTransaction,
    event: ConfirmedEventEntity | null,
    requiredSign: number,
    order: ArbitraryEntity | null,
    currentHeight: number,
  ): Promise<void> => {
    await this.TransactionRepository.insert({
      txId: paymentTx.txId,
      txJson: paymentTx.toJson(),
      type: paymentTx.txType,
      chain: paymentTx.network,
      status: TransactionStatus.approved,
      lastStatusUpdate: String(Math.round(Date.now() / 1000)),
      lastCheck: currentHeight,
      event: event !== null ? event : undefined,
      order: order !== null ? order : undefined,
      failedInSign: false,
      signFailedCount: 0,
      requiredSign: requiredSign,
    });
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      paymentTx.txId,
      TransactionStatus.approved,
    );
  };

  /** Stores a synchronized payment only against its exact pending event. */
  insertSynchronizedPaymentIfUnchanged = async (
    paymentTx: PaymentTransaction,
    expectedEvent: ConfirmedEventEntity,
    requiredSign: number,
    currentHeight: number,
    assertAuthority?: () => void,
  ): Promise<boolean> => {
    /** Recognizes nonempty textual payment fields. */
    const text = (value: unknown): value is string =>
      typeof value === 'string' && value.trim().length > 0;
    /** Recognizes nonnegative safe integer payment fields. */
    const natural = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    /** Recognizes canonical lowercase chain identifiers. */
    const chain = (value: unknown): value is string =>
      typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
    const protocolFields = [
      'height',
      'fromChain',
      'toChain',
      'fromAddress',
      'toAddress',
      'amount',
      'bridgeFee',
      'networkFee',
      'sourceChainTokenId',
      'targetChainTokenId',
      'sourceTxId',
      'sourceChainHeight',
      'sourceBlockId',
      'WIDsHash',
      'WIDsCount',
      'id',
      'txId',
      'eventId',
    ] as const;
    const event = {
      id: expectedEvent?.id,
      status: expectedEvent?.status,
      firstTry: expectedEvent?.firstTry,
      unexpectedFails: expectedEvent?.unexpectedFails,
    };
    const data = Object.fromEntries(
      protocolFields.map((field) => [field, expectedEvent?.eventData?.[field]]),
    ) as Pick<EventTriggerEntity, (typeof protocolFields)[number]>;
    const tx = {
      txId: paymentTx.txId,
      chain: paymentTx.network,
      type: paymentTx.txType,
      eventId: paymentTx.eventId,
      bytes: Buffer.from(paymentTx.txBytes).toString('hex'),
      txJson: paymentTx.toJson(),
    };
    const model: unknown = JSON.parse(tx.txJson);
    if (!model || typeof model !== 'object' || Array.isArray(model))
      throw new Error('Invalid synchronized payment model');
    const serialized = model as Record<string, unknown>;
    for (const field of ['inputBoxes', 'dataInputs'] as const) {
      const boxes = (
        paymentTx as PaymentTransaction & {
          inputBoxes?: Uint8Array[];
          dataInputs?: Uint8Array[];
        }
      )[field];
      if (tx.chain === 'ergo' || boxes !== undefined || field in serialized) {
        if (
          !Array.isArray(boxes) ||
          !boxes.every((box) => box instanceof Uint8Array) ||
          JSON.stringify(serialized[field]) !==
            JSON.stringify(boxes.map((box) => Buffer.from(box).toString('hex')))
        )
          throw new Error('Invalid synchronized payment auxiliary bytes');
      }
    }
    if (
      !text(tx.txId) ||
      !chain(tx.chain) ||
      !/^(?:[0-9a-f]{2})+$/.test(tx.bytes) ||
      tx.type !== TransactionType.payment ||
      serialized.txId !== tx.txId ||
      serialized.network !== tx.chain ||
      serialized.txType !== tx.type ||
      serialized.eventId !== tx.eventId ||
      serialized.txBytes !== tx.bytes ||
      !text(event.id) ||
      event.status !== EventStatus.pendingPayment ||
      (event.firstTry !== null && typeof event.firstTry !== 'string') ||
      !natural(event.unexpectedFails) ||
      !natural(requiredSign) ||
      requiredSign < 1 ||
      !natural(currentHeight) ||
      (assertAuthority !== undefined &&
        typeof assertAuthority !== 'function') ||
      protocolFields.some((field) =>
        ['id', 'height', 'sourceChainHeight', 'WIDsCount'].includes(field)
          ? !natural(data[field])
          : typeof data[field] !== 'string',
      ) ||
      data.id < 1 ||
      !text(data.txId) ||
      !text(data.sourceTxId) ||
      !chain(data.fromChain) ||
      !chain(data.toChain) ||
      tx.chain !== data.toChain ||
      tx.eventId !== event.id ||
      data.eventId !== event.id ||
      Utils.txIdToEventId(data.sourceTxId) !== event.id
    )
      throw new Error('Invalid synchronized payment preimage');
    const now = String(Math.round(Date.now() / 1000));
    const status =
      tx.chain === 'ergo' ? EventStatus.completed : EventStatus.pendingReward;
    const conflict = new Error('Synchronized payment CAS conflict');
    try {
      await this.dataSource.transaction(async (manager) => {
        const events = manager.getRepository(ConfirmedEventEntity);
        const transactions = manager.getRepository(TransactionEntity);
        const current = await events.findOne({
          where: { id: event.id },
          relations: ['eventData'],
        });
        if (
          !current ||
          current.status !== event.status ||
          current.firstTry !== event.firstTry ||
          current.unexpectedFails !== event.unexpectedFails ||
          !current.eventData ||
          protocolFields.some(
            (field) => current.eventData[field] !== data[field],
          ) ||
          (await transactions.existsBy({ txId: tx.txId })) ||
          (await transactions.existsBy({
            event: { id: event.id },
            type: TransactionType.payment,
            status: Not(TransactionStatus.invalid),
          }))
        )
          throw conflict;
        const inserted = {
          txId: tx.txId,
          txJson: tx.txJson,
          chain: tx.chain,
          type: tx.type,
          status: TransactionStatus.completed,
          lastStatusUpdate: now,
          lastCheck: currentHeight,
          event: { id: event.id },
          order: null,
          failedInSign: false,
          signFailedCount: 0,
          requiredSign,
        };
        // Authorize after acquiring the SQL owner, not before its wait queue.
        assertAuthority?.();
        await transactions.insert(inserted);
        // SQLite BEFORE INSERT IGNORE does not report an affected-row count.
        if (!(await transactions.existsBy({ ...inserted, order: IsNull() })))
          throw conflict;
        assertAuthority?.();
        const trigger = manager
          .getRepository(EventTriggerEntity)
          .createQueryBuilder('trigger')
          .select('1');
        for (const field of protocolFields) {
          trigger.andWhere(`trigger.${field} = :sync_${field}`, {
            [`sync_${field}`]: data[field],
          });
        }
        const changed = await events
          .createQueryBuilder()
          .update()
          .set({
            status,
            ...(status === EventStatus.pendingReward ? { firstTry: now } : {}),
          })
          .where({
            ...event,
            firstTry: event.firstTry === null ? IsNull() : event.firstTry,
            eventData: { id: data.id },
          })
          .andWhere(`EXISTS (${trigger.getQuery()})`, trigger.getParameters())
          .execute();
        if (changed.affected !== 1) throw conflict;
      });
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      tx.txId,
      TransactionStatus.completed,
    );
    PublicStatusHandler.getInstance().updatePublicEventStatus(event.id, status);
    return true;
  };

  /**
   * inserts a tx record into transactions table
   * @param currentHeight current height of the blockchain
   */
  insertCompletedTx = async (
    paymentTx: PaymentTransaction,
    event: ConfirmedEventEntity | null,
    requiredSign: number,
    order: ArbitraryEntity | null,
    currentHeight: number,
  ): Promise<void> => {
    await this.TransactionRepository.insert({
      txId: paymentTx.txId,
      txJson: paymentTx.toJson(),
      type: paymentTx.txType,
      chain: paymentTx.network,
      status: TransactionStatus.completed,
      lastStatusUpdate: String(Math.round(Date.now() / 1000)),
      lastCheck: currentHeight,
      event: event !== null ? event : undefined,
      order: order !== null ? order : undefined,
      failedInSign: false,
      signFailedCount: 0,
      requiredSign: requiredSign,
    });
    PublicStatusHandler.getInstance().updatePublicTxStatus(
      paymentTx.txId,
      TransactionStatus.completed,
    );
  };

  /**
   * @param eventId the event trigger id
   * @param eventBoxHeight the event trigger box mined height
   * @return commitments that created before event trigger and didn't spent yet
   */
  getValidCommitments = async (
    eventId: string,
    eventBoxHeight: number,
  ): Promise<CommitmentEntity[]> => {
    return await this.CommitmentRepository.find({
      where: {
        eventId: eventId,
        height: LessThan(eventBoxHeight),
        spendBlock: IsNull(),
      },
    });
  };

  /**
   * @return all event triggers with no spent height
   */
  getUnconfirmedEvents = async (): Promise<EventTriggerEntity[]> => {
    return await this.EventRepository.createQueryBuilder('event')
      .leftJoin('confirmed_event_entity', 'cee', 'event.id = cee.eventDataId')
      .leftJoin('rejected_event_entity', 'ree', 'event.id = ree.eventDataId')
      .where('cee.eventDataId IS NULL')
      .andWhere('ree.eventDataId IS NULL')
      .getMany();
  };

  /**
   * inserts a confirmed event into table
   * @param eventData
   */
  insertConfirmedEvent = async (
    eventData: EventTriggerEntity,
  ): Promise<void> => {
    const eventId = Utils.txIdToEventId(eventData.sourceTxId);
    const status = EventStatus.pendingPayment;

    await this.ConfirmedEventRepository.insert({
      id: eventId,
      eventData: eventData,
      status,
      firstTry: String(Math.round(Date.now() / 1000)),
    });

    PublicStatusHandler.getInstance().updatePublicEventStatus(eventId, status);
  };

  /**
   * inserts a rejected event into table
   * @param eventData
   * @param reason
   */
  insertRejectedEvent = async (
    eventData: EventTriggerEntity,
    reason: string,
  ): Promise<void> => {
    const eventId = Utils.txIdToEventId(eventData.sourceTxId);

    await this.RejectedEventRepository.insert({
      id: eventId,
      eventData: eventData,
      reason,
    });

    PublicStatusHandler.getInstance().updatePublicEventStatus(
      eventId,
      EventStatus.rejected,
    );
  };

  /**
   * returns all transaction for cold storage
   * @param chain the chain of the tx
   */
  getActiveColdStorageTxsInChain = async (
    chain: string,
  ): Promise<TransactionEntity[]> => {
    return await this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: {
        type: TransactionType.coldStorage,
        status: Not(
          In([TransactionStatus.invalid, TransactionStatus.completed]),
        ),
        chain: chain,
      },
    });
  };

  /**
   * returns all unsigned transactions for a chain (with status approved, in-sign or sign-failed)
   * @param chain the chain of the tx
   */
  getUnsignedActiveTxsInChain = async (
    chain: string,
  ): Promise<TransactionEntity[]> => {
    return await this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: [
        {
          status: TransactionStatus.approved,
          chain: chain,
        },
        {
          status: TransactionStatus.inSign,
          chain: chain,
        },
        {
          status: TransactionStatus.signFailed,
          chain: chain,
        },
      ],
    });
  };

  /**
   * returns all signed transactions for a chain (with status signed or sent)
   * @param chain the chain of the tx
   */
  getSignedActiveTxsInChain = async (
    chain: string,
  ): Promise<TransactionEntity[]> => {
    return await this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: [
        {
          status: TransactionStatus.signed,
          chain: chain,
        },
        {
          status: TransactionStatus.sent,
          chain: chain,
        },
      ],
    });
  };

  /**
   * returns the payment transaction for an event
   * @param eventId
   */
  getEventPaymentTransaction = async (
    eventId: string,
  ): Promise<TransactionEntity> => {
    const event = await this.getEventById(eventId);
    if (event === null) throw new Error(`Event [${eventId}] not found`);
    const txs = await this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: [
        {
          event: { id: event.id },
          status: TransactionStatus.completed,
          type: TransactionType.payment,
        },
      ],
    });
    if (txs.length === 0)
      throw new Error(`No payment tx found for event [${eventId}]`);
    else if (txs.length > 1)
      throw new ImpossibleBehavior(
        `Found more than one completed payment transaction for event [${eventId}]`,
      );
    else return txs[0];
  };

  /**
   * returns all unsigned transactions which failed in sign process
   */
  getUnsignedFailedSignTxs = async (): Promise<TransactionEntity[]> => {
    return await this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: [
        {
          status: TransactionStatus.signFailed,
          failedInSign: true,
        },
        {
          status: TransactionStatus.inSign,
          failedInSign: true,
        },
      ],
    });
  };

  /**
   * selects events with the specified condition
   * @param history if true, returns history events, otherwise returns ongoing events
   * @param sort
   * @param fromChain
   * @param toChain
   * @param minAmount
   * @param maxAmount
   * @param offset
   * @param limit
   * @returns returns events with the specified condition
   */
  getEvents = async (
    history = true,
    sort: SortRequest | undefined,
    fromChain: string | undefined,
    toChain: string | undefined,
    minAmount: string | undefined,
    maxAmount: string | undefined,
    offset = 0,
    limit = 20,
  ): Promise<Page<EventView>> => {
    const clauses = [];
    const amountCondition = [];
    if (fromChain) clauses.push({ fromChain: fromChain });
    if (toChain) clauses.push({ toChain: toChain });
    if (minAmount) amountCondition.push(MoreThanOrEqual(minAmount));
    if (maxAmount) amountCondition.push(LessThan(maxAmount));
    if (amountCondition.length > 0)
      clauses.push({ amount: And(...amountCondition) });
    const filterCondition = clauses.reduce(
      (partialCondition, clause) => ({
        ...partialCondition,
        ...clause,
      }),
      {},
    );
    const historyCondition = [
      {
        ...filterCondition,
        spendTxId: Not(IsNull()),
      },
      {
        ...filterCondition,
        status: In([
          EventStatus.rejected,
          EventStatus.timeout,
          EventStatus.reachedLimit,
        ]),
      },
    ];
    const ongoingCondition = [
      {
        ...filterCondition,
        spendTxId: IsNull(),
        status: Not(
          In([
            EventStatus.rejected,
            EventStatus.timeout,
            EventStatus.reachedLimit,
          ]),
        ),
      },
      {
        ...filterCondition,
        spendTxId: IsNull(),
        status: IsNull(),
      },
    ];
    const result = await this.EventView.findAndCount({
      where: history ? historyCondition : ongoingCondition,
      order: {
        height: sort ? sort : 'DESC',
      },
      skip: offset,
      take: limit,
    });
    return {
      items: result[0],
      total: result[1],
    };
  };

  /**
   * Returns unsaved revenue events that
   * their spending tx is confirmed enough
   * @param currentHeight
   * @param requiredConfirmation
   */
  getConfirmedUnsavedRevenueEvents = async (
    currentHeight: number,
    requiredConfirmation: number,
  ): Promise<Array<EventTriggerEntity>> => {
    return await this.EventRepository.createQueryBuilder('event')
      .leftJoin('revenue_entity', 're', 'event."id" = re."eventDataId"')
      .where('event."spendTxId" IS NOT NULL')
      .andWhere('re."eventDataId" IS NULL')
      .andWhere('event."spendHeight" < :spendHeight', {
        spendHeight: currentHeight - requiredConfirmation,
      })
      .getMany();
  };

  /**
   * Returns transactions with specified txIds
   * @param txIds
   */
  getTxsById = async (txIds: string[]): Promise<TransactionEntity[]> => {
    return this.TransactionRepository.findBy({
      txId: In(txIds),
    });
  };

  /**
   * Inserts new revenue
   * @param tokenId
   * @param amount
   * @param txId
   * @param revenueType
   * @param eventData
   */
  insertRevenue = async (
    tokenId: string,
    amount: bigint,
    txId: string,
    revenueType: string,
    eventData: EventTriggerEntity,
  ) => {
    return await this.RevenueRepository.insert({
      tokenId,
      amount,
      txId,
      revenueType,
      eventData,
    });
  };

  /**
   * Returns all revenue with respect to the filters
   * @param sort
   * @param fromChain
   * @param toChain
   * @param minHeight
   * @param maxHeight
   * @param fromBlockTime
   * @param toBlockTime
   * @param offset
   * @param limit
   */
  getRevenuesWithFilters = async (
    sort?: SortRequest,
    fromChain?: string,
    toChain?: string,
    minHeight?: number,
    maxHeight?: number,
    fromBlockTime?: number,
    toBlockTime?: number,
    offset = 0,
    limit = 20,
  ): Promise<Page<RevenueView>> => {
    const clauses = [],
      heightCondition = [],
      timeCondition = [];
    if (fromChain) clauses.push({ fromChain: fromChain });
    if (toChain) clauses.push({ toChain: toChain });
    if (minHeight) heightCondition.push(MoreThanOrEqual(minHeight));
    if (maxHeight) heightCondition.push(LessThan(maxHeight));
    if (heightCondition.length > 0)
      clauses.push({ height: And(...heightCondition) });
    if (fromBlockTime) timeCondition.push(MoreThanOrEqual(fromBlockTime));
    if (toBlockTime) timeCondition.push(LessThan(toBlockTime));
    if (timeCondition.length > 0)
      clauses.push({ timestamp: And(...timeCondition) });
    const result = await this.RevenueView.findAndCount({
      where:
        clauses.length > 0
          ? clauses.reduce(
              (partialCondition, clause) => ({
                ...partialCondition,
                ...clause,
              }),
              {},
            )
          : undefined,
      order: {
        timestamp: sort ? sort : 'DESC',
      },
      skip: offset,
      take: limit,
    });
    return {
      items: result[0],
      total: result[1],
    };
  };

  /**
   * get list of all revenues for selected list of events
   * @param ids event row id
   */
  getEventsRevenues = async (
    ids: Array<number>,
  ): Promise<Array<RevenueEntity>> => {
    return this.RevenueRepository.find({
      where: {
        eventData: In(ids),
      },
      relations: ['eventData'],
    });
  };

  /**
   * Returns chart data with the specified period
   * @param period
   * @param minTimestamp minimum timestamp (in seconds)
   */
  getRevenueChartData = async (
    period: RevenuePeriod,
    minTimestamp?: number,
  ) => {
    const query = this.RevenueChartView.createQueryBuilder();
    query
      .select('"tokenId"')
      .addSelect('SUM(amount)', 'amount')
      .addSelect('MIN(timestamp)', 'label')
      .groupBy('"tokenId"')
      .orderBy('label', 'DESC');
    if (minTimestamp)
      query.where('"timestamp" >= :timestamp', { timestamp: minTimestamp });
    if (period === RevenuePeriod.year) {
      query.addGroupBy('year');
    } else if (period === RevenuePeriod.month) {
      query.addGroupBy('year').addGroupBy('month');
    } else if (period === RevenuePeriod.week) {
      query.addGroupBy('week_number');
    }
    return query.getRawMany();
  };

  /**
   * @returns the transactions with valid status
   */
  getValidTxsForEvents = (eventIds: string[]): Promise<TransactionEntity[]> => {
    return this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: {
        event: In(eventIds),
        status: Not(TransactionStatus.invalid),
      },
    });
  };

  /**
   * @param eventId
   * @return commitments that are merged into event trigger
   */
  getEventCommitments = (eventId: string): Promise<CommitmentEntity[]> => {
    return this.CommitmentRepository.createQueryBuilder('commitment')
      .leftJoin(
        'confirmed_event_entity',
        'cee',
        'commitment."eventId" = cee."id"',
      )
      .leftJoin('event_trigger_entity', 'ete', 'ete."id" = cee."eventDataId"')
      .where('commitment."eventId" = :eventId', { eventId })
      .andWhere('commitment."spendTxId" = ete."txId"')
      .orderBy('commitment."spendIndex"', 'ASC')
      .getMany();
  };

  /**
   * @param scannerName
   * @return the last block height of the given scanner
   */
  getLastSavedBlockForScanner = async (
    scannerName: string,
  ): Promise<LastSavedBlock> => {
    const lastBlock = await this.BlockRepository.find({
      where: { status: PROCEED, scanner: scannerName },
      order: { height: 'DESC' },
      take: 1,
    });
    if (lastBlock.length !== 0)
      return {
        height: lastBlock[0].height,
        timestamp: lastBlock[0].timestamp,
      };
    throw new NotFoundError(`No block found in database`);
  };

  /**
   * @param status order status
   * @return the arbitrary orders with status
   */
  getOrdersByStatus = async (
    orderStatus: string,
  ): Promise<ArbitraryEntity[]> => {
    return await this.ArbitraryRepository.find({
      where: {
        status: orderStatus,
      },
    });
  };

  /**
   * updates the status of an arbitrary order by id
   * @param id order id
   * @param status order status
   * @param updateFirstTry if true, firstTry column will be updated to the current timestamp
   * @param incrementUnexpectedFails if true, unexpectedFails column will be incremented
   */
  setOrderStatus = async (
    id: string,
    status: string,
    updateFirstTry = false,
    incrementUnexpectedFails = false,
  ): Promise<void> => {
    const updatedRecord: QueryDeepPartialEntity<ArbitraryEntity> = {
      status: status,
    };
    if (updateFirstTry)
      updatedRecord.firstTry = String(Math.round(Date.now() / 1000));
    if (incrementUnexpectedFails)
      updatedRecord.unexpectedFails = () => '"unexpectedFails" + 1';

    await this.ArbitraryRepository.update({ id: id }, updatedRecord);
  };

  /**
   * @param id order id
   */
  getOrderById = async (id: string): Promise<ArbitraryEntity | null> => {
    return await this.ArbitraryRepository.findOne({
      where: {
        id: id,
      },
    });
  };

  /**
   * inserts an arbitrary order record into database
   */
  insertNewOrder = async (
    id: string,
    chain: string,
    orderJson: string,
  ): Promise<void> => {
    await this.ArbitraryRepository.insert({
      id: id,
      chain: chain,
      orderJson: orderJson,
      status: OrderStatus.pending,
      firstTry: String(Math.round(Date.now() / 1000)),
    });
  };

  /**
   * returns all valid transaction for corresponding order
   * @param id order id
   */
  getOrderValidTxs = async (id: string): Promise<TransactionEntity[]> => {
    return await this.TransactionRepository.find({
      relations: ['event', 'order'],
      where: {
        order: { id: id },
        status: Not(TransactionStatus.invalid),
      },
    });
  };

  /**
   * inserts reprocess request into db
   * @param senderId
   * @param requestId
   * @param eventTxId
   * @param timestamp
   * @param peerIds
   */
  insertReprocessRequests = async (
    senderId: string,
    requestId: string,
    eventTxId: string,
    timestamp: number,
    peerIds: string[],
  ) => {
    await this.ReprocessRepository.insert(
      peerIds.map((peerId) => ({
        requestId: requestId,
        eventTxId: eventTxId,
        sender: senderId,
        receiver: peerId,
        status: ReprocessStatus.noResponse,
        timestamp: timestamp,
      })),
    );
  };

  /**
   * gets all requests sent by the given peerId after the given timestamp
   * @param senderId
   * @param timestamp
   */
  getRecentReprocessRequestsByGuard = async (
    senderId: string,
    timestamp: number,
  ) => {
    return await this.ReprocessRepository.find({
      where: {
        sender: senderId,
        timestamp: MoreThan(timestamp),
      },
    });
  };

  /**
   * updates the status of a reprocess request
   * @param requestId
   * @param senderId
   * @param receiverId
   * @param status
   */
  updateReprocessRequest = async (
    requestId: string,
    senderId: string,
    receiverId: string,
    status: ReprocessStatus,
  ) => {
    return await this.ReprocessRepository.update(
      {
        requestId: requestId,
        sender: senderId,
        receiver: receiverId,
      },
      {
        status: status,
      },
    );
  };

  /**
   * gets AddressEntity records
   * @param chain
   * @param type
   * @param offset
   * @param limit
   * @returns a promise of paginated AddressEntity objects
   */
  getAddresses = async (
    chain?: SupportedChain,
    type?: AddressType,
    offset?: number,
    limit?: number,
  ): Promise<Page<AddressEntity>> => {
    const [items, total] = await this.AddressRepository.findAndCount({
      where: {
        ...(chain ? { chain } : {}),
        ...(type ? { type } : {}),
      },
      ...(Number.isFinite(offset) ? { skip: offset } : {}),
      ...(Number.isFinite(limit) ? { take: limit } : {}),
      order: {
        id: 'ASC',
      },
    });

    return {
      items,
      total,
    };
  };

  /**
   * gets all ChainAddressBalanceEntity by array of tokenIds
   * @param tokenIds
   * @returns array of ChainAddressBalanceEntity
   */
  getChainAddressBalanceByTokenIds = async (
    tokenIds: string[],
  ): Promise<ChainAddressBalanceEntity[]> => {
    return await this.ChainAddressBalanceRepository.findBy({
      tokenId: In(tokenIds),
    });
  };

  /**
   * gets all ChainAddressBalanceEntity by array of addresses
   * @param addresses
   * @param chain
   * @param tokenId
   * @param offset
   * @param limit
   * @returns a promise of Page ChainAddressBalanceEntity object
   */
  getChainAddressBalanceByAddresses = async (
    addresses: string[],
    chain?: string | readonly string[],
    tokenId?: string,
    offset?: number,
    limit?: number,
  ): Promise<Page<ChainAddressBalanceEntity>> => {
    const [items, total] =
      await this.ChainAddressBalanceRepository.findAndCount({
        where: {
          address: In(addresses),
          ...(chain
            ? { chain: typeof chain === 'string' ? chain : In([...chain]) }
            : {}),
          ...(tokenId ? { tokenId } : {}),
        },
        ...(Number.isFinite(offset) ? { skip: offset } : {}),
        ...(Number.isFinite(limit) ? { take: limit } : {}),
      });

    return {
      items,
      total,
    };
  };

  /**
   * gets all ChainAddressBalanceEntity objects by chain name
   * @param chain
   * @returns array of ChainAddressBalanceEntity objects
   */
  getChainAddressBalanceByChain = async (
    chain: string,
  ): Promise<ChainAddressBalanceEntity[]> => {
    return this.ChainAddressBalanceRepository.findBy({
      chain,
    });
  };

  /**
   * removes an array of ChainAddressBalanceEntity objects
   * @param records
   */
  removeChainAddressBalances = async (records: ChainAddressBalanceEntity[]) => {
    return await this.ChainAddressBalanceRepository.remove(records);
  };

  /**
   * upserts an array of ChainAddressBalanceEntity objects
   * @param records
   */
  upsertChainAddressBalances = async (records: ChainAddressBalanceEntity[]) => {
    return await this.ChainAddressBalanceRepository.upsert(records, [
      'chain',
      'address',
      'tokenId',
    ]);
  };

  /**
   * @param eventTxId the trigger transaction id
   * @return the event trigger
   */
  getEventByTriggerId = async (
    eventTxId: string,
  ): Promise<EventTriggerEntity | null> => {
    return await this.EventRepository.findOne({
      where: {
        txId: eventTxId,
      },
    });
  };

  /**
   * deletes an event from RejectedEventEntity by it's trigger transaction id
   * @param eventTxId the trigger transaction id
   */
  deleteRejectedEventByTriggerId = async (
    eventTxId: string,
  ): Promise<number> => {
    const rejectedEvents = await this.RejectedEventRepository.find({
      relations: ['eventData'],
      where: {
        eventData: { txId: eventTxId },
      },
    });
    const result = await this.RejectedEventRepository.delete({
      eventDataId: In(rejectedEvents.map((event) => event.eventDataId)),
    });
    return result.affected ?? 0;
  };
}

export { DatabaseAction };
