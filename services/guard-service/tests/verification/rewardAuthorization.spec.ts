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
  EventTrigger,
  NotEnoughAssetsError,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import TxAgreement from '../../src/agreement/txAgreement';
import EventOrder from '../../src/event/eventOrder';
import EventProcessor from '../../src/event/eventProcessor';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import GuardPkHandler from '../../src/handlers/guardPkHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import { TransactionSigningContext } from '../../src/signing/transactionSigningContext';
import { TssAuthorizationRegistry } from '../../src/signing/tssAuthorizationRegistry';
import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import {
  EventStatus,
  OrderStatus,
  TransactionStatus,
} from '../../src/utils/constants';
import GuardTurn from '../../src/utils/guardTurn';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import TransactionVerifier from '../../src/verification/transactionVerifier';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
describe('Avalanche reward admission', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let scannerDb: DataSource;
  let network: AvalancheRpcNetwork;
  let scanner: AvalancheRpcScanner;
  let event: EventTrigger;
  let eventId: string;
  let payment: PaymentTransaction;
  let signed: Transaction;
  let authorization: RewardAuthorization;
  const alias = vi.fn();
  const confirmation = vi.fn();
  const consistent = vi.fn();
  const extra = vi.fn();
  let target: AbstractChain<unknown>;
  const eventTxId = 'event-creation-tx-id';
  const admit = () => authorization.bind(event, eventTxId);
  const state = async () => ({
    event: await db().getEventById(eventId),
    tx: await db().getTxById(payment.txId),
  });
  const decode = (json: string) => {
    const model = JSON.parse(json);
    return new PaymentTransaction(
      model.network,
      model.txId,
      model.eventId,
      Buffer.from(model.txBytes, 'hex'),
      model.txType,
    );
  };
  const prepare = async (source = 'ergo', destination = 'avalanche') => {
    await DatabaseActionMock.clearTables();
    event = mockEventTrigger().event;
    event.fromChain = source;
    event.toChain = destination;
    event.sourceChainHeight = 1;
    event.sourceBlockId = hash(1);
    event.WIDsCount = 1;
    event.WIDsHash = Buffer.from(
      blake2b(Buffer.from('aa'.repeat(32), 'hex'), undefined, 32),
    ).toString('hex');
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
      eventTxId,
      0,
    );
    signed = Transaction.from({
      type: 2,
      chainId: 43113,
      nonce: 0,
      to: '0x' + '11'.repeat(20),
      value: 1n,
      gasLimit: 21000n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
    });
    // Deterministic fixture key; no network signing or submission occurs.
    signed.signature = new SigningKey('0x' + '01'.repeat(32)).sign(
      signed.unsignedHash,
    );
    payment = new PaymentTransaction(
      destination,
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
    alias.mockReset().mockResolvedValue(signed.hash);
    confirmation
      .mockReset()
      .mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    consistent.mockReset().mockResolvedValue(true);
    extra.mockReset().mockReturnValue(true);
  };
  beforeEach(async () => {
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
    await prepare();
    const context = new TransactionSigningContext({
      safety: new AvalancheTransactionSafety(
        (id) => db().getEventById(id),
        () => scanner,
      ),
      getTx: (id) => db().getTxById(id),
      decode,
      registry: new TssAuthorizationRegistry(1000, 4),
    });
    target = {
      getActualTxId: alias,
      getTxConfirmationStatus: confirmation,
      verifyPaymentTransaction: consistent,
      verifyTransactionExtraConditions: extra,
    } as unknown as AbstractChain<unknown>;
    authorization = new RewardAuthorization({
      context,
      getDatabase: db,
      getChain: () => target,
    });
    vi.spyOn(RewardAuthorization, 'getInstance').mockReturnValue(authorization);
  });
  afterEach(async () => {
    network['provider'].destroy();
    await scannerDb.destroy();
    vi.restoreAllMocks();
  });

  /**
   * @target RewardAuthorization.bind 'admits %s to %s using the dedicated scanner and fresh signed settlement'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'admits %s to %s using the dedicated scanner and fresh signed settlement' with the suite's captured inputs and invoke the bind path.
   * @expected expect(action).toHaveBeenCalledOnce(); expect(bound.paymentTxId).toBe(signed.hash); expect(confirmation).toHaveBeenLastCalledWith( signed.hash, TransactionType.payment, ); expect(confirmation).toHaveBeenCalledTimes(2); expect( source === 'avalanche' ? observation : safety, ).toHaveBeenCalledTimes(2);
   */
  it.each([
    ['ergo', 'avalanche'],
    ['avalanche', 'ethereum'],
    ['avalanche', 'avalanche'],
  ])(
    'admits %s to %s using the dedicated scanner and fresh signed settlement',
    async (source, destination) => {
      await prepare(source, destination);
      const observation = vi.spyOn(scanner, 'withObservation');
      const safety = vi.spyOn(scanner, 'withSafety');
      const bound = await admit();
      const action = vi.fn();
      await bound.withAction(action);
      expect(action).toHaveBeenCalledOnce();
      expect(bound.paymentTxId).toBe(signed.hash);
      expect(confirmation).toHaveBeenLastCalledWith(
        signed.hash,
        TransactionType.payment,
      );
      expect(confirmation).toHaveBeenCalledTimes(2);
      expect(
        source === 'avalanche' ? observation : safety,
      ).toHaveBeenCalledTimes(2);
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects separate rewards for an Ergo destination'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects separate rewards for an Ergo destination' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('not eligible');
   */
  it('rejects separate rewards for an Ergo destination', async () => {
    await prepare('avalanche', 'ergo');
    await expect(admit()).rejects.toThrow('not eligible');
  });
  /**
   * @target RewardAuthorization.bind 'rejects payment status %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects payment status %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('completed payment');
   */
  it.each(
    Object.values(TransactionStatus).filter(
      (status) => status !== TransactionStatus.completed,
    ),
  )('rejects payment status %s', async (status) => {
    await db().TransactionRepository.update({ txId: payment.txId }, { status });
    await expect(admit()).rejects.toThrow('completed payment');
  });
  /**
   * @target RewardAuthorization.bind 'rejects multiple noninvalid payments even if one is completed'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects multiple noninvalid payments even if one is completed' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('exactly one');
   */
  it('rejects multiple noninvalid payments even if one is completed', async () => {
    const other = new PaymentTransaction(
      payment.network,
      'other',
      eventId,
      payment.txBytes,
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      other,
      TransactionStatus.sent,
      1,
      undefined,
      false,
      0,
      3,
    );
    await expect(admit()).rejects.toThrow('exactly one');
  });
  /**
   * @target RewardAuthorization.bind 'permits a distinct invalid previous payment'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'permits a distinct invalid previous payment' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).resolves.toMatchObject({ paymentTxId: signed.hash });
   */
  it('permits a distinct invalid previous payment', async () => {
    const other = new PaymentTransaction(
      payment.network,
      'other',
      eventId,
      payment.txBytes,
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      other,
      TransactionStatus.invalid,
      1,
      undefined,
      false,
      0,
      3,
    );
    await expect(admit()).resolves.toMatchObject({ paymentTxId: signed.hash });
  });
  /**
   * @target RewardAuthorization.bind 'rejects corrupted payment JSON %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects corrupted payment JSON %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow();
   */
  it.each(['network', 'txId', 'eventId', 'txType', 'txBytes'] as const)(
    'rejects corrupted payment JSON %s',
    async (field) => {
      const json = JSON.parse(payment.toJson());
      json[field] = 'changed';
      await db().TransactionRepository.update(
        { txId: payment.txId },
        { txJson: JSON.stringify(json) },
      );
      await expect(admit()).rejects.toThrow();
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects a completed payment carrying unsigned bytes'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects a completed payment carrying unsigned bytes' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('signed identity');
   */
  it('rejects a completed payment carrying unsigned bytes', async () => {
    payment.txBytes = Buffer.from(signed.unsignedSerialized.slice(2), 'hex');
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { txJson: payment.toJson() },
    );
    await expect(admit()).rejects.toThrow('signed identity');
  });
  /**
   * @target RewardAuthorization.bind 'rejects an alias not bound to signed bytes %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects an alias not bound to signed bytes %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('alias');
   */
  it.each(['', '0x' + '22'.repeat(32)])(
    'rejects an alias not bound to signed bytes %s',
    async (value) => {
      alias.mockResolvedValue(value);
      await expect(admit()).rejects.toThrow('alias');
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects missing settlement %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects missing settlement %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('not confirmed');
   */
  it.each([ConfirmationStatus.NotFound, ConfirmationStatus.NotConfirmedEnough])(
    'rejects missing settlement %s',
    async (status) => {
      confirmation.mockResolvedValue(status);
      await expect(admit()).rejects.toThrow('not confirmed');
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects signed payment %s validation failure'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects signed payment %s validation failure' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('inconsistent');
   */
  it.each(['consistency', 'extra'])(
    'rejects signed payment %s validation failure',
    async (kind) => {
      if (kind === 'consistency') consistent.mockResolvedValue(false);
      else extra.mockReturnValue(false);
      await expect(admit()).rejects.toThrow('inconsistent');
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects event phase %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects event phase %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('preimage');
   */
  it.each(
    Object.values(EventStatus).filter(
      (status) => status !== EventStatus.pendingReward,
    ),
  )('rejects event phase %s', async (status) => {
    await db().ConfirmedEventRepository.update({ id: eventId }, { status });
    await expect(admit()).rejects.toThrow('preimage');
  });
  /**
   * @target RewardAuthorization.bind 'rejects caller protocol mismatch %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects caller protocol mismatch %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow();
   */
  it.each([
    'amount',
    'fromChain',
    'toChain',
    'sourceTxId',
    'sourceBlockId',
    'sourceChainHeight',
    'height',
    'WIDsHash',
    'WIDsCount',
    'fromAddress',
    'toAddress',
    'bridgeFee',
    'networkFee',
    'sourceChainTokenId',
    'targetChainTokenId',
  ] as const)('rejects caller protocol mismatch %s', async (field) => {
    Object.assign(event, {
      [field]:
        typeof event[field] === 'number' ? Number(event[field]) + 1 : 'changed',
    });
    await expect(admit()).rejects.toThrow();
  });
  /**
   * @target RewardAuthorization.bind 'rejects a mismatched trigger transaction identity'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects a mismatched trigger transaction identity' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(authorization.bind(event, 'other-trigger')).rejects.toThrow( 'preimage', );
   */
  it('rejects a mismatched trigger transaction identity', async () => {
    await expect(authorization.bind(event, 'other-trigger')).rejects.toThrow(
      'preimage',
    );
  });
  /**
   * @target RewardAuthorization.bind 'denies a held scanner for source %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'denies a held scanner for source %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('not qualified');
   */
  it.each(['ergo', 'avalanche'])(
    'denies a held scanner for source %s',
    async (source) => {
      await prepare(source, source === 'ergo' ? 'avalanche' : 'ethereum');
      await scannerDb
        .getRepository(AvalancheSafetyState)
        .update({ scanner: 'avalanche' }, { holdReason: 'hold' });
      await expect(admit()).rejects.toThrow('not qualified');
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects an unknown source block hash'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects an unknown source block hash' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow();
   */
  it('rejects an unknown source block hash', async () => {
    await prepare('avalanche', 'ethereum');
    event.sourceBlockId = hash(99);
    await db().EventRepository.update(
      { id: (await db().getEventById(eventId))!.eventData.id },
      { sourceBlockId: event.sourceBlockId },
    );
    await expect(admit()).rejects.toThrow();
  });
  /**
   * @target RewardAuthorization.bind 'rechecks event %s after receipt await'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks event %s after receipt await' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(bound.withAction(action)).rejects.toThrow('changed'); expect(action).not.toHaveBeenCalled();
   */
  it.each(['status', 'firstTry', 'unexpectedFails'] as const)(
    'rechecks event %s after receipt await',
    async (field) => {
      const bound = await admit();
      confirmation.mockImplementationOnce(async () => {
        await db().ConfirmedEventRepository.update(
          { id: eventId },
          { [field]: field === 'unexpectedFails' ? 1 : 'changed' },
        );
        return ConfirmationStatus.ConfirmedEnough;
      });
      const action = vi.fn();
      await expect(bound.withAction(action)).rejects.toThrow('changed');
      expect(action).not.toHaveBeenCalled();
    },
  );
  /**
   * @target RewardAuthorization.bind 'rechecks payment %s after receipt await'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks payment %s after receipt await' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(bound.withAction(action)).rejects.toThrow('changed'); expect(action).not.toHaveBeenCalled();
   */
  it.each(['txJson', 'status', 'requiredSign', 'chain', 'type'] as const)(
    'rechecks payment %s after receipt await',
    async (field) => {
      const bound = await admit();
      confirmation.mockImplementationOnce(async () => {
        await db().TransactionRepository.update(
          { txId: payment.txId },
          { [field]: field === 'requiredSign' ? 4 : 'changed' },
        );
        return ConfirmationStatus.ConfirmedEnough;
      });
      const action = vi.fn();
      await expect(bound.withAction(action)).rejects.toThrow('changed');
      expect(action).not.toHaveBeenCalled();
    },
  );
  /**
   * @target RewardAuthorization.bind 'rechecks uniqueness after receipt await'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks uniqueness after receipt await' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(bound.withAction(vi.fn())).rejects.toThrow('changed');
   */
  it('rechecks uniqueness after receipt await', async () => {
    const bound = await admit();
    confirmation.mockImplementationOnce(async () => {
      const other = new PaymentTransaction(
        payment.network,
        'other',
        eventId,
        payment.txBytes,
        TransactionType.payment,
      );
      await DatabaseActionMock.insertTxRecord(
        other,
        TransactionStatus.completed,
        1,
        undefined,
        false,
        0,
        3,
      );
      return ConfirmationStatus.ConfirmedEnough;
    });
    await expect(bound.withAction(vi.fn())).rejects.toThrow('changed');
  });
  /**
   * @target RewardAuthorization.bind 'captures caller event before the first lookup'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'captures caller event before the first lookup' with the suite's captured inputs and invoke the bind path.
   * @expected expect(bound.event.toChain).toBe('avalanche'); expect(Object.isFrozen(bound.event)).toBe(true); await expect(bound.withAction(vi.fn())).resolves.toBeUndefined();
   */
  it('captures caller event before the first lookup', async () => {
    const pending = admit();
    event.amount = 'changed';
    event.toChain = 'changed';
    const bound = await pending;
    expect(bound.event.toChain).toBe('avalanche');
    expect(Object.isFrozen(bound.event)).toBe(true);
    await expect(bound.withAction(vi.fn())).resolves.toBeUndefined();
  });
  /**
   * @target RewardAuthorization.bind 'waits for a queued SQL owner and observes its committed mutation'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'waits for a queued SQL owner and observes its committed mutation' with the suite's captured inputs and invoke the bind path.
   * @expected expect(action).not.toHaveBeenCalled(); expect(await result).toBeInstanceOf(Error); expect(action).not.toHaveBeenCalled();
   */
  it('waits for a queued SQL owner and observes its committed mutation', async () => {
    const bound = await admit();
    let announce!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => (announce = resolve));
    const pause = new Promise<void>((resolve) => (resume = resolve));
    let writer: Promise<void> | undefined;
    confirmation.mockImplementationOnce(async () => {
      writer = db().dataSource.transaction(async (manager) => {
        announce();
        await pause;
        await manager
          .getRepository('ConfirmedEventEntity')
          .update({ id: eventId }, { status: EventStatus.inReward });
      });
      await entered;
      return ConfirmationStatus.ConfirmedEnough;
    });
    const action = vi.fn();
    const pending = bound.withAction(action);
    const result = pending.catch((error: Error) => error);
    await entered;
    await delay(20);
    expect(action).not.toHaveBeenCalled();
    resume();
    expect(await result).toBeInstanceOf(Error);
    await writer;
    expect(action).not.toHaveBeenCalled();
  });
  /**
   * @target RewardAuthorization.bind 'keeps foreign writes outside synchronous queue admission and releases on failure'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps foreign writes outside synchronous queue admission and releases on failure' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( bound.withAction(() => { writer = db().ConfirmedEventRepository.update( { id: eventId }, { firstTry: 'foreign' }, ); throw new Error('queue rejected'); }), ).rejects.toThrow('queue rejected'); expect((await db().getEventById(eventId))?.firstTry).toBe('foreign');
   */
  it('keeps foreign writes outside synchronous queue admission and releases on failure', async () => {
    const bound = await admit();
    let writer: Promise<unknown> | undefined;
    await expect(
      bound.withAction(() => {
        writer = db().ConfirmedEventRepository.update(
          { id: eventId },
          { firstTry: 'foreign' },
        );
        throw new Error('queue rejected');
      }),
    ).rejects.toThrow('queue rejected');
    await writer;
    expect((await db().getEventById(eventId))?.firstTry).toBe('foreign');
    await scanner.withSafety(async () => undefined);
  });

  const producer = () => {
    const reward = new ErgoTransaction(
      'reward-id',
      eventId,
      Buffer.from('abcd', 'hex'),
      TransactionType.reward,
      [],
      [],
    );
    const queue = vi.fn();
    const generate = vi
      .spyOn(
        EventProcessor as unknown as {
          createEventRewardDistribution(): Promise<PaymentTransaction>;
        },
        'createEventRewardDistribution',
      )
      .mockResolvedValue(reward);
    vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue(
      {} as never,
    );
    vi.spyOn(TxAgreement, 'getInstance').mockResolvedValue({
      addTransactionToQueue: queue,
    } as unknown as TxAgreement);
    vi.spyOn(GuardTurn, 'guardTurn').mockReturnValue(
      GuardPkHandler.getInstance().guardId,
    );
    return { reward, queue, generate };
  };
  /**
   * @target EventProcessor.processRewardEvent 'joins generation to fresh qualified queue admission'
   * @dependencies Actual EventProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'joins generation to fresh qualified queue admission' through EventProcessor.processRewardEvent.
   * @expected expect(generate).toHaveBeenCalledWith( expect.objectContaining({ toChain: 'avalanche' }), eventTxId, {}, signed.hash, ['aa'.repeat(32)], ); expect(queue).toHaveBeenCalledOnce(); expect(confirmation).toHaveBeenCalledTimes(2);
   */
  it('joins generation to fresh qualified queue admission', async () => {
    const { queue, generate } = producer();
    await EventProcessor.processRewardEvent(event, eventTxId);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ toChain: 'avalanche' }),
      eventTxId,
      {},
      signed.hash,
      ['aa'.repeat(32)],
    );
    expect(queue).toHaveBeenCalledOnce();
    expect(confirmation).toHaveBeenCalledTimes(2);
  });
  /**
   * @target EventProcessor.processRewardEvent 'does not queue when confirmation is lost during generation'
   * @dependencies Actual EventProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'does not queue when confirmation is lost during generation' through EventProcessor.processRewardEvent.
   * @expected await expect( EventProcessor.processRewardEvent(event, eventTxId), ).rejects.toThrow('not confirmed'); expect(queue).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
   */
  it('does not queue when confirmation is lost during generation', async () => {
    const { queue, generate, reward } = producer();
    generate.mockImplementation(async () => {
      confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
      return reward;
    });
    const before = await state();
    await expect(
      EventProcessor.processRewardEvent(event, eventTxId),
    ).rejects.toThrow('not confirmed');
    expect(queue).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
  /**
   * @target EventProcessor.processRewardEvent 'does not blindly reset a changed event on insufficient assets'
   * @dependencies Actual EventProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'does not blindly reset a changed event on insufficient assets' through EventProcessor.processRewardEvent.
   * @expected await expect( EventProcessor.processRewardEvent(event, eventTxId), ).rejects.toThrow(); expect(queue).not.toHaveBeenCalled(); expect((await db().getEventById(eventId))?.status).toBe( EventStatus.inReward, );
   */
  it('does not blindly reset a changed event on insufficient assets', async () => {
    const { queue, generate } = producer();
    generate.mockImplementation(async () => {
      await db().ConfirmedEventRepository.update(
        { id: eventId },
        { status: EventStatus.inReward },
      );
      throw new NotEnoughAssetsError('fixture');
    });
    await expect(
      EventProcessor.processRewardEvent(event, eventTxId),
    ).rejects.toThrow();
    expect(queue).not.toHaveBeenCalled();
    expect((await db().getEventById(eventId))?.status).toBe(
      EventStatus.inReward,
    );
  });
  /**
   * @target TransactionVerifier.verifyEventTransaction 'remote reward verification refreshes confirmation after constructing the expected order'
   * @dependencies Actual TransactionVerifier sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'remote reward verification refreshes confirmation after constructing the expected order' through TransactionVerifier.verifyEventTransaction.
   * @expected await expect( TransactionVerifier.verifyEventTransaction(reward, event, eventTxId), ).rejects.toThrow('not confirmed');
   */
  it('remote reward verification refreshes confirmation after constructing the expected order', async () => {
    const { reward } = producer();
    const chain = {
      extractTransactionOrder: () => [],
    } as unknown as AbstractChain<unknown>;
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getChain: () => chain,
    } as unknown as ChainHandler);
    vi.spyOn(EventOrder, 'createEventRewardOrder').mockImplementation(
      async () => {
        confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
        return [];
      },
    );
    await expect(
      TransactionVerifier.verifyEventTransaction(reward, event, eventTxId),
    ).rejects.toThrow('not confirmed');
  });
  /**
   * @target TransactionVerifier.verifyEventTransaction 'admits a remote reward only after fresh confirmation and exact order'
   * @dependencies Actual TransactionVerifier sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'admits a remote reward only after fresh confirmation and exact order' through TransactionVerifier.verifyEventTransaction.
   * @expected await expect( TransactionVerifier.verifyEventTransaction(reward, event, eventTxId), ).resolves.toBe(true); expect(confirmation).toHaveBeenCalledTimes(2);
   */
  it('admits a remote reward only after fresh confirmation and exact order', async () => {
    const { reward } = producer();
    const chain = {
      extractTransactionOrder: () => [],
    } as unknown as AbstractChain<unknown>;
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getChain: () => chain,
    } as unknown as ChainHandler);
    vi.spyOn(EventOrder, 'createEventRewardOrder').mockResolvedValue([]);
    await expect(
      TransactionVerifier.verifyEventTransaction(reward, event, eventTxId),
    ).resolves.toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(2);
  });
  /**
   * @target TransactionVerifier.verifyEventTransaction 'rejects original remote reward %s mutation during order await'
   * @dependencies Actual TransactionVerifier sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects original remote reward %s mutation during order await' through TransactionVerifier.verifyEventTransaction.
   * @expected await expect( TransactionVerifier.verifyEventTransaction(reward, event, eventTxId), ).rejects.toThrow('changed');
   */
  it.each([
    'txId',
    'network',
    'eventId',
    'txType',
    'txBytes',
    'inputBoxes',
    'dataInputs',
  ] as const)(
    'rejects original remote reward %s mutation during order await',
    async (field) => {
      const { reward } = producer();
      const chain = {
        extractTransactionOrder: () => [],
      } as unknown as AbstractChain<unknown>;
      vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
        getChain: () => chain,
      } as unknown as ChainHandler);
      vi.spyOn(EventOrder, 'createEventRewardOrder').mockImplementation(
        async () => {
          Object.assign(reward, {
            [field]:
              field === 'txBytes'
                ? Buffer.from('cafe', 'hex')
                : ['inputBoxes', 'dataInputs'].includes(field)
                  ? [Buffer.from('cafe', 'hex')]
                  : 'changed',
          });
          return [];
        },
      );
      await expect(
        TransactionVerifier.verifyEventTransaction(reward, event, eventTxId),
      ).rejects.toThrow('changed');
    },
  );
  /**
   * @target EventProcessor.processRewardEvent 'rejects original generated reward mutation during agreement lookup'
   * @dependencies Actual EventProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects original generated reward mutation during agreement lookup' through EventProcessor.processRewardEvent.
   * @expected await expect( EventProcessor.processRewardEvent(event, eventTxId), ).rejects.toThrow('changed'); expect(queue).not.toHaveBeenCalled();
   */
  it('rejects original generated reward mutation during agreement lookup', async () => {
    const { reward, queue } = producer();
    vi.mocked(TxAgreement.getInstance).mockImplementation(async () => {
      reward.txBytes[0] = 0;
      return { addTransactionToQueue: queue } as unknown as TxAgreement;
    });
    await expect(
      EventProcessor.processRewardEvent(event, eventTxId),
    ).rejects.toThrow('changed');
    expect(queue).not.toHaveBeenCalled();
  });
  /**
   * @target EventProcessor.processRewardEvent 'does not queue if the scanner becomes held while generation is running'
   * @dependencies Actual EventProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'does not queue if the scanner becomes held while generation is running' through EventProcessor.processRewardEvent.
   * @expected await expect( EventProcessor.processRewardEvent(event, eventTxId), ).rejects.toThrow('not qualified'); expect(queue).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
   */
  it('does not queue if the scanner becomes held while generation is running', async () => {
    const { reward, queue, generate } = producer();
    generate.mockImplementation(async () => {
      await scannerDb
        .getRepository(AvalancheSafetyState)
        .update(
          { scanner: 'avalanche' },
          { holdReason: 'held during generation' },
        );
      return reward;
    });
    const before = await state();
    await expect(
      EventProcessor.processRewardEvent(event, eventTxId),
    ).rejects.toThrow('not qualified');
    expect(queue).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
  /**
   * @target RewardAuthorization.bind 'does not reacquire scanner ownership in the explicit under-lease primitive'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not reacquire scanner ownership in the explicit under-lease primitive' with the suite's captured inputs and invoke the bind path.
   * @expected expect(lease).toHaveBeenCalledOnce(); expect(action).toHaveBeenCalledOnce();
   */
  it('does not reacquire scanner ownership in the explicit under-lease primitive', async () => {
    const bound = await admit();
    const lease = vi.spyOn(scanner, 'withSafety');
    const action = vi.fn();
    await scanner.withSafety(() => bound.checkUnderScannerLease(action));
    expect(lease).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });
  /**
   * @target EventProcessor.processRewardEvent 'rejects commitment %s mutation during generation'
   * @dependencies Actual EventProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects commitment %s mutation during generation' through EventProcessor.processRewardEvent.
   * @expected await expect( EventProcessor.processRewardEvent(event, eventTxId), ).rejects.toThrow('commitment inputs'); expect(queue).not.toHaveBeenCalled();
   */
  it.each([
    'WID',
    'serialized',
    'spendIndex',
    'spendTxId',
    'rwtCount',
    'commitment',
  ] as const)(
    'rejects commitment %s mutation during generation',
    async (field) => {
      const { reward, queue, generate } = producer();
      generate.mockImplementation(async () => {
        await db().CommitmentRepository.update(
          { eventId },
          { [field]: field === 'spendIndex' ? 1 : 'changed' },
        );
        return reward;
      });
      await expect(
        EventProcessor.processRewardEvent(event, eventTxId),
      ).rejects.toThrow('commitment inputs');
      expect(queue).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionVerifier.verifyEventTransaction 'rejects new unmerged commitment rows during remote order construction'
   * @dependencies Actual TransactionVerifier sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects new unmerged commitment rows during remote order construction' through TransactionVerifier.verifyEventTransaction.
   * @expected await expect( TransactionVerifier.verifyEventTransaction(reward, event, eventTxId), ).rejects.toThrow('commitment inputs');
   */
  it('rejects new unmerged commitment rows during remote order construction', async () => {
    const { reward } = producer();
    const chain = {
      extractTransactionOrder: () => [],
    } as unknown as AbstractChain<unknown>;
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getChain: () => chain,
    } as unknown as ChainHandler);
    vi.spyOn(EventOrder, 'createEventRewardOrder').mockImplementation(
      async () => {
        await DatabaseActionMock.insertCommitmentBoxRecord(
          event,
          eventId,
          'Yg==',
          'bb'.repeat(32),
          event.height - 1,
          '1',
        );
        return [];
      },
    );
    await expect(
      TransactionVerifier.verifyEventTransaction(reward, event, eventTxId),
    ).rejects.toThrow('commitment inputs');
  });
  /**
   * @target EventProcessor.processRewardEvent 'rejects a changed fee configuration during generation'
   * @dependencies Actual EventProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects a changed fee configuration during generation' through EventProcessor.processRewardEvent.
   * @expected await expect( EventProcessor.processRewardEvent(event, eventTxId), ).rejects.toThrow('fee configuration'); expect(queue).not.toHaveBeenCalled();
   */
  it('rejects a changed fee configuration during generation', async () => {
    const { reward, queue, generate } = producer();
    generate.mockImplementation(async () => {
      vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
        networkFee: 2n,
      } as never);
      return reward;
    });
    await expect(
      EventProcessor.processRewardEvent(event, eventTxId),
    ).rejects.toThrow('fee configuration');
    expect(queue).not.toHaveBeenCalled();
  });
  /**
   * @target RewardAuthorization.bind 'rechecks fee authority after awaited owned-manager assertions'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks fee authority after awaited owned-manager assertions' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( bound.withAction( () => { inputs.assertFee(); action(); }, async (manager) => { await inputs.assertInputs(manager); vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({ networkFee: 2n, } as never); }, ), ).rejects.toThrow('fee configuration'); expect(action).not.toHaveBeenCalled();
   */
  it('rechecks fee authority after awaited owned-manager assertions', async () => {
    producer();
    const bound = await admit();
    const inputs = await authorization.captureOrderInputs(
      bound.event,
      eventTxId,
    );
    const action = vi.fn();
    await expect(
      bound.withAction(
        () => {
          inputs.assertFee();
          action();
        },
        async (manager) => {
          await inputs.assertInputs(manager);
          vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
            networkFee: 2n,
          } as never);
        },
      ),
    ).rejects.toThrow('fee configuration');
    expect(action).not.toHaveBeenCalled();
  });
  /**
   * @target RewardAuthorization.bind 'rechecks core event identity after an owned-manager assertion'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks core event identity after an owned-manager assertion' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( bound.withAction(action, async (manager) => { await manager .getRepository('ConfirmedEventEntity') .update({ id: eventId }, { status: EventStatus.inReward }); }), ).rejects.toThrow('changed'); expect(action).not.toHaveBeenCalled(); expect((await db().getEventById(eventId))?.status).toBe( EventStatus.pendingReward, );
   */
  it('rechecks core event identity after an owned-manager assertion', async () => {
    const bound = await admit();
    const action = vi.fn();
    await expect(
      bound.withAction(action, async (manager) => {
        await manager
          .getRepository('ConfirmedEventEntity')
          .update({ id: eventId }, { status: EventStatus.inReward });
      }),
    ).rejects.toThrow('changed');
    expect(action).not.toHaveBeenCalled();
    expect((await db().getEventById(eventId))?.status).toBe(
      EventStatus.pendingReward,
    );
  });
  /**
   * @target RewardAuthorization.captureOrderInputs 'rejects noncanonical merged WID even when Node decodes its hash %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects noncanonical merged WID even when Node decodes its hash %s' with the suite's captured inputs and invoke the captureOrderInputs path.
   * @expected await expect( authorization.captureOrderInputs(event, eventTxId), ).rejects.toThrow('WID inputs');
   */
  it.each(['AA'.repeat(32), 'aa'.repeat(32) + 'xx', 'aa', '', 'gg'.repeat(32)])(
    'rejects noncanonical merged WID even when Node decodes its hash %s',
    async (wid) => {
      producer();
      await db().CommitmentRepository.update({ eventId }, { WID: wid });
      event.WIDsHash = Buffer.from(
        blake2b(Buffer.from(wid, 'hex'), undefined, 32),
      ).toString('hex');
      await expect(
        authorization.captureOrderInputs(event, eventTxId),
      ).rejects.toThrow('WID inputs');
    },
  );
  /**
   * @target RewardAuthorization.bind 'denies an absent scanner safety state'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'denies an absent scanner safety state' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow();
   */
  it('denies an absent scanner safety state', async () => {
    await scannerDb
      .getRepository(AvalancheSafetyState)
      .delete({ scanner: 'avalanche' });
    await expect(admit()).rejects.toThrow();
  });
  /**
   * @target RewardAuthorization.bind 'requires an actual dedicated scanner instance %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'requires an actual dedicated scanner instance %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('dedicated scanner');
   */
  it.each([undefined, {}])(
    'requires an actual dedicated scanner instance %s',
    async (replacement) => {
      scanner = replacement as AvalancheRpcScanner;
      await expect(admit()).rejects.toThrow('dedicated scanner');
    },
  );
  /**
   * @target EventProcessor.processRewardEvent, TransactionVerifier.verifyEventTransaction 'rejects trigger serialized-box mutation during %s'
   * @dependencies Actual EventProcessor, TransactionVerifier sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects trigger serialized-box mutation during %s' through EventProcessor.processRewardEvent and TransactionVerifier.verifyEventTransaction.
   * @expected await expect( EventProcessor.processRewardEvent(event, eventTxId), ).rejects.toThrow('changed'); expect(queue).not.toHaveBeenCalled(); await expect( TransactionVerifier.verifyEventTransaction(reward, event, eventTxId), ).rejects.toThrow('changed');
   */
  it.each(['generation', 'remote-order'])(
    'rejects trigger serialized-box mutation during %s',
    async (phase) => {
      const { reward, queue, generate } = producer();
      const change = async () => {
        const stored = (await db().getEventById(eventId))!;
        await db().EventRepository.update(
          { id: stored.eventData.id },
          { serialized: 'changed-box' },
        );
      };
      if (phase === 'generation') {
        generate.mockImplementation(async () => {
          await change();
          return reward;
        });
        await expect(
          EventProcessor.processRewardEvent(event, eventTxId),
        ).rejects.toThrow('changed');
        expect(queue).not.toHaveBeenCalled();
      } else {
        const chain = {
          extractTransactionOrder: () => [],
        } as unknown as AbstractChain<unknown>;
        vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
          getChain: () => chain,
        } as unknown as ChainHandler);
        vi.spyOn(EventOrder, 'createEventRewardOrder').mockImplementation(
          async () => {
            await change();
            return [];
          },
        );
        await expect(
          TransactionVerifier.verifyEventTransaction(reward, event, eventTxId),
        ).rejects.toThrow('changed');
      }
    },
  );
  /**
   * @target TransactionVerifier.verifyEventTransaction 'rejects mutation of copied reward %s during order extraction'
   * @dependencies Actual TransactionVerifier sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects mutation of copied reward %s during order extraction' through TransactionVerifier.verifyEventTransaction.
   * @expected await expect( TransactionVerifier.verifyEventTransaction(reward, event, eventTxId), ).rejects.toThrow('changed');
   */
  it.each(['inputBoxes', 'dataInputs'] as const)(
    'rejects mutation of copied reward %s during order extraction',
    async (field) => {
      const { reward } = producer();
      const chain = {
        extractTransactionOrder: (tx: ErgoTransaction) => {
          tx[field].push(Buffer.from('cafe', 'hex'));
          return [];
        },
      } as unknown as AbstractChain<unknown>;
      vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
        getChain: () => chain,
      } as unknown as ChainHandler);
      vi.spyOn(EventOrder, 'createEventRewardOrder').mockResolvedValue([]);
      await expect(
        TransactionVerifier.verifyEventTransaction(reward, event, eventTxId),
      ).rejects.toThrow('changed');
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects ambiguous trigger transaction lookup at %s'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects ambiguous trigger transaction lookup at %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('changed'); await expect( EventProcessor.processRewardEvent(event, eventTxId), ).rejects.toThrow('changed'); expect(queue).not.toHaveBeenCalled();
   */
  it.each(['initial', 'generation'])(
    'rejects ambiguous trigger transaction lookup at %s',
    async (phase) => {
      const duplicate = async () => {
        const stored = (await db().getEventById(eventId))!;
        await db().EventRepository.save({
          ...stored.eventData,
          id: undefined,
          identifier: 'other-trigger-box',
          serialized: 'other-body',
        });
      };
      if (phase === 'initial') {
        await duplicate();
        await expect(admit()).rejects.toThrow('changed');
      } else {
        const { reward, queue, generate } = producer();
        generate.mockImplementation(async () => {
          await duplicate();
          return reward;
        });
        await expect(
          EventProcessor.processRewardEvent(event, eventTxId),
        ).rejects.toThrow('changed');
        expect(queue).not.toHaveBeenCalled();
      }
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects an already spent trigger'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects an already spent trigger' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('preimage');
   */
  it('rejects an already spent trigger', async () => {
    const stored = (await db().getEventById(eventId))!;
    await db().EventRepository.update(
      { id: stored.eventData.id },
      { spendHeight: 10 },
    );
    await expect(admit()).rejects.toThrow('preimage');
  });
  /**
   * @target RewardAuthorization.bind 'rejects trigger %s mutation after receipt await'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects trigger %s mutation after receipt await' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(bound.withAction(vi.fn())).rejects.toThrow('changed');
   */
  it.each([
    'identifier',
    'extractor',
    'block',
    'spendHeight',
    'spendBlock',
    'spendTxId',
  ] as const)(
    'rejects trigger %s mutation after receipt await',
    async (field) => {
      const bound = await admit();
      confirmation.mockImplementationOnce(async () => {
        const stored = (await db().getEventById(eventId))!;
        await db().EventRepository.update(
          { id: stored.eventData.id },
          { [field]: field === 'spendHeight' ? 10 : 'changed' },
        );
        return ConfirmationStatus.ConfirmedEnough;
      });
      await expect(bound.withAction(vi.fn())).rejects.toThrow('changed');
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects a different trigger relation ID at final admission'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects a different trigger relation ID at final admission' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(bound.withAction(vi.fn())).rejects.toThrow('changed');
   */
  it('rejects a different trigger relation ID at final admission', async () => {
    const bound = await admit();
    confirmation.mockImplementationOnce(async () => {
      const stored = (await db().getEventById(eventId))!;
      const replacement = await db().EventRepository.save(
        db().EventRepository.create({
          ...stored.eventData,
          id: undefined,
          identifier: 'new-trigger-box',
        }),
      );
      await db().ConfirmedEventRepository.update(
        { id: eventId },
        { eventData: { id: replacement.id } },
      );
      return ConfirmationStatus.ConfirmedEnough;
    });
    await expect(bound.withAction(vi.fn())).rejects.toThrow('changed');
  });
  /**
   * @target RewardAuthorization.bind 'rejects an initially populated %s even without spendHeight'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects an initially populated %s even without spendHeight' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(admit()).rejects.toThrow('preimage');
   */
  it.each(['spendBlock', 'spendTxId', 'result', 'paymentTxId'] as const)(
    'rejects an initially populated %s even without spendHeight',
    async (field) => {
      await db().EventRepository.update({ eventId }, { [field]: 'spent' });
      await expect(admit()).rejects.toThrow('preimage');
    },
  );
  /**
   * @target RewardAuthorization.bind 'rejects payment %s after receipt await'
   * @dependencies Actual RewardAuthorization from verification/rewardAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects payment %s after receipt await' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(bound.withAction(action)).rejects.toThrow('changed'); expect(action).not.toHaveBeenCalled();
   */
  it.each(['deleted', 'detached-event', 'reassigned-event', 'order'])(
    'rejects payment %s after receipt await',
    async (fault) => {
      const bound = await admit();
      confirmation.mockImplementationOnce(async () => {
        if (fault === 'deleted')
          await db().TransactionRepository.delete({ txId: payment.txId });
        else if (fault === 'detached-event')
          await db().TransactionRepository.update(
            { txId: payment.txId },
            { event: null },
          );
        else if (fault === 'reassigned-event') {
          const other = { ...event, sourceTxId: 'other-source' };
          await DatabaseActionMock.insertEventRecord(
            other,
            EventStatus.pendingReward,
          );
          await db().TransactionRepository.update(
            { txId: payment.txId },
            { event: { id: EventSerializer.getId(other) } },
          );
        } else {
          await DatabaseActionMock.insertOrderRecord(
            'injected-order',
            'ergo',
            '[]',
            OrderStatus.pending,
          );
          await db().TransactionRepository.update(
            { txId: payment.txId },
            { order: { id: 'injected-order' } },
          );
        }
        return ConfirmationStatus.ConfirmedEnough;
      });
      const action = vi.fn();
      await expect(bound.withAction(action)).rejects.toThrow('changed');
      expect(action).not.toHaveBeenCalled();
    },
  );
});
