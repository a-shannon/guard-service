import { MockInstance } from 'vitest';

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

describe('exact preimage transaction status persistence', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let expected: SigningRowPreimage;
  let notify: MockInstance<PublicStatusHandler['updatePublicTxStatus']>;

  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    const payment = new PaymentTransaction(
      'ergo',
      'status-fixture',
      'event-fixture',
      Buffer.from('abcd', 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      payment,
      TransactionStatus.inSign,
      0,
      undefined,
      false,
      2,
      3,
    );
    expected = {
      txId: payment.txId,
      txJson: payment.toJson(),
      chain: payment.network,
      type: payment.txType,
      status: TransactionStatus.inSign,
      requiredSign: 3,
      eventId: null,
      orderId: null,
    };
    notify = vi
      .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
      .mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'accepts the known target status %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'accepts the known target status %s' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect(db().setTxStatusIfUnchanged(expected, status)).resolves.toBe( true, ); expect(await db().getTxById(expected.txId)).toMatchObject({ status, txJson: expected.txJson, requiredSign: 3, failedInSign: status === TransactionStatus.signFailed, signFailedCount: status === TransactionStatus.signFailed ? 3 : 2, }); expect(notify).toHaveBeenCalledExactlyOnceWith(expected.txId, status);
   */
  it.each(Object.values(TransactionStatus))(
    'accepts the known target status %s',
    async (status) => {
      await expect(db().setTxStatusIfUnchanged(expected, status)).resolves.toBe(
        true,
      );
      expect(await db().getTxById(expected.txId)).toMatchObject({
        status,
        txJson: expected.txJson,
        requiredSign: 3,
        failedInSign: status === TransactionStatus.signFailed,
        signFailedCount: status === TransactionStatus.signFailed ? 3 : 2,
      });
      expect(notify).toHaveBeenCalledExactlyOnceWith(expected.txId, status);
    },
  );

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'accepts the known starting status %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'accepts the known starting status %s' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged( { ...expected, status }, TransactionStatus.sent, ), ).resolves.toBe(true); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.sent, );
   */
  it.each(Object.values(TransactionStatus))(
    'accepts the known starting status %s',
    async (status) => {
      await db().TransactionRepository.update(
        { txId: expected.txId },
        { status },
      );
      await expect(
        db().setTxStatusIfUnchanged(
          { ...expected, status },
          TransactionStatus.sent,
        ),
      ).resolves.toBe(true);
      expect((await db().getTxById(expected.txId))!.status).toBe(
        TransactionStatus.sent,
      );
    },
  );

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'rejects an isolated mismatch in %s without any write'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects an isolated mismatch in %s without any write' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged( { ...expected, [field]: value }, TransactionStatus.sent, ), ).resolves.toBe(false); expect(await db().getTxById(expected.txId)).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    ['txId', 'other-id'],
    ['txJson', 'different-json'],
    ['chain', 'avalanche'],
    ['type', TransactionType.reward],
    ['status', TransactionStatus.approved],
    ['requiredSign', 4],
    ['eventId', 'other-event'],
    ['orderId', 'other-order'],
  ] as const)(
    'rejects an isolated mismatch in %s without any write',
    async (field, value) => {
      const before = await db().getTxById(expected.txId);
      await expect(
        db().setTxStatusIfUnchanged(
          { ...expected, [field]: value },
          TransactionStatus.sent,
        ),
      ).resolves.toBe(false);
      expect(await db().getTxById(expected.txId)).toEqual(before);
      expect(notify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'rejects undefined %s before issuing an update'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects undefined %s before issuing an update' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged( { ...expected, [field]: undefined } as unknown as SigningRowPreimage, TransactionStatus.sent, ), ).rejects.toThrow('preimage'); expect(update).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
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
    'rejects undefined %s before issuing an update',
    async (field) => {
      const update = vi.spyOn(db().TransactionRepository, 'update');
      await expect(
        db().setTxStatusIfUnchanged(
          { ...expected, [field]: undefined } as unknown as SigningRowPreimage,
          TransactionStatus.sent,
        ),
      ).rejects.toThrow('preimage');
      expect(update).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'rejects invalid %s=%s before issuing an update'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid %s=%s before issuing an update' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged( { ...expected, [field]: value }, TransactionStatus.sent, ), ).rejects.toThrow('preimage'); expect(update).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    ['txId', ''],
    ['txJson', ''],
    ['chain', ''],
    ['type', ''],
    ['status', 'unknown'],
    ['requiredSign', 0],
    ['requiredSign', 1.5],
    ['requiredSign', Number.MAX_SAFE_INTEGER + 1],
    ['eventId', ''],
    ['orderId', ''],
  ] as const)(
    'rejects invalid %s=%s before issuing an update',
    async (field, value) => {
      const update = vi.spyOn(db().TransactionRepository, 'update');
      await expect(
        db().setTxStatusIfUnchanged(
          { ...expected, [field]: value },
          TransactionStatus.sent,
        ),
      ).rejects.toThrow('preimage');
      expect(update).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'rejects invalid target %s before issuing an update'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid target %s before issuing an update' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged(expected, status as string), ).rejects.toThrow('status transition'); expect(update).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
   */
  it.each([undefined, null, '', 'unknown', 0])(
    'rejects invalid target %s before issuing an update',
    async (status) => {
      const update = vi.spyOn(db().TransactionRepository, 'update');
      await expect(
        db().setTxStatusIfUnchanged(expected, status as string),
      ).rejects.toThrow('status transition');
      expect(update).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'rejects signing failure from %s before querying'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects signing failure from %s before querying' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged( { ...expected, status }, TransactionStatus.signFailed, ), ).rejects.toThrow('status transition'); expect(update).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
   */
  it.each(
    Object.values(TransactionStatus).filter(
      (status) => status !== TransactionStatus.inSign,
    ),
  )('rejects signing failure from %s before querying', async (status) => {
    const update = vi.spyOn(db().TransactionRepository, 'update');
    await expect(
      db().setTxStatusIfUnchanged(
        { ...expected, status },
        TransactionStatus.signFailed,
      ),
    ).rejects.toThrow('status transition');
    expect(update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'matches explicit populated %s and refuses stale null'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'matches explicit populated %s and refuses stale null' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged(expected, TransactionStatus.sent), ).resolves.toBe(false); expect(notify).not.toHaveBeenCalled(); await expect( db().setTxStatusIfUnchanged( { ...expected, [relation === 'event' ? 'eventId' : 'orderId']: id }, TransactionStatus.sent, ), ).resolves.toBe(true); expect((await db().getTxById(expected.txId))![relation]?.id).toBe(id); expect(notify).toHaveBeenCalledTimes(1);
   */
  it.each(['event', 'order'] as const)(
    'matches explicit populated %s and refuses stale null',
    async (relation) => {
      let id: string;
      if (relation === 'event') {
        const event = mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.inPayment,
        );
        id = Utils.txIdToEventId(event.sourceTxId);
      } else {
        id = 'status-order';
        await DatabaseActionMock.insertOrderRecord(
          id,
          'ergo',
          '[]',
          OrderStatus.inProcess,
        );
      }
      await db().TransactionRepository.update(
        { txId: expected.txId },
        { [relation]: { id } },
      );
      await expect(
        db().setTxStatusIfUnchanged(expected, TransactionStatus.sent),
      ).resolves.toBe(false);
      expect(notify).not.toHaveBeenCalled();
      await expect(
        db().setTxStatusIfUnchanged(
          { ...expected, [relation === 'event' ? 'eventId' : 'orderId']: id },
          TransactionStatus.sent,
        ),
      ).resolves.toBe(true);
      expect((await db().getTxById(expected.txId))![relation]?.id).toBe(id);
      expect(notify).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'increments signing failure exactly once across concurrent stale callbacks'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'increments signing failure exactly once across concurrent stale callbacks' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected expect(results.sort()).toEqual([false, true]); expect(await db().getTxById(expected.txId)).toMatchObject({ status: TransactionStatus.signFailed, failedInSign: true, signFailedCount: 3, }); expect(notify).toHaveBeenCalledTimes(1);
   */
  it('increments signing failure exactly once across concurrent stale callbacks', async () => {
    const results = await Promise.all([
      db().setTxStatusIfUnchanged(expected, TransactionStatus.signFailed),
      db().setTxStatusIfUnchanged(expected, TransactionStatus.signFailed),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await db().getTxById(expected.txId)).toMatchObject({
      status: TransactionStatus.signFailed,
      failedInSign: true,
      signFailedCount: 3,
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'does not recreate a removed row or notify'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'does not recreate a removed row or notify' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged(expected, TransactionStatus.sent), ).resolves.toBe(false); expect(await db().getTxById(expected.txId)).toBeNull(); expect(notify).not.toHaveBeenCalled();
   */
  it('does not recreate a removed row or notify', async () => {
    await db().TransactionRepository.delete({ txId: expected.txId });
    await expect(
      db().setTxStatusIfUnchanged(expected, TransactionStatus.sent),
    ).resolves.toBe(false);
    expect(await db().getTxById(expected.txId)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.setTxStatusIfUnchanged 'preserves every column when SQLite rejects the atomic failure update'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'preserves every column when SQLite rejects the atomic failure update' through setTxStatusIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().setTxStatusIfUnchanged(expected, TransactionStatus.signFailed), ).rejects.toThrow('fixture update rejected'); expect(await db().getTxById(expected.txId)).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it('preserves every column when SQLite rejects the atomic failure update', async () => {
    const before = await db().getTxById(expected.txId);
    await db().dataSource.query(
      `CREATE TEMP TRIGGER reject_status_update BEFORE UPDATE ON transaction_entity BEGIN SELECT RAISE(ABORT, 'fixture update rejected'); END`,
    );
    try {
      await expect(
        db().setTxStatusIfUnchanged(expected, TransactionStatus.signFailed),
      ).rejects.toThrow('fixture update rejected');
      expect(await db().getTxById(expected.txId)).toEqual(before);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await db().dataSource.query('DROP TRIGGER reject_status_update');
    }
  });
});
