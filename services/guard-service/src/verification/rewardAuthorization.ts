import { blake2b } from 'blakejs';
import * as wasm from 'ergo-lib-wasm-nodejs';
import { Transaction } from 'ethers';
import { isEqual } from 'lodash-es';

import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { EntityManager, IsNull } from '@rosen-bridge/extended-typeorm';
import JsonBigInt from '@rosen-bridge/json-bigint';
import { ChainMinimumFee } from '@rosen-bridge/minimum-fee';
import {
  CommitmentEntity,
  EventTriggerEntity,
} from '@rosen-bridge/watcher-data-extractor';
import {
  AbstractChain,
  ConfirmationStatus,
  EventTrigger,
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ErgoChain, ErgoTransaction } from '@rosen-chains/ergo';

import { DatabaseAction } from '../db/databaseAction';
import { ConfirmedEventEntity } from '../db/entities/confirmedEventEntity';
import { TransactionEntity } from '../db/entities/transactionEntity';
import EventOrder from '../event/eventOrder';
import EventSerializer from '../event/eventSerializer';
import ChainHandler from '../handlers/chainHandler';
import MinimumFeeHandler from '../handlers/minimumFeeHandler';
import {
  TransactionSigningContext,
  RewardSigningAuthority,
  SigningRowPreimage,
  SigningActionPhase,
  SigningPersistencePurpose,
} from '../signing/transactionSigningContext';
import { EventStatus, TransactionStatus } from '../utils/constants';
import Utils from '../utils/utils';
import { assertSameSignedErgoSemantics } from './ergoSignedSemantics';
import TransactionVerifier from './transactionVerifier';

export interface BoundRewardAuthorization {
  readonly authorityId: string;
  readonly event: Readonly<EventTrigger>;
  readonly eventTxId: string;
  readonly paymentTxId: string;
  withAction(
    action: () => void,
    assertInputs?: (manager: EntityManager) => Promise<void>,
  ): Promise<void>;
  /**
   * Caller must already own the source-observation/destination-safety scanner
   * lease for this exact event. This primitive does not acquire a second lease.
   * The final action must be synchronous and must not use a global DB manager.
   */
  checkUnderScannerLease(
    action: () => void,
    assertInputs?: (manager: EntityManager) => Promise<void>,
  ): Promise<void>;
}

export interface BoundAgreementRewardAuthorization
  extends BoundRewardAuthorization {
  readonly phase: string;
  prepareSnapshotUnderScannerLease(): Promise<
    (
      manager: EntityManager,
      phase?: string,
      unexpected?: boolean,
    ) => Promise<void>
  >;
  withManagerAction<T>(
    action: (
      manager: EntityManager,
      assertSettlement: (phase: string) => Promise<void>,
    ) => Promise<T>,
    assertInputs?: (manager: EntityManager) => Promise<void>,
  ): Promise<T>;
}

interface Dependencies {
  context: TransactionSigningContext;
  getDatabase: () => DatabaseAction;
  getChain: (network: string) => AbstractChain<unknown>;
}

/** Serializes the event fields used for reward authority equality checks. */
const eventFingerprint = (event: ConfirmedEventEntity): string =>
  JSON.stringify({
    id: event.id,
    status: event.status,
    firstTry: event.firstTry,
    unexpectedFails: event.unexpectedFails,
    triggerId: event.eventData.id,
    triggerTxId: event.eventData.txId,
    triggerEventId: event.eventData.eventId,
    triggerSerialized: event.eventData.serialized,
    trigger: event.eventData,
    protocol: EventSerializer.fromEntity(event.eventData),
  });

/** Reward admission for Avalanche events; later agreement/signing need own gates. */
class RewardAuthorization {
  private static instance: RewardAuthorization | undefined;
  private readonly knownEvents = new Set<string>();
  private static readonly capturedAuthorities = new WeakMap<
    PaymentTransaction,
    { authorityId: string; assertUnchanged: () => void }
  >();

  /** Returns the currently captured reward authority. */
  static capturedAuthority(payment: PaymentTransaction): string | undefined {
    const captured = this.capturedAuthorities.get(payment);
    captured?.assertUnchanged();
    return captured?.authorityId;
  }

  /** Reports whether reward authority has been captured. */
  static hasCapturedAuthority(payment: PaymentTransaction): boolean {
    return this.capturedAuthorities.has(payment);
  }

  /** Retains this process's observed Avalanche provenance across queue delays. */
  static remembersEvent(eventId: string): boolean {
    try {
      return this.getInstance().knownEvents.has(eventId);
    } catch {
      return false;
    }
  }

  /** Initializes the singleton reward authorization with its configured dependencies. */
  static init(context: TransactionSigningContext): void {
    this.instance = new RewardAuthorization({
      context,
      getDatabase: () => DatabaseAction.getInstance(),
      getChain: (network) => ChainHandler.getInstance().getChain(network),
    });
  }

  /** Returns the initialized reward authorization singleton. */
  static getInstance(): RewardAuthorization {
    if (!this.instance)
      throw new Error('Reward authorization is not initialized');
    return this.instance;
  }

  /** Reports whether the transaction requires Avalanche reward authorization. */
  static applies(event: EventTrigger): boolean {
    return [event.fromChain, event.toChain].some(
      (chain) =>
        typeof chain === 'string' && chain.toLowerCase() === 'avalanche',
    );
  }

