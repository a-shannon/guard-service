import {
  captureAvalancheHealthConfig,
  readAvalancheHealthConfig,
} from '../../src/configs/avalancheHealthConfig';
import { createRawHealthConfig as raw } from './avalancheConfigTestUtils';

describe('readAvalancheHealthConfig', () => {
  /**
   * @target readAvalancheHealthConfig captures immutable exact wei and ignores blockTime
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Use exact wei strings, a forbidden blockTime getter and caller mutation.
   * @expected Capture immutable exact wei independently and avoid blockTime.
   */
  it('captures immutable exact wei and ignores blockTime', () => {
    const input = {
      ...raw(),
      get blockTime() {
        throw new Error('must not read');
      },
    };
    const config = readAvalancheHealthConfig(input);
    expect(config.nativeWarnWei).toEqual(9007199254740993n);
    expect(Object.isFrozen(config)).toEqual(true);
    input.nativeWarnWei = '1';
    expect(config.nativeWarnWei).toEqual(9007199254740993n);
    expect(captureAvalancheHealthConfig(config)).toEqual(config);
    expect(captureAvalancheHealthConfig(config)).not.toBe(config);
  });
  /**
   * @target readAvalancheHealthConfig requires an explicit section %s
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Supply each absent or malformed policy section.
   * @expected Reject the section.
   */
  it.each([null, undefined, [], true, 'config'])(
    'requires an explicit section %s',
    (value) => {
      expect(() => readAvalancheHealthConfig(value)).toThrow();
    },
  );
  for (const field of ['nativeWarnWei', 'nativeCriticalWei'] as const) {
    /**
     * @target readAvalancheHealthConfig 'rejects ' + field + ' %s'
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Replace one wei threshold with a malformed decimal value.
     * @expected Reject each noncanonical or overflowing threshold.
     */
    it.each([
      undefined,
      0,
      1n,
      '',
      '-1',
      '01',
      '1.1',
      '1e18',
      ' 1',
      '1\n',
      (1n << 256n).toString(),
    ])('rejects ' + field + ' %s', (value) => {
      expect(() =>
        readAvalancheHealthConfig({ ...raw(), [field]: value }),
      ).toThrow();
    });
  }
  for (const field of [
    'scannerWarnAgeSeconds',
    'scannerCriticalAgeSeconds',
  ] as const) {
    /**
     * @target readAvalancheHealthConfig 'rejects ' + field + ' %s'
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Replace one scanner-age threshold with an invalid value.
     * @expected Reject nonpositive or unsafe integer thresholds.
     */
    it.each([
      undefined,
      0,
      -1,
      1.1,
      NaN,
      Infinity,
      '10',
      10n,
      Number.MAX_SAFE_INTEGER + 1,
    ])('rejects ' + field + ' %s', (value) => {
      expect(() =>
        readAvalancheHealthConfig({ ...raw(), [field]: value }),
      ).toThrow();
    });
  }
  /**
   * @target readAvalancheHealthConfig allows zero/equal wei and equal positive scanner thresholds
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Use equal zero wei thresholds and equal positive age thresholds.
   * @expected Accept inclusive equal boundaries.
   */
  it('allows zero/equal wei and equal positive scanner thresholds', () => {
    expect(
      readAvalancheHealthConfig({
        ...raw(),
        nativeWarnWei: '0',
        nativeCriticalWei: '0',
        scannerCriticalAgeSeconds: 10,
      }),
    ).toMatchObject({ nativeWarnWei: 0n, nativeCriticalWei: 0n });
  });
  /**
   * @target readAvalancheHealthConfig allows uint256 and safe integer maximum thresholds
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Supply uint256 and safe-integer maximum thresholds.
   * @expected Preserve the exact maximum wei threshold.
   */
  it('allows uint256 and safe integer maximum thresholds', () => {
    const max = ((1n << 256n) - 1n).toString();
    expect(
      readAvalancheHealthConfig({
        nativeWarnWei: max,
        nativeCriticalWei: max,
        scannerWarnAgeSeconds: Number.MAX_SAFE_INTEGER,
        scannerCriticalAgeSeconds: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ nativeWarnWei: BigInt(max) });
  });
  /**
   * @target readAvalancheHealthConfig rejects reversed thresholds
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Reverse native or scanner threshold ordering independently.
   * @expected Throw the ordering error.
   */
  it.each([
    { nativeCriticalWei: '9007199254740994' },
    { scannerCriticalAgeSeconds: 9 },
  ])('rejects reversed thresholds', (patch) => {
    expect(() => readAvalancheHealthConfig({ ...raw(), ...patch })).toThrow(
      'ordering',
    );
  });
  /**
   * @target readAvalancheHealthConfig captures exact immutable mapped token thresholds
   * @dependencies Actual canonical config parser
   * @scenario Parse one JOE raw-unit threshold and mutate the caller afterward
   * @expected Preserve captured bigint thresholds and frozen token policy
   */
  it('captures exact immutable mapped token thresholds', () => {
    const token = {
      tokenId: '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd',
      warnRaw: '9007199254740993',
      criticalRaw: '5',
    };
    const captured = readAvalancheHealthConfig({ ...raw(), tokens: [token] });
    expect(captured.tokens).toEqual([
      { tokenId: token.tokenId, warnRaw: 9007199254740993n, criticalRaw: 5n },
    ]);
    token.warnRaw = '1';
    expect(captureAvalancheHealthConfig(captured)).toEqual(captured);
    expect(Object.isFrozen(captured.tokens)).toEqual(true);
    expect(Object.isFrozen(captured.tokens![0])).toEqual(true);
  });
  /**
   * @target readAvalancheHealthConfig refuses mapped token threshold %s
   * @dependencies Actual token policy parser; isolated identity/amount fault
   * @scenario Corrupt one token identity, raw threshold, ordering or cardinality
   * @expected Throw before a token health monitor can be registered
   */
  it.each([
    'uppercase',
    'zero address',
    'duplicate',
    'negative',
    'raw overflow',
    'reversed',
    'not array',
  ])('refuses mapped token threshold %s', (fault) => {
    const token = {
      tokenId: '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd',
      warnRaw: '9007199254740993',
      criticalRaw: '5',
    };
    if (fault === 'uppercase') token.tokenId = token.tokenId.toUpperCase();
    if (fault === 'zero address') token.tokenId = '0x' + '00'.repeat(20);
    if (fault === 'negative') token.criticalRaw = '-1';
    if (fault === 'raw overflow') token.warnRaw = (1n << 256n).toString();
    if (fault === 'reversed') token.criticalRaw = '9007199254740994';
    const selected =
      fault === 'not array'
        ? {}
        : fault === 'duplicate'
          ? [token, { ...token }]
          : [token];
    expect(() =>
      readAvalancheHealthConfig({ ...raw(), tokens: selected }),
    ).toThrow();
  });
});

describe('captureAvalancheHealthConfig', () => {
  /**
   * @target captureAvalancheHealthConfig does not coerce raw strings in the parsed constructor contract
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Pass raw string thresholds or a negative parsed bigint threshold.
   * @expected Reject both invalid parsed constructor contracts.
   */
  it('does not coerce raw strings in the parsed constructor contract', () => {
    expect(() => captureAvalancheHealthConfig(raw() as never)).toThrow();
    expect(() =>
      captureAvalancheHealthConfig({
        ...readAvalancheHealthConfig(raw()),
        nativeWarnWei: -1n,
      }),
    ).toThrow();
  });
});
