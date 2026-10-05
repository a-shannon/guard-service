import { JsonRpcProvider } from 'ethers';

import { TokenMap } from '@rosen-bridge/tokens';

import {
  GuardsAvalancheConfig,
  GuardsAvalancheConfigs,
} from '../../src/configs/guardsAvalancheConfigs';
import { config, contracts, mapping } from '../utils/avalancheChainTestUtils';
import {
  captured,
  dataSource,
  createSignMediator,
} from '../utils/mocked/avalancheChain.mock';
import { valid } from './avalancheConfigTestData';
import { reader } from './avalancheConfigTestUtils';
import {
  routeNames,
  routePolicies,
  routeValueFaults,
  routeBlockFaults,
  unknownRouteKeys,
  hiddenKeyKinds,
  extraRouteKey,
} from './avalancheManagementRoutesTestData';

describe('Avalanche management route policy', () => {
  let factory: typeof import('../../src/utils/avalancheChain').createAvalancheChain;
  let factoryConfigs: typeof GuardsAvalancheConfigs;
  let tokens: TokenMap;
  const instances: Awaited<
    ReturnType<
      typeof import('../../src/utils/avalancheChain').createAvalancheChain
    >
  >[] = [];
  beforeAll(async () => {
    ({ createAvalancheChain: factory } = await import(
      '../../src/utils/avalancheChain'
    ));
    ({ GuardsAvalancheConfigs: factoryConfigs } = await import(
      '../../src/configs/guardsAvalancheConfigs'
    ));
  });
  beforeEach(async () => {
    tokens = new TokenMap();
    await tokens.updateConfigByJson(mapping());
    captured.calls.length = 0;
    createSignMediator.mockClear();
    vi.spyOn(JsonRpcProvider.prototype, 'send').mockRejectedValue(
      new Error('Unexpected live RPC'),
    );
  });
  afterEach(() => {
    for (const { network } of instances.splice(0))
      network['provider'].destroy();
    vi.restoreAllMocks();
  });
  const create = async (routes: unknown) => {
    const input = { ...config(), routes } as GuardsAvalancheConfig;
    const instance = await factory(input, contracts(), {
      dataSource,
      tokens,
      createSignMediator,
    });
    instances.push(instance);
    return instance;
  };
  const refuses = async (routes: unknown) => {
    const raw = vi.spyOn(tokens, 'getRawConfig'),
      project = vi.spyOn(factoryConfigs, 'createChainConfigs');
    await expect(create(routes)).rejects.toThrow(
      'Invalid Avalanche management routes',
    );
    expect(raw).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(createSignMediator).not.toHaveBeenCalled();
    expect(captured.calls).toEqual([]);
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  };

  /**
   * @target GuardsAvalancheConfigs.read captures exact route policy $cold/$manual/$arbitrary
   * @dependencies Actual config snapshot and synthetic operator records.
   * @scenario Read each independent boolean combination and mutate its source.
   * @expected Preserve all three captured flags in an immutable detached snapshot.
   */
  it.each(routePolicies)(
    'captures exact route policy $cold/$manual/$arbitrary',
    (policy) => {
      const source = { ...policy };
      const value = GuardsAvalancheConfigs.read(
        reader({ ...valid, 'avalanche.routes': source }),
      )!;
      expect(value.routes).toEqual(policy);
      expect(Object.isFrozen(value.routes)).toEqual(true);
      source.cold = !source.cold;
      expect(value.routes).toEqual(policy);
    },
  );
  /**
   * @target GuardsAvalancheConfigs.read defaults omitted %s flag to false
   * @dependencies Actual config parser and synthetic partial route blocks.
   * @scenario Omit one route while setting the other two true.
   * @expected Default only that omitted route to false.
   */
  it.each(routeNames)('defaults omitted %s flag to false', (route) => {
    const source: Record<string, unknown> = {
      cold: true,
      manual: true,
      arbitrary: true,
    };
    delete source[route];
    expect(
      GuardsAvalancheConfigs.read(
        reader({ ...valid, 'avalanche.routes': source }),
      )!.routes,
    ).toEqual({ ...source, [route]: false });
  });
  /**
   * @target GuardsAvalancheConfigs.read defaults absent route block to false
   * @dependencies Actual config parser and complete synthetic inputs without routes.
   * @scenario Read the predecessor configuration containing no route block.
   * @expected Return three explicit false flags.
   */
  it('defaults absent route block to false', () => {
    expect(GuardsAvalancheConfigs.read(reader(valid))!.routes).toEqual({
      cold: false,
      manual: false,
      arbitrary: false,
    });
  });
  /**
   * @target GuardsAvalancheConfigs.read rejects malformed $route flag $value
   * @dependencies Actual parser; one malformed present route value.
   * @scenario Replace one otherwise valid flag with a nonboolean.
   * @expected Reject its field instead of coercing the value or treating it as omitted.
   */
  it.each(routeValueFaults)(
    'rejects malformed $route flag $value',
    ({ route, value }) => {
      expect(() =>
        GuardsAvalancheConfigs.read(
          reader({
            ...valid,
            'avalanche.routes': {
              cold: false,
              manual: false,
              arbitrary: false,
              [route]: value,
            },
          }),
        ),
      ).toThrow('Invalid avalanche.routes.' + route);
    },
  );
  /**
   * @target GuardsAvalancheConfigs.read rejects malformed route block %s
   * @dependencies Actual parser and isolated invalid block shapes.
   * @scenario Supply one nonrecord block.
   * @expected Reject the block before capturing any policy.
   */
  it.each(routeBlockFaults)('rejects malformed route block %s', (routes) => {
    expect(() =>
      GuardsAvalancheConfigs.read(
        reader({ ...valid, 'avalanche.routes': routes }),
      ),
    ).toThrow('Invalid avalanche.routes');
  });
  /**
   * @target GuardsAvalancheConfigs.read rejects unknown route key %s
   * @dependencies Actual parser and one unknown own key.
   * @scenario Add one unsupported key to a valid block.
   * @expected Reject the route block.
   */
  it.each(unknownRouteKeys)('rejects unknown route key %s', (key) => {
    expect(() =>
      GuardsAvalancheConfigs.read(
        reader({
          ...valid,
          'avalanche.routes': {
            cold: false,
            manual: false,
            arbitrary: false,
            [key]: false,
          },
        }),
      ),
    ).toThrow('Invalid avalanche.routes');
  });
  /**
   * @target createAvalancheChain preserves synthetic boolean route policy $cold/$manual/$arbitrary
   * @dependencies Real factory; inert DB, signing and guarded RPC ports.
   * @scenario Construct each opt-in combination without invoking a management operation.
   * @expected Project an immutable exact copy and perform no network or signing call.
   */
  it.each(routePolicies)(
    'preserves synthetic boolean route policy $cold/$manual/$arbitrary',
    async (policy) => {
      const project = vi.spyOn(factoryConfigs, 'createChainConfigs');
      await create({ ...policy });
      const capturedPolicy = project.mock.calls[0][0].routes;
      expect(capturedPolicy).toEqual(policy);
      expect(capturedPolicy).not.toBe(policy);
      expect(Object.isFrozen(capturedPolicy)).toEqual(true);
      expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
    },
  );
  /**
   * @target createAvalancheChain refuses malformed $route flag $value before dependencies
   * @dependencies Actual factory; spies on token/projection/signing/RPC ports.
   * @scenario Replace only one required runtime flag.
   * @expected Refuse before accessing downstream ports.
   */
  it.each(routeValueFaults)(
    'refuses malformed $route flag $value before dependencies',
    async ({ route, value }) => {
      expect.assertions(6);
      await refuses({
        cold: false,
        manual: false,
        arbitrary: false,
        [route]: value,
      });
    },
  );
  /**
   * @target createAvalancheChain refuses missing %s flag before dependencies
   * @dependencies Actual factory; complete synthetic policy with one removed key.
   * @scenario Remove one captured route key.
   * @expected Reject the incomplete runtime policy instead of applying parser defaults.
   */
  it.each(routeNames)(
    'refuses missing %s flag before dependencies',
    async (route) => {
      expect.assertions(6);
      const routes: Record<string, unknown> = {
        cold: false,
        manual: false,
        arbitrary: false,
      };
      delete routes[route];
      await refuses(routes);
    },
  );
  /**
   * @target createAvalancheChain refuses unknown route %s before dependencies
   * @dependencies Actual factory and one additional route key.
   * @scenario Add only the unsupported key.
   * @expected Reject before projection or runtime construction.
   */
  it.each(unknownRouteKeys)(
    'refuses unknown route %s before dependencies',
    async (key) => {
      expect.assertions(6);
      await refuses({
        cold: false,
        manual: false,
        arbitrary: false,
        [key]: false,
      });
    },
  );
  /**
   * @target createAvalancheChain rejects keys lost by structured cloning %s
   * @dependencies Actual parser/factory and nonenumerable or symbol key fixture.
   * @scenario Add a key which cloning would omit.
   * @expected Both boundaries reject the original input rather than silently dropping it.
   */
  it.each(hiddenKeyKinds)(
    'rejects keys lost by structured cloning %s',
    async (symbol) => {
      const routes = extraRouteKey(symbol);
      expect(() =>
        GuardsAvalancheConfigs.read(
          reader({ ...valid, 'avalanche.routes': routes }),
        ),
      ).toThrow('Invalid avalanche.routes');
      await refuses(routes);
    },
  );
});
