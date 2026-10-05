import { TokenMap } from '@rosen-bridge/tokens';

import {
  mapping as avalancheMapping,
  internals,
} from './avalancheTokenMapTestUtils';
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

describe('TokenHandler', () => {
  const mapping = avalancheMapping;

  let handler: import('../../src/handlers/tokenHandler').TokenHandler;
  let map: TokenMap;
  beforeEach(async () => {
    vi.resetModules();
    const { TokenHandler } = await import('../../src/handlers/tokenHandler');
    mockTokenMapRead(mapping());
    await TokenHandler.init('synthetic-token-map.json');
    vi.restoreAllMocks();
    handler = TokenHandler.getInstance();
    map = handler.getTokenMap();
  });

  describe('getTokenMap', () => {
    /**
     * @target TokenHandler.getTokenMap preserves updates and callback notifications until explicitly sealed
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Update the unsealed map with a registered callback.
     * @expected Preserve mutable updates and callback notification before sealing.
     */
    it('preserves updates and callback notifications until explicitly sealed', async () => {
      const callback = vi.fn();
      map.registerCallback(callback);
      const next = mapping();
      next[0].avalanche.decimals = 12;
      await map.updateConfigByJson(next);
      expect(map.getRawConfig()).toEqual(next);
      expect(callback).toHaveBeenCalledOnce();
    });
  });
  describe('sealForAvalanche', () => {
    /**
     * @target TokenHandler.sealForAvalanche retains the exact map, reader results and conversion after sealing
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Capture conversions and seal the map twice.
     * @expected Retain map identity, token partitions and exact conversions.
     */
    it('retains the exact map, reader results and conversion after sealing', async () => {
      const before = map.getRawConfig();
      const wrapped = map.wrapAmount('avax', 1000000001n, 'avalanche');
      await handler.sealForAvalanche();
      await handler.sealForAvalanche();
      expect(handler.getTokenMap()).toBe(map);
      expect(map.getRawConfig()).toEqual(before);
      expect(map.wrapAmount('avax', 1000000001n, 'avalanche')).toEqual(wrapped);
      expect(map.unwrapAmount('avax', 1n, 'avalanche').amount).toEqual(
        1000000000n,
      );
      expect(map.getAllChains()).toEqual(['avalanche', 'ergo']);
      expect(map.getSupportedChains('avalanche')).toEqual(['ergo']);
      expect(map.getID(map.getTokenSet('avax')!, 'ergo')).toEqual(
        'cd'.repeat(32),
      );
    });

    /**
     * @target TokenHandler.sealForAvalanche retains installed TokenMap partition behavior: %s
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Compare empty, Ergo-only and full partitions with a fresh real TokenMap.
     * @expected Preserve installed partition behavior before and after sealing.
     */
    it.each(['empty', 'Ergo only', 'bridgeable and unbridgeable'])(
      'retains installed TokenMap partition behavior: %s',
      async (kind) => {
        const input =
          kind === 'empty'
            ? []
            : kind === 'Ergo only'
              ? [{ ergo: mapping()[0].ergo }]
              : mapping();
        const reference = new TokenMap();
        await reference.updateConfigByJson(input);
        await map.updateConfigByJson(input);
        expect(map.getConfig()).toEqual(reference.getConfig());
        expect(map.getRawConfig()).toEqual(reference.getRawConfig());
        await handler.sealForAvalanche();
        expect(map.getRawConfig()).toEqual(reference.getRawConfig());
      },
    );

    for (const [name, obtain] of [
      ['getTokenSet', (m: TokenMap) => m.getTokenSet('avax')!.avalanche],
      [
        'search',
        (m: TokenMap) =>
          m.search('avalanche', { tokenId: 'avax' })[0].avalanche,
      ],
      ['getTokens', (m: TokenMap) => m.getTokens('avalanche', 'ergo')[0]],
      [
        'getAllNativeTokens',
        (m: TokenMap) => m.getAllNativeTokens('avalanche')[0],
      ],
      [
        'unbridgeable getTokenSet',
        (m: TokenMap) => m.getTokenSet('unbridgeable', true)!.ethereum,
      ],
    ] as const) {
      /**
       * @target TokenHandler.sealForAvalanche `freezes previously captured ${name} member and its extra object`
       * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
       * @scenario Capture each reader member before sealing and attempt nested mutation.
       * @expected Freeze the captured member and its extra object without changing the map.
       */
      it(`freezes previously captured ${name} member and its extra object`, async () => {
        const member = obtain(map);
        await handler.sealForAvalanche();
        expect(() => {
          member.decimals = 0;
        }).toThrow();
        expect(() => {
          member.extra.label = 'changed';
        }).toThrow();
        expect(Object.isFrozen(member)).toEqual(true);
        expect(map.getRawConfig()).toEqual(mapping());
      });
    }

    /**
     * @target TokenHandler.sealForAvalanche keeps %s as an independent editable copy
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Mutate each returned configuration copy after sealing.
     * @expected Keep the sealed map intact while its copies remain editable.
     */
    it.each(['getConfig', 'getRawConfig'] as const)(
      'keeps %s as an independent editable copy',
      async (method) => {
        await handler.sealForAvalanche();
        const copy = map[method]();
        copy[0].avalanche.decimals = 0;
        copy.length = 0;
        expect(map.getRawConfig()).toEqual(mapping());
      },
    );

    /**
     * @target TokenHandler.sealForAvalanche blocks %s replacement, redefinition and array mutation
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Replace, redefine and mutate each internal token array after sealing.
     * @expected Reject every mutation attempt.
     */
    it.each(['tokensConfig', 'unbridgeableTokens'] as const)(
      'blocks %s replacement, redefinition and array mutation',
      async (key) => {
        const array = internals(map)[key];
        await handler.sealForAvalanche();
        expect(() => {
          internals(map)[key] = [];
        }).toThrow();
        expect(() => Object.defineProperty(map, key, { value: [] })).toThrow();
        expect(() => array.push(mapping()[0])).toThrow();
        expect(() => {
          array[0].replacement = mapping()[0].ergo;
        }).toThrow();
      },
    );

    /**
     * @target TokenHandler.sealForAvalanche blocks handler map, getter and update-method replacement
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Replace the map, getter, reader and update methods after sealing.
     * @expected Reject each replacement attempt.
     */
    it('blocks handler map, getter and update-method replacement', async () => {
      await handler.sealForAvalanche();
      expect(() =>
        Object.defineProperty(handler, 'tokenMap', { value: new TokenMap() }),
      ).toThrow();
      expect(() => {
        handler.getTokenMap = () => new TokenMap();
      }).toThrow();
      expect(() => {
        map.updateConfigByJson = async () => undefined;
      }).toThrow();
      expect(() => {
        map.getRawConfig = () => [];
      }).toThrow();
      expect(() => {
        map.getTokenSet = () => undefined;
      }).toThrow();
      expect(() => {
        map.unwrapAmount = () => ({ amount: 0n, decimals: 0 });
      }).toThrow();
    });

    /**
     * @target TokenHandler.sealForAvalanche rejects updates through current and previously captured methods without notifying callbacks
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Call both captured and current update methods after sealing.
     * @expected Reject both updates without notifying callbacks or changing tokens.
     */
    it('rejects updates through current and previously captured methods without notifying callbacks', async () => {
      const update = map.updateConfigByJson;
      const callback = vi.fn();
      map.registerCallback(callback);
      await handler.sealForAvalanche();
      await expect(async () => await update(mapping())).rejects.toThrow(
        'sealed',
      );
      await expect(
        async () => await map.updateConfigByJson(mapping()),
      ).rejects.toThrow('sealed');
      expect(callback).not.toHaveBeenCalled();
      expect(map.getRawConfig()).toEqual(mapping());
    });

    /**
     * @target TokenHandler.sealForAvalanche leaves callback registration and removal operational after sealing
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Register and remove callbacks after sealing.
     * @expected Keep callback management operational.
     */
    it('leaves callback registration and removal operational after sealing', async () => {
      await handler.sealForAvalanche();
      const first = map.registerCallback(vi.fn());
      const second = map.registerCallback(vi.fn());
      expect(second).toEqual(first + 1);
      expect(() => map.unregisterCallback(first)).not.toThrow();
      expect(() => map.unregisterCallback(second)).not.toThrow();
    });

    /**
     * @target TokenHandler.sealForAvalanche serializes an admitted update before sealing and rejects one queued after it
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Queue an admitted update, seal and later update behind one lease.
     * @expected Apply the admitted update and reject the later update.
     */
    it('serializes an admitted update before sealing and rejects one queued after it', async () => {
      const release = await internals(map).updateSemaphore.acquire();
      const next = mapping();
      next[0].avalanche.name = 'accepted before seal';
      const updating = map.updateConfigByJson(next);
      const sealing = handler.sealForAvalanche();
      const later = map
        .updateConfigByJson(mapping())
        .catch((error: unknown) => error);
      release();
      await updating;
      await sealing;
      expect(await later).toEqual(
        new Error('Avalanche startup token map is sealed'),
      );
      expect(map.getRawConfig()).toEqual(next);
    });

    /**
     * @target TokenHandler.sealForAvalanche blocks replacement of the handler map while sealing waits for an update lease
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Hold the update lease and attempt map replacement while sealing waits.
     * @expected Reject replacement and retain map identity after releasing the lease.
     */
    it('blocks replacement of the handler map while sealing waits for an update lease', async () => {
      const release = await internals(map).updateSemaphore.acquire();
      const sealing = handler.sealForAvalanche();
      expect(() =>
        Object.defineProperty(handler, 'tokenMap', { value: new TokenMap() }),
      ).toThrow();
      release();
      await sealing;
      expect(handler.getTokenMap()).toBe(map);
    });

    /**
     * @target TokenHandler.sealForAvalanche releases the update lease after malformed input
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Reject malformed updates then submit valid tokens and seal.
     * @expected Release the lease after each failure and seal the valid state.
     */
    it('releases the update lease after malformed input', async () => {
      await expect(
        async () => await map.updateConfigByJson([{}]),
      ).rejects.toThrow('empty token set');
      await expect(
        async () =>
          await map.updateConfigByJson([
            {
              avalanche: mapping()[0].avalanche,
              ethereum: mapping()[1].ethereum,
            },
          ]),
      ).rejects.toThrow('without chain [ergo]');
      await map.updateConfigByJson(mapping());
      await handler.sealForAvalanche();
      expect(map.getRawConfig()).toEqual(mapping());
    });

    /**
     * @target TokenHandler.sealForAvalanche releases the update lease after a throwing callback and seals the applied state
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Apply an update whose callback throws, remove it and seal.
     * @expected Seal the applied state and reject later updates.
     */
    it('releases the update lease after a throwing callback and seals the applied state', async () => {
      const id = map.registerCallback(() => {
        throw new Error('callback failure');
      });
      const next = mapping();
      next[0].avalanche.name = 'applied before callback';
      await expect(
        async () => await map.updateConfigByJson(next),
      ).rejects.toThrow('callback failure');
      map.unregisterCallback(id);
      await handler.sealForAvalanche();
      expect(map.getRawConfig()).toEqual(next);
      await expect(
        async () => await map.updateConfigByJson(mapping()),
      ).rejects.toThrow('sealed');
    });

    /**
     * @target TokenHandler.sealForAvalanche rejects a callback-triggered update queued behind a seal without deadlocking
     * @dependencies Real TokenHandler and TokenMap; synthetic token records and file-read fixtures.
     * @scenario Queue an update from a callback behind a seal.
     * @expected Reject the nested update without deadlocking.
     */
    it('rejects a callback-triggered update queued behind a seal without deadlocking', async () => {
      let nested: Promise<unknown> | undefined;
      const id = map.registerCallback(() => {
        nested = map
          .updateConfigByJson(mapping())
          .catch((error: unknown) => error);
      });
      const updating = map.updateConfigByJson(mapping());
      const sealing = handler.sealForAvalanche();
      await updating;
      map.unregisterCallback(id);
      await sealing;
      expect(await nested).toEqual(
        new Error('Avalanche startup token map is sealed'),
      );
    });
  });
});
