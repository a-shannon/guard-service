import '@rosen-bridge/extended-typeorm/bootstrap';

import { DummyLogger } from '@rosen-bridge/abstract-logger';
import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations,
  PROCEED,
} from '@rosen-bridge/abstract-scanner';
import {
  AddressTxsEntity,
  migrations as addressMigrations,
} from '@rosen-bridge/evm-address-tx-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import { GuardsAvalancheConfig } from '../../src/configs/guardsAvalancheConfigs';
import type { AvalancheScannerInstance } from '../../src/utils/avalancheScanner';
import { hash, signed } from './avalancheScannerTestUtils';
import { hook, mockBlock } from './mocked/avalancheScanner.mock';

describe('createAvalancheScanner', () => {
  let AvalancheRpcScanner: typeof import('@rosen-bridge/evm-scanner').AvalancheRpcScanner;
  let AvalancheSafetyState: typeof import('@rosen-bridge/evm-scanner').AvalancheSafetyState;
  let AvalancheSafetyState1790769600000: typeof import('@rosen-bridge/evm-scanner').AvalancheSafetyState1790769600000;
  let createAvalancheScanner: typeof import('../../src/utils/avalancheScanner').createAvalancheScanner;
  let AVALANCHE_LOCK_EXTRACTOR_ID: typeof import('../../src/utils/avalancheScanner').AVALANCHE_LOCK_EXTRACTOR_ID;

  beforeAll(async () => {
    // Load scanner classes and the real factory after the registration mock.
    ({
      AvalancheRpcScanner,
      AvalancheSafetyState,
      AvalancheSafetyState1790769600000,
    } = await import('@rosen-bridge/evm-scanner'));
    ({ createAvalancheScanner, AVALANCHE_LOCK_EXTRACTOR_ID } = await import(
      '../../src/utils/avalancheScanner'
    ));
  });
  let dataSource: DataSource;
  let config: GuardsAvalancheConfig;
  const instances: AvalancheScannerInstance[] = [];
  const create = async (
    overrides: Partial<GuardsAvalancheConfig> = {},
    lockAddress = signed.from!,
  ) => {
    const instance = await createAvalancheScanner(
      { ...config, ...overrides },
      {
        dataSource,
        lockAddress,
        logger: new DummyLogger(),
        blockCleanupConfig: {
          blockCleanupThresholdDuration: 86400,
          blockTrimCountInRound: 0,
        },
      },
    );
    instances.push(instance);
    return instance;
  };
  beforeEach(async () => {
    hook.beforeRegister = undefined;
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [
        BlockEntity,
        ExtractorStatusEntity,
        AddressTxsEntity,
        AvalancheSafetyState,
      ],
      migrations: [
        ...migrations.sqlite,
        ...addressMigrations.sqlite,
        AvalancheSafetyState1790769600000,
      ],
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    config = {
      enabled: true,
      chainNetworkName: 'rpc',
      chainId: 43113,
      sourceId: 'synthetic-guard-source',
      rpc: {
        url: 'http://127.0.0.1:1',
        timeout: 0.125,
        scannerInterval: 0.25,
        initialHeight: 0,
      },
      blockTime: 0.5,
      maxParallelTx: 2,
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
      tssChainCode: 'SyntheticChainCode',
      derivationPath: [44, 60, 0, 0],
    };
  });
  afterEach(async () => {
    for (const instance of instances.splice(0)) {
      instance.network['provider'].destroy();
      instance.extractor['provider'].destroy();
    }
    await dataSource.destroy();
    vi.restoreAllMocks();
  });

  /**
   * @target createAvalancheScanner constructs explicit chain %s with effective millisecond timeout and no startup
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Construct each supported network with explicit millisecond timers.
   * @expected Create the inert scanner and extractor without granting unqualified safety.
   */
  it.each([43113, 43114] as const)(
    'constructs explicit chain %s with effective millisecond timeout and no startup',
    async (chainId) => {
      const instance = await create({ chainId });
      expect(instance.scanner).toBeInstanceOf(AvalancheRpcScanner);
      expect(instance.network.expectedChainId).toEqual(BigInt(chainId));
      expect(instance.network['provider']._getConnection().timeout).toEqual(
        125,
      );
      expect(instance.intervalMs).toEqual(250);
      expect(instance.extractor.getId()).toEqual(AVALANCHE_LOCK_EXTRACTOR_ID);
      expect(instance.scanner.name()).toEqual('avalanche');
      expect(
        await dataSource.getRepository(AvalancheSafetyState).count(),
      ).toEqual(0);
      await expect(
        async () => await instance.scanner.withSafety(vi.fn()),
      ).rejects.toThrow('not qualified');
    },
  );

  /**
   * @target createAvalancheScanner indexes admitted receipt status %s and nonce under completed blocks
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Scan a mocked canonical receipt with each admitted execution status.
   * @expected Persist completed blocks and exact nonce/hash/status transactions.
   */
  it.each([0, 1])(
    'indexes admitted receipt status %s and nonce under completed blocks',
    async (status) => {
      const instance = await create();
      const { provider } = mockBlock(instance, status);
      const skipping = vi.spyOn(instance.extractor, 'hasEventInHeightRange');
      await instance.scanner.update();
      expect(await dataSource.getRepository(BlockEntity).find()).toEqual([
        expect.objectContaining({
          hash: hash('1'),
          height: 1,
          scanner: 'avalanche',
          status: PROCEED,
        }),
      ]);
      expect(await dataSource.getRepository(AddressTxsEntity).find()).toEqual([
        expect.objectContaining({
          extractor: AVALANCHE_LOCK_EXTRACTOR_ID,
          address: signed.from!.toLowerCase(),
          nonce: 7,
          unsignedHash: signed.unsignedHash,
          signedHash: signed.hash,
          blockId: hash('1'),
          status: status ? 'succeed' : 'failed',
        }),
      ]);
      expect(provider.getTransactionReceipt).toHaveBeenCalledOnce();
      expect(skipping).not.toHaveBeenCalled();
      await expect(
        instance.scanner.withObservation(1, hash('1'), () => 'admitted'),
      ).resolves.toEqual('admitted');
    },
  );

  /**
   * @target createAvalancheScanner does not return until extractor registration finishes
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Hold extractor registration before returning the factory result.
   * @expected Wait for registration and then persist extracted transactions.
   */
  it('does not return until extractor registration finishes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    hook.beforeRegister = async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    let returned = false;
    const creating = create().then((instance) => {
      returned = true;
      return instance;
    });
    await started;
    expect(returned).toEqual(false);
    release();
    const instance = await creating;
    mockBlock(instance);
    await instance.scanner.update();
    expect(await dataSource.getRepository(AddressTxsEntity).count()).toEqual(1);
  });

  /**
   * @target createAvalancheScanner propagates extractor registration failure without exposing an instance
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Reject extractor registration with the captured error object.
   * @expected Propagate the same error without publishing an instance or safety row.
   */
  it('propagates extractor registration failure without exposing an instance', async () => {
    const failure = new Error('Synthetic registration failure');
    hook.beforeRegister = async () => {
      throw failure;
    };
    await expect(create()).rejects.toBe(failure);
    expect(instances).toHaveLength(0);
    expect(
      await dataSource.getRepository(AvalancheSafetyState).count(),
    ).toEqual(0);
  });

  /**
   * @target createAvalancheScanner preserves a held scanner across a new factory invocation
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Restart the factory against a held scanner database row.
   * @expected Preserve the hold and reject safety without a height request.
   */
  it('preserves a held scanner across a new factory invocation', async () => {
    const first = await create();
    mockBlock(first);
    await first.scanner.update();
    await dataSource
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'synthetic-hold' });
    const restarted = await create();
    const rpc = vi.spyOn(restarted.network, 'getCurrentHeight');
    await expect(async () => await restarted.scanner.update()).rejects.toThrow(
      'scanner held',
    );
    await expect(
      async () => await restarted.scanner.withSafety(vi.fn()),
    ).rejects.toThrow('not qualified');
    expect(rpc).not.toHaveBeenCalled();
  });

  /**
   * @target createAvalancheScanner propagates transport failure without fabricating indexed transactions
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Reject the network height read with a captured transport error.
   * @expected Propagate the same error without fabricated transactions or qualification.
   */
  it('propagates transport failure without fabricating indexed transactions', async () => {
    const instance = await create();
    const failure = new Error('Synthetic transport failure');
    vi.spyOn(instance.network, 'getCurrentHeight').mockRejectedValue(failure);
    await expect(instance.scanner.update()).rejects.toBe(failure);
    expect(await dataSource.getRepository(AddressTxsEntity).count()).toEqual(0);
    expect(
      await dataSource
        .getRepository(AvalancheSafetyState)
        .findOneByOrFail({ scanner: 'avalanche' }),
    ).toMatchObject({ holdReason: null, finalizedHeight: null });
  });

  /**
   * @target createAvalancheScanner rejects unrepresentable %s timer values
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Supply each unrepresentable timer field value.
   * @expected Reject values that cannot produce valid millisecond timers.
   */
  it.each(['timeout', 'scannerInterval'] as const)(
    'rejects unrepresentable %s timer values',
    async (field) => {
      for (const value of [0, -1, 0.0001, 2147483.648, Infinity, NaN])
        await expect(
          async () => await create({ rpc: { ...config.rpc, [field]: value } }),
        ).rejects.toThrow('milliseconds');
    },
  );
  /**
   * @target createAvalancheScanner rejects invalid scanner input %j
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Alter chain, enablement, network, source or initial-height input.
   * @expected Reject each invalid factory input.
   */
  it.each([
    { chainId: 1 },
    { enabled: false },
    { chainNetworkName: 'explorer' },
    { sourceId: 'invalid/source' },
    {
      rpc: {
        url: 'http://127.0.0.1:1',
        timeout: 1,
        scannerInterval: 1,
        initialHeight: -2,
      },
    },
  ])('rejects invalid scanner input %j', async (override) => {
    await expect(
      async () => await create(override as Partial<GuardsAvalancheConfig>),
    ).rejects.toThrow();
  });
  /**
   * @target createAvalancheScanner rejects invalid lock address %s
   * @dependencies Real scanner, extractor and in-memory SQLite; mocked RPC and registration boundary.
   * @scenario Supply each invalid lock address.
   * @expected Reject the lock address before returning a scanner.
   */
  it.each(['', 'invalid-address', '0x' + '0'.repeat(40)])(
    'rejects invalid lock address %s',
    async (address) => {
      await expect(async () => await create({}, address)).rejects.toThrow();
    },
  );
});
