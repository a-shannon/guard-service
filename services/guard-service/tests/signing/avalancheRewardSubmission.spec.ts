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
import { ErgoChain, ErgoTransaction } from '@rosen-chains/ergo';
import ErgoExplorerNetwork from '@rosen-chains/ergo-explorer-network';
import ErgoNodeNetwork from '@rosen-chains/ergo-node-network';
import axios, {
  Axios,
  type InternalAxiosRequestConfig,
} from '@rosen-clients/rate-limited-axios';

import GuardsErgoConfigs from '../../src/configs/guardsErgoConfigs';
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
describe('Avalanche reward HTTP admission', () => {
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
      new ErgoNodeNetwork({ nodeBaseUrl: 'http://127.0.0.1:1' }),
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

  const originalAdapter = axios.defaults.adapter;
  const originalTimeouts = {
    node: GuardsErgoConfigs.node.timeout,
    explorer: GuardsErgoConfigs.explorer.timeout,
  };
  const originalNetworkName = GuardsErgoConfigs.chainNetworkName;
  const transport = vi.fn();
  beforeEach(async () => {
    GuardsErgoConfigs.node.timeout = 2;
    GuardsErgoConfigs.explorer.timeout = 2;
    axios.defaults.adapter = transport;
    transport.mockReset().mockImplementation(async (config) => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      data: 'accepted',
    }));
    await db().EventRepository.update(
      { eventId },
      {
        result: null,
        spendHeight: null,
        spendBlock: null,
        spendTxId: null,
        paymentTxId: null,
      },
    );
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { status: TransactionStatus.signed },
    );
    vi.spyOn(ergo, 'isTxValid').mockResolvedValue({
      isValid: true,
      details: undefined,
    });
    vi.spyOn(ergo, 'isTxInMempool').mockResolvedValue(false);
    TransactionProcessor.initSigning(context, {
      timeoutMs: 1000,
      maxPending: 4,
    });
  });
  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
    GuardsErgoConfigs.node.timeout = originalTimeouts.node;
    GuardsErgoConfigs.explorer.timeout = originalTimeouts.explorer;
    GuardsErgoConfigs.chainNetworkName = originalNetworkName;
  });
  const row = async () => (await db().getTxById(reward.txId))!;
  const submit = async () => TransactionProcessor.processSignedTx(await row());
  const snapshot = async () => ({
    row: await row(),
    event: await db().getEventById(eventId),
  });
  const observe = async () => {
    const target = authorization['dependencies'].getChain('avalanche');
    await db().EventRepository.update(
      { eventId },
      {
        result: 'successful',
        spendTxId: reward.txId,
        paymentTxId: await target.getActualTxId(payment.txId),
        spendHeight: 1000000,
        spendBlock: blockId,
      },
    );
  };
  /**
   * @target TransactionProcessor.processSignedTx 'uses actual qualified Node adapter and persists sent after fresh unspent qualification'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'uses actual qualified Node adapter and persists sent after fresh unspent qualification' through TransactionProcessor.processSignedTx.
   * @expected expect(await ergo.verifyTransactionFee(reward, SigningStatus.Signed)).toBe( true, ); expect(await ergo.verifyNoTokenBurned(reward, SigningStatus.Signed)).toBe( true, ); expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0][0].data).toBe(JSON.stringify(signedHex)); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('uses actual qualified Node adapter and persists sent after fresh unspent qualification', async () => {
    expect(await ergo.verifyTransactionFee(reward, SigningStatus.Signed)).toBe(
      true,
    );
    expect(await ergo.verifyNoTokenBurned(reward, SigningStatus.Signed)).toBe(
      true,
    );
    await submit();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].data).toBe(JSON.stringify(signedHex));
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'reconciles already observed execution without any POST'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'reconciles already observed execution without any POST' through TransactionProcessor.processSignedTx.
   * @expected expect(transport).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('reconciles already observed execution without any POST', async () => {
    await observe();
    await submit();
    expect(transport).not.toHaveBeenCalled();
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'reconciles observed execution arriving while HTTP is pending'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'reconciles observed execution arriving while HTTP is pending' through TransactionProcessor.processSignedTx.
   * @expected expect(transport).toHaveBeenCalledTimes(1); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('reconciles observed execution arriving while HTTP is pending', async () => {
    transport.mockImplementation(async (config) => {
      await observe();
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: 'accepted',
      };
    });
    await submit();
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  const intercept = Axios as unknown as {
    interceptorForRequest(
      config: InternalAxiosRequestConfig,
    ): Promise<InternalAxiosRequestConfig>;
  };
  const beforeAdapter = (action: () => Promise<void>) => {
    const original = intercept.interceptorForRequest;
    vi.spyOn(intercept, 'interceptorForRequest').mockImplementation(
      async (config) => {
        const result = await original(config);
        await action();
        return result;
      },
    );
  };
  /**
   * @target TransactionProcessor.processSignedTx 'refuses %s drift after the actual rate-limit interceptor before POST'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'refuses %s drift after the actual rate-limit interceptor before POST' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(transport).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it.each(['hold', 'payment', 'fee', 'order', 'trigger', 'row', 'commitments'])(
    'refuses %s drift after the actual rate-limit interceptor before POST',
    async (fault) => {
      beforeAdapter(async () => {
        if (fault === 'hold') await hold();
        if (fault === 'payment')
          await db().TransactionRepository.update(
            { txId: payment.txId },
            { requiredSign: 9 },
          );
        if (fault === 'fee')
          vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
            changed: 1,
          } as never);
        if (fault === 'order')
          vi.mocked(EventOrder.eventRewardOrder).mockReturnValue({
            watchersOrder: [],
            guardsOrder: [],
          });
        if (fault === 'trigger')
          await db().EventRepository.update(
            { eventId },
            { serialized: 'YQ==' },
          );
        if (fault === 'row')
          await db().TransactionRepository.update(
            { txId: reward.txId },
            { requiredSign: 9 },
          );
        if (fault === 'commitments')
          await db().CommitmentRepository.update(
            { eventId },
            { rwtCount: '99' },
          );
      });
      await expect(submit()).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect((await row()).status).toBe(TransactionStatus.signed);
    },
  );
  /**
   * @target TransactionProcessor.processSignedTx 'releases scanner and SQL while the actual HTTP adapter response is pending'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'releases scanner and SQL while the actual HTTP adapter response is pending' through TransactionProcessor.processSignedTx.
   * @expected expect(await db().dataSource.query('SELECT 1 AS value')).toEqual([ { value: 1 }, ]); expect((await row()).status).toBe(TransactionStatus.signed); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('releases scanner and SQL while the actual HTTP adapter response is pending', async () => {
    let release!: () => void, entered!: () => void, authorized!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingHttp = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const authorizationReturned = new Promise<void>((resolve) => {
      authorized = resolve;
    });
    const original = ergo.submitAuthorizedTransaction;
    vi.spyOn(ergo, 'submitAuthorizedTransaction').mockImplementation(
      (tx, options) =>
        original(tx, {
          ...options!,
          authorizeSubmit: async (start) => {
            await options!.authorizeSubmit(start);
            authorized();
          },
        }),
    );
    transport.mockImplementation(async (config) => {
      entered();
      await gate;
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: 'accepted',
      };
    });
    const operation = submit();
    await pendingHttp;
    await authorizationReturned;
    try {
      await scanner.update();
      expect(await db().dataSource.query('SELECT 1 AS value')).toEqual([
        { value: 1 },
      ]);
      expect((await row()).status).toBe(TransactionStatus.signed);
    } finally {
      release();
    }
    await operation;
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'does not overwrite signed after %s changes during HTTP'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'does not overwrite signed after %s changes during HTTP' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(1); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it.each([
    'hold',
    'payment',
    'fee',
    'trigger',
    'row',
    'foreign-spend',
    'partial-spend',
  ])(
    'does not overwrite signed after %s changes during HTTP',
    async (fault) => {
      transport.mockImplementation(async (config) => {
        if (fault === 'hold') await hold();
        if (fault === 'payment')
          await db().TransactionRepository.update(
            { txId: payment.txId },
            { requiredSign: 9 },
          );
        if (fault === 'fee')
          vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
            changed: 1,
          } as never);
        if (fault === 'trigger')
          await db().EventRepository.update(
            { eventId },
            { serialized: 'YQ==' },
          );
        if (fault === 'row')
          await db().TransactionRepository.update(
            { txId: reward.txId },
            { requiredSign: 9 },
          );
        if (fault === 'foreign-spend') {
          await observe();
          await db().EventRepository.update(
            { eventId },
            { spendTxId: 'cc'.repeat(32) },
          );
        }
        if (fault === 'partial-spend')
          await db().EventRepository.update(
            { eventId },
            { spendHeight: 1000000 },
          );
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
          data: 'accepted',
        };
      });
      await expect(submit()).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
      expect((await row()).status).toBe(TransactionStatus.signed);
    },
  );
  /**
   * @target TransactionProcessor.processSignedTx 'rejects %s at explicit Signed accounting and input checks'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects %s at explicit Signed accounting and input checks' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(transport).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it.each(['fee', 'burn', 'extra', 'spent'])(
    'rejects %s at explicit Signed accounting and input checks',
    async (fault) => {
      if (fault === 'fee')
        vi.spyOn(ergo, 'verifyTransactionFee').mockResolvedValue(false);
      if (fault === 'burn')
        vi.spyOn(ergo, 'verifyNoTokenBurned').mockResolvedValue(false);
      if (fault === 'extra')
        vi.spyOn(ergo, 'verifyTransactionExtraConditions').mockReturnValue(
          false,
        );
      if (fault === 'spent')
        vi.mocked(ergo.isTxValid).mockResolvedValue({
          isValid: false,
          details: { reason: 'spent', unexpected: false },
        });
      await expect(submit()).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect((await row()).status).toBe(TransactionStatus.signed);
    },
  );
  /**
   * @target TransactionProcessor.processSignedTx 'rejects malformed stored Signed %s before transport'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects malformed stored Signed %s before transport' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
   */
  it.each([
    'bytes',
    'reduced',
    'input',
    'input-hole',
    'data',
    'data-hole',
    'network',
    'eventId',
    'type',
  ])('rejects malformed stored Signed %s before transport', async (fault) => {
    const model = JSON.parse(reward.toJson());
    if (fault === 'bytes') model.txBytes += '00';
    if (fault === 'reduced') model.txBytes = ergoFixture.payment.txBytes;
    if (fault === 'input') model.inputBoxes[0] += '00';
    if (fault === 'input-hole') delete model.inputBoxes[0];
    if (fault === 'data') model.dataInputs.push('00');
    if (fault === 'data-hole') {
      model.dataInputs.length = 1;
      delete model.dataInputs[0];
    }
    if (fault === 'network') model.network = 'ethereum';
    if (fault === 'eventId') model.eventId = 'wrong';
    if (fault === 'type') model.txType = 'payment';
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { txJson: JSON.stringify(model) },
    );
    await expect(submit()).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionProcessor.processSignedTx 'rejects contradictory observed %s without POST'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects contradictory observed %s without POST' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(transport).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it.each(['spendTxId', 'paymentTxId', 'spendBlock', 'spendHeight', 'result'])(
    'rejects contradictory observed %s without POST',
    async (field) => {
      await observe();
      await db().EventRepository.update(
        { eventId },
        { [field]: field === 'spendHeight' ? null : 'wrong' },
      );
      await expect(submit()).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect((await row()).status).toBe(TransactionStatus.signed);
    },
  );
  /**
   * @target TransactionProcessor.processSignedTx 'rolls back result %s after HTTP'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rolls back result %s after HTTP' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).toHaveBeenCalledTimes(1);
   */
  it.each(['ABORT', 'IGNORE', 'row', 'payment', 'event'])(
    'rolls back result %s after HTTP',
    async (fault) => {
      const sql =
        fault === 'ABORT' || fault === 'IGNORE'
          ? `CREATE TEMP TRIGGER submit_fault BEFORE UPDATE ON transaction_entity WHEN NEW.status='sent' BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'stop'" : ''}); END`
          : `CREATE TEMP TRIGGER submit_fault AFTER UPDATE ON transaction_entity WHEN NEW.status='sent' BEGIN ${fault === 'row' ? 'UPDATE transaction_entity SET signFailedCount=99 WHERE txId=NEW.txId;' : fault === 'payment' ? "UPDATE transaction_entity SET requiredSign=99 WHERE type='payment';" : "UPDATE confirmed_event_entity SET firstTry='changed';"} END`;
      await db().dataSource.query(sql);
      const before = await snapshot();
      try {
        await expect(submit()).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        expect(transport).toHaveBeenCalledTimes(1);
      } finally {
        await db().dataSource.query('DROP TRIGGER submit_fault');
      }
    },
  );
  /**
   * @target TransactionProcessor.processSignedTx 'allows different canonical observed proof bytes with exactly the same body and auxiliaries'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'allows different canonical observed proof bytes with exactly the same body and auxiliaries' through TransactionProcessor.processSignedTx.
   * @expected expect(different.id().to_str()).toBe(reward.txId); expect(transport).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('allows different canonical observed proof bytes with exactly the same body and auxiliaries', async () => {
    const reduced = wasm.ReducedTransaction.sigma_parse_bytes(
      Buffer.from(ergoFixture.payment.txBytes, 'hex'),
    );
    const different = wasm.Transaction.from_unsigned_tx(reduced.unsigned_tx(), [
      Buffer.from('ab', 'hex'),
    ]);
    expect(different.id().to_str()).toBe(reward.txId);
    signedHex = Buffer.from(different.sigma_serialize_bytes()).toString('hex');
    await observe();
    await submit();
    expect(transport).not.toHaveBeenCalled();
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionSigningContext.bind 'denies stale retained submit and repeated result actions'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'denies stale retained submit and repeated result actions' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(prepared.authorizeSubmit(start)).rejects.toThrow(); await expect(prepared.withResult(async () => undefined)).rejects.toThrow(); await expect(prepared.authorizeSubmit(start)).rejects.toThrow(); expect(start).toHaveBeenCalledTimes(1);
   */
  it('denies stale retained submit and repeated result actions', async () => {
    const bound = await context.bind(await row(), [TransactionStatus.signed]);
    const prepared = await bound.prepareRewardSubmission(1000);
    const start = vi.fn();
    await prepared.authorizeSubmit(start);
    await expect(prepared.authorizeSubmit(start)).rejects.toThrow();
    await prepared.withResult((expected, permit) =>
      db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, permit),
    );
    await expect(prepared.withResult(async () => undefined)).rejects.toThrow();
    prepared.close();
    await expect(prepared.authorizeSubmit(start)).rejects.toThrow();
    expect(start).toHaveBeenCalledTimes(1);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'rejects HTTP error without a status transition'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects HTTP error without a status transition' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(notify).not.toHaveBeenCalled();
   */
  it('rejects HTTP error without a status transition', async () => {
    transport.mockRejectedValue(new Error('HTTP failed'));
    const notify = vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    );
    const before = await snapshot();
    await expect(submit()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionProcessor.processSignedTx 'rejects selected timeout %s before POST'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects selected timeout %s before POST' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
   */
  it.each([0, -1, NaN, Infinity, 2147484, true, '2'])(
    'rejects selected timeout %s before POST',
    async (value) => {
      GuardsErgoConfigs.node.timeout = value as number;
      GuardsErgoConfigs.explorer.timeout = value as number;
      await expect(submit()).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'expires an unused prepared closure without starting transport'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'expires an unused prepared closure without starting transport' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(prepared.authorizeSubmit(start)).rejects.toThrow('expired'); expect(start).not.toHaveBeenCalled();
   */
  it('expires an unused prepared closure without starting transport', async () => {
    const bound = await context.bind(await row(), [TransactionStatus.signed]);
    const prepared = await bound.prepareRewardSubmission(100);
    await new Promise((resolve) => setTimeout(resolve, 110));
    const start = vi.fn();
    await expect(prepared.authorizeSubmit(start)).rejects.toThrow('expired');
    expect(start).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionProcessor.processSignedTx 'bounds the pending response and leaves signed unchanged on timeout'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'bounds the pending response and leaves signed unchanged on timeout' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).toHaveBeenCalledTimes(1);
   */
  it('bounds the pending response and leaves signed unchanged on timeout', async () => {
    GuardsErgoConfigs.node.timeout = 0.1;
    GuardsErgoConfigs.explorer.timeout = 0.1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.mockImplementation(async (config) => {
      await gate;
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: 'accepted',
      };
    });
    const before = await snapshot();
    try {
      await expect(submit()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });
  /**
   * @target TransactionSigningContext.bind 'rejects expiry while queued for SQL ownership before starting transport'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects expiry while queued for SQL ownership before starting transport' with the suite's captured inputs and invoke the bind path.
   * @expected expect(await operation).toBeInstanceOf(Error); expect(start).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
   */
  it('rejects expiry while queued for SQL ownership before starting transport', async () => {
    const bound = await context.bind(await row(), [TransactionStatus.signed]);
    const prepared = await bound.prepareRewardSubmission(1000);
    const before = await snapshot();
    let acquired!: () => void, queued!: () => void, release!: () => void;
    const owned = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let owner: Promise<void> | undefined;
    confirmation.mockImplementationOnce(async () => {
      owner = db().dataSource.transaction(async () => {
        acquired();
        await gate;
      });
      await owned;
      const create = db().dataSource.createQueryRunner.bind(db().dataSource);
      vi.spyOn(db().dataSource, 'createQueryRunner').mockImplementationOnce(
        () => {
          const runner = create();
          const start = runner.startTransaction.bind(runner);
          vi.spyOn(runner, 'startTransaction').mockImplementation(async () => {
            queued();
            await start();
          });
          return runner;
        },
      );
      return ConfirmationStatus.ConfirmedEnough;
    });
    const start = vi.fn();
    const operation = prepared.authorizeSubmit(start).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waiting;
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1001);
      release();
      await owner;
      expect(await operation).toBeInstanceOf(Error);
      expect(start).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    } finally {
      release();
      await owner;
      prepared.close();
    }
  });
  /**
   * @target TransactionProcessor.processSignedTx 'rechecks %s after waiting for SQL ownership before POST'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rechecks %s after waiting for SQL ownership before POST' through TransactionProcessor.processSignedTx.
   * @expected expect(await operation).toBeInstanceOf(Error); expect(transport).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it.each(['payment', 'fee'])(
    'rechecks %s after waiting for SQL ownership before POST',
    async (fault) => {
      let entered!: () => void, release!: () => void;
      const acquired = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let owner: Promise<void> | undefined;
      confirmation.mockImplementationOnce(async () => {
        owner = db().dataSource.transaction(async (manager) => {
          if (fault === 'payment')
            await manager
              .getRepository(TransactionEntity)
              .update({ txId: payment.txId }, { requiredSign: 9 });
          entered();
          await gate;
        });
        await acquired;
        return ConfirmationStatus.ConfirmedEnough;
      });
      const operation = submit().then(
        () => undefined,
        (error: unknown) => error,
      );
      await acquired;
      if (fault === 'fee')
        vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
          changed: 1,
        } as never);
      release();
      await owner;
      expect(await operation).toBeInstanceOf(Error);
      expect(transport).not.toHaveBeenCalled();
      expect((await row()).status).toBe(TransactionStatus.signed);
    },
  );
  /**
   * @target TransactionProcessor.processSentTx 'qualifies sent resubmission using the same final adapter boundary'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'qualifies sent resubmission using the same final adapter boundary' through TransactionProcessor.processSentTx.
   * @expected expect(transport).toHaveBeenCalledTimes(1); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('qualifies sent resubmission using the same final adapter boundary', async () => {
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { status: TransactionStatus.sent },
    );
    rewardConfirmation.mockResolvedValue(ConfirmationStatus.NotFound);
    await TransactionProcessor.processSentTx(await row());
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionProcessor.processSentTx 'never sends an observed sent reward even if an earlier RPC said absent'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'never sends an observed sent reward even if an earlier RPC said absent' through TransactionProcessor.processSentTx.
   * @expected expect(transport).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('never sends an observed sent reward even if an earlier RPC said absent', async () => {
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { status: TransactionStatus.sent },
    );
    await observe();
    rewardConfirmation.mockResolvedValueOnce(ConfirmationStatus.NotFound);
    await TransactionProcessor.processSentTx(await row());
    expect(transport).not.toHaveBeenCalled();
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'defers observed %s without POST or status overwrite'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'defers observed %s without POST or status overwrite' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled();
   */
  it.each(['missing', 'held', 'not-confirmed', 'suffix', 'body'])(
    'defers observed %s without POST or status overwrite',
    async (fault) => {
      await observe();
      if (fault === 'missing')
        vi.mocked(ergo.getTransaction).mockRejectedValue(new Error('pruned'));
      if (fault === 'held') await hold();
      if (fault === 'not-confirmed')
        rewardConfirmation.mockResolvedValue(
          ConfirmationStatus.NotConfirmedEnough,
        );
      if (fault === 'suffix') signedHex += '00';
      if (fault === 'body') {
        const body = JSON.parse(
          wasm.ReducedTransaction.sigma_parse_bytes(
            Buffer.from(ergoFixture.payment.txBytes, 'hex'),
          )
            .unsigned_tx()
            .to_json(),
        );
        body.outputs[0].value = String(BigInt(body.outputs[0].value) + 1n);
        signedHex = Buffer.from(
          wasm.Transaction.from_unsigned_tx(
            wasm.UnsignedTransaction.from_json(JSON.stringify(body)),
            [new Uint8Array()],
          ).sigma_serialize_bytes(),
        ).toString('hex');
      }
      const before = await snapshot();
      await expect(submit()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(transport).not.toHaveBeenCalled();
    },
  );
  const multipleInputs = async () => {
    const previous = reward.txId;
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
    const trigger = wasm.ErgoBox.sigma_parse_bytes(reward.inputBoxes[1]);
    await db().EventRepository.update(
      { eventId },
      {
        identifier: trigger.box_id().to_str(),
        serialized: Buffer.from(reward.inputBoxes[1]).toString('base64'),
      },
    );
    const event = (await db().getEventById(eventId))!;
    const wid = 'bb'.repeat(32);
    await DatabaseActionMock.insertCommitmentBoxRecord(
      EventSerializer.fromConfirmedEntity(event),
      eventId,
      Buffer.from(reward.inputBoxes[3]).toString('base64'),
      wid,
      event.eventData.height - 1,
      '10',
    );
    await db().CommitmentRepository.update(
      { eventId, WID: wid },
      {
        identifier: wasm.ErgoBox.sigma_parse_bytes(reward.inputBoxes[3])
          .box_id()
          .to_str(),
      },
    );
    vi.spyOn(ergo, 'getRWTToken').mockReturnValue(
      trigger.tokens().get(0).id().to_str(),
    );
    vi.spyOn(ergo, 'getBoxRWT').mockReturnValue(10n);
    vi.spyOn(ergo, 'getBoxWID').mockReturnValue(wid);
    vi.mocked(EventOrder.eventRewardOrder).mockReturnValue({
      watchersOrder: ergo.extractTransactionOrder(reward, SigningStatus.Signed),
      guardsOrder: [],
    });
    await db().TransactionRepository.delete({ txId: previous });
    await DatabaseActionMock.insertTxRecord(
      reward,
      TransactionStatus.signed,
      123,
      'updated',
      false,
      0,
      3,
    );
    return wid;
  };
  /**
   * @target TransactionProcessor.processSignedTx 'submits with an exact unspent additional commitment input'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'submits with an exact unspent additional commitment input' through TransactionProcessor.processSignedTx.
   * @expected expect(transport).toHaveBeenCalledTimes(1); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it('submits with an exact unspent additional commitment input', async () => {
    await multipleInputs();
    await submit();
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row()).status).toBe(TransactionStatus.sent);
  });
  /**
   * @target TransactionSigningContext.bind 'refuses observed evidence regression: %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'refuses observed evidence regression: %s' with the suite's captured inputs and invoke the bind path.
   * @expected expect(prepared.kind).toBe('observed'); await expect( prepared.withResult((expected, permit) => db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, permit), ), ).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(await db().CommitmentRepository.findBy({ eventId })).toEqual( commitments, ); expect(transport).not.toHaveBeenCalled();
   */
  it.each([
    'trigger-only',
    'additional-trigger',
    'additional-commitment',
    'additional-both',
  ])('refuses observed evidence regression: %s', async (fault) => {
    const wid = fault === 'trigger-only' ? undefined : await multipleInputs();
    await observe();
    if (wid)
      await db().CommitmentRepository.update(
        { eventId, WID: wid },
        {
          spendTxId: reward.txId,
          spendIndex: 3,
          spendHeight: 1000000,
          spendBlock: blockId,
        },
      );
    const bound = await context.bind(await row(), [TransactionStatus.signed]);
    const prepared = await bound.prepareRewardSubmission(1000);
    expect(prepared.kind).toBe('observed');
    if (fault !== 'additional-commitment')
      await db().EventRepository.update(
        { eventId },
        {
          result: null,
          spendTxId: null,
          paymentTxId: null,
          spendHeight: null,
          spendBlock: null,
        },
      );
    if (wid && fault !== 'additional-trigger')
      await db().CommitmentRepository.update(
        { eventId, WID: wid },
        {
          spendTxId: null,
          spendIndex: null,
          spendHeight: null,
          spendBlock: null,
        },
      );
    vi.mocked(ergo.getTxConfirmationStatus).mockResolvedValue(
      ConfirmationStatus.NotFound,
    );
    const before = await snapshot();
    const commitments = await db().CommitmentRepository.findBy({ eventId });
    try {
      await expect(
        prepared.withResult((expected, permit) =>
          db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, permit),
        ),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await db().CommitmentRepository.findBy({ eventId })).toEqual(
        commitments,
      );
      expect(transport).not.toHaveBeenCalled();
    } finally {
      prepared.close();
    }
  });
  /**
   * @target TransactionProcessor.processSignedTx 'reconciles exact trigger and additional commitment own-spends during HTTP'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'reconciles exact trigger and additional commitment own-spends during HTTP' through TransactionProcessor.processSignedTx.
   * @expected expect((await row()).status).toBe(TransactionStatus.sent); expect(transport).toHaveBeenCalledTimes(1);
   */
  it('reconciles exact trigger and additional commitment own-spends during HTTP', async () => {
    const wid = await multipleInputs();
    transport.mockImplementation(async (config) => {
      await observe();
      await db().CommitmentRepository.update(
        { eventId, WID: wid },
        {
          spendTxId: reward.txId,
          spendIndex: 3,
          spendHeight: 1000000,
          spendBlock: blockId,
        },
      );
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: 'accepted',
      };
    });
    await submit();
    expect((await row()).status).toBe(TransactionStatus.sent);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'refuses additional commitment %s during HTTP'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'refuses additional commitment %s during HTTP' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(1); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it.each(['foreign', 'partial', 'wrong-index', 'bytes', 'wid', 'rwt'])(
    'refuses additional commitment %s during HTTP',
    async (fault) => {
      const wid = await multipleInputs();
      transport.mockImplementation(async (config) => {
        await observe();
        await db().CommitmentRepository.update(
          { eventId, WID: wid },
          {
            spendTxId: reward.txId,
            spendIndex: 3,
            spendHeight: 1000000,
            spendBlock: blockId,
          },
        );
        await db().CommitmentRepository.update(
          { eventId, WID: wid },
          fault === 'foreign'
            ? { spendTxId: 'ff'.repeat(32) }
            : fault === 'partial'
              ? { spendHeight: null }
              : fault === 'wrong-index'
                ? { spendIndex: 0 }
                : fault === 'bytes'
                  ? { serialized: 'YQ==' }
                  : fault === 'wid'
                    ? { WID: 'cc'.repeat(32) }
                    : { rwtCount: '11' },
        );
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
          data: 'accepted',
        };
      });
      await expect(submit()).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
      expect((await row()).status).toBe(TransactionStatus.signed);
    },
  );
  /**
   * @target TransactionProcessor.processSignedTx 'uses only the selected Explorer timeout and actual EIP-12 adapter'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'uses only the selected Explorer timeout and actual EIP-12 adapter' through TransactionProcessor.processSignedTx.
   * @expected expect(transport.mock.calls[0][0].url).toBe('/api/v0/transactions/send'); expect(transport.mock.calls[0][0].timeout).toBe(2000); expect(JSON.parse(transport.mock.calls[0][0].data)).toEqual( wasm.Transaction.sigma_parse_bytes(reward.txBytes).to_js_eip12(), );
   */
  it('uses only the selected Explorer timeout and actual EIP-12 adapter', async () => {
    GuardsErgoConfigs.chainNetworkName = 'explorer';
    GuardsErgoConfigs.node.timeout = NaN;
    Object.assign(ergo, {
      network: new ErgoExplorerNetwork({
        explorerBaseUrl: 'http://127.0.0.1:1',
      }),
    });
    await submit();
    expect(transport.mock.calls[0][0].url).toBe('/api/v0/transactions/send');
    expect(transport.mock.calls[0][0].timeout).toBe(2000);
    expect(JSON.parse(transport.mock.calls[0][0].data)).toEqual(
      wasm.Transaction.sigma_parse_bytes(reward.txBytes).to_js_eip12(),
    );
  });
  /**
   * @target TransactionProcessor.processSignedTx 'qualifies Avalanche source observation, mismatched=%s'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'qualifies Avalanche source observation, mismatched=%s' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(transport).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1); expect((await row()).status).toBe(TransactionStatus.sent);
   */
  it.each([false, true])(
    'qualifies Avalanche source observation, mismatched=%s',
    async (mismatch) => {
      const target = authorization['dependencies'].getChain('avalanche');
      Object.assign(target, { getRWTToken: () => ergo.getRWTToken() });
      await db().EventRepository.update(
        { eventId },
        {
          fromChain: 'avalanche',
          toChain: 'ethereum',
          ...(mismatch ? { sourceBlockId: hash(99) } : {}),
        },
      );
      payment.network = 'ethereum';
      await db().TransactionRepository.update(
        { txId: payment.txId },
        { chain: 'ethereum', txJson: payment.toJson() },
      );
      if (mismatch) {
        await expect(submit()).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
      } else {
        await submit();
        expect(transport).toHaveBeenCalledTimes(1);
        expect((await row()).status).toBe(TransactionStatus.sent);
      }
    },
  );
  /**
   * @target TransactionProcessor.processSignedTx 'rejects a missing explicit chain capability without calling the legacy API'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects a missing explicit chain capability without calling the legacy API' through TransactionProcessor.processSignedTx.
   * @expected await expect(submit()).rejects.toThrow(); expect(legacy).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled(); expect((await row()).status).toBe(TransactionStatus.signed);
   */
  it('rejects a missing explicit chain capability without calling the legacy API', async () => {
    const legacy = vi.spyOn(ergo, 'submitTransaction');
    Object.defineProperty(ergo, 'submitAuthorizedTransaction', {
      value: undefined,
      configurable: true,
    });
    await expect(submit()).rejects.toThrow();
    expect(legacy).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect((await row()).status).toBe(TransactionStatus.signed);
  });
  /**
   * @target TransactionProcessor.processSignedTx 'does not delegate authorized dispatch through an overridable legacy API'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'does not delegate authorized dispatch through an overridable legacy API' through TransactionProcessor.processSignedTx.
   * @expected expect(legacy).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
   */
  it('does not delegate authorized dispatch through an overridable legacy API', async () => {
    const legacy = vi
      .spyOn(ergo, 'submitTransaction')
      .mockRejectedValue(new Error('legacy must not run'));
    await submit();
    expect(legacy).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  /**
   * @target TransactionSigningContext.bind 'does not reuse a revocable signing attempt as submission authority'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not reuse a revocable signing attempt as submission authority' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(attempt.prepareRewardSubmission(1000)).rejects.toThrow( 'Signing attempts', ); expect(transport).not.toHaveBeenCalled();
   */
  it('does not reuse a revocable signing attempt as submission authority', async () => {
    const bound = await context.bind(await row(), [TransactionStatus.signed]);
    const attempt = context.beginAttempt(bound, 1000, () => true);
    await expect(attempt.prepareRewardSubmission(1000)).rejects.toThrow(
      'Signing attempts',
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