  /** Copies the complete reward model and retains an exact caller-mutation check. */
  static captureReward(input: PaymentTransaction, eventId: string) {
    /** Captures reward event and order inputs for later equality checks. */
    const snapshot = (tx: PaymentTransaction) => {
      const ergo = tx as ErgoTransaction;
      return JSON.stringify({
        json: tx.toJson(),
        network: tx.network,
        txId: tx.txId,
        eventId: tx.eventId,
        txType: tx.txType,
        bytes: Buffer.from(tx.txBytes).toString('hex'),
        inputs: ergo.inputBoxes.map((box) => Buffer.from(box).toString('hex')),
        data: ergo.dataInputs.map((box) => Buffer.from(box).toString('hex')),
      });
    };
    const before = snapshot(input);
    const payment = ErgoTransaction.fromJson(input.toJson());
    if (
      snapshot(payment) !== before ||
      payment.network !== 'ergo' ||
      payment.txType !== TransactionType.reward ||
      payment.eventId !== eventId
    )
      throw new Error('Reward request model mismatch');
    return Object.freeze({
      payment,
      /** Invoke only at the successful R1/R2 action, never during early capture. */
      retainAuthority: (authority: BoundRewardAuthorization) => {
        if (
          snapshot(input) !== before ||
          snapshot(payment) !== before ||
          EventSerializer.getId(authority.event) !== eventId
        )
          throw new Error('Reward authority handoff mismatch');
        for (const object of [input, payment]) {
          const previous = this.capturedAuthority(object);
          if (previous !== undefined && previous !== authority.authorityId)
            throw new Error(
              'A fresh reward authority requires a new attempt object',
            );
        }
        const retained = {
          authorityId: authority.authorityId,
          assertUnchanged: () => {
            if (snapshot(input) !== before || snapshot(payment) !== before)
              throw new Error('Queued reward model changed');
          },
        };
        this.capturedAuthorities.set(input, retained);
        this.capturedAuthorities.set(payment, retained);
      },
      assertUnchanged: () => {
        if (snapshot(input) !== before || snapshot(payment) !== before)
          throw new Error('Reward transaction changed before admission');
      },
    });
  }

  /** Captures the dependencies used by subsequent authorization checks. */
  constructor(private readonly dependencies: Dependencies) {}

  /** Captures merged WID order and all commitment rows used to form reward inputs. */
  async captureOrderInputs(event: EventTrigger, eventTxId: string) {
    const database = this.dependencies.getDatabase();
    const eventId = EventSerializer.getId(event);
    const feeConfig: ChainMinimumFee = Object.freeze(
      structuredClone(MinimumFeeHandler.getEventFeeConfig(event)),
    );
    const feeFingerprint = JsonBigInt.stringify(feeConfig);
    /** Reads and captures the reward order inputs. */
    const read = async (manager: EntityManager) => {
      const repository = manager.getRepository(CommitmentEntity);
      const rows = await repository.find({
        where: { eventId },
        order: { id: 'ASC' },
      });
      const merged = await repository
        .createQueryBuilder('commitment')
        .where('commitment."eventId" = :eventId', { eventId })
        .andWhere('commitment."spendTxId" = :eventTxId', { eventTxId })
        .orderBy('commitment."spendIndex"', 'ASC')
        .getMany();
      return { rows, eventWIDs: merged.map((commitment) => commitment.WID) };
    };
    const captured = await database.dataSource.transaction(read);
    const fingerprint = JSON.stringify(captured);
    const eventWIDs = Object.freeze([...captured.eventWIDs]);
    if (
      eventWIDs.some(
        (wid) => typeof wid !== 'string' || !/^[0-9a-f]{64}$/.test(wid),
      ) ||
      eventWIDs.length !== event.WIDsCount ||
      Buffer.from(
        blake2b(Buffer.from(eventWIDs.join(''), 'hex'), undefined, 32),
      ).toString('hex') !== event.WIDsHash
    )
      throw new Error('Reward WID inputs do not match the event');
    return Object.freeze({
      authorityId: JSON.stringify([fingerprint, feeFingerprint]),
      feeConfig,
      eventWIDs,
      commitments: Object.freeze(structuredClone(captured.rows)),
      assertFee: () => {
        if (
          JsonBigInt.stringify(MinimumFeeHandler.getEventFeeConfig(event)) !==
          feeFingerprint
        )
          throw new Error('Reward fee configuration changed');
      },
      assertInputs: async (manager: EntityManager) => {
        if (JSON.stringify(await read(manager)) !== fingerprint)
          throw new Error('Reward commitment inputs changed');
      },
    });
  }

  /** Binds the supplied model to the captured transaction authority. */
  async bind(
    input: EventTrigger,
    eventTxId: string,
  ): Promise<BoundRewardAuthorization> {
    return this.bindInternal(input, eventTxId, false);
  }

  /** Agreement has a separate inReward path; ordinary generation stays pending-only. */
  async bindForAgreement(
    input: EventTrigger,
    eventTxId: string,
  ): Promise<BoundAgreementRewardAuthorization> {
    return this.bindInternal(input, eventTxId, true);
  }

