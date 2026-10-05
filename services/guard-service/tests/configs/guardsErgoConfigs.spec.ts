import config from 'config';

import GuardsErgoConfigs, {
  readAvalancheFeeDistribution,
} from '../../src/configs/guardsErgoConfigs';
import { LEGACY_SUPPORTED_CHAINS } from '../../src/utils/constants';
import { ergo, reader } from './avalancheConfigTestUtils';

describe('GuardsErgoConfigs', () => {
  describe('chainBridgeFeeDistribution', () => {
    /**
     * @target GuardsErgoConfigs.chainBridgeFeeDistribution does not inherit a default Avalanche distribution while disabled
     * @dependencies Real config and static fee consumer; no mocked dependencies.
     * @scenario Inspect the default-disabled configuration after registry expansion.
     * @expected Preserve all legacy distributions and create no Avalanche fallback.
     */
    it('does not inherit a default Avalanche distribution while disabled', () => {
      expect(
        config.has('avalanche.enabled')
          ? config.get('avalanche.enabled')
          : false,
      ).toEqual(false);
      expect(
        GuardsErgoConfigs.chainBridgeFeeDistribution.avalanche,
      ).toBeUndefined();
      expect(Object.keys(GuardsErgoConfigs.chainBridgeFeeDistribution)).toEqual(
        [...LEGACY_SUPPORTED_CHAINS],
      );
    });
    describe('explicit enabled distribution', () => {
      /**
       * @target GuardsErgoConfigs.chainBridgeFeeDistribution adds only the opted-in Avalanche distribution and revenue address to static consumers
       * @dependencies Real configuration readers; synthetic input records.
       * @scenario Reload enabled configuration with one explicit Avalanche recipient.
       * @expected Expose the Avalanche fee and revenue address while retaining Ethereum.
       */
      it('adds only the opted-in Avalanche distribution and revenue address to static consumers', async () => {
        vi.resetModules();
        vi.doMock('config', () => ({
          default: {
            has: (key: string) =>
              ['avalanche.enabled', 'reward.bridgeFee.avalanche'].includes(
                key,
              ) || config.has(key),
            get: (key: string) =>
              key === 'avalanche.enabled'
                ? true
                : key === 'reward.bridgeFee.avalanche'
                  ? [{ address: ergo, percent: 10 }]
                  : config.get(key),
          },
        }));
        try {
          const { default: enabled } = await import(
            '../../src/configs/guardsErgoConfigs'
          );
          expect(enabled.chainBridgeFeeDistribution.avalanche).toEqual([
            { address: ergo, percent: 10 },
          ]);
          expect(enabled.bridgeFeeAddresses.has(ergo)).toEqual(true);
          expect(enabled.chainBridgeFeeDistribution.ethereum).toBeDefined();
        } finally {
          vi.doUnmock('config');
          vi.resetModules();
        }
      });
    });
  });
});
describe('readAvalancheFeeDistribution', () => {
  /**
   * @target readAvalancheFeeDistribution does not read Avalanche fee fields when disabled
   * @dependencies ConfigReader API double; real fee reader.
   * @scenario Expose only the disabled flag and fail any other configuration read.
   * @expected Return undefined and read exactly the enabled flag once.
   */
  it('does not read Avalanche fee fields when disabled', () => {
    const get = vi.fn(<T>(key: string): T => {
      if (key !== 'avalanche.enabled') throw new Error('unexpected fee read');
      return false as T;
    });
    expect(
      readAvalancheFeeDistribution({
        has: (key) => key === 'avalanche.enabled',
        get: <T>(key: string): T => get(key) as T,
      }),
    ).toBeUndefined();
    expect(get).toHaveBeenCalledExactlyOnceWith('avalanche.enabled');
  });
  describe('explicit distribution validation', () => {
    /**
     * @target readAvalancheFeeDistribution does not read Avalanche fee fields when disabled %s
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Disable Avalanche or omit its enable flag.
     * @expected Return undefined without reading fee fields.
     */
    it.each([false, undefined])(
      'does not read Avalanche fee fields when disabled %s',
      (enabled) => {
        const values = reader(
          enabled === undefined ? {} : { 'avalanche.enabled': enabled },
        );
        const get = vi.spyOn(values, 'get');
        expect(readAvalancheFeeDistribution(values)).toBeUndefined();
        expect(
          get.mock.calls.every(([key]) => key === 'avalanche.enabled'),
        ).toEqual(true);
      },
    );
    /**
     * @target readAvalancheFeeDistribution requires an explicit distribution when enabled
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Enable Avalanche without a fee distribution.
     * @expected Throw the missing-distribution error.
     */
    it('requires an explicit distribution when enabled', () => {
      expect(() =>
        readAvalancheFeeDistribution(reader({ 'avalanche.enabled': true })),
      ).toThrow('Missing reward.bridgeFee.avalanche');
    });
    /**
     * @target readAvalancheFeeDistribution preserves explicit empty distribution for the existing remainder recipient
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Provide an explicitly empty distribution.
     * @expected Preserve the empty list for the remainder recipient.
     */
    it('preserves explicit empty distribution for the existing remainder recipient', () => {
      expect(
        readAvalancheFeeDistribution(
          reader({
            'avalanche.enabled': true,
            'reward.bridgeFee.avalanche': [],
          }),
        ),
      ).toEqual([]);
    });
    for (const bad of [
      null,
      {},
      [{ address: ergo, percent: -1 }],
      [{ address: ergo, percent: 1.5 }],
      [{ address: ergo, percent: '10' }],
      [{ address: ergo, percent: 100 }],
      [{ address: 'invalid', percent: 1 }],
      [
        { address: ergo, percent: 50 },
        { address: ergo, percent: 50 },
      ],
    ]) {
      /**
       * @target readAvalancheFeeDistribution `rejects malformed distribution ${JSON.stringify(bad)}`
       * @dependencies Real configuration readers; synthetic input records.
       * @scenario Supply each malformed address, percentage or distribution shape.
       * @expected Throw for each invalid distribution.
       */
      it(`rejects malformed distribution ${JSON.stringify(bad)}`, () => {
        expect(() =>
          readAvalancheFeeDistribution(
            reader({
              'avalanche.enabled': true,
              'reward.bridgeFee.avalanche': bad,
            }),
          ),
        ).toThrow();
      });
    }
    /**
     * @target readAvalancheFeeDistribution captures distribution addresses and percentages immutably
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Mutate the supplied percentage after reading.
     * @expected Retain an independently frozen distribution.
     */
    it('captures distribution addresses and percentages immutably', () => {
      const input = [{ address: ergo, percent: 10 }];
      const output = readAvalancheFeeDistribution(
        reader({
          'avalanche.enabled': true,
          'reward.bridgeFee.avalanche': input,
        }),
      )!;
      input[0].percent = 99;
      expect(output).toEqual([{ address: ergo, percent: 10 }]);
      expect(Object.isFrozen(output) && Object.isFrozen(output[0])).toEqual(
        true,
      );
    });
  });
});
