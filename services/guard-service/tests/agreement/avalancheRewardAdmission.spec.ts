import { blake2b } from 'blakejs';
import { SigningKey, Transaction } from 'ethers';
import { setTimeout as delay } from 'node:timers/promises';

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
import {
  AbstractChain,
  ConfirmationStatus,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import { AvalancheRewardAdmission } from '../../src/agreement/avalancheRewardAdmission';
import TxAgreement from '../../src/agreement/txAgreement';
import EventOrder from '../../src/event/eventOrder';
import EventProcessor from '../../src/event/eventProcessor';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import GuardPkHandler from '../../src/handlers/guardPkHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { TransactionSigningContext } from '../../src/signing/transactionSigningContext';
import { TssAuthorizationRegistry } from '../../src/signing/tssAuthorizationRegistry';
import * as TransactionSerializer from '../../src/transaction/transactionSerializer';
import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import GuardTurn from '../../src/utils/guardTurn';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import TransactionVerifier from '../../src/verification/transactionVerifier';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';
import TestConfigs from '../testUtils/testConfigs';
import TestTxAgreement from './testTxAgreement';

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
describe('Avalanche reward agreement authority', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let scannerDb: DataSource;
  let network: AvalancheRpcNetwork;
  let scanner: AvalancheRpcScanner;
  let payment: PaymentTransaction;
  let reward: ErgoTransaction;
  let eventId: string;
  let agreement: TestTxAgreement;
  const confirmation = vi.fn();
  const transport = vi.fn();
  const assertAuthority = vi.fn();
  const bind = () => AvalancheRewardAdmission.bind(reward, 3, assertAuthority);
  const admit = async () => (await bind())!;
  const hold = () =>
    scannerDb
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'test hold' });
  const start = async () => {
    agreement.addTransactionToQueue(reward);
    await agreement.processAgreementQueue();
  };
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
      EventStatus.pendingReward,
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
    transport.mockReset().mockResolvedValue(undefined);
    assertAuthority.mockReset();
    const target = {
      getActualTxId: vi.fn().mockResolvedValue(signed.hash),
      getTxConfirmationStatus: confirmation,
      verifyPaymentTransaction: vi.fn().mockResolvedValue(true),
      verifyTransactionExtraConditions: vi.fn().mockReturnValue(true),
      getHeight: vi.fn().mockResolvedValue(100),
      extractTransactionOrder: vi.fn().mockReturnValue([]),
    } as unknown as AbstractChain<unknown>;
    const context = new TransactionSigningContext({
      safety: new AvalancheTransactionSafety(
        (id) => db().getEventById(id),
        () => scanner,
      ),
      getTx: (id) => db().getTxById(id),
      decode: (json) => {
        const m = JSON.parse(json);
        return new PaymentTransaction(
          m.network,
          m.txId,
          m.eventId,
          Buffer.from(m.txBytes, 'hex'),
          m.txType,
        );
      },
      registry: new TssAuthorizationRegistry(1000, 4),
    });
    const authorization = new RewardAuthorization({
      context,
      getDatabase: db,
      getChain: () => target,
    });
    vi.spyOn(RewardAuthorization, 'getInstance').mockReturnValue(authorization);
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getErgoChain: () => target,
      getChain: () => target,
    } as never);
    const guards = {
      publicKeys: [...TestConfigs.guardPublicKeys],
      requiredSign: 3,
      guardsLen: 5,
      guardId: TestConfigs.guardIndex,
    };
    vi.spyOn(GuardPkHandler, 'getInstance').mockReturnValue(guards as never);
    vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue(
      {} as never,
    );
    vi.spyOn(EventOrder, 'createEventRewardOrder').mockResolvedValue([]);
    vi.spyOn(TransactionVerifier, 'verifyTxCommonConditions').mockResolvedValue(
      true,
    );
    vi.spyOn(TxAgreement, 'sendMessageWrapper').mockImplementation(transport);
    agreement = new TestTxAgreement();
    vi.spyOn(agreement.getSigner(), 'getPk').mockResolvedValue(
      TestConfigs.guardPublicKeys[TestConfigs.guardIndex],
    );
    vi.spyOn(agreement.getSigner(), 'sign').mockResolvedValue(
      'fixture-signature',
    );
    vi.spyOn(agreement.getSigner(), 'verify').mockResolvedValue(true);
    vi.spyOn(GuardTurn, 'guardTurn').mockReturnValue(TestConfigs.guardIndex);
  });
  afterEach(async () => {
    network['provider'].destroy();
    await scannerDb.destroy();
    vi.restoreAllMocks();
  });

  /**
   * @target AvalancheRewardAdmission.persist 'atomically inserts approved reward and advances the event'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'atomically inserts approved reward and advances the event' through AvalancheRewardAdmission.persist.
   * @expected expect((await db().getTxById(reward.txId))?.status).toBe( TransactionStatus.approved, ); expect((await db().getEventById(eventId))?.status).toBe( EventStatus.inReward, );
   */
  it('atomically inserts approved reward and advances the event', async () => {
    const bound = await admit();
    await bound.persist(() => undefined);
    expect((await db().getTxById(reward.txId))?.status).toBe(
      TransactionStatus.approved,
    );
    expect((await db().getEventById(eventId))?.status).toBe(
      EventStatus.inReward,
    );
    await bound.withAction(() => undefined);
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'qualifies real request dispatch after message signing and then records its candidate'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'qualifies real request dispatch after message signing and then records its candidate' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(transport).toHaveBeenCalledOnce(); expect(agreement.getTransactions().size).toBe(1);
   */
  it('qualifies real request dispatch after message signing and then records its candidate', async () => {
    await start();
    expect(transport).toHaveBeenCalledOnce();
    expect(agreement.getTransactions().size).toBe(1);
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'rejects a hold acquired during %s message signing'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects a hold acquired during %s message signing' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(transport).not.toHaveBeenCalled(); expect(agreement.getTransactions().size).toBe(0); expect(await db().getTxById(reward.txId)).toBeNull();
   */
  it.each(['request', 'response', 'approval'])(
    'rejects a hold acquired during %s message signing',
    async (kind) => {
      vi.mocked(agreement.getSigner().sign).mockImplementation(async () => {
        await hold();
        return 'signature';
      });
      if (kind === 'request') await start();
      else if (kind === 'response')
        await agreement.processMessage(
          'request',
          { txJson: reward.toJson() },
          '',
          TestConfigs.guardIndex,
          'peer',
          100,
        );
      else {
        agreement.insertApprovedTransactions({
          tx: reward,
          signatures: ['a', 'b', 'c', '', ''],
          timestamp: 100,
        });
        await agreement.resendApprovalMessages();
      }
      expect(transport).not.toHaveBeenCalled();
      expect(agreement.getTransactions().size).toBe(0);
      expect(await db().getTxById(reward.txId)).toBeNull();
    },
  );
  /**
   * @target TxAgreement.addTransactionToQueue 'two votes followed by lost settlement cannot persist or advance the third vote'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'two votes followed by lost settlement cannot persist or advance the third vote' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(agreement.getTransactionApprovals().get(hash)).toEqual(before); expect(await db().getTxById(reward.txId)).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
   */
  it('two votes followed by lost settlement cannot persist or advance the third vote', async () => {
    await start();
    const hash = TransactionSerializer.getTxDataHash(reward);
    const timestamp = agreement.getTransactions().get(hash)!.timestamp;
    await agreement.processMessage(
      'response',
      { txDataHash: hash },
      'vote0',
      0,
      'peer',
      timestamp,
    );
    const before = [...agreement.getTransactionApprovals().get(hash)!];
    confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
    await agreement.processMessage(
      'response',
      { txDataHash: hash },
      'vote2',
      2,
      'peer',
      timestamp,
    );
    expect(agreement.getTransactionApprovals().get(hash)).toEqual(before);
    expect(await db().getTxById(reward.txId)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'fresh quorum persists then resends only the exact inReward row'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'fresh quorum persists then resends only the exact inReward row' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect((await db().getTxById(reward.txId))?.status).toBe( TransactionStatus.approved, ); expect(agreement.getTransactions().size).toBe(0); expect(agreement.getApprovedTransactions()).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(3); expect(transport).toHaveBeenCalledTimes(3);
   */
  it('fresh quorum persists then resends only the exact inReward row', async () => {
    await start();
    const hash = TransactionSerializer.getTxDataHash(reward);
    const timestamp = agreement.getTransactions().get(hash)!.timestamp;
    for (const index of [0, 2])
      await agreement.processMessage(
        'response',
        { txDataHash: hash },
        'vote',
        index,
        'peer',
        timestamp,
      );
    expect((await db().getTxById(reward.txId))?.status).toBe(
      TransactionStatus.approved,
    );
    expect(agreement.getTransactions().size).toBe(0);
    expect(agreement.getApprovedTransactions()).toHaveLength(1);
    await agreement.resendApprovalMessages();
    expect(transport).toHaveBeenCalledTimes(3);
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { txJson: reward.toJson() + ' ' },
    );
    await agreement.resendApprovalMessages();
    expect(transport).toHaveBeenCalledTimes(3);
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'cached candidate approval rechecks settlement instead of trusting its earlier verification'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'cached candidate approval rechecks settlement instead of trusting its earlier verification' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(await db().getTxById(reward.txId)).toBeNull(); expect(agreement.getTransactions().size).toBe(1);
   */
  it('cached candidate approval rechecks settlement instead of trusting its earlier verification', async () => {
    await start();
    const hash = TransactionSerializer.getTxDataHash(reward);
    const timestamp = agreement.getTransactions().get(hash)!.timestamp;
    await hold();
    await agreement.processMessage(
      'approval',
      { txJson: reward.toJson(), signatures: ['a', 'b', 'c', '', ''] },
      '',
      0,
      'peer',
      timestamp,
    );
    expect(await db().getTxById(reward.txId)).toBeNull();
    expect(agreement.getTransactions().size).toBe(1);
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'rejects changed %s during message signing'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects changed %s during message signing' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(transport).not.toHaveBeenCalled(); expect(agreement.getTransactions().size).toBe(0);
   */
  it.each(['requiredSign', 'guardId', 'guardsLen', 'publicKeys'] as const)(
    'rejects changed %s during message signing',
    async (field) => {
      const guards = GuardPkHandler.getInstance();
      const before = guards[field];
      vi.mocked(agreement.getSigner().sign).mockImplementation(async () => {
        Object.assign(guards, {
          [field]:
            field === 'publicKeys'
              ? [...guards.publicKeys].reverse()
              : Number(before) + 1,
        });
        return 'signature';
      });
      try {
        await start();
        expect(transport).not.toHaveBeenCalled();
        expect(agreement.getTransactions().size).toBe(0);
      } finally {
        Object.assign(guards, { [field]: before });
      }
    },
  );
  /**
   * @target AvalancheRewardAdmission.bind 'rejects original %s mutation after binding'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects original %s mutation after binding' through AvalancheRewardAdmission.bind.
   * @expected await expect(bound.withAction(() => undefined)).rejects.toThrow();
   */
  it.each([
    'network',
    'txId',
    'eventId',
    'txType',
    'txBytes',
    'inputBoxes',
    'dataInputs',
  ])('rejects original %s mutation after binding', async (field) => {
    const bound = await admit();
    Object.assign(reward, {
      [field]:
        field.endsWith('Boxes') || field === 'dataInputs'
          ? [Buffer.from('ff', 'hex')]
          : field === 'txBytes'
            ? Buffer.from('ff', 'hex')
            : 'changed',
    });
    await expect(bound.withAction(() => undefined)).rejects.toThrow();
  });
  /**
   * @target AvalancheRewardAdmission.persist 'does not resurrect or reset existing %s reward'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'does not resurrect or reset existing %s reward' through AvalancheRewardAdmission.persist.
   * @expected await expect(bound.persist(() => undefined)).rejects.toThrow(); expect((await db().getTxById(reward.txId))?.status).toBe(status);
   */
  it.each([
    TransactionStatus.invalid,
    TransactionStatus.inSign,
    TransactionStatus.signed,
    TransactionStatus.sent,
    TransactionStatus.completed,
  ])('does not resurrect or reset existing %s reward', async (status) => {
    const bound = await admit();
    await bound.persist(() => undefined);
    await db().TransactionRepository.update({ txId: reward.txId }, { status });
    await expect(bound.persist(() => undefined)).rejects.toThrow();
    expect((await db().getTxById(reward.txId))?.status).toBe(status);
  });
  /**
   * @target AvalancheRewardAdmission.persist 'retries exact signFailed row without changing its identity or counters'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'retries exact signFailed row without changing its identity or counters' through AvalancheRewardAdmission.persist.
   * @expected expect(await db().getTxById(reward.txId)).toMatchObject({ failedInSign: false, signFailedCount: 2, status: TransactionStatus.signFailed, });
   */
  it('retries exact signFailed row without changing its identity or counters', async () => {
    const bound = await admit();
    await bound.persist(() => undefined);
    await db().TransactionRepository.update(
      { txId: reward.txId },
      {
        status: TransactionStatus.signFailed,
        failedInSign: true,
        signFailedCount: 2,
      },
    );
    await bound.persist(() => undefined);
    expect(await db().getTxById(reward.txId)).toMatchObject({
      failedInSign: false,
      signFailedCount: 2,
      status: TransactionStatus.signFailed,
    });
  });
  /**
   * @target AvalancheRewardAdmission.persist 'rolls back reward insertion when event CAS trigger raises %s'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rolls back reward insertion when event CAS trigger raises %s' through AvalancheRewardAdmission.persist.
   * @expected await expect(bound.persist(() => undefined)).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toBeNull(); expect((await db().getEventById(eventId))?.status).toBe( EventStatus.pendingReward, ); expect(notify).not.toHaveBeenCalled();
   */
  it.each(['ABORT', 'IGNORE'])(
    'rolls back reward insertion when event CAS trigger raises %s',
    async (mode) => {
      const bound = await admit();
      const notify = vi.spyOn(
        PublicStatusHandler.getInstance(),
        'updatePublicTxStatus',
      );
      await db().dataSource.query(
        `CREATE TRIGGER reject_reward BEFORE UPDATE ON confirmed_event_entity BEGIN SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'test abort'" : ''}); END`,
      );
      try {
        await expect(bound.persist(() => undefined)).rejects.toThrow();
        expect(await db().getTxById(reward.txId)).toBeNull();
        expect((await db().getEventById(eventId))?.status).toBe(
          EventStatus.pendingReward,
        );
        expect(notify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER reject_reward');
      }
    },
  );
  /**
   * @target AvalancheRewardAdmission.persist 'ignoring the insert cannot leave only the event transition'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'ignoring the insert cannot leave only the event transition' through AvalancheRewardAdmission.persist.
   * @expected await expect(bound.persist(() => undefined)).rejects.toThrow(); expect((await db().getEventById(eventId))?.status).toBe( EventStatus.pendingReward, );
   */
  it('ignoring the insert cannot leave only the event transition', async () => {
    const bound = await admit();
    await db().dataSource.query(
      'CREATE TRIGGER reject_reward BEFORE INSERT ON transaction_entity BEGIN SELECT RAISE(IGNORE); END',
    );
    try {
      await expect(bound.persist(() => undefined)).rejects.toThrow();
      expect((await db().getEventById(eventId))?.status).toBe(
        EventStatus.pendingReward,
      );
    } finally {
      await db().dataSource.query('DROP TRIGGER reject_reward');
    }
  });
  /**
   * @target AvalancheRewardAdmission.persist 'observes changed authority committed by the preceding SQL owner'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'observes changed authority committed by the preceding SQL owner' through AvalancheRewardAdmission.persist.
   * @expected expect(await rejected).toBeInstanceOf(Error); expect(await db().getTxById(reward.txId)).toBeNull();
   */
  it('observes changed authority committed by the preceding SQL owner', async () => {
    const bound = await admit();
    const runner = db().dataSource.createQueryRunner();
    await runner.startTransaction();
    const pending = bound.persist(() => undefined);
    const rejected = pending.then(
      () => undefined,
      (error) => error,
    );
    await delay(15);
    await runner.manager
      .getRepository(db().ConfirmedEventRepository.target)
      .update({ id: eventId }, { unexpectedFails: 9 });
    await runner.commitTransaction();
    await runner.release();
    expect(await rejected).toBeInstanceOf(Error);
    expect(await db().getTxById(reward.txId)).toBeNull();
  });
  /**
   * @target AvalancheRewardAdmission.bind 'retains an R1 Avalanche route if its event is edited before agreement binding'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'retains an R1 Avalanche route if its event is edited before agreement binding' through AvalancheRewardAdmission.bind.
   * @expected await expect(bind()).rejects.toThrow('Known Avalanche');
   */
  it('retains an R1 Avalanche route if its event is edited before agreement binding', async () => {
    const event = (await db().getEventById(eventId))!;
    await RewardAuthorization.getInstance().bind(
      EventSerializer.fromConfirmedEntity(event),
      event.eventData.txId,
    );
    await db().EventRepository.update({ eventId }, { toChain: 'ethereum' });
    await expect(bind()).rejects.toThrow('Known Avalanche');
  });
  /**
   * @target AvalancheRewardAdmission.bind 'rejects replacing the completed payment even when its new settlement verifies'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects replacing the completed payment even when its new settlement verifies' through AvalancheRewardAdmission.bind.
   * @expected await expect(bound.withAction(() => undefined)).rejects.toThrow();
   */
  it('rejects replacing the completed payment even when its new settlement verifies', async () => {
    const bound = await admit();
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { requiredSign: 4 },
    );
    await expect(bound.withAction(() => undefined)).rejects.toThrow();
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'rejects changed %s while quorum message signing waits'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects changed %s while quorum message signing waits' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(transport).toHaveBeenCalledTimes(1); expect(await db().getTxById(reward.txId)).toBeNull();
   */
  it.each(['serialized', 'firstTry', 'fee', 'WID'])(
    'rejects changed %s while quorum message signing waits',
    async (field) => {
      await start();
      const hash = TransactionSerializer.getTxDataHash(reward);
      const timestamp = agreement.getTransactions().get(hash)!.timestamp;
      await agreement.processMessage(
        'response',
        { txDataHash: hash },
        'vote',
        0,
        'peer',
        timestamp,
      );
      vi.mocked(agreement.getSigner().sign).mockImplementation(async () => {
        if (field === 'serialized')
          await db().EventRepository.update(
            { eventId },
            { serialized: 'changed' },
          );
        if (field === 'firstTry')
          await db().ConfirmedEventRepository.update(
            { id: eventId },
            { firstTry: 'changed' },
          );
        if (field === 'fee')
          vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
            networkFee: 9n,
          } as never);
        if (field === 'WID')
          await db().CommitmentRepository.update(
            { eventId },
            { WID: 'bb'.repeat(32) },
          );
        return 'signature';
      });
      await agreement.processMessage(
        'response',
        { txDataHash: hash },
        'vote',
        2,
        'peer',
        timestamp,
      );
      expect(transport).toHaveBeenCalledTimes(1);
      expect(await db().getTxById(reward.txId)).toBeNull();
    },
  );
  /**
   * @target TxAgreement.addTransactionToQueue 'denies stale %s during quorum envelope signing'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'denies stale %s during quorum envelope signing' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(await db().getTxById(reward.txId)).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
   */
  it.each(['timestamp', 'replacement', 'copyAux', 'approvals', 'clear'])(
    'denies stale %s during quorum envelope signing',
    async (fault) => {
      await start();
      const hash = TransactionSerializer.getTxDataHash(reward);
      const candidate = agreement.getTransactions().get(hash)!;
      const timestamp = candidate.timestamp;
      await agreement.processMessage(
        'response',
        { txDataHash: hash },
        'vote',
        0,
        'peer',
        timestamp,
      );
      vi.mocked(agreement.getSigner().sign).mockImplementation(async () => {
        if (fault === 'timestamp') candidate.timestamp++;
        if (fault === 'replacement')
          agreement.insertTransactions(hash, { ...candidate });
        if (fault === 'copyAux')
          (candidate.tx as ErgoTransaction).dataInputs.push(
            Buffer.from('01', 'hex'),
          );
        if (fault === 'approvals')
          agreement.getTransactionApprovals().get(hash)![3] = 'injected';
        if (fault === 'clear') agreement.clearTransactions();
        return 'signature';
      });
      await agreement.processMessage(
        'response',
        { txDataHash: hash },
        'vote',
        2,
        'peer',
        timestamp,
      );
      expect(await db().getTxById(reward.txId)).toBeNull();
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  /**
   * @target AvalancheRewardAdmission.persist 'allows lower-ID arbitration only against a still-approved reward'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'allows lower-ID arbitration only against a still-approved reward' through AvalancheRewardAdmission.persist.
   * @expected expect(await db().getTxById(old.txId)).toBeNull(); expect((await db().getTxById(reward.txId))?.status).toBe( TransactionStatus.approved, );
   */
  it('allows lower-ID arbitration only against a still-approved reward', async () => {
    const old = new ErgoTransaction(
      'zz-high-id',
      eventId,
      reward.txBytes,
      TransactionType.reward,
      [],
      [],
    );
    await DatabaseActionMock.insertTxRecord(
      old,
      TransactionStatus.approved,
      1,
      'first',
      false,
      0,
      3,
    );
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { status: EventStatus.inReward },
    );
    const bound = await admit();
    await bound.persist(() => undefined);
    expect(await db().getTxById(old.txId)).toBeNull();
    expect((await db().getTxById(reward.txId))?.status).toBe(
      TransactionStatus.approved,
    );
  });
  /**
   * @target AvalancheRewardAdmission.bind 'rejects a higher-ID or advanced competing %s reward'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects a higher-ID or advanced competing %s reward' through AvalancheRewardAdmission.bind.
   * @expected await expect(admit()).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toBeNull();
   */
  it.each([
    TransactionStatus.approved,
    TransactionStatus.signed,
    TransactionStatus.sent,
  ])('rejects a higher-ID or advanced competing %s reward', async (status) => {
    const old = new ErgoTransaction(
      'aa-low-id',
      eventId,
      reward.txBytes,
      TransactionType.reward,
      [],
      [],
    );
    await DatabaseActionMock.insertTxRecord(
      old,
      status,
      1,
      'first',
      false,
      0,
      3,
    );
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { status: EventStatus.inReward },
    );
    await expect(admit()).rejects.toThrow();
    expect(await db().getTxById(reward.txId)).toBeNull();
  });
  /**
   * @target AvalancheRewardAdmission.bind 'never resurrects an invalid same-ID row even with a higher approved alternative'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'never resurrects an invalid same-ID row even with a higher approved alternative' through AvalancheRewardAdmission.bind.
   * @expected await expect(admit()).rejects.toThrow(); expect((await db().getTxById(reward.txId))?.status).toBe( TransactionStatus.invalid, );
   */
  it('never resurrects an invalid same-ID row even with a higher approved alternative', async () => {
    await DatabaseActionMock.insertTxRecord(
      reward,
      TransactionStatus.invalid,
      1,
      'first',
      false,
      0,
      3,
    );
    const old = new ErgoTransaction(
      'zz-high-id',
      eventId,
      reward.txBytes,
      TransactionType.reward,
      [],
      [],
    );
    await DatabaseActionMock.insertTxRecord(
      old,
      TransactionStatus.approved,
      1,
      'first',
      false,
      0,
      3,
    );
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { status: EventStatus.inReward },
    );
    await expect(admit()).rejects.toThrow();
    expect((await db().getTxById(reward.txId))?.status).toBe(
      TransactionStatus.invalid,
    );
  });
  /**
   * @target AvalancheRewardAdmission.persist 'rolls back a replaced transaction if the event phase write fails'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rolls back a replaced transaction if the event phase write fails' through AvalancheRewardAdmission.persist.
   * @expected await expect(bound.persist(() => undefined)).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toBeNull(); expect(await db().getTxById(old.txId)).not.toBeNull();
   */
  it('rolls back a replaced transaction if the event phase write fails', async () => {
    const old = new ErgoTransaction(
      'zz-high-id',
      eventId,
      reward.txBytes,
      TransactionType.reward,
      [],
      [],
    );
    await DatabaseActionMock.insertTxRecord(
      old,
      TransactionStatus.approved,
      1,
      'first',
      false,
      0,
      3,
    );
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { status: EventStatus.inReward },
    );
    const bound = await admit();
    await db().dataSource.query(
      'CREATE TRIGGER reject_reward BEFORE UPDATE ON confirmed_event_entity BEGIN SELECT RAISE(IGNORE); END',
    );
    try {
      await expect(bound.persist(() => undefined)).rejects.toThrow();
      expect(await db().getTxById(reward.txId)).toBeNull();
      expect(await db().getTxById(old.txId)).not.toBeNull();
    } finally {
      await db().dataSource.query('DROP TRIGGER reject_reward');
    }
  });
  /**
   * @target AvalancheRewardAdmission.persist 'rejects a copied reward changed by the order builder'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects a copied reward changed by the order builder' through AvalancheRewardAdmission.persist.
   * @expected await expect(bound.persist(() => undefined)).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toBeNull();
   */
  it('rejects a copied reward changed by the order builder', async () => {
    const bound = await admit();
    vi.mocked(EventOrder.createEventRewardOrder).mockImplementation(
      async () => {
        (bound.payment as ErgoTransaction).inputBoxes.push(
          Buffer.from('aa', 'hex'),
        );
        return [];
      },
    );
    await expect(bound.persist(() => undefined)).rejects.toThrow();
    expect(await db().getTxById(reward.txId)).toBeNull();
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'does not treat a mismatched expected order as a cached approval'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not treat a mismatched expected order as a cached approval' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(await db().getTxById(reward.txId)).toBeNull();
   */
  it('does not treat a mismatched expected order as a cached approval', async () => {
    await start();
    const hash = TransactionSerializer.getTxDataHash(reward);
    const timestamp = agreement.getTransactions().get(hash)!.timestamp;
    vi.mocked(EventOrder.createEventRewardOrder).mockResolvedValue([
      { address: 'different' },
    ] as never);
    await agreement.processMessage(
      'approval',
      { txJson: reward.toJson(), signatures: ['a', 'b', 'c', '', ''] },
      '',
      0,
      'peer',
      timestamp,
    );
    expect(await db().getTxById(reward.txId)).toBeNull();
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'does not retain scanner exclusion while awaiting transport completion'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not retain scanner exclusion while awaiting transport completion' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce()); await expect(scanner.withSafety(() => undefined)).resolves.toBeUndefined();
   */
  it('does not retain scanner exclusion while awaiting transport completion', async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    transport.mockReturnValue(completion);
    const running = start();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    await expect(scanner.withSafety(() => undefined)).resolves.toBeUndefined();
    finish();
    await running;
  });
  /**
   * @target AvalancheRewardAdmission.persist 'admits the source-Avalanche direction under the observation lease'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'admits the source-Avalanche direction under the observation lease' through AvalancheRewardAdmission.persist.
   * @expected expect(lease).toHaveBeenCalled(); expect((await db().getEventById(eventId))?.status).toBe( EventStatus.inReward, );
   */
  it('admits the source-Avalanche direction under the observation lease', async () => {
    await db().EventRepository.update(
      { eventId },
      { fromChain: 'avalanche', toChain: 'ethereum' },
    );
    payment = new PaymentTransaction(
      'ethereum',
      payment.txId,
      eventId,
      payment.txBytes,
      TransactionType.payment,
    );
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { chain: payment.network, txJson: payment.toJson() },
    );
    const lease = vi.spyOn(scanner, 'withObservation');
    const bound = await admit();
    await bound.persist(() => undefined);
    expect(lease).toHaveBeenCalled();
    expect((await db().getEventById(eventId))?.status).toBe(
      EventStatus.inReward,
    );
  });
  /**
   * @target TxAgreement.processMessage 'removes no candidate when a response transport fails'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'removes no candidate when a response transport fails' with the suite's captured inputs and invoke the processMessage path.
   * @expected expect(transport).toHaveBeenCalledOnce(); expect(agreement.getTransactions().size).toBe(0); expect(agreement.getEventAgreedTransactions().size).toBe(0);
   */
  it('removes no candidate when a response transport fails', async () => {
    transport.mockRejectedValue(new Error('synthetic transport failed'));
    await agreement.processMessage(
      'request',
      { txJson: reward.toJson() },
      '',
      TestConfigs.guardIndex,
      'peer',
      100,
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(agreement.getTransactions().size).toBe(0);
    expect(agreement.getEventAgreedTransactions().size).toBe(0);
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'retains the queue entry when a qualified request transport fails'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'retains the queue entry when a qualified request transport fails' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(agreement.getTransactionQueue()).toEqual([reward]); expect(agreement.getTransactions().size).toBe(0);
   */
  it('retains the queue entry when a qualified request transport fails', async () => {
    transport.mockRejectedValue(new Error('synthetic transport failed'));
    await start();
    expect(agreement.getTransactionQueue()).toEqual([reward]);
    expect(agreement.getTransactions().size).toBe(0);
  });
  /**
   * @target TxAgreement.resendApprovalMessages 'rejects approved-array replacement during resend signing'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects approved-array replacement during resend signing' with the suite's captured inputs and invoke the resendApprovalMessages path.
   * @expected expect(transport).not.toHaveBeenCalled();
   */
  it('rejects approved-array replacement during resend signing', async () => {
    const approved = {
      tx: reward,
      signatures: ['a', 'b', 'c', '', ''],
      timestamp: 100,
    };
    agreement.insertApprovedTransactions(approved);
    vi.mocked(agreement.getSigner().sign).mockImplementation(async () => {
      agreement.getApprovedTransactions()[0] = { ...approved };
      return 'signature';
    });
    await agreement.resendApprovalMessages();
    expect(transport).not.toHaveBeenCalled();
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'rejects a fresh map object installed while a request resend is signing'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects a fresh map object installed while a request resend is signing' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(transport).not.toHaveBeenCalled();
   */
  it('rejects a fresh map object installed while a request resend is signing', async () => {
    await start();
    transport.mockClear();
    const hash = TransactionSerializer.getTxDataHash(reward);
    const previous = agreement.getTransactions().get(hash)!;
    vi.mocked(agreement.getSigner().sign).mockImplementation(async () => {
      agreement.insertTransactions(hash, { ...previous });
      return 'signature';
    });
    await agreement.resendTransactionRequests();
    expect(transport).not.toHaveBeenCalled();
  });
  /**
   * @target AvalancheRewardAdmission.persist 'rejects a changed existing reward %s'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects a changed existing reward %s' through AvalancheRewardAdmission.persist.
   * @expected await expect(bound.persist(() => undefined)).rejects.toThrow();
   */
  it.each(['txJson', 'chain', 'type', 'requiredSign', 'event'])(
    'rejects a changed existing reward %s',
    async (field) => {
      const bound = await admit();
      await bound.persist(() => undefined);
      await db().TransactionRepository.update(
        { txId: reward.txId },
        {
          [field]:
            field === 'requiredSign' ? 4 : field === 'event' ? null : 'changed',
        },
      );
      await expect(bound.persist(() => undefined)).rejects.toThrow();
    },
  );
  /**
   * @target AvalancheRewardAdmission.bind 'rejects inReward without an exact existing reward'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects inReward without an exact existing reward' through AvalancheRewardAdmission.bind.
   * @expected await expect(admit()).rejects.toThrow('Existing reward');
   */
  it('rejects inReward without an exact existing reward', async () => {
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { status: EventStatus.inReward },
    );
    await expect(admit()).rejects.toThrow('Existing reward');
  });
  /**
   * @target AvalancheRewardAdmission.bind 'rejects pendingReward with a pre-existing active reward'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects pendingReward with a pre-existing active reward' through AvalancheRewardAdmission.bind.
   * @expected await expect(admit()).rejects.toThrow('Pending reward');
   */
  it('rejects pendingReward with a pre-existing active reward', async () => {
    await DatabaseActionMock.insertTxRecord(
      reward,
      TransactionStatus.approved,
      1,
      'first',
      false,
      0,
      3,
    );
    await expect(admit()).rejects.toThrow('Pending reward');
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'denies invalid %s approval without cached-state writes'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'denies invalid %s approval without cached-state writes' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(await db().getTxById(reward.txId)).toBeNull(); expect(agreement.getTransactions().size).toBe(1);
   */
  it.each(['short', 'long', 'badSignature', 'insufficient', 'timestamp'])(
    'denies invalid %s approval without cached-state writes',
    async (fault) => {
      await start();
      const hash = TransactionSerializer.getTxDataHash(reward);
      const timestamp = agreement.getTransactions().get(hash)!.timestamp;
      const signatures =
        fault === 'short'
          ? ['a', 'b', 'c']
          : fault === 'long'
            ? ['a', 'b', 'c', '', '', 'extra']
            : fault === 'insufficient'
              ? ['a', '', '', '', '']
              : ['a', 'b', 'c', '', ''];
      if (fault === 'badSignature')
        vi.mocked(agreement.getSigner().verify).mockResolvedValue(false);
      await agreement.processMessage(
        'approval',
        { txJson: reward.toJson(), signatures },
        '',
        0,
        'peer',
        fault === 'timestamp' ? timestamp + 1 : timestamp,
      );
      expect(await db().getTxById(reward.txId)).toBeNull();
      expect(agreement.getTransactions().size).toBe(1);
    },
  );
  /**
   * @target AvalancheRewardAdmission.persist 'rolls back if synchronous authority changes during the first awaited SQL write'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rolls back if synchronous authority changes during the first awaited SQL write' through AvalancheRewardAdmission.persist.
   * @expected await expect(bound.persist(() => undefined)).rejects.toThrow( 'guard rotation', ); expect(await db().getTxById(reward.txId)).toBeNull(); expect((await db().getEventById(eventId))?.status).toBe( EventStatus.pendingReward, );
   */
  it('rolls back if synchronous authority changes during the first awaited SQL write', async () => {
    const bound = await admit();
    const subscriber = {
      afterInsert: () => {
        assertAuthority.mockImplementation(() => {
          throw new Error('guard rotation');
        });
      },
    };
    db().dataSource.subscribers.push(subscriber);
    try {
      await expect(bound.persist(() => undefined)).rejects.toThrow(
        'guard rotation',
      );
      expect(await db().getTxById(reward.txId)).toBeNull();
      expect((await db().getEventById(eventId))?.status).toBe(
        EventStatus.pendingReward,
      );
    } finally {
      db().dataSource.subscribers.splice(
        db().dataSource.subscribers.indexOf(subscriber),
        1,
      );
    }
  });
  /**
   * @target AvalancheRewardAdmission.persist 'a foreign writer waits and survives a reward admission rollback'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'a foreign writer waits and survives a reward admission rollback' through AvalancheRewardAdmission.persist.
   * @expected expect(completed).toBe(false); expect(await rejected).toBeInstanceOf(Error); expect((await db().getEventById(eventId))?.eventData.block).toBe( 'foreign-winner', ); expect(await db().getTxById(reward.txId)).toBeNull();
   */
  it('a foreign writer waits and survives a reward admission rollback', async () => {
    const bound = await admit();
    await db().dataSource.query(
      'CREATE TRIGGER reject_reward BEFORE UPDATE ON confirmed_event_entity BEGIN SELECT RAISE(IGNORE); END',
    );
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const create = db().dataSource.createQueryRunner.bind(db().dataSource);
    const intercept = vi
      .spyOn(db().dataSource, 'createQueryRunner')
      .mockImplementation((mode) => {
        const runner = create(mode);
        const query = runner.query.bind(runner);
        vi.spyOn(runner, 'query').mockImplementation(
          async (sql: string, parameters?: unknown[], structured?: boolean) => {
            if (sql.startsWith('UPDATE "confirmed_event_entity"')) {
              ready();
              await paused;
            }
            return structured
              ? query(sql, parameters, true)
              : query(sql, parameters);
          },
        );
        return runner;
      });
    const persistence = bound.persist(() => undefined);
    const rejected = persistence.then(
      () => undefined,
      (error) => error,
    );
    await entered;
    let completed = false;
    const foreign = db()
      .EventRepository.update({ eventId }, { block: 'foreign-winner' })
      .then(() => {
        completed = true;
      });
    await delay(15);
    expect(completed).toBe(false);
    resume();
    expect(await rejected).toBeInstanceOf(Error);
    await foreign;
    intercept.mockRestore();
    await db().dataSource.query('DROP TRIGGER reject_reward');
    expect((await db().getEventById(eventId))?.eventData.block).toBe(
      'foreign-winner',
    );
    expect(await db().getTxById(reward.txId)).toBeNull();
  });
  /**
   * @target AvalancheRewardAdmission.persist 'rolls back an AFTER event-write mutation: %s'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rolls back an AFTER event-write mutation: %s' through AvalancheRewardAdmission.persist.
   * @expected await expect(bound.persist(() => undefined)).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toBeNull(); expect((await db().getEventById(eventId))?.status).toBe( EventStatus.pendingReward, );
   */
  it.each([
    "UPDATE confirmed_event_entity SET status = 'completed' WHERE id = NEW.id",
    "UPDATE confirmed_event_entity SET firstTry = 'changed' WHERE id = NEW.id",
    'UPDATE confirmed_event_entity SET unexpectedFails = 9 WHERE id = NEW.id',
    "UPDATE event_trigger_entity SET serialized = 'changed' WHERE eventId = NEW.id",
    "UPDATE transaction_entity SET txJson = 'changed' WHERE type = 'reward'",
    "UPDATE transaction_entity SET lastCheck = 900 WHERE type = 'reward'",
    "UPDATE transaction_entity SET signFailedCount = 900 WHERE type = 'reward'",
    "UPDATE transaction_entity SET requiredSign = 900 WHERE type = 'payment'",
  ])('rolls back an AFTER event-write mutation: %s', async (sql) => {
    const bound = await admit();
    await db().dataSource.query(
      `CREATE TRIGGER mutate_reward AFTER UPDATE ON confirmed_event_entity BEGIN ${sql}; END`,
    );
    try {
      await expect(bound.persist(() => undefined)).rejects.toThrow();
      expect(await db().getTxById(reward.txId)).toBeNull();
      expect((await db().getEventById(eventId))?.status).toBe(
        EventStatus.pendingReward,
      );
    } finally {
      await db().dataSource.query('DROP TRIGGER mutate_reward');
    }
  });
  /**
   * @target AvalancheRewardAdmission.persist 'reports the actual stored signFailed retry status after commit'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'reports the actual stored signFailed retry status after commit' through AvalancheRewardAdmission.persist.
   * @expected expect(notify).toHaveBeenLastCalledWith( reward.txId, TransactionStatus.signFailed, );
   */
  it('reports the actual stored signFailed retry status after commit', async () => {
    const bound = await admit();
    await bound.persist(() => undefined);
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { status: TransactionStatus.signFailed, failedInSign: true },
    );
    const notify = vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    );
    await bound.persist(() => undefined);
    expect(notify).toHaveBeenLastCalledWith(
      reward.txId,
      TransactionStatus.signFailed,
    );
  });
  /**
   * @target TxAgreement.clearTransactions 'does not requeue a request explicitly cleared while its message signature waits'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not requeue a request explicitly cleared while its message signature waits' with the suite's captured inputs and invoke the clearTransactions path.
   * @expected expect(transport).not.toHaveBeenCalled(); expect(agreement.getTransactionQueue()).toHaveLength(0);
   */
  it('does not requeue a request explicitly cleared while its message signature waits', async () => {
    vi.mocked(agreement.getSigner().sign).mockImplementation(async () => {
      agreement.clearTransactions();
      return 'signature';
    });
    await start();
    expect(transport).not.toHaveBeenCalled();
    expect(agreement.getTransactionQueue()).toHaveLength(0);
  });
  /**
   * @target TxAgreement.processMessage 'does not respond to a competing inReward request even when its ID is lower'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not respond to a competing inReward request even when its ID is lower' with the suite's captured inputs and invoke the processMessage path.
   * @expected expect(transport).not.toHaveBeenCalled(); expect(agreement.getTransactions().size).toBe(0);
   */
  it('does not respond to a competing inReward request even when its ID is lower', async () => {
    const old = new ErgoTransaction(
      'zz-high-id',
      eventId,
      reward.txBytes,
      TransactionType.reward,
      [],
      [],
    );
    await DatabaseActionMock.insertTxRecord(
      old,
      TransactionStatus.approved,
      1,
      'first',
      false,
      0,
      3,
    );
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { status: EventStatus.inReward },
    );
    await agreement.processMessage(
      'request',
      { txJson: reward.toJson() },
      '',
      TestConfigs.guardIndex,
      'peer',
      100,
    );
    expect(transport).not.toHaveBeenCalled();
    expect(agreement.getTransactions().size).toBe(0);
  });
  /**
   * @target TxAgreement.processMessage 'permits lower-ID replacement from a verified approval quorum'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'permits lower-ID replacement from a verified approval quorum' with the suite's captured inputs and invoke the processMessage path.
   * @expected expect(await db().getTxById(old.txId)).toBeNull(); expect((await db().getTxById(reward.txId))?.status).toBe( TransactionStatus.approved, );
   */
  it('permits lower-ID replacement from a verified approval quorum', async () => {
    const old = new ErgoTransaction(
      'zz-high-id',
      eventId,
      reward.txBytes,
      TransactionType.reward,
      [],
      [],
    );
    await DatabaseActionMock.insertTxRecord(
      old,
      TransactionStatus.approved,
      1,
      'first',
      false,
      0,
      3,
    );
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { status: EventStatus.inReward },
    );
    await agreement.processMessage(
      'approval',
      { txJson: reward.toJson(), signatures: ['a', 'b', 'c', '', ''] },
      '',
      0,
      'peer',
      100,
    );
    expect(await db().getTxById(old.txId)).toBeNull();
    expect((await db().getTxById(reward.txId))?.status).toBe(
      TransactionStatus.approved,
    );
  });
  /**
   * @target AvalancheRewardAdmission.persist 'fresh regeneration after invalidation cannot retarget an older queued reward'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'fresh regeneration after invalidation cannot retarget an older queued reward' through AvalancheRewardAdmission.persist.
   * @expected expect( await db().invalidateTxIfUnchanged( { txId: row.txId, txJson: row.txJson, chain: row.chain, type: row.type, status: TransactionStatus.signFailed, requiredSign: row.requiredSign, eventId, orderId: null, }, row.lastCheck, true, ), ).toBe(true); expect( await AvalancheRewardAdmission.bind(next.payment, 3, assertAuthority), ).toBeDefined(); await expect( AvalancheRewardAdmission.bind(queued.payment, 3, assertAuthority), ).rejects.toThrow('Queued reward authority'); await expect( AvalancheRewardAdmission.bind(reward, 3, assertAuthority), ).rejects.toThrow('Queued reward authority');
   */
  it('fresh regeneration after invalidation cannot retarget an older queued reward', async () => {
    const helper = RewardAuthorization.getInstance();
    const originalEvent = (await db().getEventById(eventId))!;
    const first = await helper.bind(
      EventSerializer.fromConfirmedEntity(originalEvent),
      originalEvent.eventData.txId,
    );
    const queued = RewardAuthorization.captureReward(reward, eventId);
    await first.withAction(() => queued.retainAuthority(first));
    const admitted = (await AvalancheRewardAdmission.bind(
      queued.payment,
      3,
      assertAuthority,
    ))!;
    await admitted.persist(() => undefined);
    const row = (await db().getTxById(reward.txId))!;
    await db().TransactionRepository.update(
      { txId: row.txId },
      { status: TransactionStatus.signFailed },
    );
    expect(
      await db().invalidateTxIfUnchanged(
        {
          txId: row.txId,
          txJson: row.txJson,
          chain: row.chain,
          type: row.type,
          status: TransactionStatus.signFailed,
          requiredSign: row.requiredSign,
          eventId,
          orderId: null,
        },
        row.lastCheck,
        true,
      ),
    ).toBe(true);
    const currentEvent = (await db().getEventById(eventId))!;
    const second = await helper.bind(
      EventSerializer.fromConfirmedEntity(currentEvent),
      currentEvent.eventData.txId,
    );
    const newReward = new ErgoTransaction(
      'regenerated',
      eventId,
      reward.txBytes,
      TransactionType.reward,
      [],
      [],
    );
    const next = RewardAuthorization.captureReward(newReward, eventId);
    await second.withAction(() => next.retainAuthority(second));
    expect(
      await AvalancheRewardAdmission.bind(next.payment, 3, assertAuthority),
    ).toBeDefined();
    await expect(
      AvalancheRewardAdmission.bind(queued.payment, 3, assertAuthority),
    ).rejects.toThrow('Queued reward authority');
    await expect(
      AvalancheRewardAdmission.bind(reward, 3, assertAuthority),
    ).rejects.toThrow('Queued reward authority');
  });
  /**
   * @target TxAgreement.broadcastTransactionRequest 'rejects an old R1 %s against a fresh same-model agreement cache'
   * @dependencies Actual TxAgreement sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects an old R1 %s against a fresh same-model agreement cache' through TxAgreement.broadcastTransactionRequest.
   * @expected expect( await db().invalidateTxIfUnchanged( { txId: row.txId, txJson: row.txJson, chain: row.chain, type: row.type, status: row.status, requiredSign: row.requiredSign, eventId, orderId: null, }, row.lastCheck, true, ), ).toBe(true); expect(second.authorityId).not.toBe(first.authorityId); expect(transport).toHaveBeenCalledOnce(); await expect( agreement['broadcastTransactionRequest']( which === 'original' ? reward : old.payment, 100, ), ).rejects.toThrow('Queued reward authority'); expect(transport).toHaveBeenCalledOnce(); expect(agreement.getTransactions().size).toBe(0);
   */
  it.each(['original', 'copy'])(
    'rejects an old R1 %s against a fresh same-model agreement cache',
    async (which) => {
      const helper = RewardAuthorization.getInstance();
      const event = (await db().getEventById(eventId))!;
      const first = await helper.bind(
        EventSerializer.fromConfirmedEntity(event),
        event.eventData.txId,
      );
      const old = RewardAuthorization.captureReward(reward, eventId);
      await first.withAction(() => old.retainAuthority(first));
      const abandoned = new ErgoTransaction(
        'abandoned-reward',
        eventId,
        reward.txBytes,
        TransactionType.reward,
        [],
        [],
      );
      await DatabaseActionMock.insertTxRecord(
        abandoned,
        TransactionStatus.signFailed,
        123,
        'updated',
        false,
        0,
        3,
      );
      await db().ConfirmedEventRepository.update(
        { id: eventId },
        { status: EventStatus.inReward },
      );
      const row = (await db().getTxById(abandoned.txId))!;
      expect(
        await db().invalidateTxIfUnchanged(
          {
            txId: row.txId,
            txJson: row.txJson,
            chain: row.chain,
            type: row.type,
            status: row.status,
            requiredSign: row.requiredSign,
            eventId,
            orderId: null,
          },
          row.lastCheck,
          true,
        ),
      ).toBe(true);
      const current = (await db().getEventById(eventId))!;
      const second = await helper.bind(
        EventSerializer.fromConfirmedEntity(current),
        current.eventData.txId,
      );
      const fresh = RewardAuthorization.captureReward(
        ErgoTransaction.fromJson(reward.toJson()),
        eventId,
      );
      await second.withAction(() => fresh.retainAuthority(second));
      expect(second.authorityId).not.toBe(first.authorityId);
      // Real request dispatch populates the hash cache without a queued candidate.
      await agreement['broadcastTransactionRequest'](fresh.payment, 100);
      expect(transport).toHaveBeenCalledOnce();
      await expect(
        agreement['broadcastTransactionRequest'](
          which === 'original' ? reward : old.payment,
          100,
        ),
      ).rejects.toThrow('Queued reward authority');
      expect(transport).toHaveBeenCalledOnce();
      expect(agreement.getTransactions().size).toBe(0);
    },
  );
  /**
   * @target RewardAuthorization.captureReward 'an early capture before R1 binding does not attach a previously qualified event authority'
   * @dependencies Actual RewardAuthorization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'an early capture before R1 binding does not attach a previously qualified event authority' through RewardAuthorization.captureReward.
   * @expected expect(RewardAuthorization.capturedAuthority(reward)).toBeUndefined(); expect( RewardAuthorization.capturedAuthority(captured.payment), ).toBeUndefined();
   */
  it('an early capture before R1 binding does not attach a previously qualified event authority', async () => {
    const original = (await db().getEventById(eventId))!;
    const helper = RewardAuthorization.getInstance();
    await helper.bind(
      EventSerializer.fromConfirmedEntity(original),
      original.eventData.txId,
    );
    const captured = RewardAuthorization.captureReward(reward, eventId);
    expect(RewardAuthorization.capturedAuthority(reward)).toBeUndefined();
    expect(
      RewardAuthorization.capturedAuthority(captured.payment),
    ).toBeUndefined();
  });
  /**
   * @target AvalancheRewardAdmission.bind 'retained R1 %s auxiliary mutation is rejected before R2 can rebind'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'retained R1 %s auxiliary mutation is rejected before R2 can rebind' through AvalancheRewardAdmission.bind.
   * @expected await expect( AvalancheRewardAdmission.bind(captured.payment, 3, assertAuthority), ).rejects.toThrow('Queued reward model');
   */
  it.each(['original', 'copy'])(
    'retained R1 %s auxiliary mutation is rejected before R2 can rebind',
    async (which) => {
      const event = (await db().getEventById(eventId))!;
      const bound = await RewardAuthorization.getInstance().bind(
        EventSerializer.fromConfirmedEntity(event),
        event.eventData.txId,
      );
      const captured = RewardAuthorization.captureReward(reward, eventId);
      await bound.withAction(() => captured.retainAuthority(bound));
      (which === 'original' ? reward : captured.payment).dataInputs.push(
        Buffer.from('aa', 'hex'),
      );
      await expect(
        AvalancheRewardAdmission.bind(captured.payment, 3, assertAuthority),
      ).rejects.toThrow('Queued reward model');
    },
  );
  /**
   * @target EventProcessor.processRewardEvent 'actual R1 producer attaches authority to the emitted copy and its original only at queue admission'
   * @dependencies Actual EventProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'actual R1 producer attaches authority to the emitted copy and its original only at queue admission' through EventProcessor.processRewardEvent.
   * @expected expect(RewardAuthorization.capturedAuthority(reward)).toBeUndefined(); expect(enqueue).toHaveBeenCalledOnce(); expect(RewardAuthorization.capturedAuthority(reward)).toBeTypeOf('string'); expect( RewardAuthorization.capturedAuthority(enqueue.mock.calls[0][0]), ).toBe(RewardAuthorization.capturedAuthority(reward));
   */
  it('actual R1 producer attaches authority to the emitted copy and its original only at queue admission', async () => {
    const current = (await db().getEventById(eventId))!;
    vi.spyOn(
      EventProcessor as unknown as {
        createEventRewardDistribution: () => Promise<PaymentTransaction>;
      },
      'createEventRewardDistribution',
    ).mockResolvedValue(reward);
    const enqueue = vi.fn();
    vi.spyOn(TxAgreement, 'getInstance').mockResolvedValue({
      addTransactionToQueue: enqueue,
    } as never);
    expect(RewardAuthorization.capturedAuthority(reward)).toBeUndefined();
    await EventProcessor.processRewardEvent(
      EventSerializer.fromConfirmedEntity(current),
      current.eventData.txId,
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(RewardAuthorization.capturedAuthority(reward)).toBeTypeOf('string');
    expect(
      RewardAuthorization.capturedAuthority(enqueue.mock.calls[0][0]),
    ).toBe(RewardAuthorization.capturedAuthority(reward));
  });
  /**
   * @target TransactionVerifier.verifyEventTransaction 'actual R1 remote verifier attaches authority only when order comparison returns %s'
   * @dependencies Actual TransactionVerifier sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'actual R1 remote verifier attaches authority only when order comparison returns %s' through TransactionVerifier.verifyEventTransaction.
   * @expected expect( await TransactionVerifier.verifyEventTransaction( reward, EventSerializer.fromConfirmedEntity(current), current.eventData.txId, ), ).toBe(equal); expect(RewardAuthorization.capturedAuthority(reward) !== undefined).toBe( equal, );
   */
  it.each([true, false])(
    'actual R1 remote verifier attaches authority only when order comparison returns %s',
    async (equal) => {
      const current = (await db().getEventById(eventId))!;
      if (!equal)
        vi.mocked(EventOrder.createEventRewardOrder).mockResolvedValue([
          { address: 'different' },
        ] as never);
      expect(
        await TransactionVerifier.verifyEventTransaction(
          reward,
          EventSerializer.fromConfirmedEntity(current),
          current.eventData.txId,
        ),
      ).toBe(equal);
      expect(RewardAuthorization.capturedAuthority(reward) !== undefined).toBe(
        equal,
      );
    },
  );
  /**
   * @target AvalancheRewardAdmission.persist 'concurrent same-model admissions leave one exact reward'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'concurrent same-model admissions leave one exact reward' through AvalancheRewardAdmission.persist.
   * @expected expect(results.some((result) => result.status === 'fulfilled')).toBe(true); expect( await db().getEventValidTxsByType(eventId, TransactionType.reward), ).toHaveLength(1); expect((await db().getTxById(reward.txId))?.txJson).toBe(reward.toJson());
   */
  it('concurrent same-model admissions leave one exact reward', async () => {
    const one = await admit();
    const two = await admit();
    const results = await Promise.allSettled([
      one.persist(() => undefined),
      two.persist(() => undefined),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(
      await db().getEventValidTxsByType(eventId, TransactionType.reward),
    ).toHaveLength(1);
    expect((await db().getTxById(reward.txId))?.txJson).toBe(reward.toJson());
  });
  /**
   * @target AvalancheRewardAdmission.persist 'competing admissions converge to the lower approved ID without duplicates'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'competing admissions converge to the lower approved ID without duplicates' through AvalancheRewardAdmission.persist.
   * @expected expect(results.some((result) => result.status === 'fulfilled')).toBe(true); await expect(higher.persist(() => undefined)).rejects.toThrow(); expect( await db().getEventValidTxsByType(eventId, TransactionType.reward), ).toHaveLength(1); expect(await db().getTxById(high.txId)).toBeNull();
   */
  it('competing admissions converge to the lower approved ID without duplicates', async () => {
    const lower = await admit();
    const high = new ErgoTransaction(
      'zz-high-id',
      eventId,
      reward.txBytes,
      TransactionType.reward,
      [],
      [],
    );
    const higher = (await AvalancheRewardAdmission.bind(
      high,
      3,
      assertAuthority,
    ))!;
    const results = await Promise.allSettled([
      higher.persist(() => undefined),
      lower.persist(() => undefined),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    await lower.persist(() => undefined);
    await expect(higher.persist(() => undefined)).rejects.toThrow();
    expect(
      await db().getEventValidTxsByType(eventId, TransactionType.reward),
    ).toHaveLength(1);
    expect(await db().getTxById(high.txId)).toBeNull();
  });
  /**
   * @target AvalancheRewardAdmission.bind 'a retained Avalanche object cannot become legacy after replacing the helper instance'
   * @dependencies Actual AvalancheRewardAdmission sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'a retained Avalanche object cannot become legacy after replacing the helper instance' through AvalancheRewardAdmission.bind.
   * @expected expect(RewardAuthorization.remembersEvent(eventId)).toBe(false); await expect( AvalancheRewardAdmission.bind(captured.payment, 3, assertAuthority), ).rejects.toThrow('Known Avalanche');
   */
  it('a retained Avalanche object cannot become legacy after replacing the helper instance', async () => {
    const event = (await db().getEventById(eventId))!;
    const helper = RewardAuthorization.getInstance();
    const bound = await helper.bind(
      EventSerializer.fromConfirmedEntity(event),
      event.eventData.txId,
    );
    const captured = RewardAuthorization.captureReward(reward, eventId);
    await bound.withAction(() => captured.retainAuthority(bound));
    vi.mocked(RewardAuthorization.getInstance).mockReturnValue(
      new RewardAuthorization(helper['dependencies']),
    );
    await db().EventRepository.update({ eventId }, { toChain: 'ethereum' });
    expect(RewardAuthorization.remembersEvent(eventId)).toBe(false);
    await expect(
      AvalancheRewardAdmission.bind(captured.payment, 3, assertAuthority),
    ).rejects.toThrow('Known Avalanche');
  });
  /**
   * @target RewardAuthorization.captureReward 'refuses to overwrite the retained %s authority with a fresh R1 binding'
   * @dependencies Actual RewardAuthorization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'refuses to overwrite the retained %s authority with a fresh R1 binding' through RewardAuthorization.captureReward.
   * @expected await expect( next.withAction(() => replacement.retainAuthority(next)), ).rejects.toThrow(); expect(RewardAuthorization.capturedAuthority(input)).toBe( first.authorityId, );
   */
  it.each(['original', 'copy'])(
    'refuses to overwrite the retained %s authority with a fresh R1 binding',
    async (which) => {
      const helper = RewardAuthorization.getInstance();
      const event = (await db().getEventById(eventId))!;
      const first = await helper.bind(
        EventSerializer.fromConfirmedEntity(event),
        event.eventData.txId,
      );
      const captured = RewardAuthorization.captureReward(reward, eventId);
      await first.withAction(() => captured.retainAuthority(first));
      const input = which === 'original' ? reward : captured.payment;
      await db().ConfirmedEventRepository.update(
        { id: eventId },
        { unexpectedFails: 1 },
      );
      const next = await helper.bind(
        EventSerializer.fromConfirmedEntity(event),
        event.eventData.txId,
      );
      const replacement = RewardAuthorization.captureReward(input, eventId);
      await expect(
        next.withAction(() => replacement.retainAuthority(next)),
      ).rejects.toThrow();
      expect(RewardAuthorization.capturedAuthority(input)).toBe(
        first.authorityId,
      );
    },
  );
  /**
   * @target TxAgreement.addTransactionToQueue 'checks retained model identity before transaction-type classification'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'checks retained model identity before transaction-type classification' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(transport).not.toHaveBeenCalled(); expect(agreement.getTransactions().size).toBe(0);
   */
  it('checks retained model identity before transaction-type classification', async () => {
    const event = (await db().getEventById(eventId))!;
    const bound = await RewardAuthorization.getInstance().bind(
      EventSerializer.fromConfirmedEntity(event),
      event.eventData.txId,
    );
    const captured = RewardAuthorization.captureReward(reward, eventId);
    await bound.withAction(() => captured.retainAuthority(bound));
    agreement.addTransactionToQueue(captured.payment);
    Object.assign(captured.payment, { txType: TransactionType.payment });
    await agreement.processAgreementQueue();
    expect(transport).not.toHaveBeenCalled();
    expect(agreement.getTransactions().size).toBe(0);
  });
  /**
   * @target TxAgreement.addTransactionToQueue 'preserves legacy removal after a non-Avalanche reward signing failure'
   * @dependencies Actual TxAgreement from agreement/txAgreement.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'preserves legacy removal after a non-Avalanche reward signing failure' with the suite's captured inputs and invoke the addTransactionToQueue path.
   * @expected expect(agreement.getTransactionQueue()).toHaveLength(0); expect(transport).not.toHaveBeenCalled();
   */
  it('preserves legacy removal after a non-Avalanche reward signing failure', async () => {
    await db().EventRepository.update({ eventId }, { toChain: 'ethereum' });
    vi.mocked(agreement.getSigner().sign).mockRejectedValue(
      new Error('legacy signing failed'),
    );
    await start();
    expect(agreement.getTransactionQueue()).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();
  });
});
