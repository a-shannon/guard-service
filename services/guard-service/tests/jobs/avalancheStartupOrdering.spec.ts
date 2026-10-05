export {};

const {
  hooks,
  mockTxAgreement1,
  mockArbitraryProcessor2,
  mockRosenDialer3,
  mockDetectionHandler4,
  mockPublicStatusHandler5,
  mockNotificationHandler6,
  mockBalanceHandler7,
  mockAvalancheBalanceConfig8,
  mockMinimumFeeHandler9,
  mockMultiSigHandler10,
  mockTssHandler11,
  mockGuardPkHandler12,
  mockTokenHandler13,
  mockChainHandler14,
  mockDatabaseAction15,
  mockDataSource16,
  mockDataSources17,
  mockInitScanner18,
  mockApiServer19,
  mockMultiSig20,
  mockTss21,
  mockMinimumFee22,
  mockRunProcessors23,
  mockHealthCheck24,
  mockHealthCheck25,
  mockRevenue26,
  mockGuardConfigUpdate27,
  mockEventReprocess28,
  mockEventSynchronization29,
  mockTransactionProcessor30,
  mockRewardAuthorization31,
  mockSigningRuntime32,
  mockErgoMultiSig33,
} = await vi.hoisted(
  async () => import('./mocked/avalancheStartupOrdering.mock'),
);
vi.mock('../../src/agreement/txAgreement', () => mockTxAgreement1());
vi.mock('../../src/arbitrary/arbitraryProcessor', () =>
  mockArbitraryProcessor2(),
);
vi.mock('../../src/communication/rosenDialer', () => mockRosenDialer3());
vi.mock('../../src/handlers/detectionHandler', () => mockDetectionHandler4());
vi.mock('../../src/handlers/publicStatusHandler', () =>
  mockPublicStatusHandler5(),
);
vi.mock('../../src/handlers/notificationHandler', () =>
  mockNotificationHandler6(),
);
vi.mock('../../src/handlers/balanceHandler', () => mockBalanceHandler7());
vi.mock('../../src/configs/avalancheBalanceConfig', () =>
  mockAvalancheBalanceConfig8(),
);
vi.mock('../../src/handlers/minimumFeeHandler', () => mockMinimumFeeHandler9());
vi.mock('../../src/handlers/multiSigHandler', () => mockMultiSigHandler10());
vi.mock('../../src/handlers/tssHandler', () => mockTssHandler11());
vi.mock('../../src/handlers/guardPkHandler', () => mockGuardPkHandler12());
vi.mock('../../src/handlers/tokenHandler', () => mockTokenHandler13());
vi.mock('../../src/handlers/chainHandler', () => mockChainHandler14());
vi.mock('../../src/db/databaseAction', () => mockDatabaseAction15());
vi.mock('../../src/db/dataSource', () => mockDataSource16());
vi.mock('../../src/jobs/dataSources', () => mockDataSources17());
vi.mock('../../src/jobs/initScanner', () => mockInitScanner18());
vi.mock('../../src/jobs/apiServer', () => mockApiServer19());
vi.mock('../../src/jobs/multiSig', () => mockMultiSig20());
vi.mock('../../src/jobs/tss', () => mockTss21());
vi.mock('../../src/jobs/minimumFee', () => mockMinimumFee22());
vi.mock('../../src/jobs/runProcessors', () => mockRunProcessors23());
vi.mock('../../src/jobs/healthCheck', () => mockHealthCheck24());
vi.mock('../../src/guard/healthCheck', () => mockHealthCheck25());
vi.mock('../../src/jobs/revenue', () => mockRevenue26());
vi.mock('../../src/jobs/guardConfigUpdate', () => mockGuardConfigUpdate27());
vi.mock('../../src/reprocess/eventReprocess', () => mockEventReprocess28());
vi.mock('../../src/synchronization/eventSynchronization', () =>
  mockEventSynchronization29(),
);
vi.mock('../../src/transaction/transactionProcessor', () =>
  mockTransactionProcessor30(),
);
vi.mock('../../src/verification/rewardAuthorization', () =>
  mockRewardAuthorization31(),
);
vi.mock('../../src/signing/signingRuntime', () => mockSigningRuntime32());
vi.mock('@rosen-bridge/ergo-multi-sig', (original) =>
  mockErgoMultiSig33(original),
);

