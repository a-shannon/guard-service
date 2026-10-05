import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import type { SigningRowPreimage } from '../../src/signing/transactionSigningContext';
import {
  EventStatus,
  OrderStatus,
  TransactionStatus,
} from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import { mockEventTrigger } from '../event/testData';
import DatabaseActionMock from './mocked/databaseAction.mock';

describe('atomic qualified transaction finalization', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let expected: SigningRowPreimage;
  const txNotify = vi.fn();
  const eventNotify = vi.fn();
  let eventId: string;
  const orderId = 'finalization-order';
  const prepare = async (
    type = TransactionType.payment,
    chain = 'avalanche',
  ) => {
    const event = [TransactionType.payment, TransactionType.reward].includes(
      type,
    );
    const order = type === TransactionType.arbitrary;
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      {
        status:
          type === TransactionType.reward
            ? EventStatus.inReward
            : EventStatus.inPayment,
      },
    );
    const payment = new PaymentTransaction(
      chain,
      'finalization-tx',
      event ? eventId : order ? orderId : '',
      Buffer.from('abcd', 'hex'),
      type,
    );
    await DatabaseActionMock.insertTxRecord(
      payment,
      TransactionStatus.sent,
      123,
      'old-update',
      true,
      4,
      3,
    );
    expected = {
      txId: payment.txId,
      txJson: payment.toJson(),
      chain,
      type,
      status: TransactionStatus.sent,
      requiredSign: 3,
      eventId: event ? eventId : null,
      orderId: order ? orderId : null,
    };
  };
  const state = async () => ({
    tx: await db().getTxById('finalization-tx'),
    event: await db().ConfirmedEventRepository.findOneByOrFail({ id: eventId }),
    order: await db().getOrderById(orderId),
  });

  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    const event = mockEventTrigger().event;
    eventId = Utils.txIdToEventId(event.sourceTxId);
    await DatabaseActionMock.insertEventRecord(
      event,
      EventStatus.inPayment,
      undefined,
      undefined,
      'event-first',
    );
    await DatabaseActionMock.insertOrderRecord(
      orderId,
      'ergo',
      '[]',
      OrderStatus.inProcess,
      'order-first',
    );
    txNotify.mockReset().mockResolvedValue(undefined);
    eventNotify.mockReset().mockResolvedValue(undefined);
    vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    ).mockImplementation(txNotify);
    vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicEventStatus',
    ).mockImplementation(eventNotify);
  });
  afterEach(() => vi.restoreAllMocks());

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'commits %s on %s and preserves unrelated fields'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'commits %s on %s and preserves unrelated fields' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected txNotify.mockImplementation(async () => { expect(runners.every((runner) => !runner.isTransactionActive)).toBe( true, ); }); expect(runners.every((runner) => !runner.isTransactionActive)).toBe( true, ); await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(true); expect( commits.reduce((count, commit) => count + commit.mock.calls.length, 0), ).toBe(1); expect(after.tx).toMatchObject({ status: TransactionStatus.completed, txJson: expected.txJson, lastCheck: 123, lastStatusUpdate: String(now / 1000), failedInSign: true, signFailedCount: 4, requiredSign: 3, }); expect(txNotify).toHaveBeenCalledExactlyOnceWith( expected.txId, TransactionStatus.completed, ); expect(after.event).toEqual({ ...before.event, status: eventStatus, firstTry: eventStatus === EventStatus.pendingReward ? String(now / 1000) : 'event-first', }); expect(eventNotify).toHaveBeenCalledExactlyOnceWith( eventId, eventStatus, ); expect(after.event).toEqual(before.event); expect(eventNotify).not.toHaveBeenCalled(); expect(after.order).toEqual( type === TransactionType.arbitrary ? { ...before.order, status: OrderStatus.completed } : before.order, ); await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false); expect(txNotify).toHaveBeenCalledTimes(1);
   */
  it.each([
    [TransactionType.payment, 'avalanche', EventStatus.pendingReward],
    [TransactionType.payment, 'ergo', EventStatus.completed],
    [TransactionType.reward, 'ergo', EventStatus.completed],
    [TransactionType.arbitrary, 'ergo', null],
    [TransactionType.coldStorage, 'ergo', null],
    [TransactionType.manual, 'ergo', null],
  ] as const)(
    'commits %s on %s and preserves unrelated fields',
    async (type, chain, eventStatus) => {
      await prepare(type, chain);
      const before = await state();
      const now = 1730000000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const createRunner = db().dataSource.createQueryRunner.bind(
        db().dataSource,
      );
      const runners: ReturnType<typeof createRunner>[] = [];
      const commits: ReturnType<typeof vi.fn>[] = [];
      vi.spyOn(db().dataSource, 'createQueryRunner').mockImplementation(
        (mode) => {
          const runner = createRunner(mode);
          runners.push(runner);
          const committed = vi.fn();
          const commit = runner.commitTransaction.bind(runner);
          vi.spyOn(runner, 'commitTransaction').mockImplementation(async () => {
            await commit();
            committed();
          });
          commits.push(committed);
          return runner;
        },
      );
      txNotify.mockImplementation(async () => {
        expect(runners.every((runner) => !runner.isTransactionActive)).toBe(
          true,
        );
      });
      await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(true);
      expect(
        commits.reduce((count, commit) => count + commit.mock.calls.length, 0),
      ).toBe(1);
      const after = await state();
      expect(after.tx).toMatchObject({
        status: TransactionStatus.completed,
        txJson: expected.txJson,
        lastCheck: 123,
        lastStatusUpdate: String(now / 1000),
        failedInSign: true,
        signFailedCount: 4,
        requiredSign: 3,
      });
      expect(txNotify).toHaveBeenCalledExactlyOnceWith(
        expected.txId,
        TransactionStatus.completed,
      );
      if (eventStatus) {
        expect(after.event).toEqual({
          ...before.event,
          status: eventStatus,
          firstTry:
            eventStatus === EventStatus.pendingReward
              ? String(now / 1000)
              : 'event-first',
        });
        expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
          eventId,
          eventStatus,
        );
      } else {
        expect(after.event).toEqual(before.event);
        expect(eventNotify).not.toHaveBeenCalled();
      }
      expect(after.order).toEqual(
        type === TransactionType.arbitrary
          ? { ...before.order, status: OrderStatus.completed }
          : before.order,
      );
      await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false);
      expect(txNotify).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'rejects missing %s before a transaction begins'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects missing %s before a transaction begins' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().finalizeTxIfUnchanged({ ...expected, [field]: undefined, } as unknown as SigningRowPreimage), ).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled(); expect(txNotify).not.toHaveBeenCalled();
   */
  it.each([
    'txId',
    'txJson',
    'chain',
    'type',
    'status',
    'requiredSign',
    'eventId',
    'orderId',
  ] as const)(
    'rejects missing %s before a transaction begins',
    async (field) => {
      await prepare();
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(
        db().finalizeTxIfUnchanged({
          ...expected,
          [field]: undefined,
        } as unknown as SigningRowPreimage),
      ).rejects.toThrow('preimage');
      expect(transaction).not.toHaveBeenCalled();
      expect(txNotify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'preserves all rows on isolated %s mismatch'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'preserves all rows on isolated %s mismatch' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().finalizeTxIfUnchanged({ ...expected, [field]: value }), ).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each([
    ['txId', 'different'],
    ['txJson', 'replacement'],
    ['chain', 'ethereum'],
    ['requiredSign', 4],
    ['eventId', 'missing-event'],
  ] as const)(
    'preserves all rows on isolated %s mismatch',
    async (field, value) => {
      await prepare();
      const before = await state();
      await expect(
        db().finalizeTxIfUnchanged({ ...expected, [field]: value }),
      ).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'rejects non-sent preimage %s before writing'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects non-sent preimage %s before writing' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().finalizeTxIfUnchanged({ ...expected, status }), ).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
   */
  it.each(
    Object.values(TransactionStatus).filter(
      (status) => status !== TransactionStatus.sent,
    ),
  )('rejects non-sent preimage %s before writing', async (status) => {
    await prepare();
    const transaction = vi.spyOn(db().dataSource, 'transaction');
    await expect(
      db().finalizeTxIfUnchanged({ ...expected, status }),
    ).rejects.toThrow('preimage');
    expect(transaction).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'rejects invalid association %s/%s/%s before writing'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid association %s/%s/%s before writing' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().finalizeTxIfUnchanged({ ...expected, type, eventId: event, orderId: order, }), ).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled(); expect(txNotify).not.toHaveBeenCalled();
   */
  it.each([
    [TransactionType.payment, null, null],
    [TransactionType.reward, null, null],
    [TransactionType.payment, 'event', 'order'],
    [TransactionType.reward, 'event', 'order'],
    [TransactionType.arbitrary, null, null],
    [TransactionType.arbitrary, 'event', 'order'],
    [TransactionType.coldStorage, 'event', null],
    [TransactionType.coldStorage, null, 'order'],
    [TransactionType.manual, 'event', null],
    [TransactionType.manual, null, 'order'],
    [TransactionType.lock, null, null],
    ['unknown', null, null],
  ] as const)(
    'rejects invalid association %s/%s/%s before writing',
    async (type, event, order) => {
      await prepare();
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(
        db().finalizeTxIfUnchanged({
          ...expected,
          type,
          eventId: event,
          orderId: order,
        }),
      ).rejects.toThrow('preimage');
      expect(transaction).not.toHaveBeenCalled();
      expect(txNotify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'refuses a missing or wrong-phase %s relation without completing the transaction'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'refuses a missing or wrong-phase %s relation without completing the transaction' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled(); await expect( db().finalizeTxIfUnchanged({ ...expected, ...(type === TransactionType.arbitrary ? { orderId: 'missing' } : { eventId: 'missing' }), }), ).resolves.toBe(false);
   */
  it.each([
    TransactionType.payment,
    TransactionType.reward,
    TransactionType.arbitrary,
  ])(
    'refuses a missing or wrong-phase %s relation without completing the transaction',
    async (type) => {
      await prepare(type);
      if (type === TransactionType.arbitrary)
        await db().ArbitraryRepository.update(
          { id: orderId },
          { status: OrderStatus.completed },
        );
      else
        await db().ConfirmedEventRepository.update(
          { id: eventId },
          {
            status:
              type === TransactionType.payment
                ? EventStatus.inReward
                : EventStatus.inPayment,
          },
        );
      const before = await state();
      await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
      await expect(
        db().finalizeTxIfUnchanged({
          ...expected,
          ...(type === TransactionType.arbitrary
            ? { orderId: 'missing' }
            : { eventId: 'missing' }),
        }),
      ).resolves.toBe(false);
    },
  );

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'preserves a replacement row written after capture'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'preserves a replacement row written after capture' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled();
   */
  it('preserves a replacement row written after capture', async () => {
    await prepare();
    await db().TransactionRepository.update(
      { txId: expected.txId },
      { txJson: 'concurrent-winner' },
    );
    const before = await state();
    await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false);
    expect(await state()).toEqual(before);
    expect(txNotify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'refuses stored %s drift even with a valid original association'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'refuses stored %s drift even with a valid original association' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each([
    ['type', TransactionType.reward],
    ['status', TransactionStatus.signed],
  ] as const)(
    'refuses stored %s drift even with a valid original association',
    async (field, value) => {
      await prepare();
      await db().TransactionRepository.update(
        { txId: expected.txId },
        { [field]: value },
      );
      const before = await state();
      await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'rejects a different populated %s despite its valid phase'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects a different populated %s despite its valid phase' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().finalizeTxIfUnchanged({ ...expected, [relation === 'event' ? 'eventId' : 'orderId']: alternate, }), ).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each(['event', 'order'] as const)(
    'rejects a different populated %s despite its valid phase',
    async (relation) => {
      await prepare(
        relation === 'event'
          ? TransactionType.payment
          : TransactionType.arbitrary,
      );
      let alternate: string;
      if (relation === 'event') {
        const event = {
          ...mockEventTrigger().event,
          sourceTxId: 'ab'.repeat(32),
        };
        alternate = Utils.txIdToEventId(event.sourceTxId);
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.inPayment,
        );
      } else {
        alternate = 'another-order';
        await DatabaseActionMock.insertOrderRecord(
          alternate,
          'ergo',
          '[]',
          OrderStatus.inProcess,
        );
      }
      const before = await state();
      await expect(
        db().finalizeTxIfUnchanged({
          ...expected,
          [relation === 'event' ? 'eventId' : 'orderId']: alternate,
        }),
      ).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'does not recreate a missing transaction or advance its event'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'does not recreate a missing transaction or advance its event' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it('does not recreate a missing transaction or advance its event', async () => {
    await prepare();
    await db().TransactionRepository.delete({ txId: expected.txId });
    const before = await state();
    await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false);
    expect(await state()).toEqual(before);
    expect(txNotify).not.toHaveBeenCalled();
    expect(eventNotify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'commits exactly one of two overlapping finalizations'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'commits exactly one of two overlapping finalizations' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected expect(results.sort()).toEqual([false, true]); expect((await state()).tx!.status).toBe(TransactionStatus.completed); expect(txNotify).toHaveBeenCalledTimes(1); expect(eventNotify).toHaveBeenCalledTimes(1);
   */
  it('commits exactly one of two overlapping finalizations', async () => {
    await prepare();
    const results = await Promise.all([
      db().finalizeTxIfUnchanged(expected),
      db().finalizeTxIfUnchanged(expected),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await state()).tx!.status).toBe(TransactionStatus.completed);
    expect(txNotify).toHaveBeenCalledTimes(1);
    expect(eventNotify).toHaveBeenCalledTimes(1);
  });

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'rolls back the first write on %s second-write SQL failure'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back the first write on %s second-write SQL failure' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect(db().finalizeTxIfUnchanged(expected)).rejects.toThrow( 'fixture second write', ); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each([TransactionType.payment, TransactionType.arbitrary])(
    'rolls back the first write on %s second-write SQL failure',
    async (type) => {
      await prepare(type);
      const before = await state();
      const table =
        type === TransactionType.arbitrary
          ? 'arbitrary_entity'
          : 'confirmed_event_entity';
      await db().dataSource.query(
        `CREATE TEMP TRIGGER fail_finalization BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture second write'); END`,
      );
      try {
        await expect(db().finalizeTxIfUnchanged(expected)).rejects.toThrow(
          'fixture second write',
        );
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER fail_finalization');
      }
    },
  );

  /**
   * @target DatabaseAction.finalizeTxIfUnchanged 'rolls back when %s second-write CAS affects zero rows'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back when %s second-write CAS affects zero rows' through finalizeTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each([TransactionType.payment, TransactionType.arbitrary])(
    'rolls back when %s second-write CAS affects zero rows',
    async (type) => {
      await prepare(type);
      const before = await state();
      const table =
        type === TransactionType.arbitrary
          ? 'arbitrary_entity'
          : 'confirmed_event_entity';
      await db().dataSource.query(
        `CREATE TEMP TRIGGER skip_finalization BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
      );
      try {
        await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER skip_finalization');
      }
    },
  );
});