  /** Requalifies current stored authority; does not recover a past R2 binding. */
  async bindExistingReward(
    input: SigningRowPreimage,
    eligibleStatuses: readonly string[],
    purpose?: 'recovery' | 'invalidation' | 'submission',
  ): Promise<RewardSigningAuthority | undefined> {
    const expected = Object.freeze({ ...input });
    const statuses = Object.freeze([...eligibleStatuses]);
    if (expected.type !== TransactionType.reward || !expected.eventId)
      throw new Error('Reward signing context is missing');
    const database = this.dependencies.getDatabase();
    const event = await database.getEventById(expected.eventId);
    if (
      !event?.eventData ||
      event.id !== expected.eventId ||
      event.eventData.eventId !== expected.eventId
    )
      throw new Error('Reward signing event is missing or inconsistent');
    const protocol = EventSerializer.fromConfirmedEntity(event);
    if (EventSerializer.getId(protocol) !== expected.eventId)
      throw new Error('Reward signing event identity mismatch');
    const paymentRows = await database.TransactionRepository.find({
      where: { event: { id: expected.eventId }, type: TransactionType.payment },
    });
    const durableAvalanche =
      event.eventData.extractor === 'avalancheEventTrigger' ||
      paymentRows.some((row) => row.chain.toLowerCase() === 'avalanche');
    if (!RewardAuthorization.applies(protocol)) {
      if (durableAvalanche || this.knownEvents.has(expected.eventId))
        throw new Error('Stored Avalanche reward route changed');
      return undefined;
    }
    if (purpose === 'submission') {
      const trigger = event.eventData;
      const ready = [
        trigger.spendHeight,
        trigger.spendBlock,
        trigger.spendTxId,
        trigger.result,
        trigger.paymentTxId,
      ].every((value) => value == null);
      return this.bindRewardCompletion(
        expected,
        statuses,
        event,
        undefined,
        false,
        ready ? 'ready' : 'observed',
      );
    }
    if (purpose === 'invalidation')
      return this.bindRewardCompletion(
        expected,
        statuses,
        event,
        undefined,
        true,
      );
    if (purpose === 'recovery') {
      if (
        expected.status !== TransactionStatus.signFailed ||
        !statuses.includes(expected.status)
      )
        throw new Error('Reward recovery row is not eligible');
      const original = ErgoTransaction.fromJson(expected.txJson);
      if (!isEqual(JSON.parse(original.toJson()), JSON.parse(expected.txJson)))
        throw new Error('Reward recovery model differs from its row');
      const reduced = wasm.ReducedTransaction.sigma_parse_bytes(
        original.txBytes,
      );
      const ergo = this.dependencies.getChain('ergo') as ErgoChain;
      if (
        reduced.unsigned_tx().id().to_str() !== expected.txId ||
        !(await ergo.verifyPaymentTransaction(original, SigningStatus.UnSigned))
      )
        throw new Error('Reward recovery reduced identity mismatch');
      if (
        event.eventData.result !== 'successful' ||
        event.eventData.spendTxId !== expected.txId ||
        typeof event.eventData.spendBlock !== 'string' ||
        !/^[0-9a-f]{64}$/.test(event.eventData.spendBlock)
      )
        throw new Error('Reward recovery requires a successful recorded spend');
      const raw = await ergo.getTransaction(
        expected.txId,
        event.eventData.spendBlock,
      );
      if (!/^(?:[0-9a-f]{2})+$/.test(raw))
        throw new Error('Invalid recovered signed bytes');
      const signed = wasm.Transaction.sigma_parse_bytes(
        Buffer.from(raw, 'hex'),
      );
      if (signed.id().to_str() !== reduced.unsigned_tx().id().to_str())
        throw new Error('Recovered signed reward identity mismatch');
      original.txBytes = signed.sigma_serialize_bytes();
      return this.bindRewardCompletion(
        expected,
        statuses,
        event,
        original.toJson(),
      );
    }
    if (expected.status === TransactionStatus.sent)
      return this.bindRewardCompletion(expected, statuses, event);
    if (
      expected.chain !== 'ergo' ||
      expected.orderId !== null ||
      ![
        TransactionStatus.approved,
        TransactionStatus.signFailed,
        TransactionStatus.inSign,
      ].includes(expected.status) ||
      !statuses.includes(expected.status) ||
      event.status !== EventStatus.inReward
    )
      throw new Error('Existing reward is not eligible for signing');
    const captured = RewardAuthorization.captureReward(
      ErgoTransaction.fromJson(expected.txJson),
      expected.eventId,
    );
    if (
      captured.payment.txId !== expected.txId ||
      captured.payment.toJson() !== expected.txJson
    )
      throw new Error('Stored reward model differs from signing input');
    const settlement = await this.bindForAgreement(
      protocol,
      event.eventData.txId,
    );
    if (settlement.phase !== EventStatus.inReward)
      throw new Error('Reward signing event phase changed');
    const inputs = await this.captureOrderInputs(
      settlement.event,
      settlement.eventTxId,
    );
    const ergo = this.dependencies.getChain('ergo');
    /** Rejects a reward model that differs from the captured event and order. */
    const assertReward = async (
      manager: EntityManager,
      transition?: SigningRowPreimage,
    ): Promise<SigningRowPreimage> => {
      await inputs.assertInputs(manager);
      if (
        !(await manager.getRepository(TransactionEntity).existsBy({
          txId: expected.txId,
          order: IsNull(),
        }))
      )
        throw new Error('Reward signing order association changed');
      const rows = (
        await manager.getRepository(TransactionEntity).find({
          where: {
            event: { id: expected.eventId! },
            type: TransactionType.reward,
          },
          relations: ['event', 'order'],
        })
      ).filter((row) => row.status !== TransactionStatus.invalid);
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.txId !== expected.txId ||
        row.txJson !== (transition?.txJson ?? expected.txJson) ||
        row.chain !== expected.chain ||
        row.type !== expected.type ||
        row.requiredSign !== expected.requiredSign ||
        row.event?.id !== expected.eventId ||
        row.order !== null ||
        (transition
          ? row.status !== transition.status
          : !statuses.includes(row.status) ||
            ![
              TransactionStatus.approved,
              TransactionStatus.signFailed,
              TransactionStatus.inSign,
            ].includes(row.status))
      )
        throw new Error('Reward signing row changed');
      return Object.freeze({
        ...expected,
        txJson: row.txJson,
        status: row.status,
      });
    };
    /** Qualifies the captured reward model for the requested action. */
    const qualifyModel = async (): Promise<string> => {
      captured.assertUnchanged();
      if (
        this.dependencies.getChain('ergo') !== ergo ||
        !(await TransactionVerifier.verifyTxCommonConditions(captured.payment))
      )
        throw new Error('Reward signing model is inconsistent');
      const actual = ergo.extractTransactionOrder(captured.payment);
      const wanted = await EventOrder.createEventRewardOrder(
        settlement.event,
        settlement.eventTxId,
        inputs.feeConfig,
        settlement.paymentTxId,
        [...inputs.eventWIDs],
      );
      captured.assertUnchanged();
      if (!isEqual(actual, wanted))
        throw new Error('Reward signing order mismatch');
      return JsonBigInt.stringify(actual);
    };
    const order = await qualifyModel();
    const authorityId = JSON.stringify({
      settlement: settlement.authorityId,
      reward: expected,
      inputs: inputs.authorityId,
      order,
    });
    /** Rejects changes to the captured event, order or transaction authority. */
    const assertCurrent = () => {
      if (
        this.dependencies.getDatabase() !== database ||
        this.dependencies.getChain('ergo') !== ergo
      )
        throw new Error('Reward signing dependencies changed');
      captured.assertUnchanged();
      inputs.assertFee();
    };
    await settlement.withAction(assertCurrent, async (manager) => {
      await assertReward(manager);
    });
    return Object.freeze({
      authorityId,
      preparePersistenceUnderScannerLease: async (
        purpose: SigningPersistencePurpose,
        signedJson?: string,
      ) => {
        if (purpose === 'completion')
          throw new Error(
            'Signed reward recovery is required before completion',
          );
        if ((await qualifyModel()) !== order)
          throw new Error('Reward persistence order changed');
        if (purpose === 'result') {
          if (!signedJson) throw new Error('Signed reward model is missing');
          const signed = ErgoTransaction.fromJson(signedJson);
          if (
            signed.txId !== captured.payment.txId ||
            !(await (ergo as ErgoChain).verifyPaymentTransaction(
              signed,
              SigningStatus.Signed,
            )) ||
            JsonBigInt.stringify(
              (ergo as ErgoChain).extractTransactionOrder(
                signed,
                SigningStatus.Signed,
              ),
            ) !== order
          )
            throw new Error(
              'Signed reward does not match the qualified reduced transaction',
            );
        }
        const assertSettlement =
          await settlement.prepareSnapshotUnderScannerLease();
        return Object.freeze({
          assertBefore: async (
            manager: EntityManager,
            row: SigningRowPreimage,
          ) => {
            await assertSettlement(manager);
            const current = await assertReward(manager);
            if (current.status !== row.status || current.txJson !== row.txJson)
              throw new Error('Reward persistence preimage changed');
            assertCurrent();
          },
          assertAfter: async (
            manager: EntityManager,
            row: SigningRowPreimage,
          ) => {
            const target =
              purpose === 'queue'
                ? TransactionStatus.inSign
                : purpose === 'result'
                  ? TransactionStatus.signed
                  : TransactionStatus.signFailed;
            if (
              row.status !== target ||
              row.txJson !==
                (purpose === 'result' ? signedJson : expected.txJson)
            )
              throw new Error('Unexpected reward persistence transition');
            await assertSettlement(manager);
            await assertReward(manager, row);
            assertCurrent();
          },
        });
      },
      checkUnderScannerLease: async <T>(
        phase: SigningActionPhase,
        action: (row: SigningRowPreimage) => T,
      ): Promise<T> => {
        if (
          !['queue', 'commitment', 'sign', 'outbound', 'result'].includes(phase)
        )
          throw new Error('Unknown reward signing phase');
        if ((await qualifyModel()) !== order)
          throw new Error('Reward signing order changed');
        let current: SigningRowPreimage | undefined;
        let result: T;
        await settlement.checkUnderScannerLease(
          () => {
            assertCurrent();
            if (!current) throw new Error('Reward signing row is unavailable');
            result = action(current);
            if (
              result &&
              typeof (result as unknown as PromiseLike<unknown>).then ===
                'function'
            )
              throw new Error('Reward signing action must be synchronous');
          },
          async (manager) => {
            current = await assertReward(manager);
          },
        );
        return result!;
      },
    });
  }

  /** Reconciles an executed reward; this is not recovery of historical signing policy. */
  private async bindRewardCompletion(
    expected: SigningRowPreimage,
    statuses: readonly string[],
    originalEvent: ConfirmedEventEntity,
    recoveryJson?: string,
    invalidation = false,
    submission?: 'ready' | 'observed',
  ): Promise<RewardSigningAuthority> {
    if (
      expected.chain !== 'ergo' ||
      expected.orderId !== null ||
      (submission !== undefined &&
        ![TransactionStatus.signed, TransactionStatus.sent].includes(
          expected.status,
        )) ||
      (invalidation &&
        ![TransactionStatus.sent, TransactionStatus.signFailed].includes(
          expected.status,
        )) ||
      !statuses.includes(
        submission
          ? expected.status
          : invalidation
            ? expected.status
            : recoveryJson
              ? TransactionStatus.signFailed
              : TransactionStatus.sent,
      ) ||
      originalEvent.status !== EventStatus.inReward
    )
      throw new Error('Reward completion row is not eligible');
    const event = structuredClone(originalEvent);
    const database = this.dependencies.getDatabase();
    const ergo = this.dependencies.getChain('ergo') as ErgoChain;
    const captured = RewardAuthorization.captureReward(
      ErgoTransaction.fromJson(recoveryJson ?? expected.txJson),
      expected.eventId!,
    );
    if (
      captured.payment.txId !== expected.txId ||
      !isEqual(
        JSON.parse(captured.payment.toJson()),
        JSON.parse(recoveryJson ?? expected.txJson),
      )
    )
      throw new Error('Reward completion model differs from its row');
    const signingStatus =
      invalidation && expected.status === TransactionStatus.signFailed
        ? SigningStatus.UnSigned
        : SigningStatus.Signed;
    const encoded =
      signingStatus === SigningStatus.Signed
        ? wasm.Transaction.sigma_parse_bytes(captured.payment.txBytes)
        : wasm.ReducedTransaction.sigma_parse_bytes(captured.payment.txBytes);
    const body =
      signingStatus === SigningStatus.Signed
        ? (encoded as wasm.Transaction)
        : (encoded as wasm.ReducedTransaction).unsigned_tx();
    if (
      body.id().to_str() !== expected.txId ||
      !Buffer.from(encoded.sigma_serialize_bytes()).equals(
        Buffer.from(captured.payment.txBytes),
      )
    )
      throw new Error('Reward completion signed identity mismatch');
    const settlement = await this.bindInternal(
      EventSerializer.fromConfirmedEntity(event),
      event.eventData.txId,
      true,
      invalidation || submission === 'ready' ? undefined : expected,
      invalidation,
      submission === undefined,
    );
    const inputs = await this.captureOrderInputs(
      settlement.event,
      settlement.eventTxId,
    );
    const inputBoxes = (captured.payment as ErgoTransaction).inputBoxes;
    for (const boxes of [
      inputBoxes,
      (captured.payment as ErgoTransaction).dataInputs,
    ]) {
      const seen = new Set<string>();
      for (const bytes of boxes) {
        const box = wasm.ErgoBox.sigma_parse_bytes(bytes);
        if (
          seen.has(box.box_id().to_str()) ||
          !Buffer.from(box.sigma_serialize_bytes()).equals(Buffer.from(bytes))
        )
          throw new Error(
            'Reward reconciliation auxiliary encoding is not canonical',
          );
        seen.add(box.box_id().to_str());
      }
    }
    const ids = inputBoxes.map((bytes) =>
      wasm.ErgoBox.sigma_parse_bytes(bytes).box_id().to_str(),
    );
    if (new Set(ids).size !== ids.length)
      throw new Error('Duplicate reward completion inputs');
    const triggerBytes = Buffer.from(event.eventData.serialized, 'base64');
    const triggerId = wasm.ErgoBox.sigma_parse_bytes(triggerBytes)
      .box_id()
      .to_str();
    const triggerIndex = ids.indexOf(triggerId);
    if (
      triggerId !== event.eventData.identifier ||
      triggerIndex < 0 ||
      !Buffer.from(inputBoxes[triggerIndex]).equals(triggerBytes)
    )
      throw new Error('Reward does not spend the exact captured trigger');
    const triggerHex = triggerBytes.toString('hex');
    const rwtId = this.dependencies
      .getChain(settlement.event.fromChain)
      .getRWTToken();
    const triggerTokens = wasm.ErgoBox.sigma_parse_bytes(triggerBytes).tokens();
    if (
      triggerTokens.len() === 0 ||
      triggerTokens.get(0).id().to_str() !== rwtId
    )
      throw new Error('Reward completion trigger RWT identity mismatch');
    const rwtCount =
      ergo.getBoxRWT(triggerHex) / BigInt(settlement.event.WIDsCount);
    const permitValue =
      ergo.getSerializedBoxInfo(triggerHex).assets.nativeToken /
      BigInt(settlement.event.WIDsCount);
    const merged = inputs.commitments.filter(
      (row) => row.spendTxId === settlement.eventTxId,
    );
    if (
      merged.some(
        (row) =>
          row.spendBlock !== event.eventData.block ||
          row.spendHeight !== event.eventData.height ||
          ids.includes(row.identifier),
      )
    )
      throw new Error('Merged reward commitments have inconsistent provenance');
    const used = inputs.commitments.filter((row) =>
      ids.includes(row.identifier),
    );
    const foreign = used.filter((row) => row.spendTxId != null);
    if (
      invalidation &&
      (foreign.length === 0 ||
        used.some((row) =>
          row.spendTxId == null
            ? row.spendBlock != null ||
              row.spendHeight != null ||
              row.spendIndex != null
            : row.spendTxId === expected.txId ||
              !/^[0-9a-f]{64}$/.test(row.spendTxId) ||
              typeof row.spendBlock !== 'string' ||
              !/^[0-9a-f]{64}$/.test(row.spendBlock) ||
              !Number.isSafeInteger(row.spendHeight) ||
              row.spendHeight! < row.height ||
              !Number.isSafeInteger(row.spendIndex) ||
              row.spendIndex! < 0,
        ))
    )
      throw new Error(
        'Reward invalidation requires a coherent foreign commitment spend',
      );
    if (
      new Set(used.map((row) => row.identifier)).size !== used.length ||
      new Set(used.map((row) => row.WID)).size !== used.length ||
      inputs.commitments.some(
        (row) =>
          row.spendTxId === expected.txId && !ids.includes(row.identifier),
      )
    )
      throw new Error('Ambiguous reward completion commitment inputs');
    const additional = used.map((row) => {
      const index = ids.indexOf(row.identifier);
      const bytes = Buffer.from(row.serialized, 'base64');
      const tokens = wasm.ErgoBox.sigma_parse_bytes(bytes).tokens();
      if (
        !Buffer.from(inputBoxes[index]).equals(bytes) ||
        row.height >= event.eventData.height ||
        (submission === 'ready' &&
          [row.spendHeight, row.spendBlock, row.spendTxId, row.spendIndex].some(
            (value) => value != null,
          )) ||
        (!invalidation &&
          submission !== 'ready' &&
          (row.spendTxId !== expected.txId ||
            row.spendIndex !== index ||
            row.spendBlock !== event.eventData.spendBlock ||
            row.spendHeight !== event.eventData.spendHeight)) ||
        !/^[0-9a-f]{64}$/.test(row.WID) ||
        inputs.eventWIDs.includes(row.WID) ||
        BigInt(row.rwtCount) !== rwtCount ||
        tokens.len() === 0 ||
        tokens.get(0).id().to_str() !== rwtId ||
        ergo.getBoxRWT(bytes.toString('hex')) !== rwtCount ||
        row.commitment !==
          Utils.commitmentFromEvent(settlement.event, row.WID) ||
        ergo.getBoxWID(bytes.toString('hex')) !== row.WID
      )
        throw new Error(
          'Reward completion commitment does not match its signed input',
        );
      return {
        wid: row.WID,
        boxValue: ergo.getSerializedBoxInfo(bytes.toString('hex')).assets
          .nativeToken,
      };
    });
    const actualOrder = JsonBigInt.stringify(
      ergo.extractTransactionOrder(captured.payment, signingStatus),
    );
    const confirmations = invalidation
      ? ergo.getTxRequiredConfirmation(TransactionType.reward)
      : undefined;
    const ergoPolicy = submission
      ? JsonBigInt.stringify(ergo.configs)
      : undefined;
    /** Reads the order required for the current payment or reward authorization. */
    const order = () => {
      const result = EventOrder.eventRewardOrder(
        settlement.event,
        additional,
        inputs.feeConfig,
        settlement.paymentTxId,
        this.dependencies.getChain(settlement.event.fromChain).getRWTToken(),
        rwtCount,
        permitValue,
        [...inputs.eventWIDs],
      );
      return JsonBigInt.stringify([
        ...result.watchersOrder,
        ...result.guardsOrder,
      ]);
    };
    /** Rejects changes to the captured event, order or transaction authority. */
    const assertCurrent = () => {
      captured.assertUnchanged();
      inputs.assertFee();
      if (
        this.dependencies.getDatabase() !== database ||
        this.dependencies.getChain('ergo') !== ergo ||
        (submission && JsonBigInt.stringify(ergo.configs) !== ergoPolicy) ||
        (invalidation &&
          (!Number.isSafeInteger(confirmations) ||
            confirmations! < 0 ||
            ergo.getTxRequiredConfirmation(TransactionType.reward) !==
              confirmations)) ||
        order() !== actualOrder
      )
        throw new Error('Reward completion policy or order changed');
    };
    assertCurrent();
    /** Rejects a reward model that differs from the captured event and order. */
    const assertReward = async (
      manager: EntityManager,
      after: boolean,
      unexpected = false,
    ) => {
      const spendBlocks =
        submission === 'ready'
          ? []
          : invalidation
            ? foreign
            : [event.eventData];
      for (const spend of spendBlocks) {
        const blocks = await manager
          .getRepository(BlockEntity)
          .findBy({ scanner: 'ergo', height: spend.spendHeight! });
        if (
          blocks.length !== 1 ||
          blocks[0].status !== PROCEED ||
          blocks[0].hash !== spend.spendBlock
        )
          throw new Error('Reward completion block is not uniquely scanned');
      }
      const currentEvent = await manager
        .getRepository(ConfirmedEventEntity)
        .findOne({
          where: { id: expected.eventId! },
          relations: ['eventData'],
        });
      if (
        !currentEvent ||
        eventFingerprint({
          ...currentEvent,
          status: event.status,
          unexpectedFails:
            invalidation && after
              ? currentEvent.unexpectedFails - (unexpected ? 1 : 0)
              : currentEvent.unexpectedFails,
        }) !== eventFingerprint(event)
      )
        throw new Error('Reward completion trigger snapshot changed');
      const rows = await manager.getRepository(TransactionEntity).find({
        where: {
          event: { id: expected.eventId! },
          type: TransactionType.reward,
        },
        relations: ['event', 'order'],
      });
      const active = rows.filter(
        (row) => row.status !== TransactionStatus.invalid,
      );
      const row =
        invalidation && after
          ? rows.find((row) => row.txId === expected.txId)
          : active[0];
      if (
        active.length !== (invalidation && after ? 0 : 1) ||
        !row ||
        row.txId !== expected.txId ||
        row.txJson !==
          (after && recoveryJson ? recoveryJson : expected.txJson) ||
        row.chain !== expected.chain ||
        row.type !== expected.type ||
        row.requiredSign !== expected.requiredSign ||
        row.event?.id !== expected.eventId ||
        row.order !== null ||
        row.status !==
          (submission
            ? after
              ? TransactionStatus.sent
              : expected.status
            : invalidation
              ? after
                ? TransactionStatus.invalid
                : expected.status
              : recoveryJson
                ? after
                  ? TransactionStatus.sent
                  : TransactionStatus.signFailed
                : after
                  ? TransactionStatus.completed
                  : TransactionStatus.sent) ||
        !(await manager
          .getRepository(TransactionEntity)
          .existsBy({ txId: expected.txId, order: IsNull() }))
      )
        throw new Error('Reward completion row changed');
      await inputs.assertInputs(manager);
      assertCurrent();
    };
    const submissionIdentity = submission
      ? JsonBigInt.stringify({
          event: {
            ...event,
            eventData: {
              ...event.eventData,
              spendHeight: null,
              spendBlock: null,
              spendTxId: null,
              result: null,
              paymentTxId: null,
            },
          },
          payment: JSON.parse(settlement.authorityId).payment,
          reward: expected,
          commitments: inputs.commitments.map((row) =>
            ids.includes(row.identifier)
              ? {
                  ...row,
                  spendHeight: null,
                  spendBlock: null,
                  spendTxId: null,
                  spendIndex: null,
                }
              : row,
          ),
          wids: inputs.eventWIDs,
          fee: inputs.feeConfig,
          ergoPolicy,
          actualOrder,
        })
      : undefined;
    const authority: RewardSigningAuthority = Object.freeze({
      authorityId: JSON.stringify({
        settlement: settlement.authorityId,
        reward: expected,
        inputs: inputs.authorityId,
        actualOrder,
        recoveryJson,
        invalidation,
      }),
      recoveredSignedJson: recoveryJson,
      submission: submission
        ? Object.freeze({
            kind: submission,
            identity: submissionIdentity!,
            authorizeUnderScannerLease: async (start: () => void) => {
              if (submission !== 'ready')
                throw new Error('Observed reward cannot be submitted');
              const checks =
                await authority.preparePersistenceUnderScannerLease(
                  'submission',
                );
              await database.dataSource.transaction(async (manager) => {
                await checks.assertBefore(manager, expected);
                assertCurrent();
                start();
              });
            },
          })
        : undefined,
      checkUnderScannerLease: async () => {
        throw new Error('Completed reward authority cannot authorize signing');
      },
      preparePersistenceUnderScannerLease: async (
        purpose: SigningPersistencePurpose,
      ) => {
        if (
          purpose !==
          (submission
            ? 'submission'
            : invalidation
              ? 'invalidation'
              : recoveryJson
                ? 'recovery'
                : 'completion')
        )
          throw new Error('Reward completion authority has the wrong purpose');
        assertCurrent();
        if (
          !(await ergo.verifyPaymentTransaction(
            captured.payment,
            signingStatus,
          ))
        )
          throw new Error('Reward signed model is inconsistent');
        if (
          submission &&
          (!(await ergo.verifyTransactionFee(
            captured.payment,
            SigningStatus.Signed,
          )) ||
            !(await ergo.verifyNoTokenBurned(
              captured.payment,
              SigningStatus.Signed,
            )) ||
            !ergo.verifyTransactionExtraConditions(
              captured.payment,
              SigningStatus.Signed,
            ))
        )
          throw new Error(
            'Reward submission accounting or extra conditions failed',
          );
        if (submission === 'ready') {
          if (
            !(await ergo.isTxValid(captured.payment, SigningStatus.Signed))
              .isValid
          )
            throw new Error('Reward submission inputs are not available');
        } else if (invalidation) {
          for (const spend of foreign) {
            const raw = await ergo.getTransaction(
              spend.spendTxId!,
              spend.spendBlock!,
            );
            if (!/^(?:[0-9a-f]{2})+$/.test(raw))
              throw new Error('Invalid foreign spend encoding');
            const parsed = wasm.Transaction.sigma_parse_bytes(
              Buffer.from(raw, 'hex'),
            );
            if (
              parsed.id().to_str() !== spend.spendTxId ||
              Buffer.from(parsed.sigma_serialize_bytes()).toString('hex') !==
                raw ||
              parsed.inputs().len() <= spend.spendIndex! ||
              parsed.inputs().get(spend.spendIndex!).box_id().to_str() !==
                spend.identifier ||
              Array.from({ length: parsed.inputs().len() }, (_, i) =>
                parsed.inputs().get(i).box_id().to_str(),
              ).includes(triggerId) ||
              (await ergo.getTxConfirmationStatus(
                spend.spendTxId!,
                TransactionType.reward,
              )) !== ConfirmationStatus.ConfirmedEnough
            )
              throw new Error(
                'Foreign commitment spend is not confirmed or consistent',
              );
          }
        } else {
          const raw = await ergo.getTransaction(
            expected.txId,
            event.eventData.spendBlock!,
          );
          if (submission === 'observed') {
            const observed = ErgoTransaction.fromJson(
              captured.payment.toJson(),
            );
            observed.txBytes = Buffer.from(raw, 'hex');
            assertSameSignedErgoSemantics(
              captured.payment as ErgoTransaction,
              observed,
            );
          }
          if (
            (recoveryJson &&
              raw !== Buffer.from(captured.payment.txBytes).toString('hex')) ||
            wasm.Transaction.sigma_parse_bytes(Buffer.from(raw, 'hex'))
              .id()
              .to_str() !== expected.txId
          )
            throw new Error(
              'Reward completion is not confirmed in its recorded block',
            );
        }
        const assertSettlement =
          await settlement.prepareSnapshotUnderScannerLease();
        if (invalidation) {
          for (const spend of foreign)
            if (
              (await ergo.getTxConfirmationStatus(
                spend.spendTxId!,
                TransactionType.reward,
              )) !== ConfirmationStatus.ConfirmedEnough
            )
              throw new Error(
                'Foreign commitment spend lost confirmation after payment qualification',
              );
        }
        if (
          submission !== 'ready' &&
          ((await ergo.getTxConfirmationStatus(
            expected.txId,
            TransactionType.reward,
          )) !==
            (invalidation
              ? ConfirmationStatus.NotFound
              : ConfirmationStatus.ConfirmedEnough) ||
            (invalidation && (await ergo.isTxInMempool(expected.txId))))
        )
          throw new Error(
            'Reward completion lost confirmation after payment qualification',
          );
        return Object.freeze({
          assertBefore: async (manager: EntityManager) => {
            await assertSettlement(manager);
            await assertReward(manager, false);
          },
          assertAfter: async (
            manager: EntityManager,
            _expected: SigningRowPreimage,
            transition?: { unexpected: boolean },
          ) => {
            if (invalidation && typeof transition?.unexpected !== 'boolean')
              throw new Error('Reward invalidation transition is missing');
            await assertSettlement(
              manager,
              submission
                ? EventStatus.inReward
                : invalidation
                  ? EventStatus.pendingReward
                  : recoveryJson
                    ? EventStatus.inReward
                    : EventStatus.completed,
              transition?.unexpected,
            );
            await assertReward(manager, true, transition?.unexpected);
          },
        });
      },
    });
    return authority;
  }

  /** Builds the reward action authorization from captured source inputs. */
  private async bindInternal(
    input: EventTrigger,
    eventTxId: string,
    agreement: boolean,
    completion?: SigningRowPreimage,
    invalidation = false,
    eager = true,
  ): Promise<BoundAgreementRewardAuthorization> {
    const event = Object.freeze({ ...input });
    const protocol = JSON.stringify(
      EventSerializer.fromEntity(event as ConfirmedEventEntity['eventData']),
    );
    if (!RewardAuthorization.applies(event) || event.toChain === 'ergo')
      throw new Error('Separate Avalanche reward route is not eligible');
    if (typeof eventTxId !== 'string' || eventTxId.trim().length === 0)
      throw new Error('Reward trigger identity is missing');
    const eventId = EventSerializer.getId(event);
    const database = this.dependencies.getDatabase();
    const captured = await database.getEventById(eventId);
    if (
      !captured ||
      (captured.status !== EventStatus.pendingReward &&
        !(agreement && captured.status === EventStatus.inReward)) ||
      captured.eventData.txId !== eventTxId ||
      captured.eventData.eventId !== eventId ||
      typeof captured.eventData.serialized !== 'string' ||
      captured.eventData.serialized.length === 0 ||
      (!completion &&
        (captured.eventData.spendHeight != null ||
          captured.eventData.spendBlock != null ||
          captured.eventData.spendTxId != null ||
          captured.eventData.result != null ||
          captured.eventData.paymentTxId != null)) ||
      JSON.stringify(EventSerializer.fromConfirmedEntity(captured)) !==
        protocol ||
      !Number.isSafeInteger(captured.eventData.id) ||
      captured.eventData.id < 1 ||
      (captured.firstTry !== null && typeof captured.firstTry !== 'string') ||
      !Number.isSafeInteger(captured.unexpectedFails) ||
      captured.unexpectedFails < 0
    )
      throw new Error('Reward event preimage is not eligible');
    this.knownEvents.add(eventId);
    const fingerprint = eventFingerprint(captured);
    const payments = await database.getEventValidTxsByType(
      eventId,
      TransactionType.payment,
    );
    if (
      payments.length !== 1 ||
      payments[0].status !== TransactionStatus.completed
    )
      throw new Error('Reward requires exactly one completed payment');
    const row = payments[0];
    if (
      row.type !== TransactionType.payment ||
      row.chain !== event.toChain ||
      row.event?.id !== eventId ||
      row.order !== null
    )
      throw new Error('Reward payment route mismatch');
    const bound = await this.dependencies.context.bind(row, [
      TransactionStatus.completed,
    ]);
    // Phase may advance after this exact reward is admitted. Payment, trigger and
    // retry counters remain the same authority across that explicit transition.
    const authorityId = JSON.stringify({
      event: eventFingerprint({
        ...captured,
        status: EventStatus.pendingReward,
      }),
      payment: bound.preimage,
    });
    const payment = bound.payment();
    const chain = this.dependencies.getChain(event.toChain);
    if (
      payment.network !== event.toChain ||
      payment.txType !== TransactionType.payment ||
      payment.eventId !== eventId
    )
      throw new Error('Reward payment model route mismatch');
    let signedId: string | undefined;
    if (['avalanche', 'ethereum', 'binance'].includes(payment.network)) {
      const signed = Transaction.from(
        '0x' + Buffer.from(payment.txBytes).toString('hex'),
      );
      if (
        !signed.isSigned() ||
        signed.unsignedHash !== payment.txId ||
        !signed.hash
      )
        throw new Error('Reward payment signed identity mismatch');
      signedId = signed.hash;
    }
    const alias = await chain.getActualTxId(payment.txId);
    if (
      typeof alias !== 'string' ||
      alias.trim().length === 0 ||
      (signedId !== undefined && alias.toLowerCase() !== signedId)
    )
      throw new Error('Reward payment alias mismatch');
    const paymentTxId = signedId ?? alias;
    if (
      completion &&
      (captured.status !== EventStatus.inReward ||
        captured.eventData.result !== 'successful' ||
        captured.eventData.spendTxId !== completion.txId ||
        captured.eventData.paymentTxId !== paymentTxId ||
        !Number.isSafeInteger(captured.eventData.spendHeight) ||
        captured.eventData.spendHeight! < captured.eventData.height ||
        typeof captured.eventData.spendBlock !== 'string' ||
        !/^[0-9a-f]{64}$/.test(captured.eventData.spendBlock))
    )
      throw new Error('Reward completion spend tuple is inconsistent');
    /** Rejects changes to the captured reward input snapshot. */
    const validateSnapshot = async (
      manager: EntityManager,
      phase = captured.status,
      unexpected = false,
    ): Promise<void> => {
      if (
        phase !== captured.status &&
        !(
          agreement &&
          captured.status === EventStatus.pendingReward &&
          phase === EventStatus.inReward
        ) &&
        !(
          completion &&
          captured.status === EventStatus.inReward &&
          phase === EventStatus.completed
        ) &&
        !(
          invalidation &&
          captured.status === EventStatus.inReward &&
          phase === EventStatus.pendingReward
        )
      )
        throw new Error('Unexpected reward authority phase transition');
      const triggers = await manager
        .getRepository(EventTriggerEntity)
        .findBy({ txId: eventTxId });
      const currentEvent = await manager
        .getRepository(ConfirmedEventEntity)
        .findOne({
          where: { id: eventId },
          relations: ['eventData'],
        });
      const currentPayments = (
        await manager.getRepository(TransactionEntity).find({
          where: { event: { id: eventId }, type: TransactionType.payment },
          relations: ['event', 'order'],
        })
      ).filter((candidate) => candidate.status !== TransactionStatus.invalid);
      const current = currentPayments[0];
      const expected = bound.preimage;
      const noOrder = await manager.getRepository(TransactionEntity).existsBy({
        txId: expected.txId,
        order: IsNull(),
      });
      if (
        !noOrder ||
        triggers.length !== 1 ||
        triggers[0].id !== captured.eventData.id ||
        !currentEvent ||
        !currentEvent.eventData ||
        currentEvent.status !== phase ||
        eventFingerprint({
          ...currentEvent,
          status: captured.status,
          unexpectedFails:
            invalidation && phase === EventStatus.pendingReward
              ? currentEvent.unexpectedFails - (unexpected ? 1 : 0)
              : currentEvent.unexpectedFails,
        }) !== fingerprint ||
        currentPayments.length !== 1 ||
        !current ||
        current.txId !== expected.txId ||
        current.txJson !== expected.txJson ||
        current.chain !== expected.chain ||
        current.type !== expected.type ||
        current.status !== TransactionStatus.completed ||
        current.requiredSign !== expected.requiredSign ||
        current.event?.id !== expected.eventId ||
        current.order !== null
      )
        throw new Error('Reward payment or event changed before admission');
    };
    /** Prepares reward inputs while holding the current scanner observation lease. */
    const prepareSnapshotUnderScannerLease = async () => {
      if (
        this.dependencies.getDatabase() !== database ||
        this.dependencies.getChain(event.toChain) !== chain
      )
        throw new Error('Reward authority instance changed');
      const fresh = bound.payment();
      if (
        !(await chain.verifyPaymentTransaction(fresh)) ||
        !chain.verifyTransactionExtraConditions(fresh, SigningStatus.Signed)
      )
        throw new Error('Reward completed payment is inconsistent');
      const currentAlias = await chain.getActualTxId(fresh.txId);
      if (
        typeof currentAlias !== 'string' ||
        (signedId !== undefined ? currentAlias.toLowerCase() : currentAlias) !==
          paymentTxId
      )
        throw new Error('Reward payment alias changed');
      if (
        (await chain.getTxConfirmationStatus(
          paymentTxId,
          TransactionType.payment,
        )) !== ConfirmationStatus.ConfirmedEnough
      )
        throw new Error('Reward payment is not confirmed');
      if (
        this.dependencies.getDatabase() !== database ||
        this.dependencies.getChain(event.toChain) !== chain
      )
        throw new Error('Reward authority instance changed');
      return async (
        manager: EntityManager,
        phase?: string,
        unexpected?: boolean,
      ) => {
        await validateSnapshot(manager, phase, unexpected);
        if (
          this.dependencies.getDatabase() !== database ||
          this.dependencies.getChain(event.toChain) !== chain
        )
          throw new Error('Reward authority instance changed');
      };
    };
    /** Runs the reward action while holding its scanner observation lease. */
    const underLease = async <T>(
      action: (manager: EntityManager) => Promise<T>,
      assertInputs?: (manager: EntityManager) => Promise<void>,
    ): Promise<T> => {
      const assertSnapshot = await prepareSnapshotUnderScannerLease();
      // Own the connection only for the final reads and synchronous admission.
      // Generation, RPC waits, message signing and transport waits stay outside SQL.
      return database.dataSource.transaction(async (manager) => {
        if (assertInputs) await assertInputs(manager);
        await assertSnapshot(manager);
        return action(manager);
      });
    };
    /** Checks reward authority against the current leased scanner observation. */
    const checkUnderScannerLease = (
      action: () => void,
      assertInputs?: (manager: EntityManager) => Promise<void>,
    ): Promise<void> =>
      underLease(async () => {
        const result: unknown = action();
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        )
          throw new Error('Reward admission action must be synchronous');
      }, assertInputs);
    const authorization = Object.freeze({
      authorityId,
      phase: captured.status,
      prepareSnapshotUnderScannerLease,
      event,
      eventTxId,
      paymentTxId,
      withAction: (
        action: () => void,
        assertInputs?: (manager: EntityManager) => Promise<void>,
      ) => bound.withAction(() => checkUnderScannerLease(action, assertInputs)),
      checkUnderScannerLease,
      withManagerAction: <T>(
        action: (
          manager: EntityManager,
          assertSettlement: (phase: string) => Promise<void>,
        ) => Promise<T>,
        assertInputs?: (manager: EntityManager) => Promise<void>,
      ): Promise<T> =>
        bound.withAction(() =>
          underLease(
            (manager) =>
              action(manager, (phase) => validateSnapshot(manager, phase)),
            assertInputs,
          ),
        ),
    });
    if (eager) await authorization.withAction(() => undefined);
    return authorization;
  }
}

export default RewardAuthorization;
