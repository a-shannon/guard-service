import { readAvalancheBalanceConfig } from '../../src/configs/avalancheBalanceConfig';
import { createBalanceConfig as valid } from './avalancheConfigTestUtils';

describe('readAvalancheBalanceConfig', () => {
  /**
   * @target readAvalancheBalanceConfig captures explicit seconds and immutable token batch size
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Mutate timer and batch inputs after parsing.
   * @expected Retain explicit seconds, batch size and frozen nested records.
   */
  it('captures explicit seconds and immutable token batch size', () => {
    const source = valid();
    const result = readAvalancheBalanceConfig(source);
    source.updateInterval = 1;
    source.tokensPerIteration.rpc = 99;
    expect(result.updateInterval).toEqual(20);
    expect(result.tokensPerIteration.rpc).toEqual(3);
    expect(Object.isFrozen(result)).toEqual(true);
    expect(Object.isFrozen(result.tokensPerIteration)).toEqual(true);
  });
  /**
   * @target readAvalancheBalanceConfig rejects absent or malformed section %s
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Supply each absent or malformed section.
   * @expected Reject the section.
   */
  it.each([undefined, null, [], false, ''])(
    'rejects absent or malformed section %s',
    (raw) => {
      expect(() => readAvalancheBalanceConfig(raw)).toThrow();
    },
  );
  describe.each(['updateInterval', 'updateBatchInterval'])('%s', (field) => {
    /**
     * @target readAvalancheBalanceConfig rejects invalid timer value %s
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Replace one timer field with each invalid deadline.
     * @expected Reject the named timer field.
     */
    it.each([undefined, 0, -1, NaN, Infinity, '1', 0.0001, 2147483.648])(
      'rejects invalid timer value %s',
      (value) => {
        expect(() =>
          readAvalancheBalanceConfig({ ...valid(), [field]: value }),
        ).toThrow(field);
      },
    );
    /**
     * @target readAvalancheBalanceConfig accepts the maximum representable timer deadline
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Supply the maximum representable deadline in each timer field.
     * @expected Preserve that exact deadline.
     */
    it('accepts the maximum representable timer deadline', () => {
      expect(
        readAvalancheBalanceConfig({ ...valid(), [field]: 2147483.647 }),
      ).toMatchObject({ [field]: 2147483.647 });
    });
  });
  /**
   * @target readAvalancheBalanceConfig rejects invalid RPC batch size %s
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Replace the RPC batch size with each invalid value.
   * @expected Reject tokensPerIteration.
   */
  it.each([
    undefined,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    '3',
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid RPC batch size %s', (rpc) => {
    expect(() =>
      readAvalancheBalanceConfig({ ...valid(), tokensPerIteration: { rpc } }),
    ).toThrow('tokensPerIteration');
  });
});
