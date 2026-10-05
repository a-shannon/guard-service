import {
  SUPPORTED_CHAINS,
  LEGACY_SUPPORTED_CHAINS,
  LEGACY_BALANCE_CHAINS,
  COLD_STORAGE_CHAINS,
  ARBITRARY_ORDER_CHAINS,
  ChainNativeToken,
  ChainConfigKey,
} from '../../src/utils/constants';

describe('constants', () => {
  describe('chain registration', () => {
    /**
     * @target SUPPORTED_CHAINS registers Avalanche without changing existing chain order
     * @dependencies Real constant registries; no mocked dependencies.
     * @scenario Read the known identities and their associated native/config keys.
     * @expected Avalanche appears once, maps to avax, and leaves Ergo first.
     */
    it('registers Avalanche without changing existing chain order', () => {
      expect(SUPPORTED_CHAINS).toEqual([
        ...LEGACY_SUPPORTED_CHAINS,
        'avalanche',
      ]);
      expect(SUPPORTED_CHAINS[0]).toEqual('ergo');
      expect(ChainNativeToken.avalanche).toEqual('avax');
      expect(ChainConfigKey.avalanche).toEqual('avalanche');
    });
  });
  describe('capability registration', () => {
    /**
     * @target LEGACY_BALANCE_CHAINS, COLD_STORAGE_CHAINS, ARBITRARY_ORDER_CHAINS preserves numeric balances while registering management capabilities
     * @dependencies Real capability registries; no mocked dependencies.
     * @scenario Inspect each capability list after Avalanche identity registration.
     * @expected Preserve original numeric balances and register immutable management capabilities.
     */
    it('preserves numeric balances while registering management capabilities', () => {
      const original = [
        'ergo',
        'cardano',
        'bitcoin',
        'ethereum',
        'binance',
        'doge',
        'firo',
        'handshake',
        'bitcoin-runes',
      ];
      expect(LEGACY_BALANCE_CHAINS).toEqual(original);
      expect(LEGACY_BALANCE_CHAINS).not.toContain('avalanche');
      expect(Object.isFrozen(LEGACY_BALANCE_CHAINS)).toEqual(true);
      for (const list of [COLD_STORAGE_CHAINS, ARBITRARY_ORDER_CHAINS]) {
        expect(list).toEqual([...original, 'avalanche']);
        expect(Object.isFrozen(list)).toEqual(true);
      }
      expect(Object.isFrozen(SUPPORTED_CHAINS)).toEqual(true);
    });
  });
});
