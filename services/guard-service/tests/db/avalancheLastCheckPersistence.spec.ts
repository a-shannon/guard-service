import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { TransactionStatus } from '../../src/utils/constants';
import DatabaseActionMock from './mocked/databaseAction.mock';

describe('exact transaction last-check persistence', () => {
  const db = () => DatabaseActionMock.testDatabase;
  const id = 'last-check-fixture';
  const row = async () => (await db().getTxById(id))!;
  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    const payment = new PaymentTransaction(
      'ergo',
      id,
      'event',
      Buffer.from('abcd', 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      payment,
      TransactionStatus.sent,
      10,
      'captured',
      true,
      2,
      3,
    );
    vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    ).mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'updates only lastCheck for %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'updates only lastCheck for %s' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateTxLastCheckIfUnchanged( db().captureTxCheckPreimage(before), 11, ), ).resolves.toBe(true); expect(await row()).toEqual({ ...before, lastCheck: 11 }); expect( PublicStatusHandler.getInstance().updatePublicTxStatus, ).not.toHaveBeenCalled();
   */
  it.each([TransactionStatus.sent, TransactionStatus.signFailed])(
    'updates only lastCheck for %s',
    async (status) => {
      await db().TransactionRepository.update({ txId: id }, { status });
      const before = await row();
      await expect(
        db().updateTxLastCheckIfUnchanged(
          db().captureTxCheckPreimage(before),
          11,
        ),
      ).resolves.toBe(true);
      expect(await row()).toEqual({ ...before, lastCheck: 11 });
      expect(
        PublicStatusHandler.getInstance().updatePublicTxStatus,
      ).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'accepts equal height and an explicit null status timestamp'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'accepts equal height and an explicit null status timestamp' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateTxLastCheckIfUnchanged( db().captureTxCheckPreimage(before), 10, ), ).resolves.toBe(true); expect(await row()).toEqual(before);
   */
  it('accepts equal height and an explicit null status timestamp', async () => {
    await db().dataSource.query(
      'UPDATE transaction_entity SET lastStatusUpdate=NULL WHERE txId=?',
      [id],
    );
    const before = await row();
    await expect(
      db().updateTxLastCheckIfUnchanged(
        db().captureTxCheckPreimage(before),
        10,
      ),
    ).resolves.toBe(true);
    expect(await row()).toEqual(before);
  });
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rejects isolated captured %s mismatch'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects isolated captured %s mismatch' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateTxLastCheckIfUnchanged( { ...expected, [field as string]: value }, 11, ), ).resolves.toBe(false); expect(await row()).toEqual(before); expect( PublicStatusHandler.getInstance().updatePublicTxStatus, ).not.toHaveBeenCalled();
   */
  it.each([
    ['txId', 'other'],
    ['txJson', 'different'],
    ['chain', 'avalanche'],
    ['type', TransactionType.reward],
    ['status', TransactionStatus.signFailed],
    ['requiredSign', 4],
    ['eventId', 'other'],
    ['orderId', 'other'],
    ['lastCheck', 9],
    ['lastStatusUpdate', 'different'],
    ['failedInSign', false],
    ['signFailedCount', 3],
  ])('rejects isolated captured %s mismatch', async (field, value) => {
    const before = await row();
    const expected = db().captureTxCheckPreimage(before);
    await expect(
      db().updateTxLastCheckIfUnchanged(
        { ...expected, [field as string]: value },
        11,
      ),
    ).resolves.toBe(false);
    expect(await row()).toEqual(before);
    expect(
      PublicStatusHandler.getInstance().updatePublicTxStatus,
    ).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rejects undefined %s before SQL'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects undefined %s before SQL' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateTxLastCheckIfUnchanged( { ...expected, [field]: undefined }, 11, ), ).rejects.toThrow(); expect(transaction).not.toHaveBeenCalled();
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
    'lastCheck',
    'lastStatusUpdate',
    'failedInSign',
    'signFailedCount',
  ])('rejects undefined %s before SQL', async (field) => {
    const expected = db().captureTxCheckPreimage(await row());
    const transaction = vi.spyOn(db().dataSource, 'transaction');
    await expect(
      db().updateTxLastCheckIfUnchanged(
        { ...expected, [field]: undefined },
        11,
      ),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rejects invalid or regressing target %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid or regressing target %s' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateTxLastCheckIfUnchanged( db().captureTxCheckPreimage(before), height as number, ), ).rejects.toThrow(); expect(await row()).toEqual(before);
   */
  it.each([-1, 9, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 10.5, '11'])(
    'rejects invalid or regressing target %s',
    async (height) => {
      const before = await row();
      await expect(
        db().updateTxLastCheckIfUnchanged(
          db().captureTxCheckPreimage(before),
          height as number,
        ),
      ).rejects.toThrow();
      expect(await row()).toEqual(before);
    },
  );
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rejects ineligible status %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects ineligible status %s' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected expect(() => db().captureTxCheckPreimage({ ...before, status })).toThrow();
   */
  it.each([
    TransactionStatus.approved,
    TransactionStatus.inSign,
    TransactionStatus.signed,
    TransactionStatus.completed,
    TransactionStatus.invalid,
  ])('rejects ineligible status %s', async (status) => {
    const before = await row();
    expect(() => db().captureTxCheckPreimage({ ...before, status })).toThrow();
  });
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'captures caller fields before waiting for SQL ownership'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'captures caller fields before waiting for SQL ownership' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect(pending).resolves.toBe(true); expect(await row()).toEqual({ ...before, lastCheck: 11 });
   */
  it('captures caller fields before waiting for SQL ownership', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const before = await row();
    const expected = { ...db().captureTxCheckPreimage(before) };
    const owner = db().dataSource.transaction(async () => {
      entered();
      await gate;
    });
    await acquired;
    const pending = db().updateTxLastCheckIfUnchanged(expected, 11);
    expected.txJson = 'caller mutation';
    expected.lastCheck = 999;
    release();
    await owner;
    await expect(pending).resolves.toBe(true);
    expect(await row()).toEqual({ ...before, lastCheck: 11 });
  });
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'preserves a concurrent newer refresh after waiting for SQL ownership'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'preserves a concurrent newer refresh after waiting for SQL ownership' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect(pending).resolves.toBe(false); expect((await row()).lastCheck).toBe(20);
   */
  it('preserves a concurrent newer refresh after waiting for SQL ownership', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const expected = db().captureTxCheckPreimage(await row());
    const owner = db().dataSource.transaction(async (manager) => {
      await manager
        .getRepository(TransactionEntity)
        .update({ txId: id }, { lastCheck: 20 });
      entered();
      await gate;
    });
    await acquired;
    const pending = db().updateTxLastCheckIfUnchanged(expected, 11);
    release();
    await owner;
    await expect(pending).resolves.toBe(false);
    expect((await row()).lastCheck).toBe(20);
  });
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rolls back AFTER-trigger %s mutation'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back AFTER-trigger %s mutation' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateTxLastCheckIfUnchanged( db().captureTxCheckPreimage(before), 11, ), ).rejects.toThrow('postcondition'); expect(await row()).toEqual(before);
   */
  it.each([
    'status',
    'txJson',
    'lastCheck',
    'lastStatusUpdate',
    'failedInSign',
    'signFailedCount',
    'requiredSign',
  ])('rolls back AFTER-trigger %s mutation', async (field) => {
    const values: Record<string, string> = {
      status: "'completed'",
      txJson: "'changed'",
      lastCheck: '99',
      lastStatusUpdate: "'changed'",
      failedInSign: '0',
      signFailedCount: '99',
      requiredSign: '99',
    };
    const before = await row();
    await db().dataSource.query(
      `CREATE TEMP TRIGGER lastcheck_test AFTER UPDATE ON transaction_entity WHEN NEW.lastCheck=11 BEGIN UPDATE transaction_entity SET "${field}"=${values[field]} WHERE txId=NEW.txId; END`,
    );
    try {
      await expect(
        db().updateTxLastCheckIfUnchanged(
          db().captureTxCheckPreimage(before),
          11,
        ),
      ).rejects.toThrow('postcondition');
      expect(await row()).toEqual(before);
    } finally {
      await db().dataSource.query('DROP TRIGGER lastcheck_test');
    }
  });
  /**
   * @target DatabaseAction.updateTxLastCheckIfUnchanged 'leaves no partial write on %s trigger'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'leaves no partial write on %s trigger' through updateTxLastCheckIfUnchanged using the named isolated input or authority change.
   * @expected await expect(pending).rejects.toThrow('refused'); await expect(pending).resolves.toBe(false); expect(await row()).toEqual(before);
   */
  it.each(['ABORT', 'IGNORE'])(
    'leaves no partial write on %s trigger',
    async (fault) => {
      const before = await row();
      await db().dataSource.query(
        `CREATE TEMP TRIGGER lastcheck_test BEFORE UPDATE ON transaction_entity BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'refused'" : ''}); END`,
      );
      try {
        const pending = db().updateTxLastCheckIfUnchanged(
          db().captureTxCheckPreimage(before),
          11,
        );
        if (fault === 'ABORT') await expect(pending).rejects.toThrow('refused');
        else await expect(pending).resolves.toBe(false);
        expect(await row()).toEqual(before);
      } finally {
        await db().dataSource.query('DROP TRIGGER lastcheck_test');
      }
    },
  );
});
