import { isEqual } from 'lodash-es';

import { EntityManager, IsNull } from '@rosen-bridge/extended-typeorm';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import { DatabaseAction } from '../db/databaseAction';
import { ConfirmedEventEntity } from '../db/entities/confirmedEventEntity';
import { TransactionEntity } from '../db/entities/transactionEntity';
import EventOrder from '../event/eventOrder';
import EventSerializer from '../event/eventSerializer';
import ChainHandler from '../handlers/chainHandler';
import PublicStatusHandler from '../handlers/publicStatusHandler';
import * as TransactionSerializer from '../transaction/transactionSerializer';
import { EventStatus, TransactionStatus } from '../utils/constants';
import RewardAuthorization, {
  BoundAgreementRewardAuthorization,
} from '../verification/rewardAuthorization';
import TransactionVerifier from '../verification/transactionVerifier';

/** Authority retained across request, quorum, approval and an exact-row retry. */
export class AvalancheRewardAdmission {
  /** Retains the captured payment, settlement authority, order inputs and quorum. */
  private constructor(
    private readonly reward: ReturnType<
      typeof RewardAuthorization.captureReward
    >,
    private readonly authorization: RewardAuthorization,
    private readonly initial: BoundAgreementRewardAuthorization,
    private readonly inputs: Awaited<
      ReturnType<RewardAuthorization['captureOrderInputs']>
    >,
    readonly requiredSign: number,
    private readonly assertAuthority: () => void,
  ) {}

  /** Binds an applicable reward to its event and retained settlement authority. */
  static async bind(
    input: PaymentTransaction,
    requiredSign: number,
    assertAuthority: () => void,
  ): Promise<AvalancheRewardAdmission | undefined> {
    const retained = RewardAuthorization.capturedAuthority(input);
    if (input.txType !== TransactionType.reward) return undefined;
    // Capture actual fields as well as JSON before the first database await.
    const before = this.fingerprint(input);
    const id = input.eventId;
    const event = await DatabaseAction.getInstance().getEventById(id);
    if (!event) throw new Error('Reward agreement event is missing');
    if (this.fingerprint(input) !== before)
      throw new Error('Reward agreement input changed');
    const protocol = EventSerializer.fromConfirmedEntity(event);
    if (!RewardAuthorization.applies(protocol)) {
      if (retained !== undefined || RewardAuthorization.remembersEvent(id))
        throw new Error('Known Avalanche reward route changed');
      return undefined;
    }
    assertAuthority();
    if (!Number.isSafeInteger(requiredSign) || requiredSign < 1)
      throw new Error('Invalid reward quorum');
    const reward = RewardAuthorization.captureReward(input, id);
    const authorization = RewardAuthorization.getInstance();
    const initial = await authorization.bindForAgreement(
      protocol,
      event.eventData.txId,
    );
    if (retained !== undefined && retained !== initial.authorityId)
      throw new Error('Queued reward authority changed');
    const inputs = await authorization.captureOrderInputs(
      initial.event,
      initial.eventTxId,
    );
    const result = new AvalancheRewardAdmission(
      reward,
      authorization,
      initial,
      inputs,
      requiredSign,
      assertAuthority,
    );
    await result.withAction(() => reward.retainAuthority(initial), true);
    return result;
  }

  /** Serializes payment fields and optional input bytes for mutation detection. */
  static fingerprint(tx: PaymentTransaction): string {
    const extra = tx as PaymentTransaction & {
      inputBoxes?: Uint8Array[];
      dataInputs?: Uint8Array[];
    };
    return JSON.stringify([
      tx.toJson(),
      tx.network,
      tx.txId,
      tx.eventId,
      tx.txType,
      Buffer.from(tx.txBytes).toString('hex'),
      extra.inputBoxes?.map((b) => Buffer.from(b).toString('hex')),
      extra.dataInputs?.map((b) => Buffer.from(b).toString('hex')),
    ]);
  }

  /** Returns the payment retained by the reward capture. */
  get payment(): PaymentTransaction {
    return this.reward.payment;
  }
  /** Computes the agreement data hash of the retained payment. */
  get hash(): string {
    return TransactionSerializer.getTxDataHash(this.payment);
  }

