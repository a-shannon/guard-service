import { Address, NetworkPrefix } from 'ergo-lib-wasm-nodejs';

import { DummyLogger } from '@rosen-bridge/abstract-logger';
import type { AbstractLogger } from '@rosen-bridge/abstract-logger';
import {
  BlockEntity,
  ExtractorStatusEntity,
} from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import {
  AvalancheRpcScanner,
  AvalancheSafetyState,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { EventTriggerEntity } from '@rosen-bridge/watcher-data-extractor';

import {
  GuardsAvalancheConfig,
  readAvalancheConfig,
} from '../../src/configs/guardsAvalancheConfigs';
import { readAvalancheBridgeContracts } from '../../src/configs/rosenConfig';
import { dataSource as configuredSource } from '../../src/db/dataSource';
import { AddressEntity } from '../../src/db/entities/addressEntity';
import { ArbitraryEntity } from '../../src/db/entities/arbitraryEntity';
import { ChainAddressBalanceEntity } from '../../src/db/entities/chainAddressBalanceEntity';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import { AvalancheScannerStartup } from '../../src/jobs/avalancheScannerStartup';
import {
  AVALANCHE_LOCK_EXTRACTOR_ID,
  AvalancheScannerInstance,
  createAvalancheScanner,
} from '../../src/utils/avalancheScanner';
import {
  avalancheTransportFailure,
  avalancheTransportSentinels,
} from './testData';

const lock = `0x${'12'.repeat(20)}`;
const ergoAddress = Address.p2pk_from_pk_bytes(
  Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex',
  ),
).to_base58(NetworkPrefix.Testnet);
const contracts = () =>
  readAvalancheBridgeContracts({
    addresses: {
      lock,
      cold: '0x' + '34'.repeat(20),
      WatcherPermit: ergoAddress,
      Fraud: ergoAddress,
      WatcherTriggerEvent: ergoAddress,
      Commitment: ergoAddress,
    },
    tokens: { RWTId: 'ab'.repeat(32) },
  });
