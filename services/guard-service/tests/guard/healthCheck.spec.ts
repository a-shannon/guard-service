import { HealthStatusLevel } from '@rosen-bridge/health-check';
import { TokenMap } from '@rosen-bridge/tokens';

import { tokenMapping } from '../utils/avalancheChainTestUtils';
import { param } from './avalancheHealthTestUtils';
import { hooks } from './mocked/avalancheHealthWiring.mock';

describe('getHealthCheck', () => {
  const joe = '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd';
  let tokens: TokenMap;
  beforeEach(async () => {
    vi.resetModules();
    hooks.enabled = true;
    hooks.registered = true;
    hooks.raw = {
      nativeWarnWei: '9007199254740993',
      nativeCriticalWei: '5',
      scannerWarnAgeSeconds: 30,
      scannerCriticalAgeSeconds: 60,
    };
    hooks.rawReads.mockReset();
    hooks.balance.mockReset().mockResolvedValue(9007199254740994n);
    hooks.supportedTokens = [];
    hooks.tokenBalance.mockReset().mockResolvedValue(9007199254740994n);
    hooks.lastBlock.mockReset().mockResolvedValue({
      height: 42,
      timestamp: Math.floor(Date.now() / 1000),
    });
    hooks.safety.mockReset().mockImplementation((action) => action());
    tokens = new TokenMap();
    await tokens.updateConfigByJson(tokenMapping());
    const { TokenHandler } = await import('../../src/handlers/tokenHandler');
    vi.spyOn(TokenHandler, 'getInstance').mockReturnValue({
      getTokenMap: () => tokens,
    } as unknown as import('../../src/handlers/tokenHandler').TokenHandler);
    // Load the asset libraries during fixture setup, outside the test deadline.
    await import('../../src/guard/healthCheck');
  });
  afterEach(() => vi.restoreAllMocks());

  /**
   * @target getHealthCheck registers two inert Avalanche parameters and publishes one complete singleton
   * @dependencies Real getHealthCheck; mocked configuration, scanner and chain boundaries.
   * @scenario Construct enabled health without updating its parameters.
   * @expected Publish one complete singleton with two inert Avalanche parameters.
   */
  it('registers two inert Avalanche parameters and publishes one complete singleton', async () => {
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    const health = await getHealthCheck();
    expect(await getHealthCheck()).toBe(health);
    expect(await param(health, 'avalanche-native-balance')).toBeDefined();
    expect(await param(health, 'avalanche-scanner-age')).toBeDefined();
    expect(hooks.balance).not.toHaveBeenCalled();
    expect(hooks.lastBlock).not.toHaveBeenCalled();
    expect(hooks.safety).not.toHaveBeenCalled();
    expect(hooks.rawReads).toHaveBeenCalledTimes(1);
  });

  /**
   * @target getHealthCheck uses raw wei and the qualified scanner reader at update time
   * @dependencies Real getHealthCheck; mocked configuration, scanner and chain boundaries.
   * @scenario Update native and scanner parameters then reject the scanner safety guard.
   * @expected Read raw wei and only qualified blocks; mark held scanner BROKEN without another block read.
   */
  it('uses raw wei and the qualified scanner reader at update time', async () => {
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    const health = await getHealthCheck();
    await health.updateParam('avalanche-native-balance');
    await health.updateParam('avalanche-scanner-age');
    expect((await param(health, 'avalanche-native-balance'))?.status).toEqual(
      HealthStatusLevel.HEALTHY,
    );
    expect((await param(health, 'avalanche-scanner-age'))?.status).toEqual(
      HealthStatusLevel.HEALTHY,
    );
    expect(hooks.balance).toHaveBeenCalledTimes(1);
    expect(hooks.safety).toHaveBeenCalledTimes(2);
    expect(hooks.lastBlock).toHaveBeenCalledExactlyOnceWith('avalanche');
    hooks.safety.mockRejectedValue(new Error('scanner held'));
    await health.updateParam('avalanche-scanner-age');
    expect((await param(health, 'avalanche-scanner-age'))?.status).toEqual(
      HealthStatusLevel.BROKEN,
    );
    expect(hooks.lastBlock).toHaveBeenCalledTimes(1);
  });

  /**
   * @target getHealthCheck projects exact native thresholds for balance %s
   * @dependencies Real Configs, health parser and shared native health parameter; mocked chain balance only.
   * @scenario Update the registered native health parameter at exact warning and critical boundaries.
   * @expected Preserve inclusive exact-wei thresholds without rounding or substituting defaults.
   */
  it.each([
    [9007199254740994n, HealthStatusLevel.HEALTHY],
    [9007199254740993n, HealthStatusLevel.UNSTABLE],
    [5n, HealthStatusLevel.BROKEN],
  ])(
    'projects exact native thresholds for balance %s',
    async (balance, status) => {
      hooks.balance.mockResolvedValue(balance);
      const { getHealthCheck } = await import('../../src/guard/healthCheck');
      const health = await getHealthCheck();
      await health.updateParam('avalanche-native-balance');
      expect((await param(health, 'avalanche-native-balance'))?.status).toEqual(
        status,
      );
      expect(hooks.rawReads).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * @target getHealthCheck skips all Avalanche configuration and readers when disabled
   * @dependencies Real getHealthCheck; mocked configuration, scanner and chain boundaries.
   * @scenario Disable Avalanche and forbid health configuration reads.
   * @expected Skip all Avalanche parameters, readers and configuration.
   */
  it('skips all Avalanche configuration and readers when disabled', async () => {
    hooks.enabled = false;
    hooks.rawReads.mockImplementation(() => {
      throw new Error('forbidden config');
    });
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    const health = await getHealthCheck();
    expect(await param(health, 'avalanche-native-balance')).toBeUndefined();
    expect(await param(health, 'avalanche-scanner-age')).toBeUndefined();
    expect(hooks.rawReads).not.toHaveBeenCalled();
    expect(hooks.balance).not.toHaveBeenCalled();
  });

  /**
   * @target getHealthCheck rejects absent or malformed enabled health policy without retaining a partial singleton
   * @dependencies Real getHealthCheck; mocked configuration, scanner and chain boundaries.
   * @scenario Reject enabled malformed policy then restore its valid raw configuration.
   * @expected Reject partial construction and retry with exactly one of each parameter.
   */
  it.each([undefined, {}, { nativeWarnWei: 10 }])(
    'rejects absent or malformed enabled health policy without retaining a partial singleton',
    async (invalid) => {
      const valid = hooks.raw;
      hooks.raw = invalid;
      const { getHealthCheck } = await import('../../src/guard/healthCheck');
      await expect(async () => await getHealthCheck()).rejects.toThrow(
        'Avalanche health',
      );
      hooks.raw = valid;
      const health = await getHealthCheck();
      expect(await param(health, 'avalanche-native-balance')).toBeDefined();
      expect(await param(health, 'avalanche-scanner-age')).toBeDefined();
      const params = await health.getHealthStatus();
      expect(
        params.filter((param) => param.id === 'avalanche-native-balance'),
      ).toHaveLength(1);
      expect(
        params.filter((param) => param.id === 'avalanche-scanner-age'),
      ).toHaveLength(1);
    },
  );

  /**
   * @target getHealthCheck rejects missing scanner registration and can retry complete construction
   * @dependencies Real getHealthCheck; mocked configuration, scanner and chain boundaries.
   * @scenario Remove scanner registration then restore it.
   * @expected Reject incomplete construction and allow a complete retry.
   */
  it('rejects missing scanner registration and can retry complete construction', async () => {
    hooks.registered = false;
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    await expect(async () => await getHealthCheck()).rejects.toThrow(
      'registered scanner',
    );
    hooks.registered = true;
    expect(
      await param(await getHealthCheck(), 'avalanche-scanner-age'),
    ).toBeDefined();
  });

  /**
   * @target getHealthCheck retains captured thresholds after the raw configuration changes
   * @dependencies Real getHealthCheck; mocked configuration, scanner and chain boundaries.
   * @scenario Mutate raw thresholds after construction and update native health.
   * @expected Retain the captured policy and read raw configuration once.
   */
  it('retains captured thresholds after the raw configuration changes', async () => {
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    const health = await getHealthCheck();
    (hooks.raw as { nativeWarnWei: string }).nativeWarnWei =
      '9999999999999999999999';
    await health.updateParam('avalanche-native-balance');
    expect((await param(health, 'avalanche-native-balance'))?.status).toEqual(
      HealthStatusLevel.HEALTHY,
    );
    expect(hooks.rawReads).toHaveBeenCalledTimes(1);
  });

  /**
   * @target getHealthCheck registers separate JOE and AVAX monitors using raw balances under scanner exclusion
   * @dependencies Real shared asset health, generated TokenMap and Guard registration; retained synthetic chain/scanner ports
   * @scenario Configure one mapped JOE threshold, update native and token monitors, then hold the scanner
   * @expected Preserve exact values above Number.MAX_SAFE_INTEGER and prevent both balance readers while held
   */
  it('registers separate JOE and AVAX monitors using raw balances under scanner exclusion', async () => {
    hooks.supportedTokens = [joe];
    hooks.raw = {
      ...(hooks.raw as object),
      tokens: [{ tokenId: joe, warnRaw: '9007199254740993', criticalRaw: '5' }],
    };
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    const health = await getHealthCheck();
    const id = (await health.getHealthStatus()).find((item) =>
      item.id.startsWith('asset_' + joe + '_'),
    )!.id;
    await health.updateParam(id);
    await health.updateParam('avalanche-native-balance');
    expect((await param(health, id))?.status).toEqual(
      HealthStatusLevel.HEALTHY,
    );
    expect((await param(health, 'avalanche-native-balance'))?.status).toEqual(
      HealthStatusLevel.HEALTHY,
    );
    expect(hooks.tokenBalance).toHaveBeenCalledExactlyOnceWith(
      '0x' + '12'.repeat(20),
      joe,
    );
    expect(hooks.safety).toHaveBeenCalledTimes(2);
    hooks.safety.mockRejectedValue(new Error('scanner held'));
    await health.updateParam(id);
    await health.updateParam('avalanche-native-balance');
    expect((await param(health, id))?.status).toEqual(HealthStatusLevel.BROKEN);
    expect((await param(health, 'avalanche-native-balance'))?.status).toEqual(
      HealthStatusLevel.BROKEN,
    );
    expect(hooks.tokenBalance).toHaveBeenCalledTimes(1);
    expect(hooks.balance).toHaveBeenCalledTimes(1);
  });
  /**
   * @target getHealthCheck refuses token health %s
   * @dependencies Actual parsed token policy and asset health registration with one changed map or retained reader
   * @scenario Remove a required threshold, select an unsupported token, or change metadata during a token read
   * @expected Refuse partial startup or mark the affected monitor BROKEN
   */
  it.each([
    'missing threshold',
    'unsupported token',
    'late map',
    'late reader',
  ])('refuses token health %s', async (fault) => {
    hooks.supportedTokens = [joe];
    if (fault !== 'missing threshold')
      hooks.raw = {
        ...(hooks.raw as object),
        tokens: [
          {
            tokenId:
              fault === 'unsupported token' ? '0x' + '78'.repeat(20) : joe,
            warnRaw: '9007199254740993',
            criticalRaw: '5',
          },
        ],
      };
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    if (fault === 'missing threshold' || fault === 'unsupported token') {
      await expect(getHealthCheck()).rejects.toThrow(
        'thresholds for every mapped token',
      );
      expect(hooks.tokenBalance).not.toHaveBeenCalled();
      return;
    }
    const health = await getHealthCheck();
    const id = (await health.getHealthStatus()).find((item) =>
      item.id.startsWith('asset_' + joe + '_'),
    )!.id;
    hooks.tokenBalance.mockImplementationOnce(async () => {
      if (fault === 'late map') {
        const raw = tokens.getRawConfig();
        raw[1].avalanche.name = 'changed';
        await tokens.updateConfigByJson(raw);
      } else {
        const { default: ChainHandler } = await import(
          '../../src/handlers/chainHandler'
        );
        (
          ChainHandler.getInstance().getChain(
            'avalanche',
          ) as import('@rosen-chains/avalanche').AvalancheChain
        ).network.getAddressBalanceForERC20Asset = vi
          .fn()
          .mockResolvedValue(1n);
      }
      return 9007199254740994n;
    });
    await health.updateParam(id);
    expect((await param(health, id))?.status).toEqual(HealthStatusLevel.BROKEN);
  });
  /**
   * @target getHealthCheck refuses a scanner health reader replaced during its read
   * @dependencies Actual registration and health parameters; stable mocked DAO and a late reader replacement.
   * @scenario Replace the captured DAO method before its pending read completes.
   * @expected The result is Broken and cannot publish a successful stale observation.
   */
  it('refuses a scanner health reader replaced during its read', async () => {
    const { DatabaseAction } = await import('../../src/db/databaseAction');
    const database = DatabaseAction.getInstance();
    const original = database.getLastSavedBlockForScanner;
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    const health = await getHealthCheck();
    hooks.lastBlock.mockImplementation(async () => {
      database.getLastSavedBlockForScanner = vi.fn();
      return { height: 42, timestamp: Math.floor(Date.now() / 1000) };
    });
    try {
      await health.updateParam('avalanche-scanner-age');
      expect((await param(health, 'avalanche-scanner-age'))?.status).toEqual(
        HealthStatusLevel.BROKEN,
      );
    } finally {
      database.getLastSavedBlockForScanner = original;
    }
  });

  /**
   * @target getHealthCheck bounds Avalanche health admission by configured RPC time and selected monitor count
   * @dependencies Actual registration; mocked health acquisition records its arguments.
   * @scenario Update native and scanner health for a configuration with eight-second RPC timeout and no ERC20 monitor.
   * @expected Both health reads receive the 8000ms deadline and capacity two.
   */
  it('bounds Avalanche health admission by configured RPC time and selected monitor count', async () => {
    const { getHealthCheck } = await import('../../src/guard/healthCheck');
    const health = await getHealthCheck();
    await health.updateParam('avalanche-native-balance');
    await health.updateParam('avalanche-scanner-age');
    expect(hooks.safety).toHaveBeenCalledTimes(2);
    for (const args of hooks.safety.mock.calls)
      expect(args.slice(1)).toEqual([8000, 2]);
  });
});
