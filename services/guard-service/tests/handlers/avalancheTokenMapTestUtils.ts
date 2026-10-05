import { Semaphore } from '@rosen-bridge/semaphore';
import { RosenTokens, TokenMap } from '@rosen-bridge/tokens';

/** Creates independent native AVAX, wrapped Ergo and unbridgeable token records. */
export const mapping = (): RosenTokens => [
  {
    avalanche: {
      tokenId: 'avax',
      name: 'AVAX',
      decimals: 18,
      type: 'native',
      residency: 'native',
      extra: { label: 'native' },
    },
    ergo: {
      tokenId: 'cd'.repeat(32),
      name: 'wrapped',
      decimals: 9,
      type: 'token',
      residency: 'wrapped',
      extra: {},
    },
  },
  {
    ethereum: {
      tokenId: 'unbridgeable',
      name: 'unbridgeable',
      decimals: 6,
      type: 'token',
      residency: 'native',
      extra: {},
    },
  },
];

type Internals = {
  tokensConfig: RosenTokens;
  unbridgeableTokens: RosenTokens;
  updateSemaphore: Semaphore;
};
/** Exposes the real TokenMap partition and lease fields for mutation controls. */
export const internals = (map: TokenMap) => map as unknown as Internals;
