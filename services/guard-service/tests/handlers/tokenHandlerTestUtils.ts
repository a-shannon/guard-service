import { RosenTokens } from '@rosen-bridge/tokens';

/** Creates independent native ETH/wrapped Ergo and unbridgeable token records. */
export const mapping = (): RosenTokens => [
  {
    ethereum: {
      tokenId: 'eth',
      name: 'ETH',
      decimals: 18,
      type: 'native',
      residency: 'native',
      extra: {},
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
    bitcoin: {
      tokenId: 'btc',
      name: 'BTC',
      decimals: 8,
      type: 'native',
      residency: 'native',
      extra: {},
    },
  },
];
