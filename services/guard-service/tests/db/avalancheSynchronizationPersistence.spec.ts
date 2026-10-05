import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import type { ConfirmedEventEntity } from '../../src/db/entities/confirmedEventEntity';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import { mockEventTrigger } from '../event/testData';
import DatabaseActionMock from './mocked/databaseAction.mock';

describe('atomic synchronized payment persistence', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let expected: ConfirmedEventEntity;
  let payment: PaymentTransaction;
  const txNotify = vi.fn();
  const eventNotify = vi.fn();
  const prepare = async (
    network = 'avalanche',
    firstTry: string | undefined = 'first',
  ) => {
    const event = mockEventTrigger().event;
    event.fromChain = 'ergo';
    event.toChain = network;
    await DatabaseActionMock.insertEventRecord(
      event,
      EventStatus.pendingPayment,
      undefined,
      undefined,
      firstTry,
    );
    const eventId = Utils.txIdToEventId(event.sourceTxId);
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { unexpectedFails: 4 },
    );
    expected = (await db().getEventById(eventId))!;
    payment =
      network === 'ergo'
        ? new ErgoTransaction(
            'sync-payment',
            eventId,
            Buffer.from('abcd', 'hex'),
            TransactionType.payment,
            [Buffer.from('dcba', 'hex')],
            [],
          )
        : new PaymentTransaction(
            network,
            'sync-payment',
            eventId,
            Buffer.from('abcd', 'hex'),
            TransactionType.payment,
          );
  };
  const state = async () => ({
    events: await db().ConfirmedEventRepository.find({
      relations: ['eventData'],
    }),
    transactions: await db().TransactionRepository.find({
      relations: ['event', 'order'],
    }),
  });
  const sync = () =>
    db().insertSynchronizedPaymentIfUnchanged(payment, expected, 3, 123);
  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
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
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'atomically inserts completed %s payment and updates its event'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'atomically inserts completed %s payment and updates its event' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected txNotify.mockImplementation(() => expect(committed).toBe(true)); eventNotify.mockImplementation(() => expect(committed).toBe(true)); await expect(sync()).resolves.toBe(true); expect(after.events).toEqual([ { ...before.events[0], status, firstTry: network === 'ergo' ? 'first' : '1730000000', }, ]); expect(after.transactions).toHaveLength(1); expect(after.transactions[0]).toMatchObject({ txId: payment.txId, txJson: payment.toJson(), chain: network, type: TransactionType.payment, status: TransactionStatus.completed, requiredSign: 3, lastCheck: 123, lastStatusUpdate: '1730000000', failedInSign: false, signFailedCount: 0, event: { id: expected.id }, order: null, }); expect(txNotify).toHaveBeenCalledExactlyOnceWith( payment.txId, TransactionStatus.completed, ); expect(eventNotify).toHaveBeenCalledExactlyOnceWith(expected.id, status);
   */
  it.each(['avalanche', 'ethereum', 'ergo'])(
    'atomically inserts completed %s payment and updates its event',
    async (network) => {
      await prepare(network);
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
      await expect(sync()).resolves.toBe(true);
      const after = await state();
      const status =
        network === 'ergo' ? EventStatus.completed : EventStatus.pendingReward;
      expect(after.events).toEqual([
        {
          ...before.events[0],
          status,
          firstTry: network === 'ergo' ? 'first' : '1730000000',
        },
      ]);
      expect(after.transactions).toHaveLength(1);
      expect(after.transactions[0]).toMatchObject({
        txId: payment.txId,
        txJson: payment.toJson(),
        chain: network,
        type: TransactionType.payment,
        status: TransactionStatus.completed,
        requiredSign: 3,
        lastCheck: 123,
        lastStatusUpdate: '1730000000',
        failedInSign: false,
        signFailedCount: 0,
        event: { id: expected.id },
        order: null,
      });
      expect(txNotify).toHaveBeenCalledExactlyOnceWith(
        payment.txId,
        TransactionStatus.completed,
      );
      expect(eventNotify).toHaveBeenCalledExactlyOnceWith(expected.id, status);
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'accepts an explicit null firstTry and preserves it for Ergo'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'accepts an explicit null firstTry and preserves it for Ergo' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(true); expect((await db().getEventById(expected.id))?.firstTry).toBeNull();
   */
  it('accepts an explicit null firstTry and preserves it for Ergo', async () => {
    await prepare('ergo');
    await db().ConfirmedEventRepository.update(
      { id: expected.id },
      { firstTry: null as unknown as string },
    );
    expected = (await db().getEventById(expected.id))!;
    await expect(sync()).resolves.toBe(true);
    expect((await db().getEventById(expected.id))?.firstTry).toBeNull();
  });
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects noneligible event phase %s before query'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects noneligible event phase %s before query' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled(); expect(txNotify).not.toHaveBeenCalled();
   */
  it.each(
    Object.values(EventStatus).filter(
      (status) => status !== EventStatus.pendingPayment,
    ),
  )('rejects noneligible event phase %s before query', async (status) => {
    await prepare();
    expected.status = status;
    const transaction = vi.spyOn(db().dataSource, 'transaction');
    await expect(sync()).rejects.toThrow('preimage');
    expect(transaction).not.toHaveBeenCalled();
    expect(txNotify).not.toHaveBeenCalled();
  });
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
    'txId',
    'eventId',
  ] as const;
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'compares persisted protocol field %s independently'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'compares persisted protocol field %s independently' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each(protocolFields)(
    'compares persisted protocol field %s independently',
    async (field) => {
      await prepare();
      const original = expected.eventData[field];
      await db().EventRepository.update(
        { id: expected.eventData.id },
        {
          [field]:
            typeof original === 'number' ? original + 1 : original + '-changed',
        },
      );
      const before = await state();
      await expect(sync()).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'compares persisted confirmed field %s independently'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'compares persisted confirmed field %s independently' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled();
   */
  it.each(['status', 'firstTry', 'unexpectedFails'] as const)(
    'compares persisted confirmed field %s independently',
    async (field) => {
      await prepare();
      await db().ConfirmedEventRepository.update(
        { id: expected.id },
        { [field]: field === 'unexpectedFails' ? 5 : 'changed' },
      );
      const before = await state();
      await expect(sync()).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'binds the exact eventData row even with identical protocol fields'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'binds the exact eventData row even with identical protocol fields' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(false); expect(await state()).toEqual(before);
   */
  it('binds the exact eventData row even with identical protocol fields', async () => {
    await prepare();
    const original = expected.eventData;
    const copy = { ...original, id: undefined };
    const duplicate = await db().EventRepository.save(
      db().EventRepository.create({ ...copy, identifier: 'other-box' }),
    );
    await db().ConfirmedEventRepository.update(
      { id: expected.id },
      { eventData: { id: duplicate.id } },
    );
    const before = await state();
    await expect(sync()).resolves.toBe(false);
    expect(await state()).toEqual(before);
  });
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'returns false for a missing confirmed event'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'returns false for a missing confirmed event' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(false); expect(await db().TransactionRepository.count()).toBe(0);
   */
  it('returns false for a missing confirmed event', async () => {
    await prepare();
    await db().ConfirmedEventRepository.delete({ id: expected.id });
    await expect(sync()).resolves.toBe(false);
    expect(await db().TransactionRepository.count()).toBe(0);
  });
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects absent confirmed input %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects absent confirmed input %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
   */
  it.each([
    'id',
    'status',
    'firstTry',
    'unexpectedFails',
    'eventData',
  ] as const)('rejects absent confirmed input %s', async (field) => {
    await prepare();
    Object.assign(expected, { [field]: undefined });
    const transaction = vi.spyOn(db().dataSource, 'transaction');
    await expect(sync()).rejects.toThrow('preimage');
    expect(transaction).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects undefined eventData input %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects undefined eventData input %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
   */
  it.each([...protocolFields, 'id'] as const)(
    'rejects undefined eventData input %s',
    async (field) => {
      await prepare();
      Object.assign(expected.eventData, { [field]: undefined });
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(sync()).rejects.toThrow('preimage');
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects mismatched serialized %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects mismatched serialized %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
   */
  it.each(['network', 'txId', 'eventId', 'txType', 'txBytes'] as const)(
    'rejects mismatched serialized %s',
    async (field) => {
      await prepare();
      const model = JSON.parse(payment.toJson());
      model[field] = 'different';
      vi.spyOn(payment, 'toJson').mockReturnValue(JSON.stringify(model));
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(sync()).rejects.toThrow('preimage');
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects mismatched serialized Ergo %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects mismatched serialized Ergo %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('auxiliary'); expect(await db().TransactionRepository.count()).toBe(0);
   */
  it.each(['inputBoxes', 'dataInputs'] as const)(
    'rejects mismatched serialized Ergo %s',
    async (field) => {
      await prepare('ergo');
      const model = JSON.parse(payment.toJson());
      model[field] = ['cafe'];
      vi.spyOn(payment, 'toJson').mockReturnValue(JSON.stringify(model));
      await expect(sync()).rejects.toThrow('auxiliary');
      expect(await db().TransactionRepository.count()).toBe(0);
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects internally consistent wrong payment route %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects internally consistent wrong payment route %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage');
   */
  it.each(['network', 'eventId', 'txType'] as const)(
    'rejects internally consistent wrong payment route %s',
    async (field) => {
      await prepare();
      if (field === 'network') payment.network = 'ethereum';
      else if (field === 'eventId') payment.eventId = '00'.repeat(32);
      else payment.txType = TransactionType.reward;
      await expect(sync()).rejects.toThrow('preimage');
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects broken event digest binding %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects broken event digest binding %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage');
   */
  it.each(['id', 'sourceTxId', 'eventId'] as const)(
    'rejects broken event digest binding %s',
    async (field) => {
      await prepare();
      if (field === 'id') expected.id = '00'.repeat(32);
      else expected.eventData[field] = '00'.repeat(32);
      await expect(sync()).rejects.toThrow('preimage');
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects invalid currentHeight %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid currentHeight %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().insertSynchronizedPaymentIfUnchanged( payment, expected, 3, height as number, ), ).rejects.toThrow('preimage');
   */
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined])(
    'rejects invalid currentHeight %s',
    async (height) => {
      await prepare();
      await expect(
        db().insertSynchronizedPaymentIfUnchanged(
          payment,
          expected,
          3,
          height as number,
        ),
      ).rejects.toThrow('preimage');
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects invalid requiredSign %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects invalid requiredSign %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().insertSynchronizedPaymentIfUnchanged( payment, expected, requiredSign as number, 123, ), ).rejects.toThrow('preimage');
   */
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined])(
    'rejects invalid requiredSign %s',
    async (requiredSign) => {
      await prepare();
      await expect(
        db().insertSynchronizedPaymentIfUnchanged(
          payment,
          expected,
          requiredSign as number,
          123,
        ),
      ).rejects.toThrow('preimage');
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects duplicate candidate ID already %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects duplicate candidate ID already %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each(Object.values(TransactionStatus))(
    'rejects duplicate candidate ID already %s',
    async (status) => {
      await prepare();
      const sameId = new PaymentTransaction(
        'ergo',
        payment.txId,
        '',
        Buffer.from('cafe', 'hex'),
        TransactionType.manual,
      );
      await DatabaseActionMock.insertTxRecord(sameId, status, 0);
      const before = await state();
      await expect(sync()).resolves.toBe(false);
      expect(await state()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects another event payment already %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects another event payment already %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled();
   */
  it.each(
    Object.values(TransactionStatus).filter(
      (status) => status !== TransactionStatus.invalid,
    ),
  )('rejects another event payment already %s', async (status) => {
    await prepare();
    const previous = new PaymentTransaction(
      payment.network,
      'previous-payment',
      payment.eventId,
      Buffer.from('cafe', 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(previous, status, 0);
    const before = await state();
    await expect(sync()).resolves.toBe(false);
    expect(await state()).toEqual(before);
    expect(txNotify).not.toHaveBeenCalled();
  });
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'allows a different invalid previous payment'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'allows a different invalid previous payment' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(true); expect((await db().getTxById(previous.txId))?.status).toBe( TransactionStatus.invalid, );
   */
  it('allows a different invalid previous payment', async () => {
    await prepare();
    const previous = new PaymentTransaction(
      payment.network,
      'invalid-payment',
      payment.eventId,
      Buffer.from('cafe', 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      previous,
      TransactionStatus.invalid,
      0,
    );
    await expect(sync()).resolves.toBe(true);
    expect((await db().getTxById(previous.txId))?.status).toBe(
      TransactionStatus.invalid,
    );
  });
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'admits one concurrent candidate (differentID=%s)'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'admits one concurrent candidate (differentID=%s)' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected expect(results.sort()).toEqual([false, true]); expect(await db().TransactionRepository.count()).toBe(1); expect(txNotify).toHaveBeenCalledTimes(1); expect(eventNotify).toHaveBeenCalledTimes(1);
   */
  it.each([false, true])(
    'admits one concurrent candidate (differentID=%s)',
    async (differentId) => {
      await prepare();
      const other = new PaymentTransaction(
        payment.network,
        differentId ? 'other-payment' : payment.txId,
        payment.eventId,
        payment.txBytes,
        payment.txType,
      );
      const results = await Promise.all([
        sync(),
        db().insertSynchronizedPaymentIfUnchanged(other, expected, 3, 123),
      ]);
      expect(results.sort()).toEqual([false, true]);
      expect(await db().TransactionRepository.count()).toBe(1);
      expect(txNotify).toHaveBeenCalledTimes(1);
      expect(eventNotify).toHaveBeenCalledTimes(1);
    },
  );
  for (const table of ['transaction_entity', 'confirmed_event_entity']) {
    /**
     * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged `rolls back ${table} %s`
     * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
     * @scenario Exercise `rolls back ${table} %s` through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
     * @expected await expect(sync()).rejects.toThrow('sync SQL failed'); await expect(sync()).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
     */
    it.each(['ABORT', 'IGNORE'])(`rolls back ${table} %s`, async (mode) => {
      await prepare();
      const before = await state();
      await db().dataSource.query(
        `CREATE TEMP TRIGGER reject_sync BEFORE ${table === 'transaction_entity' ? 'INSERT' : 'UPDATE'} ON ${table} BEGIN SELECT RAISE(${mode === 'ABORT' ? "ABORT, 'sync SQL failed'" : 'IGNORE'}); END`,
      );
      try {
        if (mode === 'ABORT')
          await expect(sync()).rejects.toThrow('sync SQL failed');
        else await expect(sync()).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER reject_sync');
      }
    });
  }
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'event CAS detects %s drift caused by insert trigger and rolls everything back'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'event CAS detects %s drift caused by insert trigger and rolls everything back' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(false); expect(await state()).toEqual(before); expect(txNotify).not.toHaveBeenCalled();
   */
  it.each(['amount', 'txId'] as const)(
    'event CAS detects %s drift caused by insert trigger and rolls everything back',
    async (field) => {
      await prepare();
      const before = await state();
      await db().dataSource.query(
        `CREATE TEMP TRIGGER drift_sync AFTER INSERT ON transaction_entity BEGIN UPDATE event_trigger_entity SET "${field}" = 'changed' WHERE id = ${expected.eventData.id}; END`,
      );
      try {
        await expect(sync()).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER drift_sync');
      }
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'ignores mutable spend metadata while preserving exact protocol fields'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'ignores mutable spend metadata while preserving exact protocol fields' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).resolves.toBe(true); expect((await db().getEventById(expected.id))?.eventData.spendHeight).toBe( 456, );
   */
  it('ignores mutable spend metadata while preserving exact protocol fields', async () => {
    await prepare();
    await db().EventRepository.update(
      { id: expected.eventData.id },
      {
        spendHeight: 456,
        spendBlock: 'spent',
        spendTxId: 'spent',
        result: 'paid',
        paymentTxId: payment.txId,
      },
    );
    await expect(sync()).resolves.toBe(true);
    expect((await db().getEventById(expected.id))?.eventData.spendHeight).toBe(
      456,
    );
  });
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects non-object or malformed transaction JSON %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects non-object or malformed transaction JSON %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow(); expect(transaction).not.toHaveBeenCalled();
   */
  it.each(['null', '[]', '"text"', '{'])(
    'rejects non-object or malformed transaction JSON %s',
    async (json) => {
      await prepare();
      vi.spyOn(payment, 'toJson').mockReturnValue(json);
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      await expect(sync()).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects malformed numeric trigger %s before querying'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects malformed numeric trigger %s before querying' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage'); expect(transaction).not.toHaveBeenCalled();
   */
  it.each(['height', 'sourceChainHeight', 'WIDsCount', 'id'] as const)(
    'rejects malformed numeric trigger %s before querying',
    async (field) => {
      await prepare();
      const transaction = vi.spyOn(db().dataSource, 'transaction');
      for (const invalid of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '1',
      ]) {
        Object.assign(expected.eventData, { [field]: invalid });
        await expect(sync()).rejects.toThrow('preimage');
      }
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects malformed chain name %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects malformed chain name %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage');
   */
  it.each(['fromChain', 'toChain'] as const)(
    'rejects malformed chain name %s',
    async (field) => {
      await prepare();
      for (const invalid of ['', 'Avalanche', 'avalanche ']) {
        expected.eventData[field] = invalid;
        if (field === 'toChain') payment.network = invalid;
        await expect(sync()).rejects.toThrow('preimage');
      }
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects malformed confirmed field %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'rejects malformed confirmed field %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('preimage');
   */
  it.each(['firstTry', 'unexpectedFails'] as const)(
    'rejects malformed confirmed field %s',
    async (field) => {
      await prepare();
      const values =
        field === 'firstTry'
          ? [0, {}]
          : [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4'];
      for (const invalid of values) {
        Object.assign(expected, { [field]: invalid });
        await expect(sync()).rejects.toThrow('preimage');
      }
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'accepts exact currentHeight boundary %s'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'accepts exact currentHeight boundary %s' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect( db().insertSynchronizedPaymentIfUnchanged(payment, expected, 1, height), ).resolves.toBe(true); expect((await db().getTxById(payment.txId))?.lastCheck).toBe(height);
   */
  it.each([0, Number.MAX_SAFE_INTEGER])(
    'accepts exact currentHeight boundary %s',
    async (height) => {
      await prepare();
      await expect(
        db().insertSynchronizedPaymentIfUnchanged(payment, expected, 1, height),
      ).resolves.toBe(true);
      expect((await db().getTxById(payment.txId))?.lastCheck).toBe(height);
    },
  );
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'requires the full Ergo auxiliary model'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'requires the full Ergo auxiliary model' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(sync()).rejects.toThrow('auxiliary'); expect(await db().TransactionRepository.count()).toBe(0);
   */
  it('requires the full Ergo auxiliary model', async () => {
    await prepare('ergo');
    payment = new PaymentTransaction(
      'ergo',
      payment.txId,
      payment.eventId,
      payment.txBytes,
      payment.txType,
    );
    await expect(sync()).rejects.toThrow('auxiliary');
    expect(await db().TransactionRepository.count()).toBe(0);
  });
  /**
   * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'captures mutable payment, bytes and event inputs before yielding'
   * @dependencies Actual DatabaseAction, SQLite transaction repositories, and the suite's captured preimage fixtures.
   * @scenario Exercise 'captures mutable payment, bytes and event inputs before yielding' through insertSynchronizedPaymentIfUnchanged using the named isolated input or authority change.
   * @expected await expect(pending).resolves.toBe(true); expect((await db().getTxById(txId))?.txJson).toBe(json); expect(eventNotify).toHaveBeenCalledExactlyOnceWith( id, EventStatus.completed, );
   */
  it('captures mutable payment, bytes and event inputs before yielding', async () => {
    await prepare('ergo');
    const id = expected.id;
    const txId = payment.txId;
    const json = payment.toJson();
    const pending = sync();
    payment.txId = 'changed';
    payment.txBytes[0] = 0;
    payment.network = 'other';
    (payment as ErgoTransaction).inputBoxes[0][0] = 0;
    expected.id = 'changed';
    expected.eventData.amount = 'changed';
    expected.firstTry = 'changed';
    await expect(pending).resolves.toBe(true);
    expect((await db().getTxById(txId))?.txJson).toBe(json);
    expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
      id,
      EventStatus.completed,
    );
  });
});
