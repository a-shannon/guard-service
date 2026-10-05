import '@rosen-bridge/extended-typeorm/bootstrap';

import { blake2b } from 'blakejs';

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
import { EventTrigger, TransactionType } from '@rosen-chains/abstract-chain';

import {
  AvalancheTransactionEvent,
  AvalancheTransactionIntent,
  AvalancheTransactionSafety,
} from '../../src/utils/avalancheTransactionSafety';

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
const eventId = (txId: string) =>
  Buffer.from(blake2b(txId, undefined, 32)).toString('hex');
const makeEvent = (): AvalancheTransactionEvent => ({
  id: eventId('synthetic-source-tx'),
  eventData: {
    height: 4,
    fromChain: 'avalanche',
    toChain: 'ergo',
    fromAddress: 'source-address',
    toAddress: 'destination-address',
    amount: '10',
    bridgeFee: '1',
    networkFee: '1',
    sourceChainTokenId: 'avax',
    targetChainTokenId: 'wrapped-avax',
    sourceTxId: 'synthetic-source-tx',
    sourceChainHeight: 1,
    sourceBlockId: hash(1),
    WIDsHash: 'wid-hash',
    WIDsCount: 1,
  },
});

describe('AvalancheTransactionSafety', () => {
  let database: DataSource;
  let network: AvalancheRpcNetwork;
  let scanner: AvalancheRpcScanner;
  let event: AvalancheTransactionEvent;
  let intent: AvalancheTransactionIntent;
  let getEvent: ReturnType<
    typeof vi.fn<(id: string) => Promise<AvalancheTransactionEvent | null>>
  >;
  let getScanner: ReturnType<
    typeof vi.fn<() => AvalancheRpcScanner | undefined>
  >;
  let safety: AvalancheTransactionSafety;
  const action = () => vi.fn(async () => 'dispatched');

  beforeEach(async () => {
    database = await new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [BlockEntity, ExtractorStatusEntity, AvalancheSafetyState],
      migrations: [...migrations.sqlite, AvalancheSafetyState1790769600000],
      synchronize: false,
    }).initialize();
    await database.runMigrations();
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
      dataSource: database,
      sourceId: 'synthetic-action-source',
      initialHeight: 0,
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 0,
      },
    });
    await scanner.update();
    event = makeEvent();
    intent = {
      network: 'ergo',
      eventId: event.id,
      txType: TransactionType.payment,
      txId: 'synthetic-payment-id',
      txBytes: 'abcd',
    };
    getEvent = vi.fn(async () => event);
    getScanner = vi.fn(() => scanner);
    safety = new AvalancheTransactionSafety(getEvent, getScanner);
  });

  afterEach(async () => {
    network['provider'].destroy();
    await database.destroy();
    vi.restoreAllMocks();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'admits source Avalanche %s only through completed observation'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'admits source Avalanche %s only through completed observation' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect( safety.withTransaction({ ...intent, txType }, dispatch), ).resolves.toBe('dispatched'); expect(observation).toHaveBeenCalledWith( 1, hash(1), expect.any(Function), ); expect(dispatch).toHaveBeenCalledOnce(); expect(getEvent).toHaveBeenCalledTimes(2);
   */
  it.each([TransactionType.payment, TransactionType.reward])(
    'admits source Avalanche %s only through completed observation',
    async (txType) => {
      const observation = vi.spyOn(scanner, 'withObservation');
      const dispatch = action();
      await expect(
        safety.withTransaction({ ...intent, txType }, dispatch),
      ).resolves.toBe('dispatched');
      expect(observation).toHaveBeenCalledWith(
        1,
        hash(1),
        expect.any(Function),
      );
      expect(dispatch).toHaveBeenCalledOnce();
      expect(getEvent).toHaveBeenCalledTimes(2);
    },
  );

  /**
   * @target AvalancheTransactionSafety.withTransaction 'uses a safety lease for destination Avalanche without a local source observation'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'uses a safety lease for destination Avalanche without a local source observation' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect( safety.withTransaction({ ...intent, network: 'avalanche' }, action()), ).resolves.toBe('dispatched'); expect(observation).not.toHaveBeenCalled(); expect(lease).toHaveBeenCalledOnce();
   */
  it('uses a safety lease for destination Avalanche without a local source observation', async () => {
    event.eventData.fromChain = 'ergo';
    event.eventData.toChain = 'avalanche';
    event.eventData.sourceBlockId = 'external-block';
    const observation = vi.spyOn(scanner, 'withObservation');
    const lease = vi.spyOn(scanner, 'withSafety');
    await expect(
      safety.withTransaction({ ...intent, network: 'avalanche' }, action()),
    ).resolves.toBe('dispatched');
    expect(observation).not.toHaveBeenCalled();
    expect(lease).toHaveBeenCalledOnce();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'guards Ergo rewards for an Avalanche destination'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'guards Ergo rewards for an Avalanche destination' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect( safety.withTransaction( { ...intent, txType: TransactionType.reward }, dispatch, ), ).rejects.toThrow('not qualified'); expect(dispatch).not.toHaveBeenCalled();
   */
  it('guards Ergo rewards for an Avalanche destination', async () => {
    event.eventData.fromChain = 'ergo';
    event.eventData.toChain = 'avalanche';
    await database
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'held' });
    const dispatch = action();
    await expect(
      safety.withTransaction(
        { ...intent, txType: TransactionType.reward },
        dispatch,
      ),
    ).rejects.toThrow('not qualified');
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'requires a completed source observation when both directions are Avalanche'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'requires a completed source observation when both directions are Avalanche' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect( safety.withTransaction({ ...intent, network: 'avalanche' }, dispatch), ).rejects.toThrow('no matching completed block'); expect(dispatch).not.toHaveBeenCalled();
   */
  it('requires a completed source observation when both directions are Avalanche', async () => {
    event.eventData.toChain = 'avalanche';
    event.eventData.sourceBlockId = hash(8);
    const dispatch = action();
    await expect(
      safety.withTransaction({ ...intent, network: 'avalanche' }, dispatch),
    ).rejects.toThrow('no matching completed block');
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'rejects persisted %s'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects persisted %s' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow( 'not qualified', ); expect(dispatch).not.toHaveBeenCalled();
   */
  it.each([
    ['hold', { holdReason: 'held' }],
    ['source', { sourceId: 'unknown-source' }],
    ['chain', { chainId: '43114' }],
    ['policy', { policy: 'unknown-policy' }],
    ['unqualified frontier', { finalizedHeight: null }],
  ] as const)('rejects persisted %s', async (_, patch) => {
    await database
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, patch);
    const dispatch = action();
    await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow(
      'not qualified',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'rejects absent persisted safety state'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects absent persisted safety state' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow( 'not qualified', ); expect(dispatch).not.toHaveBeenCalled();
   */
  it('rejects absent persisted safety state', async () => {
    await database.getRepository(AvalancheSafetyState).clear();
    const dispatch = action();
    await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow(
      'not qualified',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'rejects source block %s mismatch'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects source block %s mismatch' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow( 'no matching completed block', ); expect(dispatch).not.toHaveBeenCalled();
   */
  it.each([
    ['hash', { hash: hash(9) }],
    ['scanner', { scanner: 'ethereum' }],
    ['status', { status: 'PROCESSING' }],
  ])('rejects source block %s mismatch', async (_, patch) => {
    await database.getRepository(BlockEntity).update({ height: 1 }, patch);
    const dispatch = action();
    await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow(
      'no matching completed block',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'does not bypass residual Avalanche events when scanner is absent or generic'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not bypass residual Avalanche events when scanner is absent or generic' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow( 'dedicated scanner', ); expect(dispatch).not.toHaveBeenCalled();
   */
  it.each([undefined, { withSafety: vi.fn(), withObservation: vi.fn() }])(
    'does not bypass residual Avalanche events when scanner is absent or generic',
    async (value) => {
      getScanner.mockReturnValue(value as AvalancheRpcScanner | undefined);
      const dispatch = action();
      await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow(
        'dedicated scanner',
      );
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  /**
   * @target AvalancheTransactionSafety.withTransaction 'validates non-Avalanche events then passes through without scanner access'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'validates non-Avalanche events then passes through without scanner access' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect(safety.withTransaction(intent, action())).resolves.toBe( 'dispatched', ); expect(getEvent).toHaveBeenCalledTimes(2); expect(getScanner).not.toHaveBeenCalled();
   */
  it('validates non-Avalanche events then passes through without scanner access', async () => {
    event.eventData.fromChain = 'ethereum';
    await expect(safety.withTransaction(intent, action())).resolves.toBe(
      'dispatched',
    );
    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(getScanner).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'rejects Avalanche management type %s while preserving other-chain management'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects Avalanche management type %s while preserving other-chain management' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect( safety.withTransaction( { ...intent, network: 'avalanche', txType }, dispatch, ), ).rejects.toThrow('routes are disabled'); expect(dispatch).not.toHaveBeenCalled(); await expect( safety.withTransaction({ ...intent, txType, eventId: '' }, dispatch), ).resolves.toBe('dispatched'); expect(getEvent).not.toHaveBeenCalled();
   */
  it.each([
    TransactionType.coldStorage,
    TransactionType.manual,
    TransactionType.arbitrary,
    TransactionType.lock,
  ])(
    'rejects Avalanche management type %s while preserving other-chain management',
    async (txType) => {
      const dispatch = action();
      await expect(
        safety.withTransaction(
          { ...intent, network: 'avalanche', txType },
          dispatch,
        ),
      ).rejects.toThrow('routes are disabled');
      expect(dispatch).not.toHaveBeenCalled();
      await expect(
        safety.withTransaction({ ...intent, txType, eventId: '' }, dispatch),
      ).resolves.toBe('dispatched');
      expect(getEvent).not.toHaveBeenCalled();
    },
  );

  /**
   * @target AvalancheTransactionSafety.withTransaction 'rejects %s event context'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s event context' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow(); expect(dispatch).not.toHaveBeenCalled();
   */
  it.each([
    'missing-event',
    'missing-data',
    'wrong-id',
    'wrong-source-tx',
    'missing-chain',
    'uppercase-chain',
    'missing-field',
  ])('rejects %s event context', async (fault) => {
    if (fault === 'missing-event') getEvent.mockResolvedValue(null);
    if (fault === 'missing-data')
      event.eventData = undefined as unknown as EventTrigger;
    if (fault === 'wrong-id') event.id = 'a'.repeat(64);
    if (fault === 'wrong-source-tx')
      event.eventData.sourceTxId = 'another-source-tx';
    if (fault === 'missing-chain') event.eventData.fromChain = '';
    if (fault === 'uppercase-chain') event.eventData.fromChain = 'Avalanche';
    if (fault === 'missing-field')
      delete (event.eventData as Partial<EventTrigger>).amount;
    const dispatch = action();
    await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'rejects malformed numeric event field $field=$value'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects malformed numeric event field $field=$value' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow( 'context is malformed', ); expect(dispatch).not.toHaveBeenCalled();
   */
  it.each(
    (['height', 'sourceChainHeight', 'WIDsCount'] as const).flatMap((field) =>
      [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, '1', undefined].map(
        (value) => ({ field, value }),
      ),
    ),
  )(
    'rejects malformed numeric event field $field=$value',
    async ({ field, value }) => {
      Object.assign(event.eventData, { [field]: value });
      const dispatch = action();
      await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow(
        'context is malformed',
      );
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  /**
   * @target AvalancheTransactionSafety.withTransaction 'rejects missing string event field %s'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects missing string event field %s' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow( 'context is malformed', ); expect(dispatch).not.toHaveBeenCalled();
   */
  it.each([
    'fromAddress',
    'toAddress',
    'amount',
    'bridgeFee',
    'networkFee',
    'sourceChainTokenId',
    'targetChainTokenId',
    'sourceBlockId',
    'WIDsHash',
  ] as const)('rejects missing string event field %s', async (field) => {
    delete (event.eventData as Partial<EventTrigger>)[field];
    const dispatch = action();
    await expect(safety.withTransaction(intent, dispatch)).rejects.toThrow(
      'context is malformed',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'rejects invalid intent %j'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects invalid intent %j' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect( safety.withTransaction( { ...intent, ...patch } as AvalancheTransactionIntent, dispatch, ), ).rejects.toThrow(); expect(dispatch).not.toHaveBeenCalled();
   */
  it.each([
    { network: 'bitcoin' },
    { network: 'avalanche', txType: TransactionType.reward },
    { eventId: '' },
    { txId: '' },
    { txBytes: '' },
    { txBytes: '0x12' },
    { txBytes: 'abc' },
    { txType: 'unknown' },
  ])('rejects invalid intent %j', async (patch) => {
    const dispatch = action();
    await expect(
      safety.withTransaction(
        { ...intent, ...patch } as AvalancheTransactionIntent,
        dispatch,
      ),
    ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'rejects %s drift after initial binding'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s drift after initial binding' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected await expect(bound.withAction(dispatch)).rejects.toThrow('event changed'); expect(dispatch).not.toHaveBeenCalled(); await expect(scanner.withSafety(() => 'released')).resolves.toBe( 'released', );
   */
  it.each([
    'fromChain',
    'fromAddress',
    'toAddress',
    'amount',
    'bridgeFee',
    'networkFee',
    'sourceBlockId',
    'sourceChainTokenId',
    'targetChainTokenId',
    'WIDsHash',
  ] as const)('rejects %s drift after initial binding', async (field) => {
    const bound = await safety.bindTransaction(intent);
    event.eventData[field] = field === 'fromChain' ? 'ethereum' : 'changed';
    const dispatch = action();
    await expect(bound.withAction(dispatch)).rejects.toThrow('event changed');
    expect(dispatch).not.toHaveBeenCalled();
    await expect(scanner.withSafety(() => 'released')).resolves.toBe(
      'released',
    );
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'rejects numeric %s drift'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects numeric %s drift' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected await expect(bound.withAction(dispatch)).rejects.toThrow('event changed'); expect(dispatch).not.toHaveBeenCalled();
   */
  it.each(['height', 'sourceChainHeight', 'WIDsCount'] as const)(
    'rejects numeric %s drift',
    async (field) => {
      const bound = await safety.bindTransaction(intent);
      event.eventData[field]++;
      const dispatch = action();
      await expect(bound.withAction(dispatch)).rejects.toThrow('event changed');
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'rejects invalid %s after binding'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects invalid %s after binding' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected await expect(bound.withAction(dispatch)).rejects.toThrow(); expect(dispatch).not.toHaveBeenCalled(); await expect(scanner.withSafety(() => 'released')).resolves.toBe( 'released', );
   */
  it.each(['toChain', 'sourceTxId', 'id', 'deleted'] as const)(
    'rejects invalid %s after binding',
    async (field) => {
      const bound = await safety.bindTransaction(intent);
      if (field === 'toChain') event.eventData.toChain = 'bitcoin';
      if (field === 'sourceTxId') event.eventData.sourceTxId = 'another-source';
      if (field === 'id') event.id = 'f'.repeat(64);
      if (field === 'deleted') getEvent.mockResolvedValue(null);
      const dispatch = action();
      await expect(bound.withAction(dispatch)).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
      await expect(scanner.withSafety(() => 'released')).resolves.toBe(
        'released',
      );
    },
  );

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'ignores mutable ORM status metadata when rebinding the same event'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'ignores mutable ORM status metadata when rebinding the same event' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected expect(second.bindingId).toBe(first.bindingId); await expect(first.withAction(action())).resolves.toBe('dispatched');
   */
  it('ignores mutable ORM status metadata when rebinding the same event', async () => {
    const first = await safety.bindTransaction(intent);
    Object.assign(event, { status: 'changed', firstTry: '123' });
    const second = await safety.bindTransaction(intent);
    expect(second.bindingId).toBe(first.bindingId);
    await expect(first.withAction(action())).resolves.toBe('dispatched');
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'binding identity includes exact authorized bytes and intent'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'binding identity includes exact authorized bytes and intent' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected expect( (await safety.bindTransaction({ ...intent, ...patch })).bindingId, ).not.toBe(original.bindingId); expect(Object.isFrozen(original)).toBe(true); expect(Object.isFrozen(original.intent)).toBe(true);
   */
  it('binding identity includes exact authorized bytes and intent', async () => {
    const original = await safety.bindTransaction(intent);
    for (const patch of [
      { txBytes: 'abce' },
      { txId: 'different' },
      { txType: TransactionType.reward },
    ]) {
      expect(
        (await safety.bindTransaction({ ...intent, ...patch })).bindingId,
      ).not.toBe(original.bindingId);
    }
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.intent)).toBe(true);
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'captures intent before the first resolver await'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'captures intent before the first resolver await' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected expect(bound.intent).toEqual(intent); await bound.withAction((captured) => expect(captured).toEqual(intent)); expect(getEvent).toHaveBeenCalledWith(intent.eventId);
   */
  it('captures intent before the first resolver await', async () => {
    let release!: (value: AvalancheTransactionEvent) => void;
    getEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const mutable = { ...intent };
    const binding = safety.bindTransaction(mutable);
    mutable.network = 'avalanche';
    mutable.txBytes = 'ffff';
    release(event);
    const bound = await binding;
    expect(bound.intent).toEqual(intent);
    await bound.withAction((captured) => expect(captured).toEqual(intent));
    expect(getEvent).toHaveBeenCalledWith(intent.eventId);
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'holds update exclusion during the fresh event lookup and action'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'holds update exclusion during the fresh event lookup and action' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected getEvent.mockImplementation(async () => { await expect(scanner.update()).rejects.toThrow('already running'); return event; }); await expect(scanner.update()).rejects.toThrow('already running'); await bound.withAction(async () => { await expect(scanner.update()).rejects.toThrow('already running'); }); await expect(scanner.update()).rejects.toThrow('already running'); await expect(scanner.update()).resolves.toBeUndefined();
   */
  it('holds update exclusion during the fresh event lookup and action', async () => {
    const bound = await safety.bindTransaction(intent);
    getEvent.mockImplementation(async () => {
      await expect(scanner.update()).rejects.toThrow('already running');
      return event;
    });
    await bound.withAction(async () => {
      await expect(scanner.update()).rejects.toThrow('already running');
    });
    getEvent.mockResolvedValue(event);
    await expect(scanner.update()).resolves.toBeUndefined();
  });

  /**
   * @target AvalancheTransactionSafety.withTransaction 'releases the lease after rejected dispatch'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'releases the lease after rejected dispatch' with the suite's captured inputs and invoke the withTransaction path.
   * @expected await expect( safety.withTransaction(intent, () => { throw failure; }), ).rejects.toBe(failure); await expect(scanner.update()).resolves.toBeUndefined();
   */
  it('releases the lease after rejected dispatch', async () => {
    const failure = new Error('dispatch failed');
    await expect(
      safety.withTransaction(intent, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(scanner.update()).resolves.toBeUndefined();
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'releases the lease when the event resolver fails'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'releases the lease when the event resolver fails' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected await expect(bound.withAction(dispatch)).rejects.toBe(failure); expect(dispatch).not.toHaveBeenCalled(); await expect(scanner.update()).resolves.toBeUndefined();
   */
  it('releases the lease when the event resolver fails', async () => {
    const bound = await safety.bindTransaction(intent);
    const failure = new Error('event lookup failed');
    getEvent.mockRejectedValue(failure);
    const dispatch = action();
    await expect(bound.withAction(dispatch)).rejects.toBe(failure);
    expect(dispatch).not.toHaveBeenCalled();
    await expect(scanner.update()).resolves.toBeUndefined();
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction 'rechecks each action of a bound intent'
   * @dependencies Actual AvalancheTransactionSafety from utils/avalancheTransactionSafety.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks each action of a bound intent' with the suite's captured inputs and invoke the bindTransaction path.
   * @expected await expect(bound.withAction(dispatch)).rejects.toThrow('not qualified'); expect(dispatch).not.toHaveBeenCalled();
   */
  it('rechecks each action of a bound intent', async () => {
    const bound = await safety.bindTransaction(intent);
    await bound.withAction(action());
    await database
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'later-hold' });
    const dispatch = action();
    await expect(bound.withAction(dispatch)).rejects.toThrow('not qualified');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
