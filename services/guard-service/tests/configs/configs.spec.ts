import { hooks } from '../guard/mocked/avalancheHealthWiring.mock';

describe('Configs.getAvalancheHealthConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    hooks.rawReads.mockReset();
    hooks.raw = {
      nativeWarnWei: '9007199254740993',
      nativeCriticalWei: '5',
      scannerWarnAgeSeconds: 30,
      scannerCriticalAgeSeconds: 60,
    };
  });

  /**
   * @target Configs.getAvalancheHealthConfig reads exact thresholds lazily and returns an immutable snapshot
   * @dependencies Real Configs and health parser; mocked operator configuration only.
   * @scenario Import Configs without reading health policy, then read once and mutate the raw thresholds.
   * @expected Avoid eager policy reads and preserve the exact captured wei and age thresholds.
   */
  it('reads exact thresholds lazily and returns an immutable snapshot', async () => {
    const { default: Configs } = await import('../../src/configs/configs');
    expect(hooks.rawReads).not.toHaveBeenCalled();
    const policy = Configs.getAvalancheHealthConfig();
    expect(policy).toEqual({
      nativeWarnWei: 9007199254740993n,
      nativeCriticalWei: 5n,
      scannerWarnAgeSeconds: 30,
      scannerCriticalAgeSeconds: 60,
    });
    expect(hooks.rawReads).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(policy)).toBe(true);
    (hooks.raw as { nativeWarnWei: string }).nativeWarnWei = '1';
    expect(policy.nativeWarnWei).toBe(9007199254740993n);
  });

  /**
   * @target Configs.getAvalancheHealthConfig rejects missing or inverted enabled policy
   * @dependencies Real Configs and health parser; mocked operator configuration only.
   * @scenario Omit the section or independently invert native and scanner threshold ordering.
   * @expected Reject each policy before returning a threshold snapshot.
   */
  it.each([
    undefined,
    {
      nativeWarnWei: '4',
      nativeCriticalWei: '5',
      scannerWarnAgeSeconds: 30,
      scannerCriticalAgeSeconds: 60,
    },
    {
      nativeWarnWei: '9007199254740993',
      nativeCriticalWei: '5',
      scannerWarnAgeSeconds: 61,
      scannerCriticalAgeSeconds: 60,
    },
  ])('rejects missing or inverted enabled policy', async (raw) => {
    hooks.raw = raw;
    const { default: Configs } = await import('../../src/configs/configs');
    expect(() => Configs.getAvalancheHealthConfig()).toThrow(
      'Avalanche health',
    );
  });
});