describe('production entry-point registration barrier', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    hooks.calls.length = 0;
    hooks.inputs = Object.freeze({ config: {}, contracts: {} });
    hooks.register.mockReset().mockResolvedValue(undefined);
    hooks.chain.mockReset().mockResolvedValue(undefined);
    hooks.reward.mockReset();
    hooks.health.mockReset().mockResolvedValue(undefined);
    hooks.balancePolicy.mockReset().mockReturnValue({
      updateInterval: 1,
      updateBatchInterval: 1,
      tokensPerIteration: { rpc: 1 },
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const starts = [
    'api',
    'multisig jobs',
    'tss jobs',
    'fee jobs',
    'scanner jobs',
    'processors',
  ];
  /**
   * @target initialization 'registers everything before API and recurring work, enabled=%s'
   * @dependencies Actual initialization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'registers everything before API and recurring work, enabled=%s' through initialization.
   * @expected expect(hooks.calls.indexOf(name)).toBeGreaterThan( hooks.calls.indexOf('register ready'), ); expect(hooks.calls.indexOf(name)).toBeGreaterThan( hooks.calls.indexOf('health ready'), ); expect(hooks.calls.indexOf('chain ready')).toBeLessThan( hooks.calls.indexOf('register begin'), ); expect(hooks.calls.indexOf('reward authorization')).toBeGreaterThan( hooks.calls.indexOf('signing context'), ); expect(hooks.calls.indexOf('reward authorization')).toBeLessThan( hooks.calls.indexOf('chain begin'), ); expect(hooks.calls.indexOf('prepare')).toBeLessThan( hooks.calls.indexOf('chain prepare'), ); expect(hooks.calls.indexOf('seal')).toBeLessThan( hooks.calls.indexOf('signing context'), ); expect(hooks.calls).not.toContain('seal'); expect(hooks.balancePolicy).toHaveBeenCalledTimes(enabled ? 1 : 0);
   */
  it.each([true, false])(
    'registers everything before API and recurring work, enabled=%s',
    async (enabled) => {
      if (!enabled) hooks.inputs = undefined;
      const { initialization } = await import('../../src/index');
      await initialization;
      for (const name of starts)
        expect(hooks.calls.indexOf(name)).toBeGreaterThan(
          hooks.calls.indexOf('register ready'),
        );
      for (const name of starts)
        expect(hooks.calls.indexOf(name)).toBeGreaterThan(
          hooks.calls.indexOf('health ready'),
        );
      expect(hooks.calls.indexOf('chain ready')).toBeLessThan(
        hooks.calls.indexOf('register begin'),
      );
      expect(hooks.calls.indexOf('reward authorization')).toBeGreaterThan(
        hooks.calls.indexOf('signing context'),
      );
      expect(hooks.calls.indexOf('reward authorization')).toBeLessThan(
        hooks.calls.indexOf('chain begin'),
      );
      expect(hooks.calls.indexOf('prepare')).toBeLessThan(
        hooks.calls.indexOf('chain prepare'),
      );
      if (enabled)
        expect(hooks.calls.indexOf('seal')).toBeLessThan(
          hooks.calls.indexOf('signing context'),
        );
      else expect(hooks.calls).not.toContain('seal');
      expect(hooks.balancePolicy).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );
  /**
   * @target initialization 'starts no API or jobs with invalid enabled Avalanche balance policy'
   * @dependencies Actual initialization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'starts no API or jobs with invalid enabled Avalanche balance policy' through initialization.
   * @expected await expect(initialization).rejects.toThrow('balance policy rejected'); expect(hooks.calls).not.toContain(name); expect(hooks.calls).not.toContain('balance'); expect(hooks.calls).not.toContain('health prepare'); expect(vi.getTimerCount()).toBe(0);
   */
  it('starts no API or jobs with invalid enabled Avalanche balance policy', async () => {
    hooks.balancePolicy.mockImplementation(() => {
      throw new Error('balance policy rejected');
    });
    const { initialization } = await import('../../src/index');
    await expect(initialization).rejects.toThrow('balance policy rejected');
    for (const name of starts) expect(hooks.calls).not.toContain(name);
    expect(hooks.calls).not.toContain('balance');
    expect(hooks.calls).not.toContain('health prepare');
    expect(vi.getTimerCount()).toBe(0);
  });
  /**
   * @target initialization 'starts no API or recurring work after health registration fails'
   * @dependencies Actual initialization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'starts no API or recurring work after health registration fails' through initialization.
   * @expected await expect(initialization).rejects.toThrow( 'health configuration rejected', ); expect(hooks.calls).not.toContain(name); expect(hooks.calls).not.toContain('health'); expect(hooks.calls).not.toContain('revenue'); expect(vi.getTimerCount()).toBe(0);
   */
  it('starts no API or recurring work after health registration fails', async () => {
    hooks.health.mockRejectedValue(new Error('health configuration rejected'));
    const { initialization } = await import('../../src/index');
    await expect(initialization).rejects.toThrow(
      'health configuration rejected',
    );
    for (const name of starts) expect(hooks.calls).not.toContain(name);
    expect(hooks.calls).not.toContain('health');
    expect(hooks.calls).not.toContain('revenue');
    expect(vi.getTimerCount()).toBe(0);
  });
  /**
   * @target initialization 'starts no chain, API or jobs after reward authorization initialization fails'
   * @dependencies Actual initialization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'starts no chain, API or jobs after reward authorization initialization fails' through initialization.
   * @expected await expect(initialization).rejects.toThrow( 'reward authorization rejected', ); expect(hooks.calls).not.toContain('chain begin'); expect(hooks.calls).not.toContain('register begin'); expect(hooks.calls).not.toContain(name); expect(vi.getTimerCount()).toBe(0);
   */
  it('starts no chain, API or jobs after reward authorization initialization fails', async () => {
    hooks.reward.mockImplementation(() => {
      throw new Error('reward authorization rejected');
    });
    const { initialization } = await import('../../src/index');
    await expect(initialization).rejects.toThrow(
      'reward authorization rejected',
    );
    expect(hooks.calls).not.toContain('chain begin');
    expect(hooks.calls).not.toContain('register begin');
    for (const name of starts) expect(hooks.calls).not.toContain(name);
    expect(vi.getTimerCount()).toBe(0);
  });
  /**
   * @target initialization 'exposes no API, recurring job or processor after scanner registration rejection'
   * @dependencies Actual initialization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'exposes no API, recurring job or processor after scanner registration rejection' through initialization.
   * @expected await expect(initialization).rejects.toThrow( 'extractor registration rejected', ); expect(hooks.calls).not.toContain(name); expect(vi.getTimerCount()).toBe(0);
   */
  it('exposes no API, recurring job or processor after scanner registration rejection', async () => {
    hooks.register.mockRejectedValue(
      new Error('extractor registration rejected'),
    );
    const { initialization } = await import('../../src/index');
    await expect(initialization).rejects.toThrow(
      'extractor registration rejected',
    );
    for (const name of starts) expect(hooks.calls).not.toContain(name);
    expect(vi.getTimerCount()).toBe(0);
  });
  /**
   * @target initialization 'does not register scanners or start work after chain factory rejection'
   * @dependencies Actual initialization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'does not register scanners or start work after chain factory rejection' through initialization.
   * @expected await expect(initialization).rejects.toThrow('chain rejected'); expect(hooks.calls).not.toContain('register begin'); expect(hooks.calls).not.toContain(name);
   */
  it('does not register scanners or start work after chain factory rejection', async () => {
    hooks.chain.mockRejectedValue(new Error('chain rejected'));
    const { initialization } = await import('../../src/index');
    await expect(initialization).rejects.toThrow('chain rejected');
    expect(hooks.calls).not.toContain('register begin');
    for (const name of starts) expect(hooks.calls).not.toContain(name);
  });
  /**
   * @target initialization 'waits for pending registration instead of exposing partially initialized services'
   * @dependencies Actual initialization sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'waits for pending registration instead of exposing partially initialized services' through initialization.
   * @expected expect(hooks.calls).toContain('register begin'); expect(hooks.calls).not.toContain(name); expect(hooks.calls).toContain('processors');
   */
  it('waits for pending registration instead of exposing partially initialized services', async () => {
    let release!: () => void;
    hooks.register.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const { initialization } = await import('../../src/index');
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(hooks.calls).toContain('register begin');
    for (const name of starts) expect(hooks.calls).not.toContain(name);
    release();
    await initialization;
    expect(hooks.calls).toContain('processors');
  });
});