  /** Rejects candidate mutation, changed retained authority or a revoked caller authority. */
  assertCandidate(input: PaymentTransaction): void {
    const retained = RewardAuthorization.capturedAuthority(input);
    if (retained !== undefined && retained !== this.initial.authorityId)
      throw new Error('Queued reward authority changed');
    this.reward.assertUnchanged();
    if (
      AvalancheRewardAdmission.fingerprint(input) !==
      AvalancheRewardAdmission.fingerprint(this.payment)
    )
      throw new Error('Reward agreement candidate changed');
    this.assertAuthority();
  }

  /** Rebinds settlement and checks common conditions and the captured expected order. */
  private async refresh(): Promise<BoundAgreementRewardAuthorization> {
    this.assertCandidate(this.payment);
    if (RewardAuthorization.getInstance() !== this.authorization)
      throw new Error('Reward authority instance changed');
    const fresh = await this.authorization.bindForAgreement(
      this.initial.event,
      this.initial.eventTxId,
    );
    if (fresh.authorityId !== this.initial.authorityId)
      throw new Error('Reward settlement authority changed');
    if (!(await TransactionVerifier.verifyTxCommonConditions(this.payment)))
      throw new Error('Reward common conditions failed');
    const order = ChainHandler.getInstance()
      .getErgoChain()
      .extractTransactionOrder(this.payment);
    const expected = await EventOrder.createEventRewardOrder(
      fresh.event,
      fresh.eventTxId,
      this.inputs.feeConfig,
      fresh.paymentTxId,
      [...this.inputs.eventWIDs],
    );
    if (!isEqual(order, expected)) throw new Error('Reward order mismatch');
    return fresh;
  }

  /** Rechecks the retained candidate and captured fee policy before an action. */
  private assertCurrent = (): void => {
    this.assertCandidate(this.payment);
    this.inputs.assertFee();
  };

  /** Validates the reward row and any permitted replacement for the current event phase. */
  private async rewardState(
    manager: EntityManager,
    phase: string,
    allowReplacement = false,
  ): Promise<TransactionEntity | undefined> {
    const repository = manager.getRepository(TransactionEntity);
    const sameId = await repository.findOne({
      where: { txId: this.payment.txId },
      relations: ['event', 'order'],
    });
    const active = (
      await repository.find({
        where: {
          event: { id: this.payment.eventId },
          type: TransactionType.reward,
        },
        relations: ['event', 'order'],
      })
    ).filter((row) => row.status !== TransactionStatus.invalid);
    if (sameId?.status === TransactionStatus.invalid || active.length > 1)
      throw new Error('Reward admission conflict');
    const row = active[0];
    if (
      row &&
      !(await repository.existsBy({ txId: row.txId, order: IsNull() }))
    )
      throw new Error('Reward order association changed');
    if (phase === EventStatus.pendingReward) {
      if (row || sameId)
        throw new Error('Pending reward already has a transaction');
    } else if (phase === EventStatus.inReward) {
      if (
        !row ||
        row.chain !== 'ergo' ||
        row.order !== null ||
        row.requiredSign !== this.requiredSign ||
        ![TransactionStatus.approved, TransactionStatus.signFailed].includes(
          row.status,
        )
      )
        throw new Error('Existing reward is not eligible for agreement');
      const existing = RewardAuthorization.captureReward(
        ErgoTransaction.fromJson(row.txJson),
        this.payment.eventId,
      ).payment;
      if (existing.txId !== row.txId || existing.toJson() !== row.txJson)
        throw new Error('Existing reward database model differs');
      if (row.txId === this.payment.txId) {
        if (row.txJson !== this.payment.toJson())
          throw new Error('Existing reward model differs');
      } else if (
        !allowReplacement ||
        sameId ||
        row.status !== TransactionStatus.approved ||
        this.payment.txId >= row.txId
      )
        throw new Error('Reward replacement is not eligible');
    } else throw new Error('Reward event phase is not eligible');
    return row;
  }

  /** Runs an action under fresh settlement authority and manager-owned reward checks. */
  async withAction(
    action: () => void,
    allowReplacement = false,
  ): Promise<void> {
    const fresh = await this.refresh();
    await fresh.withAction(
      () => {
        this.assertCurrent();
        action();
      },
      async (manager) => {
        await this.inputs.assertInputs(manager);
        await this.rewardState(manager, fresh.phase, allowReplacement);
      },
    );
  }

