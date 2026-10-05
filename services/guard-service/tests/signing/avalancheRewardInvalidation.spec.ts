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
describe('Avalanche reward invalidation', () => {
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
    reward = ErgoTransaction.fromJson(transaction3PaymentTransaction);
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
    const trigger = wasm.ErgoBox.sigma_parse_bytes(reward.inputBoxes[1]);
    const paymentHash = await target.getActualTxId(payment.txId);
    await db().EventRepository.update(
      { eventId },
      {
        identifier: trigger.box_id().to_str(),
        serialized: Buffer.from(reward.inputBoxes[1]).toString('base64'),
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

  let foreignId: string;
  let foreignHex: string;
  let commitmentId: string;
  const wid = 'bb'.repeat(32);
  beforeEach(async () => {
    const body = JSON.parse(
      wasm.ReducedTransaction.sigma_parse_bytes(
        ErgoTransaction.fromJson(transaction3PaymentTransaction).txBytes,
      )
        .unsigned_tx()
        .to_json(),
    );
    body.inputs = [body.inputs[3]];
    const unsigned = wasm.UnsignedTransaction.from_json(JSON.stringify(body));
    const foreign = wasm.Transaction.from_unsigned_tx(unsigned, [
      new Uint8Array(),
    ]);
    foreignId = foreign.id().to_str();
    foreignHex = Buffer.from(foreign.sigma_serialize_bytes()).toString('hex');
    commitmentId = wasm.ErgoBox.sigma_parse_bytes(reward.inputBoxes[3])
      .box_id()
      .to_str();
    await db().EventRepository.update(
      { eventId },
      {
        result: null,
        spendTxId: null,
        spendHeight: null,
        spendBlock: null,
        paymentTxId: null,
      },
    );
    const event = (await db().getEventById(eventId))!;
    await DatabaseActionMock.insertCommitmentBoxRecord(
      EventSerializer.fromConfirmedEntity(event),
      eventId,
      Buffer.from(reward.inputBoxes[3]).toString('base64'),
      wid,
      event.eventData.height - 1,
      '10',
      foreignId,
      0,
    );
    await db().CommitmentRepository.update(
      { eventId, WID: wid },
      {
        identifier: commitmentId,
        spendHeight: 1000000,
        spendBlock: blockId,
      },
    );
    vi.spyOn(ergo, 'getRWTToken').mockReturnValue(
      wasm.ErgoBox.sigma_parse_bytes(reward.inputBoxes[1])
        .tokens()
        .get(0)
        .id()
        .to_str(),
    );
    vi.spyOn(ergo, 'getBoxRWT').mockReturnValue(10n);
    vi.spyOn(ergo, 'getBoxWID').mockReturnValue(wid);
    vi.mocked(ergo.getTransaction).mockImplementation(async () => foreignHex);
    rewardConfirmation.mockImplementation(async (id) =>
      id === reward.txId
        ? ConfirmationStatus.NotFound
        : ConfirmationStatus.ConfirmedEnough,
    );
    vi.spyOn(ergo, 'isTxInMempool').mockResolvedValue(false);
    vi.spyOn(ergo, 'getHeight').mockResolvedValue(1000001);
  });
  const bind = async () => {
    const row = (await db().getTxById(reward.txId))!;
    return context.bind(row, [row.status]);
  };
  const invalidate = async (
    unexpected = false,
    bound?: Awaited<ReturnType<typeof bind>>,
  ) =>
    (bound ?? (await bind())).withPersistence(
      'invalidation',
      (expected, permit) =>
        db().invalidateTxIfUnchanged(expected, 123, unexpected, permit),
    );
  const snapshot = async () => ({
    row: await db().getTxById(reward.txId),
    event: await db().getEventById(eventId),
  });
  const unchanged = async (action = () => invalidate()) => {
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
   * @target TransactionSigningContext.bind 'retires %s only with a confirmed foreign input spend'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'retires %s only with a confirmed foreign input spend' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidate(true)).resolves.toBe(true); expect(after.row).toEqual({ ...before.row, status: TransactionStatus.invalid, lastStatusUpdate: expect.any(String), event: { ...before.row!.event, status: EventStatus.pendingReward, unexpectedFails: before.event!.unexpectedFails + 1, }, }); expect(after.event).toEqual({ ...before.event, status: EventStatus.pendingReward, unexpectedFails: before.event!.unexpectedFails + 1, });
   */
  it.each([TransactionStatus.sent, TransactionStatus.signFailed])(
    'retires %s only with a confirmed foreign input spend',
    async (status) => {
      if (status === TransactionStatus.signFailed) {
        const reduced = ErgoTransaction.fromJson(
          transaction3PaymentTransaction,
        );
        reduced.eventId = eventId;
        reduced.txType = TransactionType.reward;
        await db().TransactionRepository.update(
          { txId: reward.txId },
          { status, txJson: reduced.toJson() },
        );
      }
      const before = await snapshot();
      await expect(invalidate(true)).resolves.toBe(true);
      const after = await snapshot();
      expect(after.row).toEqual({
        ...before.row,
        status: TransactionStatus.invalid,
        lastStatusUpdate: expect.any(String),
        event: {
          ...before.row!.event,
          status: EventStatus.pendingReward,
          unexpectedFails: before.event!.unexpectedFails + 1,
        },
      });
      expect(after.event).toEqual({
        ...before.event,
        status: EventStatus.pendingReward,
        unexpectedFails: before.event!.unexpectedFails + 1,
      });
    },
  );
  /**
   * @target TransactionProcessor.setTransactionAsInvalid 'joins the processor invalidation branch to current authority'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'joins the processor invalidation branch to current authority' through TransactionProcessor.setTransactionAsInvalid.
   * @expected expect((await snapshot()).row!.status).toBe(TransactionStatus.invalid);
   */
  it('joins the processor invalidation branch to current authority', async () => {
    TransactionProcessor.initSigning(context, {
      timeoutMs: 1000,
      maxPending: 4,
    });
    await TransactionProcessor.setTransactionAsInvalid(
      (await snapshot()).row!,
      ergo as AbstractChain<unknown>,
      { reason: 'foreign spend', unexpected: false },
    );
    expect((await snapshot()).row!.status).toBe(TransactionStatus.invalid);
  });
  /**
   * @target TransactionSigningContext.bind 'rejects initially populated trigger %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects initially populated trigger %s' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['spendHeight', 'spendBlock', 'spendTxId', 'result', 'paymentTxId'])(
    'rejects initially populated trigger %s',
    async (field) => {
      expect.hasAssertions();
      await db().EventRepository.update(
        { eventId },
        { [field]: field === 'spendHeight' ? 1000000 : 'bad' },
      );
      await unchanged();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects foreign commitment %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects foreign commitment %s' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each([
    'missing',
    'own',
    'height',
    'block',
    'index',
    'id',
    'serialized',
    'wid',
    'count',
    'commitment',
  ])('rejects foreign commitment %s', async (field) => {
    expect.hasAssertions();
    const changes = {
      missing: {
        spendTxId: null,
        spendHeight: null,
        spendBlock: null,
        spendIndex: null,
      },
      own: { spendTxId: reward.txId },
      height: { spendHeight: null },
      block: { spendBlock: null },
      index: { spendIndex: 1 },
      id: { identifier: 'cc'.repeat(32) },
      serialized: { serialized: 'YQ==' },
      wid: { WID: 'cc'.repeat(32) },
      count: { rwtCount: '11' },
      commitment: { commitment: 'wrong' },
    }[field]!;
    await db().CommitmentRepository.update({ eventId, WID: wid }, changes);
    await unchanged();
  });
  /**
   * @target TransactionSigningContext.bind 'defers %s without a write'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers %s without a write' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each([
    'rpc',
    'pruned',
    'suffix',
    'different',
    'unconfirmed',
    'own-confirmed',
    'mempool',
    'hold',
    'payment',
  ])('defers %s without a write', async (fault) => {
    expect.hasAssertions();
    if (fault === 'rpc' || fault === 'pruned')
      vi.mocked(ergo.getTransaction).mockRejectedValue(new Error(fault));
    if (fault === 'suffix') foreignHex += '00';
    if (fault === 'different') foreignHex = signedHex;
    if (fault === 'unconfirmed')
      rewardConfirmation.mockResolvedValue(
        ConfirmationStatus.NotConfirmedEnough,
      );
    if (fault === 'own-confirmed')
      rewardConfirmation.mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    if (fault === 'mempool')
      vi.mocked(ergo.isTxInMempool).mockResolvedValue(true);
    if (fault === 'hold') await hold();
    if (fault === 'payment')
      confirmation.mockRejectedValue(new Error('payment unavailable'));
    await unchanged();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects foreign scanned block %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects foreign scanned block %s' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['hash', 'status', 'missing'])(
    'rejects foreign scanned block %s',
    async (fault) => {
      expect.hasAssertions();
      if (fault === 'missing')
        await db().BlockRepository.delete({ scanner: 'ergo' });
      else
        await db().BlockRepository.update(
          { scanner: 'ergo' },
          fault === 'hash' ? { hash: 'cc'.repeat(32) } : { status: 'forked' },
        );
      await unchanged();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rechecks own reward after payment RPC'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks own reward after payment RPC' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it('rechecks own reward after payment RPC', async () => {
    expect.hasAssertions();
    confirmation.mockImplementationOnce(async () => {
      rewardConfirmation.mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
      return ConfirmationStatus.ConfirmedEnough;
    });
    await unchanged();
  });
  /**
   * @target TransactionSigningContext.bind 'rolls back first write when event update %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rolls back first write when event update %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidate()).resolves.toBe(false); await expect(invalidate()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
   */
  it.each(['ABORT', 'IGNORE'])(
    'rolls back first write when event update %s',
    async (mode) => {
      await db().dataSource.query(
        `CREATE TRIGGER fail_event BEFORE UPDATE ON confirmed_event_entity BEGIN SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'stop'" : ''}); END`,
      );
      try {
        const before = await snapshot();
        if (mode === 'IGNORE') await expect(invalidate()).resolves.toBe(false);
        else await expect(invalidate()).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      } finally {
        await db().dataSource.query('DROP TRIGGER fail_event');
      }
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rolls back post-event-write mutation of %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rolls back post-event-write mutation of %s' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each([
    'txJson',
    'requiredSign',
    'lastCheck',
    'signFailedCount',
    'failedInSign',
    'lastStatusUpdate',
    'event',
    'payment',
    'trigger',
    'commitment',
  ])('rolls back post-event-write mutation of %s', async (field) => {
    expect.hasAssertions();
    const sql =
      field === 'event'
        ? "UPDATE confirmed_event_entity SET firstTry='changed';"
        : field === 'payment'
          ? "UPDATE transaction_entity SET requiredSign=99 WHERE type='payment';"
          : field === 'trigger'
            ? "UPDATE event_trigger_entity SET spendTxId='foreign';"
            : field === 'commitment'
              ? 'UPDATE commitment_entity SET spendHeight=1;'
              : `UPDATE transaction_entity SET ${field}=${field === 'txJson' || field === 'lastStatusUpdate' ? "'changed'" : field === 'failedInSign' ? '1' : '99'} WHERE type='reward';`;
    await db().dataSource.query(
      `CREATE TEMP TRIGGER post_invalidation AFTER UPDATE ON confirmed_event_entity WHEN NEW.status='pending-reward' BEGIN ${sql} END`,
    );
    try {
      await unchanged();
    } finally {
      await db().dataSource.query('DROP TRIGGER post_invalidation');
    }
  });
  /**
   * @target TransactionSigningContext.bind 'rejects inconsistent stored reward model %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects inconsistent stored reward model %s' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each([
    'txBytes',
    'inputBoxes',
    'dataInputs',
    'network',
    'txId',
    'eventId',
    'txType',
  ])('rejects inconsistent stored reward model %s', async (field) => {
    expect.hasAssertions();
    const model = JSON.parse(reward.toJson());
    if (field === 'txBytes') model.txBytes += '00';
    else if (field === 'inputBoxes') model.inputBoxes.reverse();
    else if (field === 'dataInputs') model.dataInputs = [];
    else model[field] = 'wrong';
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { txJson: JSON.stringify(model) },
    );
    await unchanged();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects %s encoding without fallback'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s encoding without fallback' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['sent-reduced', 'failed-signed', 'input-suffix', 'data-suffix'])(
    'rejects %s encoding without fallback',
    async (fault) => {
      expect.hasAssertions();
      const model = ErgoTransaction.fromJson(reward.toJson());
      let status = TransactionStatus.sent;
      if (fault === 'sent-reduced')
        model.txBytes = ErgoTransaction.fromJson(
          transaction3PaymentTransaction,
        ).txBytes;
      if (fault === 'failed-signed') status = TransactionStatus.signFailed;
      if (fault === 'input-suffix')
        model.inputBoxes[0] = Buffer.concat([
          model.inputBoxes[0],
          Buffer.from('00', 'hex'),
        ]);
      if (fault === 'data-suffix')
        model.dataInputs[0] = Buffer.concat([
          model.dataInputs[0],
          Buffer.from('00', 'hex'),
        ]);
      await db().TransactionRepository.update(
        { txId: reward.txId },
        { status, txJson: model.toJson() },
      );
      await unchanged();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects %s changed during payment qualification'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s changed during payment qualification' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['fee', 'order', 'confirmations', 'foreign-confirmation'])(
    'rejects %s changed during payment qualification',
    async (fault) => {
      expect.hasAssertions();
      confirmation
        .mockResolvedValueOnce(ConfirmationStatus.ConfirmedEnough)
        .mockImplementationOnce(async () => {
          if (fault === 'fee')
            vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
              changed: 1,
            } as never);
          if (fault === 'order')
            vi.mocked(EventOrder.eventRewardOrder).mockReturnValue({
              watchersOrder: [],
              guardsOrder: [],
            });
          if (fault === 'confirmations')
            vi.spyOn(ergo, 'getTxRequiredConfirmation').mockReturnValue(0);
          if (fault === 'foreign-confirmation')
            rewardConfirmation.mockImplementation(async (id) =>
              id === reward.txId
                ? ConfirmationStatus.NotFound
                : ConfirmationStatus.NotConfirmedEnough,
            );
          return ConfirmationStatus.ConfirmedEnough;
        });
      await unchanged();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'keeps the concurrent payment winner after queued SQL ownership'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps the concurrent payment winner after queued SQL ownership' with the suite's captured inputs and invoke the bind path.
   * @expected expect(await pending).toBeInstanceOf(Error); expect(await snapshot()).toEqual(before); expect((await db().getTxById(payment.txId))!.requiredSign).toBe(9);
   */
  it('keeps the concurrent payment winner after queued SQL ownership', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let owner: Promise<void> | undefined;
    vi.mocked(ergo.isTxInMempool).mockImplementation(async () => {
      owner = db().dataSource.transaction(async (manager) => {
        await manager
          .getRepository(TransactionEntity)
          .update({ txId: payment.txId }, { requiredSign: 9 });
        entered();
        await gate;
      });
      await acquired;
      return false;
    });
    const before = await snapshot();
    const pending = invalidate().then(
      () => undefined,
      (error: unknown) => error,
    );
    await acquired;
    release();
    await owner;
    expect(await pending).toBeInstanceOf(Error);
    expect(await snapshot()).toEqual(before);
    expect((await db().getTxById(payment.txId))!.requiredSign).toBe(9);
  });
  /**
   * @target TransactionSigningContext.beginAttempt 'rolls back revoked or failed authority %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rolls back revoked or failed authority %s' with the suite's captured inputs and invoke the beginAttempt path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it.each(['before', 'after-write', 'after-check'])(
    'rolls back revoked or failed authority %s',
    async (phase) => {
      expect.hasAssertions();
      const attempt = context.beginAttempt(await bind(), 1000, () => true);
      if (phase === 'before') attempt.revoke();
      await unchanged(() =>
        attempt.withPersistence('invalidation', (expected, permit) =>
          db().invalidateTxIfUnchanged(expected, 123, true, {
            ...permit,
            assertAfter: async (manager, after, transition) => {
              await permit.assertAfter(manager, after, transition);
              if (phase === 'after-write')
                throw new Error('failure after update');
              if (phase === 'after-check') attempt.revoke();
            },
          }),
        ),
      );
    },
  );
  /**
   * @target TransactionSigningContext.bind 'never resurrects the old invalidated row'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'never resurrects the old invalidated row' with the suite's captured inputs and invoke the bind path.
   * @expected The suite assertion helper verifies the expected result and that rejected actions leave captured state unchanged.
   */
  it('never resurrects the old invalidated row', async () => {
    expect.hasAssertions();
    const bound = await bind();
    await invalidate(false, bound);
    await unchanged(() => invalidate(false, bound));
  });
  /**
   * @target TransactionSigningContext.bind 'qualifies the Avalanche source direction with its recorded observation'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'qualifies the Avalanche source direction with its recorded observation' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidate()).resolves.toBe(true);
   */
  it('qualifies the Avalanche source direction with its recorded observation', async () => {
    const target = authorization['dependencies'].getChain('avalanche');
    Object.assign(target, { getRWTToken: () => ergo.getRWTToken() });
    await db().EventRepository.update(
      { eventId },
      { fromChain: 'avalanche', toChain: 'ethereum' },
    );
    payment.network = 'ethereum';
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { chain: 'ethereum', txJson: payment.toJson() },
    );
    const event = (await db().getEventById(eventId))!;
    const { default: Utils } = await import('../../src/utils/utils');
    await db().CommitmentRepository.update(
      { eventId, WID: wid },
      {
        commitment: Utils.commitmentFromEvent(
          EventSerializer.fromConfirmedEntity(event),
          wid,
        ),
      },
    );
    await expect(invalidate()).resolves.toBe(true);
  });
  /**
   * @target TransactionProcessor.setTransactionAsInvalid 'processor preserves a newer %s winner observed during RPC'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'processor preserves a newer %s winner observed during RPC' through TransactionProcessor.setTransactionAsInvalid.
   * @expected await expect( TransactionProcessor.setTransactionAsInvalid( row, ergo as AbstractChain<unknown>, { reason: 'spent', unexpected: false }, ), ).rejects.toThrow(); expect(after.row!.status).toBe(TransactionStatus.sent); expect(after.row![field as keyof TransactionEntity]).toBe( field === 'failedInSign' ? true : field === 'lastStatusUpdate' ? 'newer' : 124, ); expect(after.event!.status).toBe(EventStatus.inReward);
   */
  it.each(['lastCheck', 'lastStatusUpdate', 'failedInSign', 'signFailedCount'])(
    'processor preserves a newer %s winner observed during RPC',
    async (field) => {
      TransactionProcessor.initSigning(context, {
        timeoutMs: 1000,
        maxPending: 4,
      });
      vi.mocked(ergo.getHeight).mockImplementation(async () => {
        await db().TransactionRepository.update(
          { txId: reward.txId },
          {
            [field]:
              field === 'failedInSign'
                ? true
                : field === 'lastStatusUpdate'
                  ? 'newer'
                  : 124,
          },
        );
        return 1000001;
      });
      const row = (await snapshot()).row!;
      await expect(
        TransactionProcessor.setTransactionAsInvalid(
          row,
          ergo as AbstractChain<unknown>,
          { reason: 'spent', unexpected: false },
        ),
      ).rejects.toThrow();
      const after = await snapshot();
      expect(after.row!.status).toBe(TransactionStatus.sent);
      expect(after.row![field as keyof TransactionEntity]).toBe(
        field === 'failedInSign'
          ? true
          : field === 'lastStatusUpdate'
            ? 'newer'
            : 124,
      );
      expect(after.event!.status).toBe(EventStatus.inReward);
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects %s changed after confirmation'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s changed after confirmation' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidate()).resolves.toBe(false); await expect(invalidate()).rejects.toThrow(); expect((await db().getTxById(reward.txId))!.status).toBe( TransactionStatus.sent, ); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    'reward-order',
    'payment-order',
    'payment-event',
    'reward-event',
    'phase',
    'active-reward',
    'trigger-body',
  ])('rejects %s changed after confirmation', async (fault) => {
    expect.hasAssertions();
    vi.mocked(ergo.isTxInMempool).mockImplementation(async () => {
      if (fault === 'reward-order' || fault === 'payment-order')
        await db().dataSource.query(
          'UPDATE transaction_entity SET orderId=? WHERE txId=?',
          ['orphan', fault === 'reward-order' ? reward.txId : payment.txId],
        );
      if (fault === 'reward-event' || fault === 'payment-event')
        await db().dataSource.query(
          'UPDATE transaction_entity SET eventId=NULL WHERE txId=?',
          [fault === 'reward-event' ? reward.txId : payment.txId],
        );
      if (fault === 'phase')
        await db().ConfirmedEventRepository.update(
          { id: eventId },
          { status: EventStatus.completed },
        );
      if (fault === 'trigger-body')
        await db().EventRepository.update({ eventId }, { serialized: 'YQ==' });
      if (fault === 'active-reward') {
        const second = ErgoTransaction.fromJson(reward.toJson());
        second.txId = 'dd'.repeat(32);
        await DatabaseActionMock.insertTxRecord(
          second,
          TransactionStatus.approved,
          123,
          'new',
          false,
          0,
          3,
        );
      }
      return false;
    });
    const notify = vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    );
    if (fault === 'reward-event')
      await expect(invalidate()).resolves.toBe(false);
    else await expect(invalidate()).rejects.toThrow();
    expect((await db().getTxById(reward.txId))!.status).toBe(
      TransactionStatus.sent,
    );
    expect(notify).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects changing scanner safety while an invalidation action owns its lease'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects changing scanner safety while an invalidation action owns its lease' with the suite's captured inputs and invoke the bind path.
   * @expected await bound.withPersistence('invalidation', async (expected, permit) => { await expect(scanner.update()).rejects.toThrow(); return db().invalidateTxIfUnchanged(expected, 123, false, permit); }); await expect(scanner.update()).rejects.toThrow(); expect((await snapshot()).row!.status).toBe(TransactionStatus.invalid);
   */
  it('rejects changing scanner safety while an invalidation action owns its lease', async () => {
    const bound = await bind();
    await bound.withPersistence('invalidation', async (expected, permit) => {
      await expect(scanner.update()).rejects.toThrow();
      return db().invalidateTxIfUnchanged(expected, 123, false, permit);
    });
    expect((await snapshot()).row!.status).toBe(TransactionStatus.invalid);
  });
});
