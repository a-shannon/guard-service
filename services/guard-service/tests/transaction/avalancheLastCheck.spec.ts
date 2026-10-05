import { blake2b } from 'blakejs';

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

describe('scanner-qualified last-check consumers with SQLite', () => {
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

  beforeEach(async () => {
    getChain().getHeight.mockResolvedValue(20);
    vi.spyOn(TransactionProcessor, 'processApprovedTx').mockResolvedValue(
      undefined,
    );
  });
  const configure = async (phase: string) => {
    await status(
      phase === 'retry' ? TransactionStatus.signFailed : TransactionStatus.sent,
    );
    confirmation.mockResolvedValue(
      phase === 'confirming'
        ? ConfirmationStatus.NotConfirmedEnough
        : ConfirmationStatus.NotFound,
    );
    getChain().isTxInMempool.mockResolvedValue(phase === 'mempool');
  };
  const process = async (
    phase: string,
    captured?: Awaited<ReturnType<typeof row>>,
  ) =>
    phase === 'retry'
      ? TransactionProcessor.processSignFailedTx(captured ?? (await row()))
      : TransactionProcessor.processSentTx(captured ?? (await row()));
  for (const direction of ['source', 'destination']) {
    for (const phase of ['retry', 'confirming', 'mempool']) {
      /**
       * @target TransactionProcessor.processSignFailedTx `updates only lastCheck for ${direction} ${phase}`
       * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
       * @scenario Run `updates only lastCheck for ${direction} ${phase}` with the suite's captured inputs and invoke the processSignFailedTx path.
       * @expected expect(await row()).toEqual({ ...before, lastCheck: 20 }); expect(await event()).toEqual(previousEvent); expect(TransactionProcessor.processApprovedTx).toHaveBeenCalledTimes( phase === 'retry' ? 1 : 0, ); expect( PublicStatusHandler.getInstance().updatePublicTxStatus, ).not.toHaveBeenCalled();
       */
      it(`updates only lastCheck for ${direction} ${phase}`, async () => {
        if (direction === 'destination') await destination();
        await configure(phase);
        const before = await row(),
          previousEvent = await event();
        await process(phase);
        expect(await row()).toEqual({ ...before, lastCheck: 20 });
        expect(await event()).toEqual(previousEvent);
        expect(TransactionProcessor.processApprovedTx).toHaveBeenCalledTimes(
          phase === 'retry' ? 1 : 0,
        );
        expect(
          PublicStatusHandler.getInstance().updatePublicTxStatus,
        ).not.toHaveBeenCalled();
      });
      /**
       * @target TransactionProcessor.processSignFailedTx `leaves ${direction} ${phase} unchanged on %s`
       * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
       * @scenario Run `leaves ${direction} ${phase} unchanged on %s` with the suite's captured inputs and invoke the processSignFailedTx path.
       * @expected await expect(process(phase)).rejects.toThrow(); expect(await row()).toEqual(before); expect(await event()).toEqual(previousEvent); expect(TransactionProcessor.processApprovedTx).not.toHaveBeenCalled();
       */
      it.each(['hold', 'late-hold', 'RPC', 'height-RPC', 'regression'])(
        `leaves ${direction} ${phase} unchanged on %s`,
        async (fault) => {
          if (direction === 'destination') await destination();
          await configure(phase);
          if (fault === 'hold') await hold();
          if (fault === 'late-hold')
            getChain().getHeight.mockImplementation(async () => {
              await hold();
              return 20;
            });
          if (fault === 'RPC')
            confirmation.mockRejectedValue(new Error('RPC unavailable'));
          if (fault === 'height-RPC')
            getChain().getHeight.mockRejectedValue(
              new Error('RPC unavailable'),
            );
          if (fault === 'regression') getChain().getHeight.mockResolvedValue(6);
          const before = await row(),
            previousEvent = await event();
          await expect(process(phase)).rejects.toThrow();
          expect(await row()).toEqual(before);
          expect(await event()).toEqual(previousEvent);
          expect(TransactionProcessor.processApprovedTx).not.toHaveBeenCalled();
        },
      );
    }
  }
  /**
   * @target TransactionProcessor.processSignFailedTx 'preserves concurrent %s winner and never queues retry'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'preserves concurrent %s winner and never queues retry' with the suite's captured inputs and invoke the processSignFailedTx path.
   * @expected await expect(process('retry')).rejects.toThrow(); expect(await row()).toEqual({ ...before, [field]: values[field as keyof typeof values], }); expect(TransactionProcessor.processApprovedTx).not.toHaveBeenCalled();
   */
  it.each([
    'status',
    'lastCheck',
    'txJson',
    'lastStatusUpdate',
    'failedInSign',
    'signFailedCount',
    'requiredSign',
  ])('preserves concurrent %s winner and never queues retry', async (field) => {
    await configure('retry');
    const values = {
      status: TransactionStatus.completed,
      lastCheck: 30,
      txJson: payment.toJson() + ' ',
      lastStatusUpdate: 'winner',
      failedInSign: true,
      signFailedCount: 5,
      requiredSign: 9,
    };
    getChain().getHeight.mockImplementation(async () => {
      await db.TransactionRepository.update(
        { txId: payment.txId },
        { [field]: values[field as keyof typeof values] },
      );
      return 20;
    });
    const before = await row();
    await expect(process('retry')).rejects.toThrow();
    expect(await row()).toEqual({
      ...before,
      [field]: values[field as keyof typeof values],
    });
    expect(TransactionProcessor.processApprovedTx).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionProcessor.processSignFailedTx 'ignores caller mutation during height lookup and passes the captured row to retry'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'ignores caller mutation during height lookup and passes the captured row to retry' with the suite's captured inputs and invoke the processSignFailedTx path.
   * @expected expect(await row()).toEqual({ ...before, lastCheck: 20 }); expect(TransactionProcessor.processApprovedTx).toHaveBeenCalledWith(before);
   */
  it('ignores caller mutation during height lookup and passes the captured row to retry', async () => {
    await configure('retry');
    const captured = await row(),
      before = await row();
    getChain().getHeight.mockImplementation(async () => {
      captured.lastCheck = 99;
      captured.signFailedCount = 99;
      captured.txJson = 'mutated';
      captured.status = TransactionStatus.completed;
      return 20;
    });
    await process('retry', captured);
    expect(await row()).toEqual({ ...before, lastCheck: 20 });
    expect(TransactionProcessor.processApprovedTx).toHaveBeenCalledWith(before);
  });
  /**
   * @target TransactionProcessor.processSignFailedTx 'rejects malformed captured %s before RPC'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects malformed captured %s before RPC' with the suite's captured inputs and invoke the processSignFailedTx path.
   * @expected await expect(process('retry', captured)).rejects.toThrow(); expect(confirmation).not.toHaveBeenCalled();
   */
  it.each(['lastCheck', 'signFailedCount', 'failedInSign', 'lastStatusUpdate'])(
    'rejects malformed captured %s before RPC',
    async (field) => {
      await configure('retry');
      const captured = await row();
      Object.assign(captured, { [field]: undefined });
      await expect(process('retry', captured)).rejects.toThrow();
      expect(confirmation).not.toHaveBeenCalled();
    },
  );
});