  /** All writes use the already-owned manager, never the global repositories. */
  async persist(assertMemory: () => void): Promise<void> {
    const height = await ChainHandler.getInstance().getErgoChain().getHeight();
    if (!Number.isSafeInteger(height) || height < 0)
      throw new Error('Invalid reward admission height');
    const fresh = await this.refresh();
    const tx = this.payment;
    const now = String(Math.round(Date.now() / 1000));
    let persistedStatus = TransactionStatus.approved;
    await fresh.withManagerAction(async (manager, assertSettlement) => {
      const repository = manager.getRepository(TransactionEntity);
      const old = await this.rewardState(manager, fresh.phase, true);
      const events = manager.getRepository(ConfirmedEventEntity);
      const event = await events.findOneOrFail({
        where: { id: tx.eventId, status: fresh.phase },
        relations: ['eventData'],
      });
      await assertSettlement(fresh.phase);
      this.assertCurrent();
      assertMemory();
      if (old) {
        const changed =
          old.txId === tx.txId
            ? { failedInSign: false }
            : {
                txId: tx.txId,
                txJson: tx.toJson(),
                lastCheck: height,
                lastStatusUpdate: now,
                failedInSign: false,
              };
        const updated = await repository.update(
          {
            txId: old.txId,
            txJson: old.txJson,
            chain: old.chain,
            type: old.type,
            status: old.status,
            requiredSign: old.requiredSign,
            event: { id: tx.eventId },
            order: IsNull(),
            lastCheck: old.lastCheck,
            failedInSign: old.failedInSign,
            signFailedCount: old.signFailedCount,
            lastStatusUpdate:
              old.lastStatusUpdate == null ? IsNull() : old.lastStatusUpdate,
          },
          changed,
        );
        if (updated.affected !== 1) throw new Error('Reward update conflict');
      } else {
        await repository.insert({
          txId: tx.txId,
          txJson: tx.toJson(),
          chain: tx.network,
          type: tx.txType,
          status: TransactionStatus.approved,
          requiredSign: this.requiredSign,
          event: { id: tx.eventId },
          order: null,
          lastCheck: height,
          lastStatusUpdate: now,
          failedInSign: false,
          signFailedCount: 0,
        });
      }
      const saved = await repository.findOne({
        where: { txId: tx.txId },
        relations: ['event', 'order'],
      });
      if (
        !saved ||
        saved.txJson !== tx.toJson() ||
        saved.event?.id !== tx.eventId ||
        saved.order !== null ||
        saved.chain !== tx.network ||
        saved.type !== tx.txType ||
        saved.requiredSign !== this.requiredSign ||
        saved.status !==
          (old?.txId === tx.txId ? old.status : TransactionStatus.approved) ||
        saved.lastCheck !== (old?.txId === tx.txId ? old.lastCheck : height) ||
        saved.lastStatusUpdate !==
          (old?.txId === tx.txId ? old.lastStatusUpdate : now) ||
        saved.signFailedCount !== (old?.signFailedCount ?? 0) ||
        saved.failedInSign
      )
        throw new Error('Reward insert was not persisted exactly');
      this.assertCurrent();
      assertMemory();
      const transitioned = await events.update(
        {
          id: tx.eventId,
          status: fresh.phase,
          firstTry: event.firstTry == null ? IsNull() : event.firstTry,
          unexpectedFails: event.unexpectedFails,
          eventData: { id: event.eventData.id },
        },
        { status: EventStatus.inReward },
      );
      if (transitioned.affected !== 1) throw new Error('Reward phase conflict');
      await assertSettlement(EventStatus.inReward);
      await this.inputs.assertInputs(manager);
      const final = await this.rewardState(manager, EventStatus.inReward);
      /** Compares persisted reward fields with event and order relations reduced to IDs. */
      const rowFingerprint = (row: TransactionEntity) =>
        JSON.stringify({
          ...row,
          event: row.event?.id,
          order: row.order?.id ?? null,
        });
      if (!final || rowFingerprint(final) !== rowFingerprint(saved))
        throw new Error('Reward post-write state differs');
      persistedStatus = saved.status;
      this.assertCurrent();
      assertMemory();
    }, this.inputs.assertInputs);
    void PublicStatusHandler.getInstance().updatePublicTxStatus(
      tx.txId,
      persistedStatus,
    );
    void PublicStatusHandler.getInstance().updatePublicEventStatus(
      tx.eventId,
      EventStatus.inReward,
    );
  }
}
