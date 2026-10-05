import type { RosenTokens } from '@rosen-bridge/tokens';

import { avalancheErc20 as erc20 } from '../avalancheRegistryTestData';

/** Synthetic native and cached ERC20 metadata, including Ergo significant decimals. */
export const avalancheTokenConfig = [
  {
    avalanche: {
      tokenId: erc20,
      name: 'Token',
      decimals: 18,
      type: 'token',
      residency: 'native',
      extra: {},
    },
    ergo: {
      tokenId: 'bb'.repeat(32),
      name: 'rsToken',
      decimals: 6,
      type: 'token',
      residency: 'wrapped',
      extra: {},
    },
  },
  {
    avalanche: {
      tokenId: 'avax',
      name: 'AVAX',
      decimals: 18,
      type: 'native',
      residency: 'native',
      extra: {},
    },
    ergo: {
      tokenId: 'aa'.repeat(32),
      name: 'rsAVAX',
      decimals: 9,
      type: 'token',
      residency: 'wrapped',
      extra: {},
    },
  },
] satisfies RosenTokens;
