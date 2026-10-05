import { blake2b } from 'blakejs';

import { BlockEntity } from '@rosen-bridge/abstract-scanner';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import {
  ConfirmationStatus,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import { DatabaseAction } from '../../src/db/databaseAction';
import { dataSource as configuredSource } from '../../src/db/dataSource';
import ChainHandler from '../../src/handlers/chainHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import {
  createGuardSigningRuntime,
  GuardSigningRuntime,
} from '../../src/signing/signingRuntime';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import {
  TestDatabase as FixtureDatabase,
  blockHash,
  decode,
} from './avalancheTransactionTestUtils';

const eventId = Buffer.from(blake2b('actions-source', undefined, 32)).toString(
  'hex',
);

describe('qualified transaction dispatch and finalization with SQLite', () => {
  let source: DataSource;
  let db: FixtureDatabase;
  let network: AvalancheRpcNetwork;
  let scanner: AvalancheRpcScanner;
  let runtime: GuardSigningRuntime;
  let payment: PaymentTransaction;
  const submit = vi.fn<(tx: PaymentTransaction) => Promise<void>>();
  const confirmation = vi.fn<() => Promise<ConfirmationStatus>>();
  const valid =
    vi.fn<(tx: PaymentTransaction) => Promise<{ isValid: boolean }>>();
  const getChain = vi.fn();
  const row = async () => (await db.getTxById(payment.txId))!;
  const event = async () =>
    await db.ConfirmedEventRepository.findOneByOrFail({ id: eventId });
  const hold = () =>
    source
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'fixture hold' });
  const status = (value: string) =>
    db.TransactionRepository.update({ txId: payment.txId }, { status: value });
  const destination = async () => {
    await db.EventRepository.update(
      { eventId },
      { fromChain: 'ergo', toChain: 'avalanche' },
    );
    payment = new PaymentTransaction(
      'avalanche',
      payment.txId,
      eventId,
      payment.txBytes,
      TransactionType.payment,
    );
    await db.TransactionRepository.update(
      { txId: payment.txId },
      { chain: payment.network, txJson: payment.toJson() },
    );
  };

  beforeEach(async () => {
    if (configuredSource.options.type !== 'sqlite')
      throw new Error('SQLite configuration required');
    source = await new DataSource({
      ...configuredSource.options,
      type: 'sqlite',
      database: ':memory:',
    }).initialize();
    await source.runMigrations();
    db = new FixtureDatabase(source);
    vi.spyOn(DatabaseAction, 'getInstance').mockReturnValue(db);
    vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicEventStatus',
    ).mockResolvedValue(undefined);
    network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
    vi.spyOn(network, 'getCurrentHeight').mockResolvedValue(2);
    vi.spyOn(network, 'getBlockAtHeight').mockImplementation(
      async (height) => ({
        hash: blockHash(height),
        height,
        parentHash: blockHash(height - 1),
        timestamp: 100 + height,
        txCount: 0,
      }),
    );
    vi.spyOn(network, 'getBlockTxs').mockResolvedValue([]);
    scanner = new AvalancheRpcScanner({
      network,
      dataSource: source,
      sourceId: 'actions-source',
      initialHeight: 0,
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 0,
      },
    });
    await scanner.update();
    await db.EventRepository.insert({
      height: 4,
      fromChain: 'avalanche',
      toChain: 'ergo',
      fromAddress: 'source',
      toAddress: 'target',
      amount: '10',
      bridgeFee: '1',
      networkFee: '1',
      sourceChainTokenId: 'avax',
      targetChainTokenId: 'wrapped',
      sourceTxId: 'actions-source',
      sourceChainHeight: 1,
      sourceBlockId: blockHash(1),
      WIDsHash: 'wids',
      WIDsCount: 1,
      extractor: 'fixture',
      identifier: 'fixture',
      serialized: 'fixture',
      block: 'fixture',
      txId: 'creation',
      eventId,
    });
    const eventData = await db.EventRepository.findOneByOrFail({ eventId });
    await db.ConfirmedEventRepository.insert({
      id: eventId,
      eventData,
      status: EventStatus.inPayment,
    });
    payment = new ErgoTransaction(
      'action-payment',
      eventId,
      Buffer.from('cdef', 'hex'),
      TransactionType.payment,
      [Buffer.from('aa', 'hex')],
      [Buffer.from('bb', 'hex')],
    );
    await db.TransactionRepository.insert({
      txId: payment.txId,
      txJson: payment.toJson(),
      chain: payment.network,
      type: payment.txType,
      status: TransactionStatus.signed,
      requiredSign: 2,
      lastCheck: 7,
      failedInSign: false,
      signFailedCount: 0,
      event: { id: eventId },
    });
    runtime = createGuardSigningRuntime({
      getEvent: db.getEventById,
      getTx: db.getTxById,
      decode,
      getScanner: () => scanner,
      curveTimeoutSeconds: 10,
      edwardTimeoutSeconds: 10,
      ergoTimeoutSeconds: 10,
      maxPending: 4,
    });
    TransactionProcessor.initSigning(runtime.context, runtime.processor);
    submit.mockReset().mockResolvedValue(undefined);
    confirmation.mockReset().mockResolvedValue(ConfirmationStatus.NotFound);
    valid.mockReset().mockResolvedValue({ isValid: true });
    getChain.mockReset().mockReturnValue({
      submitTransaction: submit,
      getTxConfirmationStatus: confirmation,
      isTxInMempool: vi.fn().mockResolvedValue(false),
      isTxValid: valid,
      getHeight: vi.fn().mockResolvedValue(2),
      getTxRequiredConfirmation: vi.fn().mockReturnValue(5),
    });
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getChain,
    } as unknown as ChainHandler);
  });
  afterEach(async () => {
    network['provider'].destroy();
    await source.destroy();
    vi.restoreAllMocks();
  });

  /**
   * @target TransactionProcessor.setTransactionAsInvalid 'rejects an invalid captured lastCheck before querying the chain'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects an invalid captured lastCheck before querying the chain' with the suite's captured inputs and invoke the setTransactionAsInvalid path.
   * @expected await expect( TransactionProcessor.setTransactionAsInvalid(captured, getChain(), { reason: 'spent', unexpected: false, }), ).rejects.toThrow('invalidation evidence'); expect(getChain().getHeight).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.sent); expect((await event()).status).toBe(EventStatus.inPayment);
   */
  it('rejects an invalid captured lastCheck before querying the chain', async () => {
    await status(TransactionStatus.sent);
    const captured = await row();
    captured.lastCheck = -1;
    await expect(
      TransactionProcessor.setTransactionAsInvalid(captured, getChain(), {
        reason: 'spent',
        unexpected: false,
      }),
    ).rejects.toThrow('invalidation evidence');
    expect(getChain().getHeight).not.toHaveBeenCalled();
    expect((await row()).status).toBe(TransactionStatus.sent);
    expect((await event()).status).toBe(EventStatus.inPayment);
  });

  for (const field of ['height', 'confirmation']) {
    for (const value of [Number.NaN, -1, Infinity, 1.5]) {
      /**
       * @target TransactionProcessor.setTransactionAsInvalid `rejects invalid ${field} ${value} before resetting the payment`
       * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
       * @scenario Run `rejects invalid ${field} ${value} before resetting the payment` with the suite's captured inputs and invoke the setTransactionAsInvalid path.
       * @expected await expect( TransactionProcessor.setTransactionAsInvalid( await row(), getChain(), { reason: 'spent', unexpected: false }, ), ).rejects.toThrow('height or confirmation'); expect((await row()).status).toBe(TransactionStatus.sent); expect((await event()).status).toBe(EventStatus.inPayment);
       */
      it(`rejects invalid ${field} ${value} before resetting the payment`, async () => {
        await status(TransactionStatus.sent);
        getChain().getHeight.mockResolvedValue(field === 'height' ? value : 12);
        getChain().getTxRequiredConfirmation.mockReturnValue(
          field === 'confirmation' ? value : 5,
        );
        await expect(
          TransactionProcessor.setTransactionAsInvalid(
            await row(),
            getChain(),
            { reason: 'spent', unexpected: false },
          ),
        ).rejects.toThrow('height or confirmation');
        expect((await row()).status).toBe(TransactionStatus.sent);
        expect((await event()).status).toBe(EventStatus.inPayment);
      });
    }
  }

  /**
   * @target TransactionProcessor.setTransactionAsInvalid 'refuses fake Avalanche authority even with a zero confirmation threshold'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'refuses fake Avalanche authority even with a zero confirmation threshold' with the suite's captured inputs and invoke the setTransactionAsInvalid path.
   * @expected expect(payment.network).toBe('ergo'); await expect( TransactionProcessor.setTransactionAsInvalid(await row(), getChain(), { reason: 'spent', unexpected: false, }), ).rejects.toThrow(); expect({ row: await row(), event: await event() }).toEqual(before); expect(submit).not.toHaveBeenCalled();
   */
  it('refuses fake Avalanche authority even with a zero confirmation threshold', async () => {
    await status(TransactionStatus.sent);
    expect(payment.network).toBe('ergo');
    getChain().getHeight.mockResolvedValue(7);
    getChain().getTxRequiredConfirmation.mockReturnValue(0);
    const before = { row: await row(), event: await event() };
    await expect(
      TransactionProcessor.setTransactionAsInvalid(await row(), getChain(), {
        reason: 'spent',
        unexpected: false,
      }),
    ).rejects.toThrow();
    expect({ row: await row(), event: await event() }).toEqual(before);
    expect(submit).not.toHaveBeenCalled();
  });

  for (const direction of ['source', 'destination']) {
    for (const previous of [
      TransactionStatus.sent,
      TransactionStatus.signFailed,
    ]) {
      /**
       * @target TransactionProcessor.setTransactionAsInvalid `refuses fake ${direction} invalidation authority from ${previous}`
       * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
       * @scenario Run `refuses fake ${direction} invalidation authority from ${previous}` with the suite's captured inputs and invoke the setTransactionAsInvalid path.
       * @expected await expect( TransactionProcessor.setTransactionAsInvalid( await row(), getChain(), { reason: 'spent', unexpected: false }, ), ).rejects.toThrow(); expect({ row: await row(), event: await event() }).toEqual(before); expect(submit).not.toHaveBeenCalled();
       */
      it(`refuses fake ${direction} invalidation authority from ${previous}`, async () => {
        if (direction === 'destination') await destination();
        await status(previous);
        getChain().getHeight.mockResolvedValue(12);
        const before = { row: await row(), event: await event() };
        await expect(
          TransactionProcessor.setTransactionAsInvalid(
            await row(),
            getChain(),
            { reason: 'spent', unexpected: false },
          ),
        ).rejects.toThrow();
        expect({ row: await row(), event: await event() }).toEqual(before);
        expect(submit).not.toHaveBeenCalled();
      });
    }

    for (const fault of [
      'hold',
      'late hold',
      'last check',
      'transaction',
      'event phase',
      'status',
    ]) {
      /**
       * @target TransactionProcessor.setTransactionAsInvalid `refuses ${direction} invalidation after ${fault} changes`
       * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
       * @scenario Run `refuses ${direction} invalidation after ${fault} changes` with the suite's captured inputs and invoke the setTransactionAsInvalid path.
       * @expected await expect( TransactionProcessor.setTransactionAsInvalid( await row(), getChain(), { reason: 'spent', unexpected: false }, ), ).rejects.toThrow(); expect((await row()).status).toBe( fault === 'status' ? TransactionStatus.signFailed : TransactionStatus.sent, ); expect((await event()).status).toBe( fault === 'event phase' ? EventStatus.completed : EventStatus.inPayment, ); expect(submit).not.toHaveBeenCalled();
       */
      it(`refuses ${direction} invalidation after ${fault} changes`, async () => {
        if (direction === 'destination') await destination();
        await status(TransactionStatus.sent);
        if (fault === 'hold') await hold();
        getChain().getHeight.mockImplementation(async () => {
          if (fault === 'late hold') await hold();
          if (fault === 'last check')
            await db.updateTxLastCheck(payment.txId, 11);
          if (fault === 'transaction')
            await db.TransactionRepository.update(
              { txId: payment.txId },
              { txJson: 'replacement' },
            );
          if (fault === 'event phase')
            await db.ConfirmedEventRepository.update(
              { id: eventId },
              { status: EventStatus.completed },
            );
          if (fault === 'status') await status(TransactionStatus.signFailed);
          return 12;
        });
        await expect(
          TransactionProcessor.setTransactionAsInvalid(
            await row(),
            getChain(),
            { reason: 'spent', unexpected: false },
          ),
        ).rejects.toThrow();
        expect((await row()).status).toBe(
          fault === 'status'
            ? TransactionStatus.signFailed
            : TransactionStatus.sent,
        );
        expect((await event()).status).toBe(
          fault === 'event phase'
            ? EventStatus.completed
            : EventStatus.inPayment,
        );
        expect(submit).not.toHaveBeenCalled();
      });
    }

    /**
     * @target TransactionProcessor.setTransactionAsInvalid `refuses fake ${direction} invalidation despite caller mutation during height lookup`
     * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `refuses fake ${direction} invalidation despite caller mutation during height lookup` with the suite's captured inputs and invoke the setTransactionAsInvalid path.
     * @expected await expect( TransactionProcessor.setTransactionAsInvalid( original, getChain(), details, ), ).rejects.toThrow(); expect({ row: await row(), event: await event() }).toEqual(before); expect(submit).not.toHaveBeenCalled();
     */
    it(`refuses fake ${direction} invalidation despite caller mutation during height lookup`, async () => {
      if (direction === 'destination') await destination();
      await status(TransactionStatus.sent);
      const original = await row();
      const before = { row: await row(), event: await event() };
      const details = { reason: 'spent', unexpected: false };
      getChain().getHeight.mockImplementation(async () => {
        original.chain = 'ethereum';
        original.lastCheck = 99;
        original.event!.id = 'replacement';
        details.unexpected = true;
        return 12;
      });
      await expect(
        TransactionProcessor.setTransactionAsInvalid(
          original,
          getChain(),
          details,
        ),
      ).rejects.toThrow();
      expect({ row: await row(), event: await event() }).toEqual(before);
      expect(submit).not.toHaveBeenCalled();
    });

    /**
     * @target TransactionProcessor.setTransactionAsInvalid `keeps ${direction} invalidation unchanged below the confirmation threshold`
     * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `keeps ${direction} invalidation unchanged below the confirmation threshold` with the suite's captured inputs and invoke the setTransactionAsInvalid path.
     * @expected expect((await row()).status).toBe(TransactionStatus.sent); expect((await event()).status).toBe(EventStatus.inPayment);
     */
    it(`keeps ${direction} invalidation unchanged below the confirmation threshold`, async () => {
      if (direction === 'destination') await destination();
      await status(TransactionStatus.sent);
      getChain().getHeight.mockResolvedValue(11);
      await TransactionProcessor.setTransactionAsInvalid(
        await row(),
        getChain(),
        { reason: 'spent', unexpected: false },
      );
      expect((await row()).status).toBe(TransactionStatus.sent);
      expect((await event()).status).toBe(EventStatus.inPayment);
    });

    /**
     * @target TransactionProcessor.processSignedTx `refuses an unqualified fake ${direction} Avalanche payment`
     * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `refuses an unqualified fake ${direction} Avalanche payment` with the suite's captured inputs and invoke the processSignedTx path.
     * @expected await expect( TransactionProcessor.processSignedTx(await row()), ).rejects.toThrow(); expect(submit).not.toHaveBeenCalled(); expect({ row: await row(), event: await event() }).toEqual(before);
     */
    it(`refuses an unqualified fake ${direction} Avalanche payment`, async () => {
      if (direction === 'destination') await destination();
      const before = { row: await row(), event: await event() };
      await expect(
        TransactionProcessor.processSignedTx(await row()),
      ).rejects.toThrow();
      expect(submit).not.toHaveBeenCalled();
      expect({ row: await row(), event: await event() }).toEqual(before);
    });
    for (const phase of ['initial', 'rebroadcast']) {
      /**
       * @target TransactionProcessor.processSignedTx `blocks ${phase} dispatch for held ${direction} Avalanche`
       * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
       * @scenario Run `blocks ${phase} dispatch for held ${direction} Avalanche` with the suite's captured inputs and invoke the processSignedTx path.
       * @expected await expect( phase === 'initial' ? TransactionProcessor.processSignedTx(await row()) : TransactionProcessor.processSentTx(await row()), ).rejects.toThrow(); expect(submit).not.toHaveBeenCalled(); expect((await row()).status).toBe(state);
       */
      it(`blocks ${phase} dispatch for held ${direction} Avalanche`, async () => {
        if (direction === 'destination') await destination();
        const state =
          phase === 'initial'
            ? TransactionStatus.signed
            : TransactionStatus.sent;
        await status(state);
        await hold();
        await expect(
          phase === 'initial'
            ? TransactionProcessor.processSignedTx(await row())
            : TransactionProcessor.processSentTx(await row()),
        ).rejects.toThrow();
        expect(submit).not.toHaveBeenCalled();
        expect((await row()).status).toBe(state);
      });
    }
    /**
     * @target TransactionProcessor.processSentTx `refuses fake ${direction} Avalanche completion authority without changing its event`
     * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `refuses fake ${direction} Avalanche completion authority without changing its event` with the suite's captured inputs and invoke the processSentTx path.
     * @expected await expect( TransactionProcessor.processSentTx(await row()), ).rejects.toThrow(); expect({ row: await row(), event: await event() }).toEqual(before); expect(submit).not.toHaveBeenCalled();
     */
    it(`refuses fake ${direction} Avalanche completion authority without changing its event`, async () => {
      if (direction === 'destination') await destination();
      await status(TransactionStatus.sent);
      confirmation.mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
      const before = { row: await row(), event: await event() };
      await expect(
        TransactionProcessor.processSentTx(await row()),
      ).rejects.toThrow();
      expect({ row: await row(), event: await event() }).toEqual(before);
      expect(submit).not.toHaveBeenCalled();
    });
    /**
     * @target TransactionProcessor.processSentTx `blocks ${direction} finalization when hold appears during confirmation lookup`
     * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `blocks ${direction} finalization when hold appears during confirmation lookup` with the suite's captured inputs and invoke the processSentTx path.
     * @expected await expect( TransactionProcessor.processSentTx(await row()), ).rejects.toThrow(); expect((await row()).status).toBe(TransactionStatus.sent); expect((await event()).status).toBe(EventStatus.inPayment);
     */
    it(`blocks ${direction} finalization when hold appears during confirmation lookup`, async () => {
      if (direction === 'destination') await destination();
      await status(TransactionStatus.sent);
      confirmation.mockImplementation(async () => {
        await hold();
        return ConfirmationStatus.ConfirmedEnough;
      });
      await expect(
        TransactionProcessor.processSentTx(await row()),
      ).rejects.toThrow();
      expect((await row()).status).toBe(TransactionStatus.sent);
      expect((await event()).status).toBe(EventStatus.inPayment);
    });
    /**
     * @target TransactionProcessor.processSignFailedTx `blocks found-on-chain sign-failed transition for held ${direction} Avalanche`
     * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `blocks found-on-chain sign-failed transition for held ${direction} Avalanche` with the suite's captured inputs and invoke the processSignFailedTx path.
     * @expected await expect( TransactionProcessor.processSignFailedTx(await row()), ).rejects.toThrow(); expect((await row()).status).toBe(TransactionStatus.signFailed);
     */
    it(`blocks found-on-chain sign-failed transition for held ${direction} Avalanche`, async () => {
      if (direction === 'destination') await destination();
      await status(TransactionStatus.signFailed);
      confirmation.mockImplementation(async () => {
        await hold();
        return ConfirmationStatus.NotConfirmedEnough;
      });
      await expect(
        TransactionProcessor.processSignFailedTx(await row()),
      ).rejects.toThrow();
      expect((await row()).status).toBe(TransactionStatus.signFailed);
    });
  }
  for (const fault of ['missing', 'changed']) {
    for (const phase of ['initial', 'rebroadcast']) {
      /**
       * @target TransactionProcessor.processSignedTx `blocks ${phase} when the source completed observation is ${fault}`
       * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
       * @scenario Run `blocks ${phase} when the source completed observation is ${fault}` with the suite's captured inputs and invoke the processSignedTx path.
       * @expected await expect( phase === 'initial' ? TransactionProcessor.processSignedTx(await row()) : TransactionProcessor.processSentTx(await row()), ).rejects.toThrow(); expect(submit).not.toHaveBeenCalled();
       */
      it(`blocks ${phase} when the source completed observation is ${fault}`, async () => {
        if (fault === 'missing')
          await source
            .getRepository(BlockEntity)
            .delete({ scanner: 'avalanche', height: 1 });
        else
          await source
            .getRepository(BlockEntity)
            .update(
              { scanner: 'avalanche', height: 1 },
              { hash: blockHash(99) },
            );
        await status(
          phase === 'initial'
            ? TransactionStatus.signed
            : TransactionStatus.sent,
        );
        await expect(
          phase === 'initial'
            ? TransactionProcessor.processSignedTx(await row())
            : TransactionProcessor.processSentTx(await row()),
        ).rejects.toThrow();
        expect(submit).not.toHaveBeenCalled();
      });
    }
  }
  for (const lookup of ['confirmation', 'validation']) {
    for (const changed of ['row', 'event']) {
      /**
       * @target TransactionProcessor.processSentTx `rejects ${changed} drift during ${lookup} before rebroadcast`
       * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
       * @scenario Run `rejects ${changed} drift during ${lookup} before rebroadcast` with the suite's captured inputs and invoke the processSentTx path.
       * @expected await expect( TransactionProcessor.processSentTx(await row()), ).rejects.toThrow(); expect(submit).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.sent);
       */
      it(`rejects ${changed} drift during ${lookup} before rebroadcast`, async () => {
        await status(TransactionStatus.sent);
        const drift = async () => {
          if (changed === 'row')
            await db.TransactionRepository.update(
              { txId: payment.txId },
              { requiredSign: 3 },
            );
          else await db.EventRepository.update({ eventId }, { amount: '11' });
        };
        if (lookup === 'confirmation')
          confirmation.mockImplementation(async () => {
            await drift();
            return ConfirmationStatus.NotFound;
          });
        else
          valid.mockImplementation(async () => {
            await drift();
            return { isValid: true };
          });
        await expect(
          TransactionProcessor.processSentTx(await row()),
        ).rejects.toThrow();
        expect(submit).not.toHaveBeenCalled();
        expect((await row()).status).toBe(TransactionStatus.sent);
      });
    }
  }
  /**
   * @target TransactionProcessor.processSentTx 'refuses a fake qualified chain after preliminary validation mutates its input'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'refuses a fake qualified chain after preliminary validation mutates its input' with the suite's captured inputs and invoke the processSentTx path.
   * @expected await expect( TransactionProcessor.processSentTx(await row()), ).rejects.toThrow(); expect(submit).not.toHaveBeenCalled(); expect({ row: await row(), event: await event() }).toEqual(before); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('refuses a fake qualified chain after preliminary validation mutates its input', async () => {
    await status(TransactionStatus.sent);
    valid.mockImplementation(async (tx) => {
      tx.txBytes.fill(0);
      return { isValid: true };
    });
    const before = { row: await row(), event: await event() };
    await expect(
      TransactionProcessor.processSentTx(await row()),
    ).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect({ row: await row(), event: await event() }).toEqual(before);
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'retains captured chain but refuses fake payment authority after caller mutation'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'retains captured chain but refuses fake payment authority after caller mutation' with the suite's captured inputs and invoke the processSignedTx path.
   * @expected await expect(TransactionProcessor.processSignedTx(input)).rejects.toThrow(); expect(getChain).toHaveBeenCalledWith('ergo'); expect(getChain).not.toHaveBeenCalledWith('ethereum'); expect(submit).not.toHaveBeenCalled(); expect({ row: await row(), event: await event() }).toEqual(before);
   */
  it('retains captured chain but refuses fake payment authority after caller mutation', async () => {
    const input = await row();
    const before = { row: await row(), event: await event() };
    const bind = runtime.context.bind;
    vi.spyOn(runtime.context, 'bind').mockImplementationOnce(
      async (...args) => {
        const bound = await bind(...args);
        input.txJson = JSON.stringify({
          ...JSON.parse(input.txJson),
          txBytes: '0000',
        });
        input.chain = 'ethereum';
        return bound;
      },
    );
    await expect(TransactionProcessor.processSignedTx(input)).rejects.toThrow();
    expect(getChain).toHaveBeenCalledWith('ergo');
    expect(getChain).not.toHaveBeenCalledWith('ethereum');
    expect(submit).not.toHaveBeenCalled();
    expect({ row: await row(), event: await event() }).toEqual(before);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'never invokes a legacy fake submitter or its row mutation'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'never invokes a legacy fake submitter or its row mutation' with the suite's captured inputs and invoke the processSignedTx path.
   * @expected await expect( TransactionProcessor.processSignedTx(await row()), ).rejects.toThrow(); expect(submit).not.toHaveBeenCalled(); expect({ row: await row(), event: await event() }).toEqual(before);
   */
  it('never invokes a legacy fake submitter or its row mutation', async () => {
    const before = { row: await row(), event: await event() };
    submit.mockImplementation(async () => {
      await status(TransactionStatus.invalid);
    });
    await expect(
      TransactionProcessor.processSignedTx(await row()),
    ).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect({ row: await row(), event: await event() }).toEqual(before);
  });
  /**
   * @target TransactionProcessor.processSignFailedTx 'refuses weak observation of a malformed sign-failed payment without changing its row or event'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'refuses weak observation of a malformed sign-failed payment without changing its row or event' with the suite's captured inputs and invoke the processSignFailedTx path.
   * @expected await expect( TransactionProcessor.processSignFailedTx(await row()), ).rejects.toThrow(); expect({ row: await row(), event: await event() }).toEqual(before); expect(submit).not.toHaveBeenCalled();
   */
  it('refuses weak observation of a malformed sign-failed payment without changing its row or event', async () => {
    await status(TransactionStatus.signFailed);
    confirmation.mockResolvedValue(ConfirmationStatus.NotConfirmedEnough);
    const before = { row: await row(), event: await event() };
    await expect(
      TransactionProcessor.processSignFailedTx(await row()),
    ).rejects.toThrow();
    expect({ row: await row(), event: await event() }).toEqual(before);
    expect(submit).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionProcessor.processSentTx 'rejects reward completion when reward authorization is not initialized'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects reward completion when reward authorization is not initialized' with the suite's captured inputs and invoke the processSentTx path.
   * @expected await expect(TransactionProcessor.processSentTx(beforeRow)).rejects.toThrow( 'Reward authorization is not initialized', ); expect(await row()).toEqual(beforeRow); expect(await event()).toEqual(beforeEvent);
   */
  it('rejects reward completion when reward authorization is not initialized', async () => {
    payment = new ErgoTransaction(
      payment.txId,
      eventId,
      payment.txBytes,
      TransactionType.reward,
      [Buffer.from('aa', 'hex')],
      [Buffer.from('bb', 'hex')],
    );
    await db.TransactionRepository.update(
      { txId: payment.txId },
      {
        type: TransactionType.reward,
        txJson: payment.toJson(),
        status: TransactionStatus.sent,
      },
    );
    await db.ConfirmedEventRepository.update(
      { id: eventId },
      { status: EventStatus.inReward },
    );
    confirmation.mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    const beforeRow = await row();
    const beforeEvent = await event();
    await expect(TransactionProcessor.processSentTx(beforeRow)).rejects.toThrow(
      'Reward authorization is not initialized',
    );
    expect(await row()).toEqual(beforeRow);
    expect(await event()).toEqual(beforeEvent);
  });
  /**
   * @target TransactionProcessor.processSentTx 'refuses fake completion authority before reaching an event update failure'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'refuses fake completion authority before reaching an event update failure' with the suite's captured inputs and invoke the processSentTx path.
   * @expected await expect( TransactionProcessor.processSentTx(await row()), ).rejects.toThrow('Unsupported payment submission chain'); expect({ row: await row(), event: await event() }).toEqual(before); expect(submit).not.toHaveBeenCalled();
   */
  it('refuses fake completion authority before reaching an event update failure', async () => {
    await status(TransactionStatus.sent);
    const table = db.ConfirmedEventRepository.metadata.tableName;
    await source.query(
      `CREATE TRIGGER reject_fixture_event BEFORE UPDATE ON "${table}" BEGIN SELECT RAISE(ABORT, 'fixture event update failure'); END`,
    );
    confirmation.mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    const before = { row: await row(), event: await event() };
    await expect(
      TransactionProcessor.processSentTx(await row()),
    ).rejects.toThrow('Unsupported payment submission chain');
    expect({ row: await row(), event: await event() }).toEqual(before);
    expect(submit).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionProcessor.processSentTx 'refuses event phase drift at the real atomic finalization boundary'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'refuses event phase drift at the real atomic finalization boundary' with the suite's captured inputs and invoke the processSentTx path.
   * @expected await expect( TransactionProcessor.processSentTx(await row()), ).rejects.toThrow(); expect((await row()).status).toBe(TransactionStatus.sent); expect((await event()).status).toBe(EventStatus.completed);
   */
  it('refuses event phase drift at the real atomic finalization boundary', async () => {
    await status(TransactionStatus.sent);
    confirmation.mockImplementation(async () => {
      await db.ConfirmedEventRepository.update(
        { id: eventId },
        { status: EventStatus.completed },
      );
      return ConfirmationStatus.ConfirmedEnough;
    });
    await expect(
      TransactionProcessor.processSentTx(await row()),
    ).rejects.toThrow();
    expect((await row()).status).toBe(TransactionStatus.sent);
    expect((await event()).status).toBe(EventStatus.completed);
  });
  /**
   * @target TransactionProcessor.processTransactions 'public processing catches a held dispatch without changing its row'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'public processing catches a held dispatch without changing its row' with the suite's captured inputs and invoke the processTransactions path.
   * @expected expect(submit).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it('public processing catches a held dispatch without changing its row', async () => {
    await hold();
    await TransactionProcessor.processTransactions();
    expect(submit).not.toHaveBeenCalled();
    expect((await row()).status).toBe(TransactionStatus.signed);
  });
  /**
   * @target TransactionProcessor.processTransactions 'public processing refuses an unqualified fake signed payment'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'public processing refuses an unqualified fake signed payment' with the suite's captured inputs and invoke the processTransactions path.
   * @expected expect(submit).not.toHaveBeenCalled(); expect({ row: await row(), event: await event() }).toEqual(before);
   */
  it('public processing refuses an unqualified fake signed payment', async () => {
    const before = { row: await row(), event: await event() };
    await TransactionProcessor.processTransactions();
    expect(submit).not.toHaveBeenCalled();
    expect({ row: await row(), event: await event() }).toEqual(before);
  });
});
