import axios, { AxiosAdapter, AxiosHeaders } from 'axios';
import { blake2b } from 'blakejs';

import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { SignerConfig } from '@rosen-bridge/tss';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import { DatabaseAction } from '../../src/db/databaseAction';
import { dataSource as configuredSource } from '../../src/db/dataSource';
import ChainHandler from '../../src/handlers/chainHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { QualifiedEcdsaSigner } from '../../src/signing/qualifiedTssSigner';
import {
  createGuardSigningRuntime,
  GuardSigningRuntime,
} from '../../src/signing/signingRuntime';
import { BoundTransactionContext } from '../../src/signing/transactionSigningContext';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import {
  TestDatabase as FixtureDatabase,
  deferred,
  blockHash,
  decode,
} from './avalancheTransactionTestUtils';

const eventId = Buffer.from(
  blake2b('processor-source', undefined, 32),
).toString('hex');

describe('qualified transaction processor signing with SQLite', () => {
  let source: DataSource;
  let db: FixtureDatabase;
  let network: AvalancheRpcNetwork;
  let scanner: AvalancheRpcScanner;
  let runtime: GuardSigningRuntime;
  let unsigned: PaymentTransaction;
  let pending: ReturnType<typeof deferred<PaymentTransaction>>;
  const sign =
    vi.fn<
      (
        tx: PaymentTransaction,
        requiredSign: number,
      ) => Promise<PaymentTransaction>
    >();
  const isInSign = vi.fn<(tx: PaymentTransaction) => Promise<boolean>>();
  const getChain = vi.fn();
  const originalAdapter = axios.defaults.adapter;
  const row = async () => (await db.getTxById(unsigned.txId))!;
  const signed = () => {
    const tx = decode(unsigned.toJson());
    tx.txBytes = Buffer.from('cdef', 'hex');
    return tx;
  };
  const settled = async () => {
    await vi.waitFor(() =>
      expect(TransactionProcessor['attempts'].size).toBe(0),
    );
  };
  const hold = () =>
    source
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'test hold' });

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
      sourceId: 'processor-source',
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
      sourceTxId: 'processor-source',
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
    const eventData = await db.EventRepository.findOneByOrFail({
      sourceTxId: 'processor-source',
    });
    await db.ConfirmedEventRepository.insert({
      id: eventId,
      eventData,
      status: EventStatus.inPayment,
    });
    unsigned = new ErgoTransaction(
      'payment-id',
      eventId,
      Buffer.from('abcd', 'hex'),
      TransactionType.payment,
      [Buffer.from('aa', 'hex')],
      [Buffer.from('bb', 'hex')],
    );
    await db.TransactionRepository.insert({
      txId: unsigned.txId,
      txJson: unsigned.toJson(),
      chain: unsigned.network,
      type: unsigned.txType,
      status: TransactionStatus.approved,
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
    pending = deferred<PaymentTransaction>();
    sign.mockReset().mockImplementation(async () => pending.promise);
    isInSign.mockReset().mockResolvedValue(false);
    getChain.mockReset().mockReturnValue({
      signTransaction: sign,
      isTransactionInSign: isInSign,
    });
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getChain,
    } as unknown as ChainHandler);
  });

  afterEach(async () => {
    pending.resolve(signed());
    await settled();
    network['provider'].destroy();
    axios.defaults.adapter = originalAdapter;
    await source.destroy();
    vi.restoreAllMocks();
  });

  /**
   * @target TransactionProcessor.processApprovedTx 'carries the full immutable Ergo model and local context without holding the scanner lease'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'carries the full immutable Ergo model and local context without holding the scanner lease' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected sign.mockImplementation(async (tx, threshold) => { expect(runtime.context.current().payment().toJson()).toBe(tx.toJson()); expect(threshold).toBe(2); expect(JSON.parse(tx.toJson()).inputBoxes).toEqual(['aa']); expect(JSON.parse(tx.toJson()).dataInputs).toEqual(['bb']); await scanner.update(); scanned.resolve(); return pending.promise; }); expect(runtime.context.current().payment().toJson()).toBe(tx.toJson()); expect(threshold).toBe(2); expect(JSON.parse(tx.toJson()).inputBoxes).toEqual(['aa']); expect(JSON.parse(tx.toJson()).dataInputs).toEqual(['bb']); expect((await row()).status).toBe(TransactionStatus.inSign); expect(actual.status).toBe(TransactionStatus.signed); expect(JSON.parse(actual.txJson)).toEqual(JSON.parse(signed().toJson())); expect(actual.lastCheck).toBe(7);
   */
  it('carries the full immutable Ergo model and local context without holding the scanner lease', async () => {
    const scanned = deferred<void>();
    sign.mockImplementation(async (tx, threshold) => {
      expect(runtime.context.current().payment().toJson()).toBe(tx.toJson());
      expect(threshold).toBe(2);
      expect(JSON.parse(tx.toJson()).inputBoxes).toEqual(['aa']);
      expect(JSON.parse(tx.toJson()).dataInputs).toEqual(['bb']);
      await scanner.update();
      scanned.resolve();
      return pending.promise;
    });
    await TransactionProcessor.processApprovedTx(await row());
    expect((await row()).status).toBe(TransactionStatus.inSign);
    await scanned.promise;
    await scanner.update();
    pending.resolve(signed());
    await settled();
    const actual = await row();
    expect(actual.status).toBe(TransactionStatus.signed);
    expect(JSON.parse(actual.txJson)).toEqual(JSON.parse(signed().toJson()));
    expect(actual.lastCheck).toBe(7);
  });

  /**
   * @target TransactionProcessor.processApprovedTx 'refuses %s Avalanche admission while held'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'refuses %s Avalanche admission while held' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected await expect( TransactionProcessor.processApprovedTx(await row()), ).rejects.toThrow(); expect(sign).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.approved);
   */
  it.each(['source', 'destination'])(
    'refuses %s Avalanche admission while held',
    async (direction) => {
      if (direction === 'destination') {
        await db.EventRepository.update(
          { eventId },
          { fromChain: 'ergo', toChain: 'avalanche' },
        );
        unsigned = new PaymentTransaction(
          'avalanche',
          unsigned.txId,
          eventId,
          unsigned.txBytes,
          TransactionType.payment,
        );
        await db.TransactionRepository.update(
          { txId: unsigned.txId },
          { chain: 'avalanche', txJson: unsigned.toJson() },
        );
      }
      await hold();
      await expect(
        TransactionProcessor.processApprovedTx(await row()),
      ).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled();
      expect((await row()).status).toBe(TransactionStatus.approved);
    },
  );

  /**
   * @target TransactionProcessor.processApprovedTx 'refuses to persist a result after a hold without marking a new failure'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'refuses to persist a result after a hold without marking a new failure' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected expect((await row()).status).toBe(TransactionStatus.inSign); expect((await row()).signFailedCount).toBe(0);
   */
  it('refuses to persist a result after a hold without marking a new failure', async () => {
    await TransactionProcessor.processApprovedTx(await row());
    await hold();
    pending.resolve(signed());
    await settled();
    expect((await row()).status).toBe(TransactionStatus.inSign);
    expect((await row()).signFailedCount).toBe(0);
  });

  /**
   * @target TransactionProcessor.processApprovedTx 'does not send stale data to the signer after a queue CAS conflict'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not send stale data to the signer after a queue CAS conflict' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected await expect( TransactionProcessor.processApprovedTx(await row()), ).rejects.toThrow('CAS conflict'); expect(sign).not.toHaveBeenCalled(); expect((await row()).requiredSign).toBe(3);
   */
  it('does not send stale data to the signer after a queue CAS conflict', async () => {
    const original = db.setTxStatusIfUnchanged;
    vi.spyOn(db, 'setTxStatusIfUnchanged').mockImplementationOnce(
      async (expected, status) => {
        await db.TransactionRepository.update(
          { txId: unsigned.txId },
          { requiredSign: 3 },
        );
        return original(expected, status);
      },
    );
    await expect(
      TransactionProcessor.processApprovedTx(await row()),
    ).rejects.toThrow('CAS conflict');
    expect(sign).not.toHaveBeenCalled();
    expect((await row()).requiredSign).toBe(3);
  });

  /**
   * @target TransactionProcessor.processApprovedTx 'preserves the winner of a signed-result CAS race'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'preserves the winner of a signed-result CAS race' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected expect((await row()).status).toBe(TransactionStatus.sent); expect((await row()).txJson).toBe(unsigned.toJson()); expect((await row()).signFailedCount).toBe(0);
   */
  it('preserves the winner of a signed-result CAS race', async () => {
    const original = db.updateWithSignedTxIfUnchanged;
    vi.spyOn(db, 'updateWithSignedTxIfUnchanged').mockImplementationOnce(
      async (expected, json) => {
        await db.TransactionRepository.update(
          { txId: unsigned.txId },
          { status: TransactionStatus.sent },
        );
        return original(expected, json);
      },
    );
    await TransactionProcessor.processApprovedTx(await row());
    pending.resolve(signed());
    await settled();
    expect((await row()).status).toBe(TransactionStatus.sent);
    expect((await row()).txJson).toBe(unsigned.toJson());
    expect((await row()).signFailedCount).toBe(0);
  });

  /**
   * @target TransactionProcessor.processApprovedTx 'rejects changed signed %s'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects changed signed %s' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected expect((await row()).status).toBe(TransactionStatus.signFailed); expect((await row()).txJson).toBe(unsigned.toJson()); expect((await row()).signFailedCount).toBe(1);
   */
  it.each(['inputBoxes', 'dataInputs', 'eventId'])(
    'rejects changed signed %s',
    async (field) => {
      await TransactionProcessor.processApprovedTx(await row());
      const altered = JSON.parse(signed().toJson());
      altered[field] = field === 'eventId' ? 'a'.repeat(64) : ['cc'];
      pending.resolve(decode(JSON.stringify(altered)));
      await settled();
      expect((await row()).status).toBe(TransactionStatus.signFailed);
      expect((await row()).txJson).toBe(unsigned.toJson());
      expect((await row()).signFailedCount).toBe(1);
    },
  );

  /**
   * @target TransactionProcessor.processApprovedTx 'coalesces competing admissions and does not query orphan status during a live attempt'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'coalesces competing admissions and does not query orphan status during a live attempt' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected expect(sign).toHaveBeenCalledOnce(); expect(isInSign).not.toHaveBeenCalled();
   */
  it('coalesces competing admissions and does not query orphan status during a live attempt', async () => {
    const first = await row();
    await Promise.all([
      TransactionProcessor.processApprovedTx(first),
      TransactionProcessor.processApprovedTx(first),
    ]);
    await TransactionProcessor.processInSignTx(await row());
    expect(sign).toHaveBeenCalledOnce();
    expect(isInSign).not.toHaveBeenCalled();
  });

  /**
   * @target TransactionProcessor.processInSignTx 'does not let an old orphan check fail a newer local attempt'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not let an old orphan check fail a newer local attempt' with the suite's captured inputs and invoke the processInSignTx path.
   * @expected await vi.waitFor(() => expect(isInSign).toHaveBeenCalledOnce()); expect((await row()).status).toBe(TransactionStatus.signFailed); expect((await row()).status).toBe(TransactionStatus.inSign); expect((await row()).signFailedCount).toBe(1);
   */
  it('does not let an old orphan check fail a newer local attempt', async () => {
    await db.TransactionRepository.update(
      { txId: unsigned.txId },
      { status: TransactionStatus.inSign },
    );
    const oldCheck = deferred<boolean>();
    isInSign.mockImplementationOnce(() => oldCheck.promise);
    const oldProcess = TransactionProcessor.processInSignTx(await row());
    await vi.waitFor(() => expect(isInSign).toHaveBeenCalledOnce());
    await TransactionProcessor.processInSignTx(await row());
    expect((await row()).status).toBe(TransactionStatus.signFailed);
    await TransactionProcessor.processApprovedTx(await row());
    oldCheck.resolve(false);
    await oldProcess;
    expect((await row()).status).toBe(TransactionStatus.inSign);
    expect((await row()).signFailedCount).toBe(1);
  });

  /**
   * @target TransactionProcessor.initSigning 'uses the captured chain after an asynchronous orphan binding'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'uses the captured chain after an asynchronous orphan binding' with the suite's captured inputs and invoke the initSigning path.
   * @expected expect(getChain).toHaveBeenCalledWith('ergo'); expect(getChain).not.toHaveBeenCalledWith('bitcoin');
   */
  it('uses the captured chain after an asynchronous orphan binding', async () => {
    await db.TransactionRepository.update(
      { txId: unsigned.txId },
      { status: TransactionStatus.inSign },
    );
    const gate = deferred<void>();
    const entered = deferred<void>();
    runtime = createGuardSigningRuntime({
      getEvent: async (id) => {
        entered.resolve();
        await gate.promise;
        return db.getEventById(id);
      },
      getTx: db.getTxById,
      decode,
      getScanner: () => scanner,
      curveTimeoutSeconds: 10,
      edwardTimeoutSeconds: 10,
      ergoTimeoutSeconds: 10,
      maxPending: 4,
    });
    TransactionProcessor.initSigning(runtime.context, runtime.processor);
    const supplied = await row();
    const work = TransactionProcessor.processInSignTx(supplied);
    await entered.promise;
    supplied.chain = 'bitcoin';
    gate.resolve();
    await work;
    expect(getChain).toHaveBeenCalledWith('ergo');
    expect(getChain).not.toHaveBeenCalledWith('bitcoin');
  });

  /**
   * @target TransactionProcessor.processApprovedTx 'rejects orphaned payment context before changing status'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects orphaned payment context before changing status' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected await expect( TransactionProcessor.processApprovedTx(await row()), ).rejects.toThrow('identity mismatch'); expect(sign).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.approved);
   */
  it('rejects orphaned payment context before changing status', async () => {
    await db.TransactionRepository.update(
      { txId: unsigned.txId },
      { event: null },
    );
    await expect(
      TransactionProcessor.processApprovedTx(await row()),
    ).rejects.toThrow('identity mismatch');
    expect(sign).not.toHaveBeenCalled();
    expect((await row()).status).toBe(TransactionStatus.approved);
  });

  /**
   * @target TransactionProcessor.processApprovedTx 'revokes all sibling digest work when one signing promise fails'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'revokes all sibling digest work when one signing promise fails' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected expect((await row()).status).toBe(TransactionStatus.signFailed); await expect(captured.withAction(dispatch)).rejects.toThrow(); expect(dispatch).not.toHaveBeenCalled();
   */
  it('revokes all sibling digest work when one signing promise fails', async () => {
    let captured!: BoundTransactionContext;
    sign.mockImplementation(async () => {
      captured = runtime.context.current();
      return pending.promise;
    });
    await TransactionProcessor.processApprovedTx(await row());
    pending.reject(new Error('one input failed'));
    await settled();
    expect((await row()).status).toBe(TransactionStatus.signFailed);
    const dispatch = vi.fn();
    await expect(captured.withAction(dispatch)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target TransactionProcessor.initSigning 'expires old authority and preserves an identical-row retry from its late result'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'expires old authority and preserves an identical-row retry from its late result' with the suite's captured inputs and invoke the initSigning path.
   * @expected await expect(captured[0].withAction(vi.fn())).rejects.toThrow(); expect((await row()).status).toBe(TransactionStatus.signFailed); expect(captured[1].bindingId).not.toBe(captured[0].bindingId); expect((await row()).status).toBe(TransactionStatus.inSign); expect(TransactionProcessor['attempts'].get(unsigned.txId)).toBe( captured[1], ); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it('expires old authority and preserves an identical-row retry from its late result', async () => {
    TransactionProcessor.initSigning(runtime.context, {
      timeoutMs: 30,
      maxPending: 4,
    });
    const captured: BoundTransactionContext[] = [];
    const old = pending;
    sign.mockImplementation(async () => {
      captured.push(runtime.context.current());
      return pending.promise;
    });
    await TransactionProcessor.processApprovedTx(await row());
    await settled();
    await expect(captured[0].withAction(vi.fn())).rejects.toThrow();
    await TransactionProcessor.processInSignTx(await row());
    expect((await row()).status).toBe(TransactionStatus.signFailed);
    TransactionProcessor.initSigning(runtime.context, runtime.processor);
    pending = deferred<PaymentTransaction>();
    await TransactionProcessor.processApprovedTx(await row());
    expect(captured[1].bindingId).not.toBe(captured[0].bindingId);
    old.resolve(signed());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await row()).status).toBe(TransactionStatus.inSign);
    expect(TransactionProcessor['attempts'].get(unsigned.txId)).toBe(
      captured[1],
    );
    pending.resolve(signed());
    await settled();
    expect((await row()).status).toBe(TransactionStatus.signed);
  });

  /**
   * @target TransactionProcessor.initSigning 'bounds admission capacity without changing the rejected row'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'bounds admission capacity without changing the rejected row' with the suite's captured inputs and invoke the initSigning path.
   * @expected await expect( TransactionProcessor.processApprovedTx( (await db.getTxById(secondModel.txId))!, ), ).rejects.toThrow('capacity'); expect(sign).toHaveBeenCalledOnce(); expect((await db.getTxById(secondModel.txId))!.status).toBe( TransactionStatus.approved, );
   */
  it('bounds admission capacity without changing the rejected row', async () => {
    TransactionProcessor.initSigning(runtime.context, {
      timeoutMs: 10000,
      maxPending: 1,
    });
    const secondModel = JSON.parse(unsigned.toJson());
    secondModel.txId = 'second-payment';
    await db.TransactionRepository.insert({
      ...(await row()),
      txId: secondModel.txId,
      txJson: JSON.stringify(secondModel),
    });
    await TransactionProcessor.processApprovedTx(await row());
    await expect(
      TransactionProcessor.processApprovedTx(
        (await db.getTxById(secondModel.txId))!,
      ),
    ).rejects.toThrow('capacity');
    expect(sign).toHaveBeenCalledOnce();
    expect((await db.getTxById(secondModel.txId))!.status).toBe(
      TransactionStatus.approved,
    );
  });

  /**
   * @target TransactionProcessor.initSigning 'revokes a result stalled in the database lookup before it can write'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'revokes a result stalled in the database lookup before it can write' with the suite's captured inputs and invoke the initSigning path.
   * @expected expect(cas).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.inSign);
   */
  it('revokes a result stalled in the database lookup before it can write', async () => {
    const lookup = deferred<void>();
    const entered = deferred<void>();
    let blockResult = false;
    runtime = createGuardSigningRuntime({
      getEvent: db.getEventById,
      getTx: async (id) => {
        if (blockResult) {
          entered.resolve();
          await lookup.promise;
        }
        return db.getTxById(id);
      },
      decode,
      getScanner: () => scanner,
      curveTimeoutSeconds: 10,
      edwardTimeoutSeconds: 10,
      ergoTimeoutSeconds: 10,
      maxPending: 4,
    });
    TransactionProcessor.initSigning(runtime.context, {
      timeoutMs: 100,
      maxPending: 4,
    });
    const cas = vi.spyOn(db, 'updateWithSignedTxIfUnchanged');
    await TransactionProcessor.processApprovedTx(await row());
    blockResult = true;
    pending.resolve(signed());
    await entered.promise;
    await settled();
    lookup.resolve();
    await vi.waitFor(async () => {
      await scanner.update();
    });
    expect(cas).not.toHaveBeenCalled();
    expect((await row()).status).toBe(TransactionStatus.inSign);
  });

  /**
   * @target TransactionProcessor.initSigning 'revokes sibling work immediately while failure persistence is stalled'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'revokes sibling work immediately while failure persistence is stalled' with the suite's captured inputs and invoke the initSigning path.
   * @expected await expect(captured.withAction(dispatch)).rejects.toThrow('revoked'); expect(dispatch).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.signFailed);
   */
  it('revokes sibling work immediately while failure persistence is stalled', async () => {
    const lookup = deferred<void>();
    const entered = deferred<void>();
    let blockFailure = false;
    let captured!: BoundTransactionContext;
    runtime = createGuardSigningRuntime({
      getEvent: db.getEventById,
      getTx: async (id) => {
        if (blockFailure) {
          entered.resolve();
          await lookup.promise;
        }
        return db.getTxById(id);
      },
      decode,
      getScanner: () => scanner,
      curveTimeoutSeconds: 10,
      edwardTimeoutSeconds: 10,
      ergoTimeoutSeconds: 10,
      maxPending: 4,
    });
    TransactionProcessor.initSigning(runtime.context, runtime.processor);
    sign.mockImplementation(async () => {
      captured = runtime.context.current();
      return pending.promise;
    });
    await TransactionProcessor.processApprovedTx(await row());
    blockFailure = true;
    pending.reject(new Error('input failed'));
    await entered.promise;
    const dispatch = vi.fn();
    await expect(captured.withAction(dispatch)).rejects.toThrow('revoked');
    expect(dispatch).not.toHaveBeenCalled();
    lookup.resolve();
    await settled();
    expect((await row()).status).toBe(TransactionStatus.signFailed);
  });

  /**
   * @target TransactionProcessor.processApprovedTx 'joins the installed TSS signer for %s with later hold=%s'
   * @dependencies Actual TransactionProcessor from transaction/transactionProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'joins the installed TSS signer for %s with later hold=%s' with the suite's captured inputs and invoke the processApprovedTx path.
   * @expected await expect(scanner.update()).rejects.toThrow('already running'); await vi.waitFor(() => expect(signer['signs']).toHaveLength(1)); expect(transport).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledOnce(); expect(JSON.parse(transport.mock.calls[0][0].data)).toMatchObject({ message, crypto: 'ecdsa', chainCode: key.chainCode, derivationPath: key.derivationPath, }); expect((await row()).status).toBe( held ? TransactionStatus.inSign : TransactionStatus.signed, );
   */
  it.each([
    ['source', false],
    ['destination', false],
    ['source', true],
    ['destination', true],
  ] as const)(
    'joins the installed TSS signer for %s with later hold=%s',
    async (direction, held) => {
      const destination = direction === 'source' ? 'bitcoin' : 'avalanche';
      await db.EventRepository.update(
        { eventId },
        {
          fromChain: direction === 'source' ? 'avalanche' : 'ergo',
          toChain: destination,
        },
      );
      unsigned = new PaymentTransaction(
        destination,
        unsigned.txId,
        eventId,
        unsigned.txBytes,
        TransactionType.payment,
      );
      await db.TransactionRepository.update(
        { txId: unsigned.txId },
        { chain: destination, txJson: unsigned.toJson() },
      );
      const key = {
        algorithm: 'ecdsa' as const,
        chainCode: 'SyntheticChainCode',
        derivationPath: [44, 60, 0, 0],
      };
      const message = 'a'.repeat(64);
      const guard = {
        publicKey: 'fixture-guard',
        peerId: 'fixture-peer',
        index: 0,
      };
      const transport = vi.fn<AxiosAdapter>(async (config) => {
        await expect(scanner.update()).rejects.toThrow('already running');
        return {
          data: {},
          status: 200,
          statusText: 'OK',
          headers: new AxiosHeaders(),
          config,
        };
      });
      axios.defaults.adapter = transport;
      const signer = new QualifiedEcdsaSigner(
        {
          tssApiUrl: 'http://127.0.0.1:1',
          callbackUrl: 'http://127.0.0.1:1',
          guardsPk: [guard.publicKey],
          shares: ['fixture-share'],
          getPeerId: async () => guard.peerId,
          messageEnc: {
            getPk: async () => guard.publicKey,
            sign: async () => 'fixture',
            verify: async () => true,
          } as unknown as SignerConfig['messageEnc'],
          detection: {} as SignerConfig['detection'],
          submitMsg: vi.fn().mockResolvedValue(undefined),
          timeoutSeconds: 10,
        },
        {
          policy: runtime.registry,
          signingTimeoutMs: 1000,
          httpTimeoutMs: 100,
          maxPending: 2,
        },
      );
      signer.getGuardTurn = () => 0;
      signer['getApprovedGuards'] = async () => [guard];
      signer['threshold'] = { value: 1, expiry: Infinity };
      sign.mockImplementation(async () => {
        await runtime.context.withTssKey(key, () =>
          signer.signPromised(message, key.chainCode, key.derivationPath),
        );
        return signed();
      });
      await TransactionProcessor.processApprovedTx(await row());
      await vi.waitFor(() => expect(signer['signs']).toHaveLength(1));
      await vi.waitFor(async () => {
        await scanner.update();
      });
      if (held) await hold();
      await signer.processMessage(
        'start',
        { msg: message, guards: [guard], signs: ['fixture'] },
        'envelope',
        0,
        guard.peerId,
        1,
      );
      if (held) {
        expect(transport).not.toHaveBeenCalled();
      } else {
        expect(transport).toHaveBeenCalledOnce();
        expect(JSON.parse(transport.mock.calls[0][0].data)).toMatchObject({
          message,
          crypto: 'ecdsa',
          chainCode: key.chainCode,
          derivationPath: key.derivationPath,
        });
        signer['signs'][0].callback(
          true,
          undefined,
          'synthetic-signature',
          '0',
        );
      }
      await settled();
      expect((await row()).status).toBe(
        held ? TransactionStatus.inSign : TransactionStatus.signed,
      );
    },
  );
});
