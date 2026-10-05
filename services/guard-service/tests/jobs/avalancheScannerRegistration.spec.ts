export {};

const {
  hooks,
  mockAvalancheScannerStartup1,
  mockErgoScanner2,
  mockEvmScanner3,
  mockWatcherDataExtractor4,
  mockEvmAddressTxExtractor5,
} = await vi.hoisted(
  async () => import('./mocked/avalancheScannerRegistration.mock'),
);
vi.mock('../../src/jobs/avalancheScannerStartup', () =>
  mockAvalancheScannerStartup1(),
);
vi.mock('@rosen-bridge/ergo-scanner', (original) => mockErgoScanner2(original));
vi.mock('@rosen-bridge/evm-scanner', (original) => mockEvmScanner3(original));
vi.mock('@rosen-bridge/watcher-data-extractor', (original) =>
  mockWatcherDataExtractor4(original),
);
vi.mock('@rosen-bridge/evm-address-tx-extractor', (original) =>
  mockEvmAddressTxExtractor5(original),
);

describe('awaited production scanner registrations', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    hooks.inputs = undefined;
    hooks.initialize.mockReset().mockResolvedValue(undefined);
    hooks.start.mockReset();
    hooks.register.mockReset().mockResolvedValue(undefined);
    hooks.constructed.length = 0;
    hooks.updates.length = 0;
    const { TokenHandler } = await import('../../src/handlers/tokenHandler');
    const { default: Configs } = await import('../../src/configs/configs');
    await TokenHandler.init(Configs.tokensPath);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  /**
   * @target startScannerJobs 'keeps disabled registrations intact and starts only after explicit start'
   * @dependencies Actual scanner lifecycle functions from jobs/initScanner.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps disabled registrations intact and starts only after explicit start' with the suite's captured inputs and invoke the startScannerJobs path.
   * @expected expect(() => startScannerJobs()).toThrow('not registered'); expect(hooks.constructed).toHaveLength(18); expect(hooks.register.mock.calls.length).toBeGreaterThanOrEqual(18); expect(hooks.updates).toEqual([]); expect(hooks.start).not.toHaveBeenCalled(); expect(hooks.updates).toContain('ergo'); expect(() => startScannerJobs()).toThrow('already started');
   */
  it('keeps disabled registrations intact and starts only after explicit start', async () => {
    const { initScanner, startScannerJobs } = await import(
      '../../src/jobs/initScanner'
    );
    expect(() => startScannerJobs()).toThrow('not registered');
    await initScanner();
    expect(hooks.constructed).toHaveLength(18);
    expect(hooks.register.mock.calls.length).toBeGreaterThanOrEqual(18);
    expect(hooks.updates).toEqual([]);
    expect(hooks.start).not.toHaveBeenCalled();
    startScannerJobs();
    expect(hooks.updates).toContain('ergo');
    expect(() => startScannerJobs()).toThrow('already started');
  });
  /**
   * @target initScanner 'constructs both optional Ergo extractors from the exact prepared contracts'
   * @dependencies Actual scanner lifecycle functions from jobs/initScanner.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'constructs both optional Ergo extractors from the exact prepared contracts' with the suite's captured inputs and invoke the initScanner path.
   * @expected expect(getPreparedAvalancheInputs()).toBe(hooks.inputs); expect(commitment.slice(0, 3)).toEqual([ 'avalancheCommitment', ['commitment'], 'rwt', ]); expect(commitment[5]).toMatchObject({ address: 'commitment' }); expect(event.slice(4, 8)).toEqual(['trigger', 'rwt', 'permit', 'fraud']); expect( hooks.register.mock.calls.filter(([id]) => id.startsWith('avalanche')), ).toEqual([['avalancheCommitment'], ['avalancheEventTrigger']]); expect(hooks.updates).toEqual([]);
   */
  it('constructs both optional Ergo extractors from the exact prepared contracts', async () => {
    const contracts = Object.freeze({
      addresses: Object.freeze({
        lock: 'lock',
        Commitment: 'commitment',
        WatcherTriggerEvent: 'trigger',
        WatcherPermit: 'permit',
        Fraud: 'fraud',
      }),
      tokens: Object.freeze({ RWTId: 'rwt' }),
    });
    hooks.inputs = Object.freeze({ config: {}, contracts });
    const { initScanner, getPreparedAvalancheInputs } = await import(
      '../../src/jobs/initScanner'
    );
    await initScanner();
    expect(getPreparedAvalancheInputs()).toBe(hooks.inputs);
    const commitment = hooks.constructed.find(
      (item) => item.args[0] === 'avalancheCommitment',
    )!.args;
    const event = hooks.constructed.find(
      (item) => item.args[0] === 'avalancheEventTrigger',
    )!.args;
    expect(commitment.slice(0, 3)).toEqual([
      'avalancheCommitment',
      ['commitment'],
      'rwt',
    ]);
    expect(commitment[5]).toMatchObject({ address: 'commitment' });
    expect(event.slice(4, 8)).toEqual(['trigger', 'rwt', 'permit', 'fraud']);
    expect(
      hooks.register.mock.calls.filter(([id]) => id.startsWith('avalanche')),
    ).toEqual([['avalancheCommitment'], ['avalancheEventTrigger']]);
    expect(hooks.updates).toEqual([]);
  });
  /**
   * @target initScanner 'cannot start any scanner if %s registration fails'
   * @dependencies Actual scanner lifecycle functions from jobs/initScanner.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'cannot start any scanner if %s registration fails' with the suite's captured inputs and invoke the initScanner path.
   * @expected await expect(initScanner()).rejects.toThrow('registration failed'); expect(() => startScannerJobs()).toThrow('not registered'); expect(hooks.updates).toEqual([]); expect(hooks.start).not.toHaveBeenCalled();
   */
  it.each([
    'avalancheCommitment',
    'avalancheEventTrigger',
    'bitcoinRunesEventTrigger',
  ])('cannot start any scanner if %s registration fails', async (failedId) => {
    hooks.inputs = {
      contracts: {
        addresses: {
          Commitment: 'commitment',
          WatcherTriggerEvent: 'trigger',
          WatcherPermit: 'permit',
          Fraud: 'fraud',
        },
        tokens: { RWTId: 'rwt' },
      },
    };
    hooks.register.mockImplementation(async (id) => {
      if (id === failedId) throw new Error('registration failed');
    });
    const { initScanner, startScannerJobs } = await import(
      '../../src/jobs/initScanner'
    );
    await expect(initScanner()).rejects.toThrow('registration failed');
    expect(() => startScannerJobs()).toThrow('not registered');
    expect(hooks.updates).toEqual([]);
    expect(hooks.start).not.toHaveBeenCalled();
  });
  /**
   * @target initScanner 'awaits the final legacy Ergo extractor before permitting startup'
   * @dependencies Actual scanner lifecycle functions from jobs/initScanner.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'awaits the final legacy Ergo extractor before permitting startup' with the suite's captured inputs and invoke the initScanner path.
   * @expected expect(hooks.register).toHaveBeenCalledWith('bitcoinRunesEventTrigger'); expect(() => startScannerJobs()).toThrow('not registered'); expect(hooks.updates).toEqual([]); expect(hooks.updates).toContain('ergo');
   */
  it('awaits the final legacy Ergo extractor before permitting startup', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.register.mockImplementation(async (id) => {
      if (id === 'bitcoinRunesEventTrigger') await pending;
    });
    const { initScanner, startScannerJobs } = await import(
      '../../src/jobs/initScanner'
    );
    const initializing = initScanner();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(hooks.register).toHaveBeenCalledWith('bitcoinRunesEventTrigger');
    expect(() => startScannerJobs()).toThrow('not registered');
    expect(hooks.updates).toEqual([]);
    release();
    await initializing;
    startScannerJobs();
    expect(hooks.updates).toContain('ergo');
  });
});
