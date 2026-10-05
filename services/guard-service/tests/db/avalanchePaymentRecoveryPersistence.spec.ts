import type { MockInstance } from 'vitest';

import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import type { TransactionCheckPreimage } from '../../src/db/databaseAction';
import { ConfirmedEventEntity } from '../../src/db/entities/confirmedEventEntity';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import type { SigningPersistenceAuthorization } from '../../src/signing/transactionSigningContext';
import {
  EventStatus,
  OrderStatus,
  TransactionStatus,
} from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import { mockEventTrigger } from '../event/testData';
import DatabaseActionMock from './mocked/databaseAction.mock';

describe('observed payment recovery persistence', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let expected: TransactionCheckPreimage;
  let signedJson: string;
  let authority: SigningPersistenceAuthorization;
  let notify: MockInstance<PublicStatusHandler['updatePublicTxStatus']>;
  const fields = [
    ['txId', "'different-id'"],
    ['txJson', "'different-json'"],
    ['chain', "'different-chain'"],
    ['type', "'different-type'"],
    ['status', "'different-status'"],
    ['requiredSign', '99'],
    ['eventId', 'NULL'],
    ['orderId', "'other-order'"],
    ['lastCheck', '99'],
    ['lastStatusUpdate', "'different-time'"],
    ['failedInSign', '0'],
    ['signFailedCount', '99'],
  ] as const;
  const row = () => db().getTxById(expected.txId);
  const snapshot = async () => ({
    transactions: await db().TransactionRepository.find({
      relations: ['event', 'order'],
    }),
    events: await db().ConfirmedEventRepository.find({
      relations: ['eventData'],
    }),
  });
  const recover = () =>
    db().recoverSignedPaymentIfUnchanged(expected, signedJson, authority);

  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    const event = mockEventTrigger().event;
    await DatabaseActionMock.insertEventRecord(event, EventStatus.inPayment);
    await DatabaseActionMock.insertOrderRecord(
      'other-order',
      'ergo',
      '[]',
      OrderStatus.inProcess,
    );
    const payment = new PaymentTransaction(
      'ergo',
      'fixture-id',
      Utils.txIdToEventId(event.sourceTxId),
      Buffer.from('abcd', 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      payment,
      TransactionStatus.signFailed,
      7,
      'old-time',
      true,
      2,
      3,
    );
    expected = db().captureTxCheckPreimage(
      (await db().getTxById(payment.txId))!,
    );
    payment.txBytes = Buffer.from('aabb', 'hex');
    signedJson = payment.toJson();
    authority = {
      assertActive: vi.fn(),
      assertBefore: vi.fn(async () => undefined),
      assertAfter: vi.fn(async () => undefined),
    };
    notify = vi
      .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
      .mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'atomically recovers %s and passes the actual full after tuple'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'atomically recovers %s and passes the actual full after tuple' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected expect(manager).not.toBe(db().dataSource.manager); expect(input).toEqual(expected); expect(Object.isFrozen(input)).toBe(true); expect( await manager .getRepository(TransactionEntity) .findOneBy({ txId: input.txId }), ).toMatchObject({ txJson: expected.txJson, status: TransactionStatus.signFailed, }); expect(notify).not.toHaveBeenCalled(); expect(input).toEqual({ ...expected, status: TransactionStatus.sent, txJson: signedJson, lastStatusUpdate: expect.stringMatching(/^\d+$/), }); expect(Object.isFrozen(input)).toBe(true); expect( await manager .getRepository(TransactionEntity) .findOneBy({ txId: input.txId }), ).toMatchObject({ txJson: signedJson, status: TransactionStatus.sent, lastStatusUpdate: input.lastStatusUpdate, }); expect(notify).not.toHaveBeenCalled(); await expect(recover()).resolves.toBe(true); expect(before).toHaveBeenCalledTimes(1); expect(after).toHaveBeenCalledTimes(1); expect((await snapshot()).events).toEqual(eventBefore); expect(db().captureTxCheckPreimage((await row())!)).toEqual({ ...expected, txJson: signedJson, status: TransactionStatus.sent, lastStatusUpdate: expect.any(String), }); expect(notify).toHaveBeenCalledExactlyOnceWith( expected.txId, TransactionStatus.sent, ); await expect(recover()).resolves.toBe(false); expect(notify).toHaveBeenCalledTimes(1);
   */
  it.each(['ergo', 'avalanche'])(
    'atomically recovers %s and passes the actual full after tuple',
    async (chain) => {
      const original = JSON.parse(expected.txJson);
      original.network = chain;
      await db().TransactionRepository.update(
        { txId: expected.txId },
        { chain, txJson: JSON.stringify(original) },
      );
      expected = db().captureTxCheckPreimage((await row())!);
      signedJson = JSON.stringify({ ...original, txBytes: 'aabb' });
      const eventBefore = (await snapshot()).events;
      const before = vi.fn(async (manager, input) => {
        expect(manager).not.toBe(db().dataSource.manager);
        expect(input).toEqual(expected);
        expect(Object.isFrozen(input)).toBe(true);
        expect(
          await manager
            .getRepository(TransactionEntity)
            .findOneBy({ txId: input.txId }),
        ).toMatchObject({
          txJson: expected.txJson,
          status: TransactionStatus.signFailed,
        });
        expect(notify).not.toHaveBeenCalled();
      });
      const after = vi.fn(async (manager, input) => {
        expect(input).toEqual({
          ...expected,
          status: TransactionStatus.sent,
          txJson: signedJson,
          lastStatusUpdate: expect.stringMatching(/^\d+$/),
        });
        expect(Object.isFrozen(input)).toBe(true);
        expect(
          await manager
            .getRepository(TransactionEntity)
            .findOneBy({ txId: input.txId }),
        ).toMatchObject({
          txJson: signedJson,
          status: TransactionStatus.sent,
          lastStatusUpdate: input.lastStatusUpdate,
        });
        expect(notify).not.toHaveBeenCalled();
      });
      authority.assertBefore = before;
      authority.assertAfter = after;
      await expect(recover()).resolves.toBe(true);
      expect(before).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect((await snapshot()).events).toEqual(eventBefore);
      expect(db().captureTxCheckPreimage((await row())!)).toEqual({
        ...expected,
        txJson: signedJson,
        status: TransactionStatus.sent,
        lastStatusUpdate: expect.any(String),
      });
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        expected.txId,
        TransactionStatus.sent,
      );
      await expect(recover()).resolves.toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'compares stale %s in the original twelve-field CAS'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'compares stale %s in the original twelve-field CAS' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).resolves.toBe(false); expect(await snapshot()).toEqual(before); expect(authority.assertBefore).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
   */
  it.each(fields)(
    'compares stale %s in the original twelve-field CAS',
    async (field, value) => {
      await db().dataSource.query(
        `UPDATE transaction_entity SET "${field}"=${value}`,
      );
      const before = await snapshot();
      await expect(recover()).resolves.toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(authority.assertBefore).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects malformed preimage %s=%s before SQL'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects malformed preimage %s=%s before SQL' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow(); expect(transaction).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    ['status', TransactionStatus.sent],
    ['type', TransactionType.reward],
    ['chain', 'ethereum'],
    ['eventId', null],
    ['orderId', 'other-order'],
    ['lastCheck', -1],
    ['lastCheck', 1.5],
    ['lastCheck', Number.MAX_SAFE_INTEGER + 1],
    ['lastStatusUpdate', undefined],
    ['failedInSign', 1],
    ['signFailedCount', -1],
    ['signFailedCount', 1.5],
    ['requiredSign', 0],
    ['txId', ''],
    ['txJson', ''],
  ])('rejects malformed preimage %s=%s before SQL', async (field, value) => {
    expected = {
      ...expected,
      [field as string]: value,
    } as TransactionCheckPreimage;
    const transaction = vi.spyOn(db().dataSource, 'transaction');
    await expect(recover()).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects omitted preimage %s before SQL'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects omitted preimage %s before SQL' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow(); expect(transaction).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
   */
  it.each(fields)('rejects omitted preimage %s before SQL', async (field) => {
    expected = {
      ...expected,
      [field]: undefined,
    } as unknown as TransactionCheckPreimage;
    const transaction = vi.spyOn(db().dataSource, 'transaction');
    await expect(recover()).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'matches a null previous timestamp exactly'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'matches a null previous timestamp exactly' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).resolves.toBe(true); expect((await row())!.lastStatusUpdate).toMatch(/^\d+$/);
   */
  it('matches a null previous timestamp exactly', async () => {
    await db().dataSource.query(
      'UPDATE transaction_entity SET lastStatusUpdate=NULL',
    );
    expected = db().captureTxCheckPreimage((await row())!);
    await expect(recover()).resolves.toBe(true);
    expect((await row())!.lastStatusUpdate).toMatch(/^\d+$/);
  });

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects malformed signed JSON %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects malformed signed JSON %s' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow(); expect(transaction).not.toHaveBeenCalled();
   */
  it.each(['', '{', 'null', '[]', '"scalar"', '{}'])(
    'rejects malformed signed JSON %s',
    async (json) => {
      signedJson = json;
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(recover()).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects malformed signed model %s=%s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects malformed signed model %s=%s' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('signed model'); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    ['network', 'avalanche'],
    ['txId', 'other'],
    ['eventId', 'other'],
    ['txType', TransactionType.reward],
    ['txBytes', ''],
    ['txBytes', 'abc'],
    ['txBytes', 'AA'],
    ['txBytes', 'zz'],
    ['txBytes', 3],
  ])('rejects malformed signed model %s=%s', async (field, value) => {
    signedJson = JSON.stringify({
      ...JSON.parse(signedJson),
      [field as string]: value,
    });
    await expect(recover()).rejects.toThrow('signed model');
    expect(notify).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'requires %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'requires %s' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('authority'); expect(notify).not.toHaveBeenCalled();
   */
  it.each(['assertActive', 'assertBefore', 'assertAfter'] as const)(
    'requires %s',
    async (field) => {
      authority = {
        ...authority,
        [field]: undefined,
      } as unknown as SigningPersistenceAuthorization;
      await expect(recover()).rejects.toThrow('authority');
      expect(notify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'requires the authority object'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'requires the authority object' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('authority');
   */
  it('requires the authority object', async () => {
    authority = undefined as unknown as SigningPersistenceAuthorization;
    await expect(recover()).rejects.toThrow('authority');
  });
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back rejected %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back rejected %s' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('authority refused'); expect(await snapshot()).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it.each(['assertBefore', 'assertAfter'] as const)(
    'rolls back rejected %s',
    async (phase) => {
      const before = await snapshot();
      authority[phase] = async () => {
        throw new Error('authority refused');
      };
      await expect(recover()).rejects.toThrow('authority refused');
      expect(await snapshot()).toEqual(before);
      expect(notify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back expired activity gate %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back expired activity gate %s' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('expired'); expect(await snapshot()).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it.each([1, 2, 3])('rolls back expired activity gate %s', async (gate) => {
    const before = await snapshot();
    let calls = 0;
    authority.assertActive = () => {
      if (++calls === gate) throw new Error('expired');
    };
    await expect(recover()).rejects.toThrow('expired');
    expect(await snapshot()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back AFTER-trigger %s mutation'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back AFTER-trigger %s mutation' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('postcondition'); expect(await snapshot()).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it.each(fields)(
    'rolls back AFTER-trigger %s mutation',
    async (field, value) => {
      const before = await snapshot();
      await db().dataSource.query(
        `CREATE TEMP TRIGGER recovery_test AFTER UPDATE ON transaction_entity BEGIN UPDATE transaction_entity SET "${field}"=${value} WHERE txId=NEW.txId; END`,
      );
      try {
        await expect(recover()).rejects.toThrow('postcondition');
        expect(await snapshot()).toEqual(before);
        expect(notify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER recovery_test');
      }
    },
  );
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back %s including callback writes'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back %s including callback writes' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('refused'); await expect(recover()).resolves.toBe(false); expect(await snapshot()).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it.each(['ABORT', 'IGNORE'])(
    'rolls back %s including callback writes',
    async (fault) => {
      const before = await snapshot();
      authority.assertBefore = async (manager) => {
        await manager
          .getRepository(ConfirmedEventEntity)
          .update({ id: expected.eventId! }, { unexpectedFails: 7 });
      };
      await db().dataSource.query(
        `CREATE TEMP TRIGGER recovery_test BEFORE UPDATE ON transaction_entity BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'refused'" : ''}); END`,
      );
      try {
        if (fault === 'ABORT')
          await expect(recover()).rejects.toThrow('refused');
        else await expect(recover()).resolves.toBe(false);
        expect(await snapshot()).toEqual(before);
        expect(notify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER recovery_test');
      }
    },
  );
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back event trigger %s.%s changes'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back event trigger %s.%s changes' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('event postcondition'); expect(await snapshot()).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    ['confirmed_event_entity', 'status', "'pending-payment'"],
    ['confirmed_event_entity', 'firstTry', "'changed'"],
    ['confirmed_event_entity', 'unexpectedFails', '99'],
    ['confirmed_event_entity', 'eventDataId', 'NULL'],
    ['event_trigger_entity', 'spendTxId', "'other-spend'"],
  ])('rolls back event trigger %s.%s changes', async (table, field, value) => {
    const before = await snapshot();
    await db().dataSource.query(
      `CREATE TEMP TRIGGER recovery_test AFTER UPDATE ON transaction_entity BEGIN UPDATE ${table} SET "${field}"=${value}; END`,
    );
    try {
      await expect(recover()).rejects.toThrow('event postcondition');
      expect(await snapshot()).toEqual(before);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await db().dataSource.query('DROP TRIGGER recovery_test');
    }
  });
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back callback event mutation at %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back callback event mutation at %s' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('event postcondition'); expect(await snapshot()).toEqual(before);
   */
  it.each(['assertBefore', 'assertAfter'] as const)(
    'rolls back callback event mutation at %s',
    async (phase) => {
      const before = await snapshot();
      authority[phase] = async (manager) => {
        await manager
          .getRepository(ConfirmedEventEntity)
          .update({ id: expected.eventId! }, { unexpectedFails: 99 });
      };
      await expect(recover()).rejects.toThrow('event postcondition');
      expect(await snapshot()).toEqual(before);
    },
  );
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back callback row mutation before the exact CAS'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back callback row mutation before the exact CAS' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).resolves.toBe(false); expect(await snapshot()).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it('rolls back callback row mutation before the exact CAS', async () => {
    const before = await snapshot();
    authority.assertBefore = async (manager) => {
      await manager
        .getRepository(TransactionEntity)
        .update({ txId: expected.txId }, { signFailedCount: 999 });
    };
    await expect(recover()).resolves.toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back callback row mutation after writing'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rolls back callback row mutation after writing' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('row postcondition'); expect(await snapshot()).toEqual(before);
   */
  it('rolls back callback row mutation after writing', async () => {
    const before = await snapshot();
    authority.assertAfter = async (manager) => {
      await manager
        .getRepository(TransactionEntity)
        .update({ txId: expected.txId }, { lastCheck: 999 });
    };
    await expect(recover()).rejects.toThrow('row postcondition');
    expect(await snapshot()).toEqual(before);
  });
  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects a different event phase without touching the row'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects a different event phase without touching the row' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(recover()).rejects.toThrow('recovery event'); expect(await snapshot()).toEqual(before);
   */
  it('rejects a different event phase without touching the row', async () => {
    await db().ConfirmedEventRepository.update(
      { id: expected.eventId! },
      { status: EventStatus.pendingPayment },
    );
    const before = await snapshot();
    await expect(recover()).rejects.toThrow('recovery event');
    expect(await snapshot()).toEqual(before);
  });

  /**
   * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'handles queued SQL ownership: %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'handles queued SQL ownership: %s' through recoverSignedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected expect(result).toBe(true); expect((await row())!.txJson).toBe(signedJson); expect(result).toBeInstanceOf(Error); expect(result).toBe(false); expect((await row())!.txJson).toBe(original.txJson); expect(notify).not.toHaveBeenCalled(); expect(authority.assertBefore).not.toHaveBeenCalled();
   */
  it.each(['capture', 'expiry', 'concurrent winner'])(
    'handles queued SQL ownership: %s',
    async (scenario) => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let active = true;
      authority.assertActive = () => {
        if (!active) throw new Error('expired');
      };
      expected = { ...expected };
      const original = { ...expected };
      const owner = db().dataSource.transaction(async (manager) => {
        if (scenario === 'concurrent winner')
          await manager
            .getRepository(TransactionEntity)
            .update({ txId: original.txId }, { lastCheck: 99 });
        entered();
        await gate;
      });
      await acquired;
      const pending = recover();
      const outcome = pending.then(
        (value) => value,
        (error: Error) => error,
      );
      try {
        if (scenario === 'capture') {
          (expected as { txJson: string }).txJson = 'caller mutation';
          authority.assertActive = () => {
            throw new Error('replacement callback');
          };
        } else if (scenario === 'expiry') active = false;
      } finally {
        release();
        await owner;
      }
      const result = await outcome;
      if (scenario === 'capture') {
        expect(result).toBe(true);
        expect((await row())!.txJson).toBe(signedJson);
      } else {
        if (scenario === 'expiry') expect(result).toBeInstanceOf(Error);
        else expect(result).toBe(false);
        expect((await row())!.txJson).toBe(original.txJson);
        expect(notify).not.toHaveBeenCalled();
        expect(authority.assertBefore).not.toHaveBeenCalled();
      }
    },
  );
});
