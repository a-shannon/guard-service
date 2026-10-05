import { blake2b } from 'blakejs';
import * as wasm from 'ergo-lib-wasm-nodejs';
import { SigningKey, Transaction } from 'ethers';

import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations,
} from '@rosen-bridge/abstract-scanner';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
  AvalancheSafetyState1790769600000,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  AbstractChain,
  ConfirmationStatus,
  PaymentTransaction,
  TransactionType,
  SigningStatus,
} from '@rosen-chains/abstract-chain';
import {
  AbstractErgoNetwork,
  ErgoChain,
  ErgoTransaction,
} from '@rosen-chains/ergo';

import { DatabaseAction } from '../../src/db/databaseAction';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import EventOrder from '../../src/event/eventOrder';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { createGuardSigningRuntime } from '../../src/signing/signingRuntime';
import { TransactionSigningContext } from '../../src/signing/transactionSigningContext';
import { TssAuthorizationRegistry } from '../../src/signing/tssAuthorizationRegistry';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import TransactionVerifier from '../../src/verification/transactionVerifier';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';
import ergoFixture from '../synchronization/avalancheSynchronizationTestData';
import transaction3PaymentTransaction from './fixtures/recoveryMultiInput';

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
describe('Avalanche signed reward recovery', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let scannerDb: DataSource;
  let network: AvalancheRpcNetwork;
  let scanner: AvalancheRpcScanner;
  let payment: PaymentTransaction;
  let reward: ErgoTransaction;
  let eventId: string;
  let context: TransactionSigningContext;
  let authorization: RewardAuthorization;
  const confirmation = vi.fn();
  const wallet = vi.fn(() => 'signed');
  const hold = () =>
    scannerDb
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'test hold' });
  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    scannerDb = await new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [BlockEntity, ExtractorStatusEntity, AvalancheSafetyState],
      migrations: [...migrations.sqlite, AvalancheSafetyState1790769600000],
    }).initialize();
    await scannerDb.runMigrations();
    network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
    vi.spyOn(network, 'getCurrentHeight').mockResolvedValue(2);
    vi.spyOn(network, 'getBlockAtHeight').mockImplementation(
      async (height) => ({
        hash: hash(height),
        height,
        parentHash: hash(height - 1),
        timestamp: 100 + height,
        txCount: 0,
      }),
    );
    vi.spyOn(network, 'getBlockTxs').mockResolvedValue([]);
    scanner = new AvalancheRpcScanner({
      network,
      dataSource: scannerDb,
      sourceId: 'reward-source',
      initialHeight: 0,
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 0,
      },
    });
    await scanner.update();
    const event = mockEventTrigger().event;
    Object.assign(event, {
      fromChain: 'ergo',
      toChain: 'avalanche',
      sourceChainHeight: 1,
      sourceBlockId: hash(1),
      WIDsCount: 1,
      WIDsHash: Buffer.from(
        blake2b(Buffer.from('aa'.repeat(32), 'hex'), undefined, 32),
      ).toString('hex'),
    });
    eventId = EventSerializer.getId(event);
    await DatabaseActionMock.insertEventRecord(
      event,
      EventStatus.inReward,
      undefined,
      1,
      'first',
      event.height,
    );
    await db().EventRepository.update(
      { eventId },
      {
        spendBlock: null,
        spendHeight: null,
        spendTxId: null,
        result: null,
        paymentTxId: null,
      },
    );
    await DatabaseActionMock.insertCommitmentBoxRecord(
      event,
      eventId,
      'YQ==',
      'aa'.repeat(32),
      event.height - 1,
      '1',
      'event-creation-tx-id',
      0,
    );
    const signed = Transaction.from({
      type: 2,
      chainId: 43113,
      nonce: 0,
      to: '0x' + '11'.repeat(20),
      value: 1n,
      gasLimit: 21000n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
    });
    signed.signature = new SigningKey('0x' + '01'.repeat(32)).sign(
      signed.unsignedHash,
    );
    payment = new PaymentTransaction(
      'avalanche',
      signed.unsignedHash,
      eventId,
      Buffer.from(signed.serialized.slice(2), 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      payment,
      TransactionStatus.completed,
      123,
      'updated',
      false,
      0,
      3,
    );
    reward = new ErgoTransaction(
      'reward-id',
      eventId,
      Buffer.from('abcd', 'hex'),
      TransactionType.reward,
      [],
      [],
    );
    confirmation
      .mockReset()
      .mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    wallet.mockClear();
    const target = {
      getActualTxId: vi.fn().mockResolvedValue(signed.hash),
      getTxConfirmationStatus: confirmation,
      verifyPaymentTransaction: vi.fn().mockResolvedValue(true),
      verifyTransactionExtraConditions: vi.fn().mockReturnValue(true),
      getHeight: vi.fn().mockResolvedValue(100),
      extractTransactionOrder: vi.fn().mockReturnValue([]),
    } as unknown as AbstractChain<unknown>;
    context = new TransactionSigningContext({
      safety: new AvalancheTransactionSafety(
        (id) => db().getEventById(id),
        () => scanner,
      ),
      getTx: (id) => db().getTxById(id),
      decode: (json) => {
        const m = JSON.parse(json);
        if (m.network === 'ergo') return ErgoTransaction.fromJson(json);
        return new PaymentTransaction(
          m.network,
          m.txId,
          m.eventId,
          Buffer.from(m.txBytes, 'hex'),
          m.txType,
        );
      },
      registry: new TssAuthorizationRegistry(1000, 4),
      bindReward: (expected, statuses, purpose) =>
        authorization.bindExistingReward(expected, statuses, purpose),
    });
    authorization = new RewardAuthorization({
      context,
      getDatabase: db,
      getChain: () => target,
    });
    vi.spyOn(RewardAuthorization, 'getInstance').mockReturnValue(authorization);
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getErgoChain: () => target,
      getChain: () => target,
    } as never);
    vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue(
      {} as never,
    );
    vi.spyOn(EventOrder, 'createEventRewardOrder').mockResolvedValue([]);
    vi.spyOn(TransactionVerifier, 'verifyTxCommonConditions').mockResolvedValue(
      true,
    );
    await DatabaseActionMock.insertTxRecord(
      reward,
      TransactionStatus.inSign,
      123,
      'updated',
      false,
      0,
      3,
    );
  });
  afterEach(async () => {
    network['provider'].destroy();
    await scannerDb.destroy();
    vi.restoreAllMocks();
  });

  let ergo: ErgoChain;
  let signedHex: string;
  const rewardConfirmation = vi.fn();
  const blockId = 'bc'.repeat(32);
  beforeEach(async () => {
    const oldId = reward.txId;
    reward = ErgoTransaction.fromJson(JSON.stringify(ergoFixture.payment));
    reward.eventId = eventId;
    reward.txType = TransactionType.reward;
    const unsigned = wasm.ReducedTransaction.sigma_parse_bytes(
      reward.txBytes,
    ).unsigned_tx();
    reward.txBytes = wasm.Transaction.from_unsigned_tx(
      unsigned,
      Array.from({ length: unsigned.inputs().len() }, () => new Uint8Array()),
    ).sigma_serialize_bytes();
    signedHex = Buffer.from(reward.txBytes).toString('hex');
    const tokens = new TokenMap();
    await tokens.updateConfigByJson([]);
    ergo = new ErgoChain(
      {} as AbstractErgoNetwork,
      {
        fee: 1100000n,
        confirmations: {
          observation: 5,
          payment: 9,
          cold: 10,
          manual: 11,
          arbitrary: 12,
        },
        addresses: {
          lock: ergoFixture.lock,
          cold: 'unused',
          permit: ergoFixture.lock,
          fraud: 'unused',
        },
        rwtId:
          'ca0c38b1b9e9c253183cebbf6e2372f816b0e1a579aa423c974d100a8911e0e5',
        minBoxValue: 1000000n,
        eventTxConfirmation: 18,
      },
      tokens,
      {
        isInSign: vi.fn().mockResolvedValue(false),
        sign: vi.fn().mockRejectedValue(new Error('No signing')),
      },
    );
    const target = authorization['dependencies'].getChain('avalanche');
    authorization['dependencies'].getChain = (name) =>
      name === 'ergo' ? (ergo as AbstractChain<unknown>) : target;
    vi.mocked(ChainHandler.getInstance).mockReturnValue({
      getErgoChain: () => ergo,
      getChain: (name: string) => authorization['dependencies'].getChain(name),
    } as never);
    rewardConfirmation
      .mockReset()
      .mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    vi.spyOn(ergo, 'getTxConfirmationStatus').mockImplementation(
      rewardConfirmation,
    );
    vi.spyOn(ergo, 'getTransaction').mockImplementation(async () => signedHex);
    vi.spyOn(EventOrder, 'eventRewardOrder').mockReturnValue({
      watchersOrder: ergo.extractTransactionOrder(reward, SigningStatus.Signed),
      guardsOrder: [],
    });
    const trigger = wasm.ErgoBox.sigma_parse_bytes(reward.inputBoxes[0]);
    const paymentHash = await target.getActualTxId(payment.txId);
    await db().EventRepository.update(
      { eventId },
      {
        identifier: trigger.box_id().to_str(),
        serialized: Buffer.from(reward.inputBoxes[0]).toString('base64'),
        result: 'successful',
        spendTxId: reward.txId,
        paymentTxId: paymentHash,
        spendBlock: blockId,
        spendHeight: 1000000,
      },
    );
    const event = (await db().getEventById(eventId))!;
    await db().CommitmentRepository.update(
      { eventId },
      {
        spendBlock: event.eventData.block,
        spendHeight: event.eventData.height,
      },
    );
    await db().BlockRepository.insert({
      scanner: 'ergo',
      height: 1000000,
      hash: blockId,
      parentHash: 'bd'.repeat(32),
      status: 'PROCEED',
      timestamp: 1,
    });
    await db().TransactionRepository.delete({ txId: oldId });
    await DatabaseActionMock.insertTxRecord(
      reward,
      TransactionStatus.sent,
      123,
      'updated',
      false,
      0,
      3,
    );
    vi.spyOn(DatabaseAction, 'getInstance').mockReturnValue(db());
  });

  let reduced: ErgoTransaction;
  beforeEach(async () => {
    reduced = ErgoTransaction.fromJson(JSON.stringify(ergoFixture.payment));
    reduced.eventId = eventId;
    reduced.txType = TransactionType.reward;
    await db().TransactionRepository.update(
      { txId: reward.txId },
      {
        txJson: reduced.toJson(),
        status: TransactionStatus.signFailed,
        failedInSign: true,
        signFailedCount: 2,
      },
    );
  });
  const bind = async () =>
    context.bind((await db().getTxById(reward.txId))!, [
      TransactionStatus.signFailed,
    ]);
  const recover = async (bound?: Awaited<ReturnType<typeof bind>>) => {
    bound ??= await bind();
    return bound.withRewardRecovery((expected, signedJson, permit) => {
      if (!signedJson || !permit) throw new Error('Expected guarded recovery');
      return db().recoverSignedRewardIfUnchanged(expected, signedJson, permit);
    });
  };
  const snapshot = async () => ({
    row: await db().getTxById(reward.txId),
    event: await db().getEventById(eventId),
  });
  const unchanged = async (action: () => Promise<unknown>) => {
    const before = await snapshot();
    const notify = vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    );
    await expect(action()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  };
  /**
   * @target TransactionSigningContext.bind 'recovers exact signed bytes, preserves counters/auxiliary boxes, then completes separately'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'recovers exact signed bytes, preserves counters/auxiliary boxes, then completes separately' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(recover()).resolves.toBe(true); expect(after.row).toEqual({ ...before.row, status: TransactionStatus.sent, txJson: reward.toJson(), lastStatusUpdate: expect.any(String), }); expect(after.event).toEqual(before.event); expect((await snapshot()).row!.status).toBe(TransactionStatus.completed); expect((await snapshot()).event!.status).toBe(EventStatus.completed);
   */
  it('recovers exact signed bytes, preserves counters/auxiliary boxes, then completes separately', async () => {
    const before = await snapshot();
    await expect(recover()).resolves.toBe(true);
    const after = await snapshot();
    expect(after.row).toEqual({
      ...before.row,
      status: TransactionStatus.sent,
      txJson: reward.toJson(),
      lastStatusUpdate: expect.any(String),
    });
    expect(after.event).toEqual(before.event);
    const completed = await context.bind(after.row!, [TransactionStatus.sent]);
    await completed.withPersistence('completion', (expected, permit) =>
      db().finalizeTxIfUnchanged(expected, permit),
    );
    expect((await snapshot()).row!.status).toBe(TransactionStatus.completed);
    expect((await snapshot()).event!.status).toBe(EventStatus.completed);
  });
  /**
   * @target TransactionProcessor.processSignFailedTx 'joins the actual processor found-on-chain branch to recovery'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'joins the actual processor found-on-chain branch to recovery' through TransactionProcessor.processSignFailedTx.
   * @expected expect((await snapshot()).row!.txJson).toBe(reward.toJson()); expect((await snapshot()).row!.status).toBe(TransactionStatus.sent);
   */
  it('joins the actual processor found-on-chain branch to recovery', async () => {
    TransactionProcessor.initSigning(context, {
      timeoutMs: 1000,
      maxPending: 4,
    });
    await TransactionProcessor.processSignFailedTx((await snapshot()).row!);
    expect((await snapshot()).row!.txJson).toBe(reward.toJson());
    expect((await snapshot()).row!.status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionProcessor.processSignFailedTx 'defers mempool-only recovery without a successful recorded spend'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'defers mempool-only recovery without a successful recorded spend' through TransactionProcessor.processSignFailedTx.
   * @expected expect(ergo.getTransaction).not.toHaveBeenCalled();
   */
  it('defers mempool-only recovery without a successful recorded spend', async () => {
    TransactionProcessor.initSigning(context, {
      timeoutMs: 1000,
      maxPending: 4,
    });
    rewardConfirmation.mockResolvedValue(ConfirmationStatus.NotFound);
    vi.spyOn(ergo, 'isTxInMempool').mockResolvedValue(true);
    await db().EventRepository.update(
      { eventId },
      {
        spendBlock: null,
        spendHeight: null,
        spendTxId: null,
        result: null,
        paymentTxId: null,
      },
    );
    const row = (await snapshot()).row!;
    expect.hasAssertions();
    await unchanged(() => TransactionProcessor.processSignFailedTx(row));
    expect(ergo.getTransaction).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects %s signed block response'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s signed block response' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each([
    'reduced',
    'malformed',
    'wrong-id',
    'missing',
    'changed-second-read',
  ])('rejects %s signed block response', async (fault) => {
    if (fault === 'reduced')
      signedHex = Buffer.from(reduced.txBytes).toString('hex');
    if (fault === 'malformed') signedHex = 'abcd';
    if (fault === 'wrong-id') {
      // Rebuild a different transaction body from the existing unsigned fixture.
      const unsignedJson = JSON.parse(
        wasm.ReducedTransaction.sigma_parse_bytes(reduced.txBytes)
          .unsigned_tx()
          .to_json(),
      );
      unsignedJson.outputs[0].value = String(
        BigInt(unsignedJson.outputs[0].value) + 1n,
      );
      const unsigned = wasm.UnsignedTransaction.from_json(
        JSON.stringify(unsignedJson),
      );
      signedHex = Buffer.from(
        wasm.Transaction.from_unsigned_tx(
          unsigned,
          Array.from(
            { length: unsigned.inputs().len() },
            () => new Uint8Array(),
          ),
        ).sigma_serialize_bytes(),
      ).toString('hex');
    }
    if (fault === 'missing')
      vi.mocked(ergo.getTransaction).mockRejectedValue(
        new Error('not in block'),
      );
    if (fault === 'changed-second-read')
      vi.mocked(ergo.getTransaction)
        .mockResolvedValueOnce(signedHex)
        .mockResolvedValue('abcd');
    expect.hasAssertions();
    await unchanged(() => recover());
  });
  /**
   * @target TransactionSigningContext.bind 'rejects isolated original %s mismatch'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects isolated original %s mismatch' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each([
    'inputBoxes',
    'dataInputs',
    'network',
    'txId',
    'eventId',
    'txType',
    'signed-original',
  ])('rejects isolated original %s mismatch', async (fault) => {
    const model = JSON.parse(reduced.toJson());
    if (fault === 'inputBoxes') model.inputBoxes[0] = 'abcd';
    if (fault === 'dataInputs') model.dataInputs = [model.inputBoxes[0]];
    if (fault === 'network') model.network = 'ethereum';
    if (fault === 'txId') model.txId = 'aa'.repeat(32);
    if (fault === 'eventId') model.eventId = 'aa'.repeat(32);
    if (fault === 'txType') model.txType = TransactionType.payment;
    if (fault === 'signed-original') model.txBytes = signedHex;
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { txJson: JSON.stringify(model) },
    );
    expect.hasAssertions();
    await unchanged(() => recover());
  });
  /**
   * @target TransactionSigningContext.bind 'rejects isolated spent trigger %s mismatch'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects isolated spent trigger %s mismatch' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each([
    'result',
    'spendTxId',
    'paymentTxId',
    'spendHeight',
    'spendBlock',
    'serialized',
    'identifier',
  ])('rejects isolated spent trigger %s mismatch', async (field) => {
    const patches = {
      result: 'fraud',
      spendTxId: 'other',
      paymentTxId: 'other',
      spendHeight: 999999,
      spendBlock: 'ab'.repeat(32),
      serialized: 'YQ==',
      identifier: 'ab'.repeat(32),
    };
    await db().EventRepository.update(
      { eventId },
      { [field]: patches[field as keyof typeof patches] },
    );
    expect.hasAssertions();
    await unchanged(() => recover());
  });
  /**
   * @target TransactionSigningContext.bind 'defers %s scanned block'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers %s scanned block' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['missing', 'processing', 'wrong-scanner', 'wrong-hash'])(
    'defers %s scanned block',
    async (fault) => {
      if (fault === 'missing')
        await db().BlockRepository.delete({ scanner: 'ergo' });
      if (fault === 'processing')
        await db().BlockRepository.update(
          { scanner: 'ergo' },
          { status: 'PROCESSING' },
        );
      if (fault === 'wrong-scanner')
        await db().BlockRepository.update(
          { scanner: 'ergo' },
          { scanner: 'other' },
        );
      if (fault === 'wrong-hash')
        await db().BlockRepository.update(
          { scanner: 'ergo' },
          { hash: 'aa'.repeat(32) },
        );
      expect.hasAssertions();
      await unchanged(() => recover());
    },
  );
  /**
   * @target TransactionSigningContext.bind 'defers %s qualification loss'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers %s qualification loss' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['hold', 'payment', 'reward', 'late-reward'])(
    'defers %s qualification loss',
    async (fault) => {
      if (fault === 'hold') await hold();
      if (fault === 'payment')
        confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
      if (fault === 'reward')
        rewardConfirmation.mockResolvedValue(ConfirmationStatus.NotFound);
      if (fault === 'late-reward')
        confirmation.mockImplementation(async () => {
          rewardConfirmation.mockResolvedValue(ConfirmationStatus.NotFound);
          return ConfirmationStatus.ConfirmedEnough;
        });
      expect.hasAssertions();
      await unchanged(() => recover());
    },
  );
  /**
   * @target TransactionSigningContext.bind 'preserves the exact raw JSON predicate separately from semantic model ordering'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'preserves the exact raw JSON predicate separately from semantic model ordering' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(recover()).resolves.toBe(true);
   */
  it('preserves the exact raw JSON predicate separately from semantic model ordering', async () => {
    const model = JSON.parse(reduced.toJson());
    await db().TransactionRepository.update(
      { txId: reward.txId },
      {
        txJson: JSON.stringify(
          Object.fromEntries(Object.entries(model).reverse()),
        ),
      },
    );
    await expect(recover()).resolves.toBe(true);
  });
  /**
   * @target TransactionSigningContext.bind 'never uses the original unspent-only signing/commitment gate'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'never uses the original unspent-only signing/commitment gate' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(recover()).resolves.toBe(true);
   */
  it('never uses the original unspent-only signing/commitment gate', async () => {
    vi.spyOn(db(), 'getValidCommitments').mockRejectedValue(
      new Error('unspent gate forbidden'),
    );
    await expect(recover()).resolves.toBe(true);
  });
  /**
   * @target TransactionSigningContext.bind 'rolls back %s SQL failure or post-write drift'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rolls back %s SQL failure or post-write drift' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['ABORT', 'IGNORE', 'row', 'event', 'payment'])(
    'rolls back %s SQL failure or post-write drift',
    async (fault) => {
      const sql =
        fault === 'ABORT' || fault === 'IGNORE'
          ? `CREATE TEMP TRIGGER recovery_test BEFORE UPDATE ON transaction_entity WHEN NEW.status='sent' BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'rejected'" : ''}); END`
          : `CREATE TEMP TRIGGER recovery_test AFTER UPDATE ON transaction_entity WHEN NEW.status='sent' BEGIN ${fault === 'row' ? 'UPDATE transaction_entity SET signFailedCount=99 WHERE txId=NEW.txId;' : fault === 'event' ? "UPDATE confirmed_event_entity SET status='completed';" : "UPDATE transaction_entity SET requiredSign=99 WHERE type='payment';"} END`;
      await db().dataSource.query(sql);
      try {
        expect.hasAssertions();
        await unchanged(() => recover());
      } finally {
        await db().dataSource.query('DROP TRIGGER recovery_test');
      }
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects a stale original row without overwriting the newer winner'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects a stale original row without overwriting the newer winner' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it('rejects a stale original row without overwriting the newer winner', async () => {
    const bound = await bind();
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { requiredSign: 9 },
    );
    expect.hasAssertions();
    await unchanged(() => recover(bound));
  });
  /**
   * @target TransactionSigningContext.bind 'rejects repeated recovery after the first transition'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects repeated recovery after the first transition' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it('rejects repeated recovery after the first transition', async () => {
    const bound = await bind();
    await recover(bound);
    expect.hasAssertions();
    await unchanged(() => recover(bound));
  });
  /**
   * @target TransactionSigningContext.bind 'rejects reordered real multiple input boxes before retrieving any signed source'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects reordered real multiple input boxes before retrieving any signed source' with the suite's captured inputs and invoke the bind path.
   * @expected expect(original.inputBoxes.length).toBeGreaterThan(1); expect( await ergo.verifyPaymentTransaction(original, SigningStatus.UnSigned), ).toBe(true); expect(ergo.getTransaction).not.toHaveBeenCalled();
   */
  it('rejects reordered real multiple input boxes before retrieving any signed source', async () => {
    const original = ErgoTransaction.fromJson(transaction3PaymentTransaction);
    original.eventId = eventId;
    original.txType = TransactionType.reward;
    expect(original.inputBoxes.length).toBeGreaterThan(1);
    expect(
      await ergo.verifyPaymentTransaction(original, SigningStatus.UnSigned),
    ).toBe(true);
    original.inputBoxes.reverse();
    const oldId = reward.txId;
    reward.txId = original.txId;
    await db().TransactionRepository.update(
      { txId: oldId },
      { txId: original.txId, txJson: original.toJson() },
    );
    expect.hasAssertions();
    await unchanged(() => recover());
    expect(ergo.getTransaction).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rechecks payment authority after waiting for SQL ownership and preserves its concurrent winner'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks payment authority after waiting for SQL ownership and preserves its concurrent winner' with the suite's captured inputs and invoke the bind path.
   * @expected expect(await pending).toBeInstanceOf(Error); expect(await snapshot()).toEqual(before); expect((await db().getTxById(payment.txId))!.requiredSign).toBe(9); expect(notify).not.toHaveBeenCalled();
   */
  it('rechecks payment authority after waiting for SQL ownership and preserves its concurrent winner', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let owner: Promise<void> | undefined;
    rewardConfirmation.mockImplementation(async () => {
      owner = db().dataSource.transaction(async (manager) => {
        await manager
          .getRepository(TransactionEntity)
          .update({ txId: payment.txId }, { requiredSign: 9 });
        entered();
        await gate;
      });
      await acquired;
      return ConfirmationStatus.ConfirmedEnough;
    });
    const before = await snapshot();
    const notify = vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    );
    const pending = recover().then(
      () => undefined,
      (error: unknown) => error,
    );
    await acquired;
    release();
    await owner;
    expect(await pending).toBeInstanceOf(Error);
    expect(await snapshot()).toEqual(before);
    expect((await db().getTxById(payment.txId))!.requiredSign).toBe(9);
    expect(notify).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'forwards recovery purpose through the actual runtime dependency injection'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'forwards recovery purpose through the actual runtime dependency injection' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(recover(bound)).resolves.toBe(true); expect(binder).toHaveBeenCalledWith( bound.preimage, [TransactionStatus.signFailed], 'recovery', );
   */
  it('forwards recovery purpose through the actual runtime dependency injection', async () => {
    const runtime = createGuardSigningRuntime({
      getEvent: (id) => db().getEventById(id),
      getTx: (id) => db().getTxById(id),
      decode: (json) => context['dependencies'].decode(json),
      getScanner: () => scanner,
      curveTimeoutSeconds: 1,
      edwardTimeoutSeconds: 1,
      ergoTimeoutSeconds: 1,
      maxPending: 4,
    });
    const binder = vi.spyOn(authorization, 'bindExistingReward');
    const bound = await runtime.context.bind((await snapshot()).row!, [
      TransactionStatus.signFailed,
    ]);
    await expect(recover(bound)).resolves.toBe(true);
    expect(binder).toHaveBeenCalledWith(
      bound.preimage,
      [TransactionStatus.signFailed],
      'recovery',
    );
  });
  /**
   * @target TransactionSigningContext.beginAttempt 'revokes recovery %s without status/JSON/counter changes'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'revokes recovery %s without status/JSON/counter changes' with the suite's captured inputs and invoke the beginAttempt path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['before', 'during-RPC', 'after-write'])(
    'revokes recovery %s without status/JSON/counter changes',
    async (phase) => {
      const attempt = context.beginAttempt(await bind(), 1000, () => true);
      if (phase === 'before') attempt.revoke();
      if (phase === 'during-RPC')
        rewardConfirmation.mockImplementation(async () => {
          attempt.revoke();
          return ConfirmationStatus.ConfirmedEnough;
        });
      const operation = () =>
        attempt.withRewardRecovery((expected, json, permit) => {
          if (!json || !permit) throw new Error('Expected authority');
          return db().recoverSignedRewardIfUnchanged(expected, json, {
            ...permit,
            assertAfter: async (manager, after) => {
              await permit.assertAfter(manager, after);
              if (phase === 'after-write') attempt.revoke();
            },
          });
        });
      expect.hasAssertions();
      await unchanged(operation);
    },
  );
  /**
   * @target TransactionSigningContext.bind 'requires DAO recovery authority and rejects undefined predicates before opening SQL ownership'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'requires DAO recovery authority and rejects undefined predicates before opening SQL ownership' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( db().recoverSignedRewardIfUnchanged( bound.preimage, reward.toJson(), undefined as never, ), ).rejects.toThrow('authority'); await expect( db().recoverSignedRewardIfUnchanged( { ...bound.preimage, eventId: undefined } as never, reward.toJson(), {} as never, ), ).rejects.toThrow('preimage'); expect(tx).not.toHaveBeenCalled();
   */
  it('requires DAO recovery authority and rejects undefined predicates before opening SQL ownership', async () => {
    const bound = await bind();
    const tx = vi.spyOn(db().dataSource, 'transaction');
    await expect(
      db().recoverSignedRewardIfUnchanged(
        bound.preimage,
        reward.toJson(),
        undefined as never,
      ),
    ).rejects.toThrow('authority');
    await expect(
      db().recoverSignedRewardIfUnchanged(
        { ...bound.preimage, eventId: undefined } as never,
        reward.toJson(),
        {} as never,
      ),
    ).rejects.toThrow('preimage');
    expect(tx).not.toHaveBeenCalled();
  });
});
