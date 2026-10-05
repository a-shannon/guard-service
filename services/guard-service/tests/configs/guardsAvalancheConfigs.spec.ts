import { NetworkPrefix } from 'ergo-lib-wasm-nodejs';

import {
  AvalancheConfigReader,
  GuardsAvalancheConfigs,
  readAvalancheConfig,
} from '../../src/configs/guardsAvalancheConfigs';
import { contracts } from '../utils/avalancheChainTestUtils';
import { valid, faults, realRouteFaults } from './avalancheConfigTestData';
import {
  address,
  reader,
  realAvalancheConfigReader,
} from './avalancheConfigTestUtils';

describe('readAvalancheConfig', () => {
  /**
   * @target GuardsAvalancheConfigs.read captures the same validated immutable class through both APIs
   * @dependencies Real config class and compatibility reader; synthetic operator records.
   * @scenario Read enabled policy through both APIs and mutate the original derivation path.
   * @expected Produce equal class snapshots with every nested collection frozen and detached.
   */
  it('captures the same validated immutable class through both APIs', () => {
    const path = [44, 60];
    const source = reader({ ...valid, 'avalanche.derivationPath': path });
    const direct = GuardsAvalancheConfigs.read(source);
    const compatible = readAvalancheConfig(source);
    expect(direct).toBeInstanceOf(GuardsAvalancheConfigs);
    expect(compatible).toBeInstanceOf(GuardsAvalancheConfigs);
    expect(direct).toEqual(compatible);
    for (const value of [
      direct,
      direct?.rpc,
      direct?.confirmations,
      direct?.routes,
      direct?.derivationPath,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    path[0] = 99;
    expect(direct?.derivationPath).toEqual([44, 60]);
    expect(() => {
      direct!.rpc.timeout = 99;
    }).toThrow(TypeError);
    expect(direct?.rpc.timeout).toBe(8);
  });

  /**
   * @target GuardsAvalancheConfigs.read rejects invalid chain policy before constructing a snapshot
   * @dependencies Real config class; synthetic operator records.
   * @scenario Change only the explicit network ID to an unsupported chain.
   * @expected Reject the invalid chain ID instead of returning a class instance.
   */
  it('rejects invalid chain policy before constructing a snapshot', () => {
    expect(() =>
      GuardsAvalancheConfigs.read(reader({ ...valid, 'avalanche.chainId': 1 })),
    ).toThrow('Invalid avalanche.chainId');
  });

  /**
   * @target readAvalancheConfig ignores all other fields when disabled (%s)
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Disable Avalanche or omit its flag and forbid unrelated reads.
   * @expected Read only the flag and return undefined.
   */
  it.each([false, undefined])(
    'ignores all other fields when disabled (%s)',
    (enabled) => {
      const source = {
        has: vi.fn(
          (path: string) =>
            path === 'avalanche.enabled' && enabled !== undefined,
        ),
        get: vi.fn((path: string) => {
          if (path !== 'avalanche.enabled') throw new Error('unexpected read');
          return enabled;
        }),
      };
      expect(
        readAvalancheConfig(source as AvalancheConfigReader),
      ).toBeUndefined();
      expect(source.has).toHaveBeenCalledExactlyOnceWith('avalanche.enabled');
      if (enabled === undefined) expect(source.get).not.toHaveBeenCalled();
      else
        expect(source.get).toHaveBeenCalledExactlyOnceWith('avalanche.enabled');
    },
  );

  /**
   * @target readAvalancheConfig parses explicit chain %s with inactive unsupported routes
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Parse each explicit supported network with the complete fixture.
   * @expected Preserve exact typed configuration and disabled unsupported routes.
   */
  it.each([43113, 43114])(
    'parses explicit chain %s with inactive unsupported routes',
    (chainId) => {
      const result = readAvalancheConfig(
        reader({ ...valid, 'avalanche.chainId': chainId }),
      );
      expect(result).toEqual({
        enabled: true,
        chainNetworkName: 'rpc',
        chainId,
        sourceId: 'synthetic-fuji',
        rpc: {
          url: valid['avalanche.rpc.url'],
          authToken: undefined,
          timeout: 8,
          scannerInterval: 20,
          initialHeight: -1,
        },
        blockTime: 0.5,
        maxParallelTx: 2,
        gasPriceSlippage: 0n,
        gasLimitSlippage: 0n,
        gasLimitMultiplier: 1n,
        gasLimitCap: 80000n,
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
      });
    },
  );

  /**
   * @target readAvalancheConfig rejects missing required %s
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Remove each required configuration key independently.
   * @expected Throw the missing-key error.
   */
  it.each(Object.keys(valid).filter((key) => key !== 'avalanche.enabled'))(
    'rejects missing required %s',
    (key) => {
      const values = { ...valid };
      delete values[key];
      expect(() => readAvalancheConfig(reader(values))).toThrow(
        `Missing ${key}`,
      );
    },
  );

  /**
   * @target readAvalancheConfig rejects invalid %s (%s)
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Replace one field with each malformed fixture value.
   * @expected Throw the corresponding invalid-field error.
   */
  it.each(faults)('rejects invalid %s (%s)', (field, value) => {
    expect(() =>
      readAvalancheConfig(reader({ ...valid, [`avalanche.${field}`]: value })),
    ).toThrow(`Invalid avalanche.${field}`);
  });

  /**
   * @target readAvalancheConfig accepts supported boundary values without coercion
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Supply the supported maximum and minimum boundary values.
   * @expected Preserve exact values without coercion.
   */
  it('accepts supported boundary values without coercion', () => {
    const result = readAvalancheConfig(
      reader({
        ...valid,
        'avalanche.sourceId': 'A'.repeat(128),
        'avalanche.rpc.url': 'https://example.invalid/ext/bc/C/rpc',
        'avalanche.rpc.authToken': 'synthetic-token',
        'avalanche.rpc.timeout': 2147483.647,
        'avalanche.rpc.scannerInterval': 0.001,
        'avalanche.rpc.initialHeight': Number.MAX_SAFE_INTEGER,
        'avalanche.gasLimitCap': ((1n << 256n) - 1n).toString(),
        'avalanche.derivationPath': new Array(255).fill(2 ** 31 - 1),
      }),
    );
    expect(result?.gasLimitCap).toEqual((1n << 256n) - 1n);
    expect(result?.rpc.timeout).toEqual(2147483.647);
    expect(result?.rpc.authToken).toEqual('synthetic-token');
    expect(result?.derivationPath).toHaveLength(255);
  });

  /**
   * @target readAvalancheConfig accepts safe integer gas caps and copies the derivation path
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Use a safe-integer gas cap then mutate the supplied path.
   * @expected Convert the cap exactly and retain the copied path.
   */
  it('accepts safe integer gas caps and copies the derivation path', () => {
    const path = [0];
    const result = readAvalancheConfig(
      reader({
        ...valid,
        'avalanche.gasLimitCap': Number.MAX_SAFE_INTEGER,
        'avalanche.derivationPath': path,
      }),
    );
    expect(result?.gasLimitCap).toEqual(BigInt(Number.MAX_SAFE_INTEGER));
    path[0] = 1;
    expect(result?.derivationPath).toEqual([0]);
  });
});

describe('GuardsAvalancheConfigs', () => {
  describe('read', () => {
    /**
     * @target GuardsAvalancheConfigs.read preserves explicit routes through real node-config on chain %s
     * @dependencies Actual config3.3.12 module reader and immutable configuration class.
     * @scenario Read explicit false route flags with node-config's hidden util/get/has properties on the selected deployment.
     * @expected Preserve all explicit false flags, chain identity and a frozen detached route snapshot.
     */
    it.each([43113, 43114] as const)(
      'preserves explicit routes through real node-config on chain %s',
      (chainId) => {
        const source = realAvalancheConfigReader(
          { cold: false, manual: false, arbitrary: false },
          chainId,
        );
        const raw = source.get<object>('avalanche.routes');
        expect(Reflect.ownKeys(raw)).toEqual([
          'cold',
          'manual',
          'arbitrary',
          'util',
          'get',
          'has',
        ]);
        const result = GuardsAvalancheConfigs.read(source)!;
        expect(result.chainId).toEqual(chainId);
        expect(result.routes).toEqual({
          cold: false,
          manual: false,
          arbitrary: false,
        });
        expect(Object.isFrozen(result.routes)).toEqual(true);
      },
    );
    /**
     * @target GuardsAvalancheConfigs.read preserves explicit true opt-in for route %s through real node-config
     * @dependencies Actual node-config reader and immutable configuration class.
     * @scenario Enable only the selected route in a real module reader.
     * @expected Preserve that explicit true flag while the other routes remain false.
     */
    it.each(['cold', 'manual', 'arbitrary'] as const)(
      'preserves explicit true opt-in for route %s through real node-config',
      (route) => {
        const routes = {
          cold: false,
          manual: false,
          arbitrary: false,
          [route]: true,
        };
        expect(
          GuardsAvalancheConfigs.read(realAvalancheConfigReader(routes))!
            .routes,
        ).toEqual(routes);
      },
    );
    /**
     * @target GuardsAvalancheConfigs.read refuses malformed real node-config route %s
     * @dependencies Actual node-config reader and configuration class.
     * @scenario Change only the named route input while retaining the real reader's hidden helpers.
     * @expected Reject the invalid route configuration without returning an enabled snapshot.
     */
    it.each(realRouteFaults)(
      'refuses malformed real node-config route %s',
      (_, routes) => {
        expect(() =>
          GuardsAvalancheConfigs.read(realAvalancheConfigReader(routes)),
        ).toThrow('Invalid avalanche.routes');
      },
    );
    /**
     * @target GuardsAvalancheConfigs.read refuses a forged hidden helper %s on a plain route object
     * @dependencies Plain reader and actual configuration class; one descriptor mutation.
     * @scenario Add a non-enumerable helper name whose value differs from the reader's helper.
     * @expected Reject the extra route key; accepting real helpers must not whitelist arbitrary hidden properties.
     */
    it.each(['util', 'get', 'has'])(
      'refuses a forged hidden helper %s on a plain route object',
      (key) => {
        const routes = Object.defineProperty({ cold: false }, key, {
          value: () => false,
          enumerable: false,
        });
        expect(() =>
          GuardsAvalancheConfigs.read(
            reader({ ...valid, 'avalanche.routes': routes }),
          ),
        ).toThrow('Invalid avalanche.routes');
      },
    );
    /**
     * @target GuardsAvalancheConfigs.read refuses an enumerable helper copied from the reader
     * @dependencies Actual node-config reader and a single route-object substitution.
     * @scenario Copy the authentic get helper into an enumerable route key.
     * @expected Reject the key because only hidden library descriptors are compatibility metadata.
     */
    it('refuses an enumerable helper copied from the reader', () => {
      const source = realAvalancheConfigReader({ cold: false });
      const routes = { cold: false, get: source.get };
      const supplied = {
        has: source.has.bind(source),
        get: <T>(key: string) =>
          (key === 'avalanche.routes' ? routes : source.get(key)) as T,
      };
      expect(() => GuardsAvalancheConfigs.read(supplied)).toThrow(
        'Invalid avalanche.routes',
      );
    });
    /**
     * @target GuardsAvalancheConfigs.read refuses a hidden unknown route key
     * @dependencies Plain reader and actual class with an isolated unknown descriptor.
     * @scenario Add one non-enumerable key outside the route and library metadata sets.
     * @expected Reject the unknown property despite its absence from Object.keys.
     */
    it('refuses a hidden unknown route key', () => {
      const routes = Object.defineProperty({ cold: false }, 'unknown', {
        value: false,
      });
      expect(() =>
        GuardsAvalancheConfigs.read(
          reader({ ...valid, 'avalanche.routes': routes }),
        ),
      ).toThrow('Invalid avalanche.routes');
    });
    /**
     * @target GuardsAvalancheConfigs.read refuses a symbol route key
     * @dependencies Plain reader and actual class with an isolated symbol property.
     * @scenario Add one symbol key to otherwise valid false routes.
     * @expected Reject the symbol instead of dropping it during enumeration or serialization.
     */
    it('refuses a symbol route key', () => {
      const routes = { cold: false, [Symbol('unknown')]: false };
      expect(() =>
        GuardsAvalancheConfigs.read(
          reader({ ...valid, 'avalanche.routes': routes }),
        ),
      ).toThrow('Invalid avalanche.routes');
    });
  });

  describe('createChainConfigs', () => {
    /**
     * @target GuardsAvalancheConfigs.createChainConfigs projects captured four addresses and five confirmations
     * @dependencies Real config class and validated synthetic bridge contracts.
     * @scenario Project the enabled class policy, then mutate caller-owned contract data.
     * @expected Capture all configured addresses and counts while management route flags remain disabled.
     */
    it('projects captured four addresses and five confirmations', () => {
      const config = GuardsAvalancheConfigs.read(reader(valid))!;
      const inputContracts = structuredClone(contracts());
      (inputContracts.addresses as { WatcherPermit: string }).WatcherPermit =
        address.to_base58(NetworkPrefix.Mainnet);
      const projection = GuardsAvalancheConfigs.createChainConfigs(
        config,
        inputContracts,
      );
      expect(projection.addresses.lock).toBe(inputContracts.addresses.lock);
      expect(projection.addresses.cold).toBe(inputContracts.addresses.cold);
      expect(projection.addresses.permit).toBe(
        inputContracts.addresses.WatcherPermit,
      );
      expect(projection.addresses.fraud).toBe(inputContracts.addresses.Fraud);
      expect(projection.rwtId).toBe(inputContracts.tokens.RWTId);
      expect(projection.confirmations.observation).toBe(1);
      expect(projection.confirmations.payment).toBe(1);
      expect(projection.confirmations.cold).toBe(3);
      expect(projection.confirmations.manual).toBe(4);
      expect(projection.confirmations.arbitrary).toBe(5);
      expect(config.routes).toEqual({
        cold: false,
        manual: false,
        arbitrary: false,
      });
      expect(projection.fee).toBe(0n);
      expect(Object.keys(projection.addresses).sort()).toEqual([
        'cold',
        'fraud',
        'lock',
        'permit',
      ]);
      for (const value of [
        projection,
        projection.addresses,
        projection.confirmations,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      const capturedLock = projection.addresses.lock;
      (inputContracts.addresses as { lock: string }).lock =
        '0x' + '34'.repeat(20);
      expect(projection.addresses.lock).toBe(capturedLock);
      const capturedCold = projection.addresses.cold;
      (inputContracts.addresses as { cold: string }).cold =
        '0x' + '56'.repeat(20);
      expect(projection.addresses.cold).toBe(capturedCold);
      for (const route of ['cold', 'manual', 'arbitrary'] as const)
        expect(() => {
          projection.confirmations[route] = 99;
        }).toThrow(TypeError);
    });
  });
});
