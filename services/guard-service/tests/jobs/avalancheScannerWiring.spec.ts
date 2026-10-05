import {
  getAvalancheScanner,
  initScanner,
  prepareAvalancheScanner,
} from '../../src/jobs/initScanner';

const { hooks, mockAvalancheScannerStartup1, mockErgoScanner2 } =
  await vi.hoisted(async () => import('./mocked/avalancheScannerWiring.mock'));
vi.mock('../../src/jobs/avalancheScannerStartup', () =>
  mockAvalancheScannerStartup1(),
);
vi.mock('@rosen-bridge/ergo-scanner', (importOriginal) =>
  mockErgoScanner2(importOriginal),
);

describe('Avalanche startup joins the production scanner entry point', () => {
  beforeEach(() => {
    hooks.prepare.mockReset().mockResolvedValue(undefined);
    hooks.initialize.mockReset().mockResolvedValue(undefined);
    hooks.legacy.mockReset();
  });
  /**
   * @target prepareAvalancheScanner 'forwards early preflight failures without suppressing them'
   * @dependencies Actual scanner lifecycle functions from jobs/initScanner.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'forwards early preflight failures without suppressing them' with the suite's captured inputs and invoke the prepareAvalancheScanner path.
   * @expected await expect(prepareAvalancheScanner()).rejects.toThrow('residual state'); expect(hooks.initialize).not.toHaveBeenCalled();
   */
  it('forwards early preflight failures without suppressing them', async () => {
    hooks.prepare.mockRejectedValue(new Error('residual state'));
    await expect(prepareAvalancheScanner()).rejects.toThrow('residual state');
    expect(hooks.initialize).not.toHaveBeenCalled();
  });
  /**
   * @target getAvalancheScanner 'exposes the exact lifecycle-owned instance'
   * @dependencies Actual scanner lifecycle functions from jobs/initScanner.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'exposes the exact lifecycle-owned instance' with the suite's captured inputs and invoke the getAvalancheScanner path.
   * @expected expect(getAvalancheScanner()).toBe(hooks.scanner);
   */
  it('exposes the exact lifecycle-owned instance', () => {
    expect(getAvalancheScanner()).toBe(hooks.scanner);
  });
  /**
   * @target initScanner 'does not construct legacy scanners or start jobs before Avalanche registration'
   * @dependencies Actual scanner lifecycle functions from jobs/initScanner.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not construct legacy scanners or start jobs before Avalanche registration' with the suite's captured inputs and invoke the initScanner path.
   * @expected expect(hooks.legacy).not.toHaveBeenCalled(); await expect(initializing).rejects.toThrow('registration failure'); expect(hooks.legacy).not.toHaveBeenCalled();
   */
  it('does not construct legacy scanners or start jobs before Avalanche registration', async () => {
    let reject!: (error: Error) => void;
    hooks.initialize.mockReturnValue(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    const initializing = initScanner();
    expect(hooks.legacy).not.toHaveBeenCalled();
    reject(new Error('registration failure'));
    await expect(initializing).rejects.toThrow('registration failure');
    expect(hooks.legacy).not.toHaveBeenCalled();
  });
  /**
   * @target initScanner 'continues to legacy setup only after registration completes'
   * @dependencies Actual scanner lifecycle functions from jobs/initScanner.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'continues to legacy setup only after registration completes' with the suite's captured inputs and invoke the initScanner path.
   * @expected await expect(initScanner()).rejects.toThrow('legacy constructor reached'); expect(hooks.initialize).toHaveBeenCalledTimes(1); expect(hooks.legacy).toHaveBeenCalledTimes(1); expect(hooks.initialize.mock.invocationCallOrder[0]).toBeLessThan( hooks.legacy.mock.invocationCallOrder[0], );
   */
  it('continues to legacy setup only after registration completes', async () => {
    await expect(initScanner()).rejects.toThrow('legacy constructor reached');
    expect(hooks.initialize).toHaveBeenCalledTimes(1);
    expect(hooks.legacy).toHaveBeenCalledTimes(1);
    expect(hooks.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      hooks.legacy.mock.invocationCallOrder[0],
    );
  });
});
