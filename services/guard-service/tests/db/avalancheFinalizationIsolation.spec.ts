import { setTimeout as delay } from 'node:timers/promises';

import {
  EntitySubscriberInterface,
  UpdateEvent,
} from '@rosen-bridge/extended-typeorm';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import type { SigningRowPreimage } from '../../src/signing/transactionSigningContext';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import { mockEventTrigger } from '../event/testData';
import DatabaseActionMock from './mocked/databaseAction.mock';

describe('finalization isolation from ordinary repository operations', () => {
  const db = () => DatabaseActionMock.testDatabase;

  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicEventStatus',
    ).mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'foreign writes survive and foreign reads wait (rollback=%s)'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'foreign writes survive and foreign reads wait (rollback=%s)' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected expect(early).toBe('waiting'); expect(outcome.error?.message).toContain('isolated rollback'); expect(observed?.status).toBe(TransactionStatus.sent); expect(outcome.result).toBe(true); expect(observed?.status).toBe(TransactionStatus.completed); expect((await db().getTxById(unrelated.txId))?.txJson).toBe( 'independent-success', ); expect( (await db().ConfirmedEventRepository.findOneByOrFail({ id: eventId })) .status, ).toBe(rollback ? EventStatus.inPayment : EventStatus.pendingReward);
   */
  it.each([false, true])(
    'foreign writes survive and foreign reads wait (rollback=%s)',
    async (rollback) => {
      const event = mockEventTrigger().event;
      const eventId = Utils.txIdToEventId(event.sourceTxId);
      await DatabaseActionMock.insertEventRecord(event, EventStatus.inPayment);
      const payment = new PaymentTransaction(
        'avalanche',
        'isolation-finalization',
        eventId,
        Buffer.from('abcd', 'hex'),
        TransactionType.payment,
      );
      await DatabaseActionMock.insertTxRecord(
        payment,
        TransactionStatus.sent,
        0,
        undefined,
        false,
        0,
        3,
      );
      const unrelated = new PaymentTransaction(
        'ethereum',
        'independent-writer',
        '',
        Buffer.from('dcba', 'hex'),
        TransactionType.manual,
      );
      await DatabaseActionMock.insertTxRecord(
        unrelated,
        TransactionStatus.approved,
        0,
      );
      const expected: SigningRowPreimage = {
        txId: payment.txId,
        txJson: payment.toJson(),
        chain: payment.network,
        type: payment.txType,
        status: TransactionStatus.sent,
        requiredSign: 3,
        eventId,
        orderId: null,
      };
      let announce!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => (announce = resolve));
      const paused = new Promise<void>((resolve) => (resume = resolve));
      const subscriber: EntitySubscriberInterface<TransactionEntity> = {
        listenTo: () => TransactionEntity,
        afterUpdate: async (update: UpdateEvent<TransactionEntity>) => {
          if (update.entity?.status !== TransactionStatus.completed) return;
          announce();
          await paused;
        },
      };
      const source = db().dataSource;
      source.subscribers.push(subscriber);
      if (rollback)
        await source.query(
          "CREATE TEMP TRIGGER reject_isolated_finalization BEFORE UPDATE ON confirmed_event_entity BEGIN SELECT RAISE(ABORT, 'isolated rollback'); END",
        );
      const finalizing = db()
        .finalizeTxIfUnchanged(expected)
        .then(
          (result) => ({ result, error: undefined }),
          (error: Error) => ({ result: undefined, error }),
        );
      let writer: Promise<unknown> | undefined;
      let reader: Promise<TransactionEntity | null> | undefined;
      try {
        await entered;
        writer = db().TransactionRepository.update(
          { txId: unrelated.txId },
          { txJson: 'independent-success' },
        );
        reader = db().getTxById(payment.txId);
        const early = await Promise.race([
          writer.then(() => 'writer escaped'),
          reader.then(() => 'reader escaped'),
          delay(30).then(() => 'waiting'),
        ]);
        resume();
        const [outcome, , observed] = await Promise.all([
          finalizing,
          writer,
          reader,
        ]);
        expect(early).toBe('waiting');
        if (rollback) {
          expect(outcome.error?.message).toContain('isolated rollback');
          expect(observed?.status).toBe(TransactionStatus.sent);
        } else {
          expect(outcome.result).toBe(true);
          expect(observed?.status).toBe(TransactionStatus.completed);
        }
        expect((await db().getTxById(unrelated.txId))?.txJson).toBe(
          'independent-success',
        );
        expect(
          (await db().ConfirmedEventRepository.findOneByOrFail({ id: eventId }))
            .status,
        ).toBe(rollback ? EventStatus.inPayment : EventStatus.pendingReward);
      } finally {
        resume();
        await Promise.allSettled([finalizing, writer, reader]);
        source.subscribers.splice(source.subscribers.indexOf(subscriber), 1);
        if (rollback)
          await source.query('DROP TRIGGER reject_isolated_finalization');
      }
    },
  );
});