const dependencies = {
  logger: new DummyLogger(),
  blockCleanupConfig: {
    blockCleanupThresholdDuration: 86400,
    blockTrimCountInRound: 0,
  },
};
const config = (): GuardsAvalancheConfig => ({
  enabled: true,
  chainNetworkName: 'rpc',
  chainId: 43113,
  sourceId: 'fixture',
  rpc: {
    url: 'http://127.0.0.1:1',
    timeout: 1,
    scannerInterval: 2,
    initialHeight: 0,
  },
  blockTime: 0.5,
  maxParallelTx: 1,
  gasPriceSlippage: 0n,
  gasLimitSlippage: 0n,
  gasLimitMultiplier: 1n,
  gasLimitCap: 25000n,
  confirmations: {
    observation: 1,
    payment: 1,
    cold: 3,
    manual: 4,
    arbitrary: 5,
  },
  routes: { cold: false, manual: false, arbitrary: false },
  tssChainCode: 'fixture',
  derivationPath: [44, 60],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('AvalancheScannerStartup', () => {
  let source: DataSource;
  let factory: ReturnType<typeof vi.fn<typeof createAvalancheScanner>>;
  let update: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let schedule: ReturnType<
    typeof vi.fn<(action: () => void, ms: number) => void>
  >;
  let readLock: ReturnType<typeof vi.fn<typeof contracts>>;
  let instance: AvalancheScannerInstance;
  const startup = (read = () => config()) =>
    new AvalancheScannerStartup(
      read,
      readLock,
      () => source,
      factory,
      schedule,
    );

  beforeEach(async () => {
    if (configuredSource.options.type !== 'sqlite')
      throw new Error('SQLite fixture required');
    source = await new DataSource({
      ...configuredSource.options,
      type: 'sqlite',
      database: ':memory:',
    }).initialize();
    await source.runMigrations();
    update = vi.fn().mockResolvedValue(undefined);
    instance = {
      scanner: { update } as unknown as AvalancheRpcScanner,
      intervalMs: 2000,
    } as AvalancheScannerInstance;
    factory = vi
      .fn<typeof createAvalancheScanner>()
      .mockResolvedValue(instance);
    schedule = vi.fn();
    readLock = vi.fn(contracts);
  });
  afterEach(async () => {
    await source.destroy();
  });

  for (const enabled of [undefined, false]) {
    /**
     * @target AvalancheScannerStartup.config `ignores contracts and schedules nothing when enabled is ${String(enabled)}`
     * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `ignores contracts and schedules nothing when enabled is ${String(enabled)}` with the suite's captured inputs and invoke the config path.
     * @expected expect(readLock).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled(); expect(owner.getScanner()).toBeUndefined();
     */
    it(`ignores contracts and schedules nothing when enabled is ${String(enabled)}`, async () => {
      const reader = {
        has: vi.fn(() => enabled !== undefined),
        get: vi.fn(() => enabled),
      };
      const owner = startup(() => readAvalancheConfig(reader as never)!);
      await owner.prepare();
      await owner.initialize(dependencies);
      owner.start();
      expect(readLock).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
      expect(owner.getScanner()).toBeUndefined();
    });
  }

  const residues: [string, (source: DataSource) => Promise<unknown>][] = [
    ...['avalancheCommitment', 'avalancheEventTrigger'].map(
      (extractorId): [string, (source: DataSource) => Promise<unknown>] => [
        extractorId,
        (db) =>
          db.getRepository(ExtractorStatusEntity).insert({
            scannerId: 'ergo',
            extractorId,
            updateHeight: 0,
            updateBlockHash: 'hash',
          }),
      ],
    ),
    [
      'arbitrary order',
      (db) =>
        db.getRepository(ArbitraryEntity).insert({
          id: 'order',
          chain: 'AvAlAnChE',
          orderJson: '{}',
          status: 'completed',
        }),
    ],
    [
      'registered address',
      (db) =>
        db.getRepository(AddressEntity).insert({
          chain: 'AVALANCHE' as AddressEntity['chain'],
          address: lock,
          type: 'cold' as AddressEntity['type'],
        }),
    ],
    [
      'cached balance',
      (db) =>
        db.getRepository(ChainAddressBalanceEntity).insert({
          chain: 'Avalanche',
          address: lock,
          tokenId: 'avax',
          lastUpdate: '1',
          balance: 0n,
        }),
    ],
    [
      'safety',
      (db) =>
        db.getRepository(AvalancheSafetyState).insert({
          scanner: 'avalanche',
          chainId: '43113',
          sourceId: 'fixture',
          policy: 'helicon-settled-v1',
          initialHeight: 0,
          finalizedHeight: null,
          finalizedHash: null,
          holdReason: 'held',
        }),
    ],
    [
      'block',
      (db) =>
        db.getRepository(BlockEntity).insert({
          scanner: 'avalanche',
          height: 1,
          hash: 'hash',
          parentHash: 'parent',
          status: 'PROCESSING',
          timestamp: 1,
        }),
    ],
    [
      'extractor scanner',
      (db) =>
        db.getRepository(ExtractorStatusEntity).insert({
          scannerId: 'avalanche',
          extractorId: 'other',
          updateHeight: 0,
          updateBlockHash: 'hash',
        }),
    ],
    [
      'extractor identity',
      (db) =>
        db.getRepository(ExtractorStatusEntity).insert({
          scannerId: 'other',
          extractorId: AVALANCHE_LOCK_EXTRACTOR_ID,
          updateHeight: 0,
          updateBlockHash: 'hash',
        }),
    ],
    [
      'indexed transaction',
      (db) =>
        db.getRepository(AddressTxsEntity).insert({
          unsignedHash: 'unsigned',
          signedHash: 'signed',
          nonce: 0,
          address: lock,
          blockId: 'hash',
          extractor: AVALANCHE_LOCK_EXTRACTOR_ID,
          status: 'PROCEED',
        }),
    ],
    [
      'transaction',
      (db) =>
        db.getRepository(TransactionEntity).insert({
          txId: 'tx',
          txJson: '{}',
          type: 'payment',
          chain: 'Avalanche',
          status: 'completed',
          lastCheck: 1,
          failedInSign: false,
          signFailedCount: 0,
          requiredSign: 1,
        }),
    ],
    ...(['fromChain', 'toChain'] as const).map(
      (field): [string, (source: DataSource) => Promise<unknown>] => [
        field,
        (db) =>
          db.getRepository(EventTriggerEntity).insert({
            identifier: 'id',
            serialized: 'box',
            block: 'block',
            height: 1,
            extractor: 'fixture',
            eventId: 'event',
            txId: 'tx',
            fromChain: 'ergo',
            toChain: 'ethereum',
            [field]: 'Avalanche',
            fromAddress: 'source',
            toAddress: 'target',
            amount: '10',
            bridgeFee: '1',
            networkFee: '1',
            sourceChainTokenId: 'native',
            targetChainTokenId: 'wrapped',
            sourceTxId: 'source',
            sourceBlockId: 'block',
            sourceChainHeight: 1,
            WIDsHash: 'wids',
            WIDsCount: 1,
          }),
      ],
    ),
  ];
  for (const [name, insert] of residues) {
    /**
     * @target AvalancheScannerStartup.config `rejects disabled configuration with residual ${name}`
     * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `rejects disabled configuration with residual ${name}` with the suite's captured inputs and invoke the config path.
     * @expected await expect(owner.prepare()).rejects.toThrow('Stored Avalanche state'); await expect(owner.initialize(dependencies)).rejects.toThrow( 'not prepared', ); expect(factory).not.toHaveBeenCalled(); expect(readLock).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled();
     */
    it(`rejects disabled configuration with residual ${name}`, async () => {
      await insert(source);
      const owner = startup(() => undefined!);
      await expect(owner.prepare()).rejects.toThrow('Stored Avalanche state');
      await expect(owner.initialize(dependencies)).rejects.toThrow(
        'not prepared',
      );
      expect(factory).not.toHaveBeenCalled();
      expect(readLock).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    });
  }
  /**
   * @target AvalancheScannerStartup.config 'preserves unrelated Ethereum state'
   * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'preserves unrelated Ethereum state' with the suite's captured inputs and invoke the config path.
   * @expected expect(await source.getRepository(BlockEntity).count()).toBe(1);
   */
  it('preserves unrelated Ethereum state', async () => {
    await source.getRepository(ArbitraryEntity).insert({
      id: 'order',
      chain: 'ethereum',
      orderJson: '{}',
      status: 'completed',
    });
    await source.getRepository(AddressEntity).insert({
      chain: 'ethereum',
      address: lock,
      type: 'cold' as AddressEntity['type'],
    });
    await source.getRepository(ChainAddressBalanceEntity).insert({
      chain: 'ethereum',
      address: lock,
      tokenId: 'eth',
      lastUpdate: '1',
      balance: 0n,
    });
    await source.getRepository(BlockEntity).insert({
      scanner: 'ethereum',
      height: 1,
      hash: 'hash',
      parentHash: 'parent',
      status: 'PROCEED',
      timestamp: 1,
    });
    await source.getRepository(ExtractorStatusEntity).insert({
      scannerId: 'ethereum',
      extractorId: 'ethereum-lock-address',
      updateHeight: 1,
      updateBlockHash: 'hash',
    });
    const owner = startup(() => undefined!);
    await owner.prepare();
    await owner.initialize(dependencies);
    expect(await source.getRepository(BlockEntity).count()).toBe(1);
  });
  for (const value of [
    undefined,
    {},
    { addresses: {} },
    { addresses: { lock: 1 } },
    { addresses: { lock: 'invalid' } },
    { addresses: { lock: `0x${'0'.repeat(40)}` } },
  ]) {
    /**
     * @target AvalancheScannerStartup.config `rejects malformed contract ${JSON.stringify(value)} before provider creation`
     * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run `rejects malformed contract ${JSON.stringify(value)} before provider creation` with the suite's captured inputs and invoke the config path.
     * @expected await expect(owner.prepare()).rejects.toThrow(); expect(factory).not.toHaveBeenCalled();
     */
    it(`rejects malformed contract ${JSON.stringify(value)} before provider creation`, async () => {
      readLock.mockImplementation(() => readAvalancheBridgeContracts(value));
      const owner = startup();
      await expect(owner.prepare()).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
    });
  }
  /**
   * @target AvalancheScannerStartup.config 'captures immutable configuration and the validated contract once'
   * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'captures immutable configuration and the validated contract once' with the suite's captured inputs and invoke the config path.
   * @expected expect(captured.rpc.timeout).toBe(1); expect(captured.derivationPath).toEqual([44, 60]); expect(captured.confirmations.payment).toBe(1); expect(Object.isFrozen(item)).toBe(true); expect(factory.mock.calls[0][1].lockAddress).toBe(lock); expect(read).toHaveBeenCalledTimes(1); expect(readLock).toHaveBeenCalledTimes(1); expect(owner.getPreparedInputs()!.config).toBe(captured); expect(owner.getPreparedInputs()!.contracts).toEqual(contracts()); expect(Object.isFrozen(owner.getPreparedInputs())).toBe(true);
   */
  it('captures immutable configuration and the validated contract once', async () => {
    const input = config();
    const read = vi.fn(() => input);
    const owner = startup(read);
    await owner.prepare();
    input.rpc.timeout = 9;
    input.derivationPath[0] = 0;
    input.confirmations.payment = 9;
    await owner.initialize(dependencies);
    const captured = factory.mock.calls[0][0];
    expect(captured.rpc.timeout).toBe(1);
    expect(captured.derivationPath).toEqual([44, 60]);
    expect(captured.confirmations.payment).toBe(1);
    for (const item of [
      captured,
      captured.rpc,
      captured.derivationPath,
      captured.confirmations,
      captured.routes,
    ])
      expect(Object.isFrozen(item)).toBe(true);
    expect(factory.mock.calls[0][1].lockAddress).toBe(lock);
    expect(read).toHaveBeenCalledTimes(1);
    expect(readLock).toHaveBeenCalledTimes(1);
    expect(owner.getPreparedInputs()!.config).toBe(captured);
    expect(owner.getPreparedInputs()!.contracts).toEqual(contracts());
    expect(Object.isFrozen(owner.getPreparedInputs())).toBe(true);
  });
  /**
   * @target AvalancheScannerStartup.config 'requires preparation and rejects duplicate initialization or preparation'
   * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'requires preparation and rejects duplicate initialization or preparation' with the suite's captured inputs and invoke the config path.
   * @expected await expect(owner.initialize(dependencies)).rejects.toThrow( 'not prepared', ); await expect(owner.prepare()).rejects.toThrow('already attempted'); await expect(owner.initialize(dependencies)).rejects.toThrow( 'already attempted', ); expect(factory).toHaveBeenCalledTimes(1);
   */
  it('requires preparation and rejects duplicate initialization or preparation', async () => {
    const owner = startup();
    await expect(owner.initialize(dependencies)).rejects.toThrow(
      'not prepared',
    );
    await owner.prepare();
    await expect(owner.prepare()).rejects.toThrow('already attempted');
    await owner.initialize(dependencies);
    await expect(owner.initialize(dependencies)).rejects.toThrow(
      'already attempted',
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });
  /**
   * @target AvalancheScannerStartup.config 'publishes no scanner or job before registration resolves'
   * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'publishes no scanner or job before registration resolves' with the suite's captured inputs and invoke the config path.
   * @expected expect(owner.getScanner()).toBeUndefined(); expect(update).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled(); await expect(owner.initialize(dependencies)).rejects.toThrow( 'already attempted', ); expect(owner.getScanner()).toBe(instance.scanner); expect(update).not.toHaveBeenCalled(); expect(update).toHaveBeenCalledTimes(1);
   */
  it('publishes no scanner or job before registration resolves', async () => {
    const pending = deferred<AvalancheScannerInstance>();
    factory.mockReturnValue(pending.promise);
    const owner = startup();
    await owner.prepare();
    const initializing = owner.initialize(dependencies);
    expect(owner.getScanner()).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    await expect(owner.initialize(dependencies)).rejects.toThrow(
      'already attempted',
    );
    pending.resolve(instance);
    await initializing;
    expect(owner.getScanner()).toBe(instance.scanner);
    expect(update).not.toHaveBeenCalled();
    owner.start();
    expect(update).toHaveBeenCalledTimes(1);
  });
  /**
   * @target AvalancheScannerStartup.config 'keeps registration failures unpublished and terminal'
   * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps registration failures unpublished and terminal' with the suite's captured inputs and invoke the config path.
   * @expected await expect(owner.initialize(dependencies)).rejects.toThrow( 'registration failure', ); await expect(owner.initialize(dependencies)).rejects.toThrow( 'already attempted', ); expect(owner.getScanner()).toBeUndefined(); expect(schedule).not.toHaveBeenCalled();
   */
  it('keeps registration failures unpublished and terminal', async () => {
    factory.mockRejectedValue(new Error('registration failure'));
    const owner = startup();
    await owner.prepare();
    await expect(owner.initialize(dependencies)).rejects.toThrow(
      'registration failure',
    );
    await expect(owner.initialize(dependencies)).rejects.toThrow(
      'already attempted',
    );
    expect(owner.getScanner()).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });
  /**
   * @target AvalancheScannerStartup.config 'never schedules another update while the current update is pending'
   * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'never schedules another update while the current update is pending' with the suite's captured inputs and invoke the config path.
   * @expected expect(schedule).not.toHaveBeenCalled(); expect(schedule).toHaveBeenCalledTimes(1); expect(schedule.mock.calls[0][1]).toBe(2000); expect(update).toHaveBeenCalledTimes(2);
   */
  it('never schedules another update while the current update is pending', async () => {
    const pending = deferred<void>();
    update.mockReturnValueOnce(pending.promise);
    const owner = startup();
    await owner.prepare();
    await owner.initialize(dependencies);
    owner.start();
    expect(schedule).not.toHaveBeenCalled();
    pending.resolve();
    await pending.promise;
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toBe(2000);
    schedule.mock.calls[0][0]();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
  });
  /**
   * @target AvalancheScannerStartup.config 'retries a held or failed update without replacing the canonical scanner'
   * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'retries a held or failed update without replacing the canonical scanner' with the suite's captured inputs and invoke the config path.
   * @expected expect(schedule).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(2); expect(owner.getScanner()).toBe(instance.scanner); expect(factory).toHaveBeenCalledTimes(1);
   */
  it('retries a held or failed update without replacing the canonical scanner', async () => {
    update.mockRejectedValueOnce(new Error('held'));
    const owner = startup();
    await owner.prepare();
    await owner.initialize(dependencies);
    owner.start();
    await Promise.resolve();
    expect(schedule).toHaveBeenCalledTimes(1);
    schedule.mock.calls[0][0]();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
    expect(owner.getScanner()).toBe(instance.scanner);
    expect(factory).toHaveBeenCalledTimes(1);
  });
  /**
   * @target AvalancheScannerStartup should omit transport details from failed update warnings
   * @dependencies Actual startup loop and SQLite schema; scanner update and logger API spies
   * @scenario An update rejects with synthetic URL credentials and an Authorization header
   * @expected One fixed warning contains no sentinels; the same scanner retries at the configured interval
   */
  it('should omit transport details from failed update warnings', async () => {
    const logger: AbstractLogger = new DummyLogger();
    const warn = vi.spyOn(logger, 'warn');
    update.mockRejectedValueOnce(new Error(avalancheTransportFailure));
    const owner = startup();
    await owner.prepare();
    await owner.initialize({ ...dependencies, logger });
    owner.start();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      'Avalanche scanner update failed; inspect persisted safety state.',
    );
    for (const sentinel of avalancheTransportSentinels)
      expect(String(warn.mock.calls[0][0])).not.toContain(sentinel);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toEqual(2000);
    schedule.mock.calls[0][0]();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(owner.getScanner()).toBe(instance.scanner);
    expect(factory).toHaveBeenCalledTimes(1);
  });
  /**
   * @target AvalancheScannerStartup should reschedule successful updates without warnings
   * @dependencies Actual startup loop and SQLite schema; scanner update and logger API spies
   * @scenario Two successful updates complete through the same registered scanner
   * @expected Each completion schedules one next attempt and emits no failure warning
   */
  it('should reschedule successful updates without warnings', async () => {
    const logger = new DummyLogger();
    const warn = vi.spyOn(logger, 'warn');
    const owner = startup();
    await owner.prepare();
    await owner.initialize({ ...dependencies, logger });
    owner.start();
    await Promise.resolve();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toEqual(2000);
    schedule.mock.calls[0][0]();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(owner.getScanner()).toBe(instance.scanner);
    expect(factory).toHaveBeenCalledTimes(1);
  });
  /**
   * @target AvalancheScannerStartup.config 'rejects premature and duplicate job starts'
   * @dependencies Actual AvalancheScannerStartup from jobs/avalancheScannerStartup.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects premature and duplicate job starts' with the suite's captured inputs and invoke the config path.
   * @expected expect(() => owner.getPreparedInputs()).toThrow('not prepared'); expect(() => owner.start()).toThrow('not registered'); expect(() => owner.start()).toThrow('not registered'); expect(update).not.toHaveBeenCalled(); expect(() => owner.start()).toThrow('already started');
   */
  it('rejects premature and duplicate job starts', async () => {
    const owner = startup();
    expect(() => owner.getPreparedInputs()).toThrow('not prepared');
    expect(() => owner.start()).toThrow('not registered');
    await owner.prepare();
    expect(() => owner.start()).toThrow('not registered');
    await owner.initialize(dependencies);
    expect(update).not.toHaveBeenCalled();
    owner.start();
    expect(() => owner.start()).toThrow('already started');
  });
});
