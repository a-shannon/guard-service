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
import {
  EventStatus,
  OrderStatus,
  TransactionStatus,
} from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import { mockEventTrigger } from '../event/testData';
import DatabaseActionMock from './mocked/databaseAction.mock';

describe('atomic checked transaction invalidation', () => {
  const db = () => DatabaseActionMock.testDatabase;
  const txId = 'invalidation-tx';
  const orderId = 'invalidation-order';
  let eventId: string;
  let expected: SigningRowPreimage;
  const txNotify = vi.fn();
  const eventNotify = vi.fn();
  const prepare = async (
    type = TransactionType.payment,
    status = TransactionStatus.sent,
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
    const tx = new PaymentTransaction(
      chain,
      txId,
      event ? eventId : order ? orderId : '',
      Buffer.from('abcd', 'hex'),
      type,
    );
    await DatabaseActionMock.insertTxRecord(
      tx,
      status,
      123,
      'old-update',
      true,
      4,
      3,
    );
    expected = {
      txId,
      txJson: tx.toJson(),
      chain,
      type,
      status,
      requiredSign: 3,
      eventId: event ? eventId : null,
      orderId: order ? orderId : null,
    };
  };
  const state = async () => ({
    tx: await db().getTxById(txId),
    event: await db().ConfirmedEventRepository.findOneBy({ id: eventId }),
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
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { unexpectedFails: 5 },
    );
    await DatabaseActionMock.insertOrderRecord(
      orderId,
      'ergo',
      '[]',
      OrderStatus.inProcess,
      'order-first',
    );
    await db().ArbitraryRepository.update(
      { id: orderId },
      { unexpectedFails: 7 },
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

  for (const status of [TransactionStatus.sent, TransactionStatus.signFailed]) {
    for (const unexpected of [false, true]) {
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged `invalidates %s on %s from ${status} (unexpected=${unexpected})`
       * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
       * @scenario Exercise `invalidates %s on %s from ${status} (unexpected=${unexpected})` through invalidateTxIfUnchanged using the named isolated input or authority change.
       * @expected txNotify.mockImplementation(() => expect(committed).toBe(true)); eventNotify.mockImplementation(() => expect(committed).toBe(true)); await expect( db().invalidateTxIfUnchanged(expected, 123, unexpected), ).resolves.toBe(true); expect(after.tx).toEqual({ ...before.tx, status: TransactionStatus.invalid, lastStatusUpdate: '1730000000', event: before.tx!.event === null ? null : after.event, order: before.tx!.order === null ? null : after.order, }); expect(after.event).toEqual( eventStatus ? { ...before.event, status: eventStatus, unexpectedFails: 5 + Number(unexpected), } : before.event, ); expect(after.order).toEqual( type === TransactionType.arbitrary ? { ...before.order, status: OrderStatus.pending, unexpectedFails: 7 + Number(unexpected), } : before.order, ); expect(txNotify).toHaveBeenCalledExactlyOnceWith( txId, TransactionStatus.invalid, ); expect(eventNotify).toHaveBeenCalledExactlyOnceWith( eventId, eventStatus, ); expect(eventNotify).not.toHaveBeenCalled(); await expect( db().invalidateTxIfUnchanged(expected, 123, unexpected), ).resolves.toBe(false); expect(await state()).toEqual(after); expect(txNotify).toHaveBeenCalledTimes(1);
       */
      it.each([
        [TransactionType.payment, 'avalanche', EventStatus.pendingPayment],
        [TransactionType.payment, 'ergo', EventStatus.pendingPayment],
        [TransactionType.reward, 'ergo', EventStatus.pendingReward],
        [TransactionType.arbitrary, 'ergo', null],
        [TransactionType.coldStorage, 'ethereum', null],
        [TransactionType.manual, 'ergo', null],
      ] as const)(
        `invalidates %s on %s from ${status} (unexpected=${unexpected})`,
        async (type, chain, eventStatus) => {
          await prepare(type, status, chain);
          const before = await state();
          vi.spyOn(Date, 'now').mockReturnValue(1730000000000);
          const transaction = db().dataSource.transaction.bind(db().dataSource);
          let committed = false;
          vi.spyOn(db().dataSource, 'transaction').mockImplementation(
            async (...args: Parameters<typeof transaction>) => {
              const result = await transaction(...args);
              committed = true;
              return result;
            },
          );
          txNotify.mockImplementation(() => expect(committed).toBe(true));
          eventNotify.mockImplementation(() => expect(committed).toBe(true));
          await expect(
            db().invalidateTxIfUnchanged(expected, 123, unexpected),
          ).resolves.toBe(true);
          const after = await state();
          expect(after.tx).toEqual({
            ...before.tx,
            status: TransactionStatus.invalid,
            lastStatusUpdate: '1730000000',
            event: before.tx!.event === null ? null : after.event,
            order: before.tx!.order === null ? null : after.order,
          });
          expect(after.event).toEqual(
            eventStatus
              ? {
                  ...before.event,
                  status: eventStatus,
                  unexpectedFails: 5 + Number(unexpected),
                }
              : before.event,
          );
          expect(after.order).toEqual(
            type === TransactionType.arbitrary
              ? {
                  ...before.order,
                  status: OrderStatus.pending,
                  unexpectedFails: 7 + Number(unexpected),
                }
              : before.order,
          );
          expect(txNotify).toHaveBeenCalledExactlyOnceWith(
            txId,
            TransactionStatus.invalid,
          );
          if (eventStatus)
            expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
              eventId,
              eventStatus,
            );
          else expect(eventNotify).not.toHaveBeenCalled();
          await expect(
            db().invalidateTxIfUnchanged(expected, 123, unexpected),
          ).resolves.toBe(false);
          expect(await state()).toEqual(after);
          expect(txNotify).toHaveBeenCalledTimes(1);
        },
      );
    }
  }

  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'rejects undefined %s before opening a transaction'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects undefined %s before opening a transaction' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged( { ...expected, [field]: undefined } as unknown as SigningRowPreimage, 123, false, ), ).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled(); expect(txNotify).not.toHaveBeenCalled();
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
    'rejects undefined %s before opening a transaction',
    async (field) => {
      await prepare();
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(
        db().invalidateTxIfUnchanged(
          { ...expected, [field]: undefined } as unknown as SigningRowPreimage,
          123,
          false,
        ),
      ).rejects.toThrow('preimage');
      expect(transaction).not.toHaveBeenCalled();
      expect(txNotify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'rejects invalid lastCheck %s before query'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid lastCheck %s before query' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged(expected, lastCheck as number, false), ).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
   */
  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    '123',
  ])('rejects invalid lastCheck %s before query', async (lastCheck) => {
    await prepare();
    const transaction = vi.spyOn(db().dataSource, 'transaction');
    await expect(
      db().invalidateTxIfUnchanged(expected, lastCheck as number, false),
    ).rejects.toThrow('preimage');
    expect(transaction).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'rejects invalid unexpected %s before query'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid unexpected %s before query' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged( expected, 123, unexpected as unknown as boolean, ), ).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
   */
  it.each([undefined, null, 0, 'true'])(
    'rejects invalid unexpected %s before query',
    async (unexpected) => {
      await prepare();
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(
        db().invalidateTxIfUnchanged(
          expected,
          123,
          unexpected as unknown as boolean,
        ),
      ).rejects.toThrow('preimage');
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'rejects starting status %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects starting status %s' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged({ ...expected, status }, 123, false), ).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
   */
  it.each(
    Object.values(TransactionStatus).filter(
      (status) =>
        ![TransactionStatus.sent, TransactionStatus.signFailed].includes(
          status,
        ),
    ),
  )('rejects starting status %s', async (status) => {
    await prepare();
    const transaction = vi.spyOn(db().dataSource, 'transaction');
    await expect(
      db().invalidateTxIfUnchanged({ ...expected, status }, 123, false),
    ).rejects.toThrow('preimage');
    expect(transaction).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'does not overwrite an isolated %s mismatch'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'does not overwrite an isolated %s mismatch' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged( { ...expected, [field]: value }, 123, true, ), ).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each([
    ['txId', 'replacement'],
    ['txJson', 'replacement'],
    ['chain', 'ethereum'],
    ['type', TransactionType.reward],
    ['status', TransactionStatus.signFailed],
    ['requiredSign', 4],
    ['eventId', 'missing-event'],
  ] as const)(
    'does not overwrite an isolated %s mismatch',
    async (field, value) => {
      await prepare();
      // Keep both event phases eligible when changing type alone.
      if (field === 'type')
        await db().ConfirmedEventRepository.update(
          { id: eventId },
          { status: EventStatus.inReward },
        );
      const before = await state();
      await expect(
        db().invalidateTxIfUnchanged(
          { ...expected, [field]: value },
          123,
          true,
        ),
      ).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'requires the exact order relation'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'requires the exact order relation' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged( { ...expected, orderId: 'other' }, 123, true, ), ).resolves.toBe(false); expect(await state()).toEqual(before); expect((await db().getOrderById('other'))?.status).toBe( OrderStatus.inProcess, ); expect(txNotify).not.toHaveBeenCalled();
   */
  it('requires the exact order relation', async () => {
    await prepare(TransactionType.arbitrary);
    await DatabaseActionMock.insertOrderRecord(
      'other',
      'ergo',
      '[]',
      OrderStatus.inProcess,
    );
    const before = await state();
    await expect(
      db().invalidateTxIfUnchanged(
        { ...expected, orderId: 'other' },
        123,
        true,
      ),
    ).resolves.toBe(false);
    expect(await state()).toEqual(before);
    expect((await db().getOrderById('other'))?.status).toBe(
      OrderStatus.inProcess,
    );
    expect(txNotify).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'preserves a concurrent mempool refresh to %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'preserves a concurrent mempool refresh to %s' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged(expected, 123, true), ).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled();
   */
  it.each([0, 124, Number.MAX_SAFE_INTEGER])(
    'preserves a concurrent mempool refresh to %s',
    async (lastCheck) => {
      await prepare();
      await db().TransactionRepository.update({ txId }, { lastCheck });
      const before = await state();
      await expect(
        db().invalidateTxIfUnchanged(expected, 123, true),
      ).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'rejects invalid association %s/%s/%s before query'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid association %s/%s/%s before query' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged( { ...expected, type, eventId: event, orderId: order }, 123, false, ), ).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
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
    ['unknown', null, null],
  ] as const)(
    'rejects invalid association %s/%s/%s before query',
    async (type, event, order) => {
      await prepare();
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(
        db().invalidateTxIfUnchanged(
          { ...expected, type, eventId: event, orderId: order },
          123,
          false,
        ),
      ).rejects.toThrow('preimage');
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'rejects a missing or wrong-phase %s relation'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects a missing or wrong-phase %s relation' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged(expected, 123, true), ).resolves.toBe(false); expect(await state()).toEqual(before); await expect( db().invalidateTxIfUnchanged( { ...expected, ...(isOrder ? { orderId: 'absent' } : { eventId: 'absent' }), }, 123, true, ), ).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled();
   */
  it.each([
    TransactionType.payment,
    TransactionType.reward,
    TransactionType.arbitrary,
  ])('rejects a missing or wrong-phase %s relation', async (type) => {
    await prepare(type);
    const isOrder = type === TransactionType.arbitrary;
    const repository = isOrder
      ? db().ArbitraryRepository
      : db().ConfirmedEventRepository;
    const id = isOrder ? orderId : eventId;
    await repository.update({ id }, { status: 'wrong-phase' });
    const before = await state();
    await expect(
      db().invalidateTxIfUnchanged(expected, 123, true),
    ).resolves.toBe(false);
    expect(await state()).toEqual(before);
    // An absent association is represented by a captured identifier with no row.
    await expect(
      db().invalidateTxIfUnchanged(
        {
          ...expected,
          ...(isOrder ? { orderId: 'absent' } : { eventId: 'absent' }),
        },
        123,
        true,
      ),
    ).resolves.toBe(false);
    expect(await state()).toEqual(before);
    expect(txNotify).not.toHaveBeenCalled();
  });

  for (const type of [TransactionType.payment, TransactionType.arbitrary]) {
    /**
     * @target DatabaseAction.invalidateTxIfUnchanged `rolls back the transaction when ${type}'s second update raises %s`
     * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
     * @scenario Exercise `rolls back the transaction when ${type}'s second update raises %s` through invalidateTxIfUnchanged using the named isolated input or authority change.
     * @expected await expect(result).rejects.toThrow('second update failed'); await expect(result).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
     */
    it.each(['ABORT', 'IGNORE'])(
      `rolls back the transaction when ${type}'s second update raises %s`,
      async (mode) => {
        await prepare(type);
        const before = await state();
        const source = db().dataSource;
        const table =
          type === TransactionType.arbitrary
            ? 'arbitrary_entity'
            : 'confirmed_event_entity';
        await source.query(
          `CREATE TEMP TRIGGER reject_invalidation BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(${mode === 'ABORT' ? "ABORT, 'second update failed'" : 'IGNORE'}); END`,
        );
        try {
          const result = db().invalidateTxIfUnchanged(expected, 123, true);
          if (mode === 'ABORT')
            await expect(result).rejects.toThrow('second update failed');
          else await expect(result).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        } finally {
          await source.query('DROP TRIGGER reject_invalidation');
        }
      },
    );
  }
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'accepts matching lastCheck boundary %s without changing it'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'accepts matching lastCheck boundary %s without changing it' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged(expected, lastCheck, false), ).resolves.toBe(true); expect((await db().getTxById(txId))?.lastCheck).toBe(lastCheck);
   */
  it.each([0, Number.MAX_SAFE_INTEGER])(
    'accepts matching lastCheck boundary %s without changing it',
    async (lastCheck) => {
      await prepare();
      await db().TransactionRepository.update({ txId }, { lastCheck });
      await expect(
        db().invalidateTxIfUnchanged(expected, lastCheck, false),
      ).resolves.toBe(true);
      expect((await db().getTxById(txId))?.lastCheck).toBe(lastCheck);
    },
  );
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'requires a null %s relation for management rows'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'requires a null %s relation for management rows' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged(expected, 123, true), ).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each(['event', 'order'] as const)(
    'requires a null %s relation for management rows',
    async (relation) => {
      await prepare(TransactionType.manual);
      await db().TransactionRepository.update(
        { txId },
        { [relation]: { id: relation === 'event' ? eventId : orderId } },
      );
      const before = await state();
      await expect(
        db().invalidateTxIfUnchanged(expected, 123, true),
      ).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'does not overwrite an existing eligible but different event relation'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'does not overwrite an existing eligible but different event relation' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged( { ...expected, eventId: otherId }, 123, true, ), ).resolves.toBe(false); expect(await state()).toEqual(before); expect((await db().getEventById(otherId))?.status).toBe( EventStatus.inPayment, ); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it('does not overwrite an existing eligible but different event relation', async () => {
    await prepare();
    const other = mockEventTrigger().event;
    other.sourceTxId = 'cd'.repeat(32);
    await DatabaseActionMock.insertEventRecord(other, EventStatus.inPayment);
    const otherId = Utils.txIdToEventId(other.sourceTxId);
    const before = await state();
    await expect(
      db().invalidateTxIfUnchanged(
        { ...expected, eventId: otherId },
        123,
        true,
      ),
    ).resolves.toBe(false);
    expect(await state()).toEqual(before);
    expect((await db().getEventById(otherId))?.status).toBe(
      EventStatus.inPayment,
    );
    expect(txNotify).not.toHaveBeenCalled();
    expect(eventNotify).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'captures the preimage before its first asynchronous lookup'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'captures the preimage before its first asynchronous lookup' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect(pending).resolves.toBe(true); expect((await db().getTxById(txId))?.status).toBe( TransactionStatus.invalid, ); expect(txNotify).toHaveBeenCalledExactlyOnceWith( txId, TransactionStatus.invalid, ); expect(eventNotify).toHaveBeenCalledExactlyOnceWith( eventId, EventStatus.pendingPayment, );
   */
  it('captures the preimage before its first asynchronous lookup', async () => {
    await prepare();
    const mutable = { ...expected };
    const pending = db().invalidateTxIfUnchanged(mutable, 123, false);
    mutable.txId = 'changed';
    mutable.eventId = 'changed';
    mutable.type = TransactionType.manual;
    await expect(pending).resolves.toBe(true);
    expect((await db().getTxById(txId))?.status).toBe(
      TransactionStatus.invalid,
    );
    expect(txNotify).toHaveBeenCalledExactlyOnceWith(
      txId,
      TransactionStatus.invalid,
    );
    expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
      eventId,
      EventStatus.pendingPayment,
    );
  });
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'preserves relations when the transaction has been deleted'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'preserves relations when the transaction has been deleted' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().invalidateTxIfUnchanged(expected, 123, true), ).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it('preserves relations when the transaction has been deleted', async () => {
    await prepare();
    await db().TransactionRepository.delete({ txId });
    const before = await state();
    await expect(
      db().invalidateTxIfUnchanged(expected, 123, true),
    ).resolves.toBe(false);
    expect(await state()).toEqual(before);
    expect(txNotify).not.toHaveBeenCalled();
    expect(eventNotify).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'allows one concurrent winner and increments exactly once'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'allows one concurrent winner and increments exactly once' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected expect(results.sort()).toEqual([false, true]); expect((await state()).event?.unexpectedFails).toBe(6); expect(txNotify).toHaveBeenCalledTimes(1); expect(eventNotify).toHaveBeenCalledTimes(1);
   */
  it('allows one concurrent winner and increments exactly once', async () => {
    await prepare();
    const results = await Promise.all([
      db().invalidateTxIfUnchanged(expected, 123, true),
      db().invalidateTxIfUnchanged(expected, 123, true),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await state()).event?.unexpectedFails).toBe(6);
    expect(txNotify).toHaveBeenCalledTimes(1);
    expect(eventNotify).toHaveBeenCalledTimes(1);
  });
  /**
   * @target DatabaseAction.invalidateTxIfUnchanged 'keeps an unrelated writer outside a transaction that later rolls back'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'keeps an unrelated writer outside a transaction that later rolls back' through invalidateTxIfUnchanged using the named isolated input or authority change.
   * @expected expect(early).toBe('waiting'); expect(result).toBeInstanceOf(Error); expect((result as Error).message).toContain('second update failed'); expect(await state()).toEqual(before); expect((await db().getTxById(unrelated.txId))?.txJson).toBe('winner'); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it('keeps an unrelated writer outside a transaction that later rolls back', async () => {
    await prepare();
    const before = await state();
    const unrelated = new PaymentTransaction(
      'ergo',
      'unrelated',
      '',
      Buffer.from('dcba', 'hex'),
      TransactionType.manual,
    );
    await DatabaseActionMock.insertTxRecord(
      unrelated,
      TransactionStatus.approved,
      0,
    );
    const source = db().dataSource;
    let announce!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => (announce = resolve));
    const pause = new Promise<void>((resolve) => (resume = resolve));
    const subscriber: EntitySubscriberInterface<TransactionEntity> = {
      listenTo: () => TransactionEntity,
      afterUpdate: async (event: UpdateEvent<TransactionEntity>) => {
        if (event.entity?.status !== TransactionStatus.invalid) return;
        announce();
        await pause;
      },
    };
    source.subscribers.push(subscriber);
    await source.query(
      "CREATE TEMP TRIGGER reject_invalidation BEFORE UPDATE ON confirmed_event_entity BEGIN SELECT RAISE(ABORT, 'second update failed'); END",
    );
    const invalidating = db()
      .invalidateTxIfUnchanged(expected, 123, true)
      .catch((error: Error) => error);
    let writer: Promise<unknown> | undefined;
    try {
      await entered;
      writer = db().TransactionRepository.update(
        { txId: unrelated.txId },
        { txJson: 'winner' },
      );
      const early = await Promise.race([
        writer.then(() => 'escaped'),
        delay(30).then(() => 'waiting'),
      ]);
      resume();
      const [result] = await Promise.all([invalidating, writer]);
      expect(early).toBe('waiting');
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('second update failed');
      expect(await state()).toEqual(before);
      expect((await db().getTxById(unrelated.txId))?.txJson).toBe('winner');
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    } finally {
      resume();
      await Promise.allSettled([invalidating, writer]);
      source.subscribers.splice(source.subscribers.indexOf(subscriber), 1);
      await source.query('DROP TRIGGER reject_invalidation');
    }
  });
});
