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

describe('qualified signed transaction persistence', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let expected: SigningRowPreimage;
  let signedJson: string;
  let notify: MockInstance<PublicStatusHandler['updatePublicTxStatus']>;

  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    const payment = new PaymentTransaction(
      'ergo',
      'fixture-id',
      'fixture-event',
      Buffer.from('abcd', 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      payment,
      TransactionStatus.inSign,
      0,
      undefined,
      false,
      0,
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
    payment.txBytes = Buffer.from('aabb', 'hex');
    signedJson = payment.toJson();
    notify = vi
      .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
      .mockResolvedValue(undefined);
  });

  afterEach(() => notify.mockRestore());

  /**
   * @target DatabaseAction.updateWithSignedTxIfUnchanged 'atomically replaces the exact in-sign row and notifies once'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'atomically replaces the exact in-sign row and notifies once' through updateWithSignedTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateWithSignedTxIfUnchanged(expected, signedJson), ).resolves.toBe(true); expect(await db().getTxById(expected.txId)).toMatchObject({ txJson: signedJson, status: TransactionStatus.signed, requiredSign: 3, }); expect(notify).toHaveBeenCalledExactlyOnceWith( expected.txId, TransactionStatus.signed, ); await expect( db().updateWithSignedTxIfUnchanged(expected, 'late-result'), ).resolves.toBe(false); expect((await db().getTxById(expected.txId))!.txJson).toBe(signedJson); expect(notify).toHaveBeenCalledTimes(1);
   */
  it('atomically replaces the exact in-sign row and notifies once', async () => {
    await expect(
      db().updateWithSignedTxIfUnchanged(expected, signedJson),
    ).resolves.toBe(true);
    expect(await db().getTxById(expected.txId)).toMatchObject({
      txJson: signedJson,
      status: TransactionStatus.signed,
      requiredSign: 3,
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expected.txId,
      TransactionStatus.signed,
    );
    await expect(
      db().updateWithSignedTxIfUnchanged(expected, 'late-result'),
    ).resolves.toBe(false);
    expect((await db().getTxById(expected.txId))!.txJson).toBe(signedJson);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  /**
   * @target DatabaseAction.updateWithSignedTxIfUnchanged 'matches a populated %s foreign key and rejects a stale null reference'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'matches a populated %s foreign key and rejects a stale null reference' through updateWithSignedTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateWithSignedTxIfUnchanged(expected, signedJson), ).resolves.toBe(false); await expect( db().updateWithSignedTxIfUnchanged(matched, signedJson), ).resolves.toBe(true); expect((await db().getTxById(expected.txId))![relation]?.id).toBe(id); expect(notify).toHaveBeenCalledTimes(1);
   */
  it.each(['event', 'order'] as const)(
    'matches a populated %s foreign key and rejects a stale null reference',
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
        id = 'fixture-order';
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
        db().updateWithSignedTxIfUnchanged(expected, signedJson),
      ).resolves.toBe(false);
      const matched = {
        ...expected,
        [relation === 'event' ? 'eventId' : 'orderId']: id,
      };
      await expect(
        db().updateWithSignedTxIfUnchanged(matched, signedJson),
      ).resolves.toBe(true);
      expect((await db().getTxById(expected.txId))![relation]?.id).toBe(id);
      expect(notify).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * @target DatabaseAction.updateWithSignedTxIfUnchanged 'does not persist when only %s differs from the preimage'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'does not persist when only %s differs from the preimage' through updateWithSignedTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateWithSignedTxIfUnchanged( { ...expected, [field]: value }, signedJson, ), ).resolves.toBe(false); expect((await db().getTxById(expected.txId))!.txJson).toBe( expected.txJson, ); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    ['txId', 'missing-id'],
    ['txJson', 'changed-unsigned'],
    ['chain', 'avalanche'],
    ['type', TransactionType.reward],
    ['requiredSign', 4],
    ['eventId', 'other-event'],
    ['orderId', 'other-order'],
  ] as const)(
    'does not persist when only %s differs from the preimage',
    async (field, value) => {
      await expect(
        db().updateWithSignedTxIfUnchanged(
          { ...expected, [field]: value },
          signedJson,
        ),
      ).resolves.toBe(false);
      expect((await db().getTxById(expected.txId))!.txJson).toBe(
        expected.txJson,
      );
      expect(notify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.updateWithSignedTxIfUnchanged 'rejects a row that changed to %s after validation'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects a row that changed to %s after validation' through updateWithSignedTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateWithSignedTxIfUnchanged(expected, signedJson), ).resolves.toBe(false); expect((await db().getTxById(expected.txId))!.txJson).toBe(expected.txJson); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    TransactionStatus.approved,
    TransactionStatus.signFailed,
    TransactionStatus.signed,
    TransactionStatus.sent,
    TransactionStatus.invalid,
    TransactionStatus.completed,
  ])('rejects a row that changed to %s after validation', async (status) => {
    await db().TransactionRepository.update(
      { txId: expected.txId },
      { status },
    );
    await expect(
      db().updateWithSignedTxIfUnchanged(expected, signedJson),
    ).resolves.toBe(false);
    expect((await db().getTxById(expected.txId))!.txJson).toBe(expected.txJson);
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.updateWithSignedTxIfUnchanged 'does not recreate a deleted row'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'does not recreate a deleted row' through updateWithSignedTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateWithSignedTxIfUnchanged(expected, signedJson), ).resolves.toBe(false); expect(await db().getTxById(expected.txId)).toBeNull(); expect(notify).not.toHaveBeenCalled();
   */
  it('does not recreate a deleted row', async () => {
    await db().TransactionRepository.delete({ txId: expected.txId });
    await expect(
      db().updateWithSignedTxIfUnchanged(expected, signedJson),
    ).resolves.toBe(false);
    expect(await db().getTxById(expected.txId)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.updateWithSignedTxIfUnchanged 'preserves a replacement written after the preimage was captured'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'preserves a replacement written after the preimage was captured' through updateWithSignedTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateWithSignedTxIfUnchanged(expected, signedJson), ).resolves.toBe(false); expect((await db().getTxById(expected.txId))!.txJson).toBe('replacement'); expect(notify).not.toHaveBeenCalled();
   */
  it('preserves a replacement written after the preimage was captured', async () => {
    await db().TransactionRepository.update(
      { txId: expected.txId },
      { txJson: 'replacement' },
    );
    await expect(
      db().updateWithSignedTxIfUnchanged(expected, signedJson),
    ).resolves.toBe(false);
    expect((await db().getTxById(expected.txId))!.txJson).toBe('replacement');
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * @target DatabaseAction.updateWithSignedTxIfUnchanged 'refuses missing %s rather than omitting an SQL predicate'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'refuses missing %s rather than omitting an SQL predicate' through updateWithSignedTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateWithSignedTxIfUnchanged( { ...expected, [field]: undefined } as unknown as SigningRowPreimage, signedJson, ), ).rejects.toThrow('preimage'); expect((await db().getTxById(expected.txId))!.txJson).toBe( expected.txJson, ); expect(notify).not.toHaveBeenCalled();
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
    'refuses missing %s rather than omitting an SQL predicate',
    async (field) => {
      await expect(
        db().updateWithSignedTxIfUnchanged(
          { ...expected, [field]: undefined } as unknown as SigningRowPreimage,
          signedJson,
        ),
      ).rejects.toThrow('preimage');
      expect((await db().getTxById(expected.txId))!.txJson).toBe(
        expected.txJson,
      );
      expect(notify).not.toHaveBeenCalled();
    },
  );

  /**
   * @target DatabaseAction.updateWithSignedTxIfUnchanged 'requires an in-sign preimage and nonempty signed bytes'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'requires an in-sign preimage and nonempty signed bytes' through updateWithSignedTxIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().updateWithSignedTxIfUnchanged( { ...expected, status: TransactionStatus.approved }, signedJson, ), ).rejects.toThrow('preimage'); await expect( db().updateWithSignedTxIfUnchanged(expected, ''), ).rejects.toThrow('preimage'); expect(notify).not.toHaveBeenCalled();
   */
  it('requires an in-sign preimage and nonempty signed bytes', async () => {
    await expect(
      db().updateWithSignedTxIfUnchanged(
        { ...expected, status: TransactionStatus.approved },
        signedJson,
      ),
    ).rejects.toThrow('preimage');
    await expect(
      db().updateWithSignedTxIfUnchanged(expected, ''),
    ).rejects.toThrow('preimage');
    expect(notify).not.toHaveBeenCalled();
  });
});
