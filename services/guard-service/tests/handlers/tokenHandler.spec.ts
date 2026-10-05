import { TokenMap } from '@rosen-bridge/tokens';

import { mockTokenMapRead } from './mocked/tokenHandler.mock';
import { mapping } from './tokenHandlerTestUtils';

describe('StartupTokenMap', () => {
  describe('updateConfigByJson', () => {
    let map: TokenMap;
    beforeEach(async () => {
      vi.resetModules();
      const { TokenHandler } = await import('../../src/handlers/tokenHandler');
      mockTokenMapRead(mapping());
      await TokenHandler.init('synthetic-token-map.json');
      vi.restoreAllMocks();
      map = TokenHandler.getInstance().getTokenMap();
    });
    /**
     * @target StartupTokenMap.updateConfigByJson 'retains token partitions and update callbacks'
     * @dependencies Real TokenHandler and TokenMap with synthetic file-read fixtures.
     * @scenario Register a callback and update with fresh valid token records.
     * @expected Preserve bridgeable/unbridgeable partitions and notify once.
     */
    it('retains token partitions and update callbacks', async () => {
      const callback = vi.fn();
      map.registerCallback(callback);
      await map.updateConfigByJson(mapping());
      expect(map.getRawConfig()).toEqual(mapping());
      expect(callback).toHaveBeenCalledOnce();
    });
    /**
     * @target StartupTokenMap.updateConfigByJson 'releases the lease after malformed input'
     * @dependencies Real TokenHandler and TokenMap with synthetic file-read fixtures.
     * @scenario Reject an empty token set and a multi-chain set without Ergo, then update valid records.
     * @expected Each failure releases the lease and the final update completes.
     */
    it('releases the lease after malformed input', async () => {
      await expect(map.updateConfigByJson([{}])).rejects.toThrow(
        'empty token set',
      );
      await expect(
        map.updateConfigByJson([
          { ethereum: mapping()[0].ethereum, bitcoin: mapping()[1].bitcoin },
        ]),
      ).rejects.toThrow('without chain [ergo]');
      await map.updateConfigByJson(mapping());
      expect(map.getRawConfig()).toEqual(mapping());
    });
    /**
     * @target StartupTokenMap.updateConfigByJson 'releases the lease after a throwing callback'
     * @dependencies Real TokenHandler and TokenMap with synthetic file-read fixtures.
     * @scenario Apply an update whose callback throws, unregister it and update again.
     * @expected Preserve applied state after the callback failure and accept the next update.
     */
    it('releases the lease after a throwing callback', async () => {
      const id = map.registerCallback(() => {
        throw new Error('callback failure');
      });
      const next = mapping();
      next[0].ethereum.name = 'updated';
      await expect(map.updateConfigByJson(next)).rejects.toThrow(
        'callback failure',
      );
      expect(map.getRawConfig()).toEqual(next);
      map.unregisterCallback(id);
      await map.updateConfigByJson(mapping());
      expect(map.getRawConfig()).toEqual(mapping());
    });
  });
});
