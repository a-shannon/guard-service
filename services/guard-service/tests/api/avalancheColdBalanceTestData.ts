import type { RosenTokens } from '@rosen-bridge/tokens';

import type { AvalancheLockBalance } from '../../src/types/api';

/** Public mainnet asset identity; every custody and Ergo counterpart below is synthetic. */
export const joe = '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd';
export const lock = `0x${'ab'.repeat(20)}`;
export const cold = `0x${'cd'.repeat(20)}`;
export const changed = `0x${'ef'.repeat(20)}`;

/** Exact response from the cached SQLite/Fastify join; consumers use token identity, not order. */
export const coldBalanceFixture: AvalancheLockBalance = {
  chainId: 43114,
  hot: {
    total: 2,
    items: [
      {
        chain: 'avalanche',
        address: lock,
        balance: {
          tokenId: joe,
          name: 'JOE',
          amount: '9007199254740993123456789',
          decimals: 6,
          isNativeToken: false,
        },
      },
      {
        chain: 'avalanche',
        address: lock,
        balance: {
          tokenId: 'avax',
          name: 'AVAX',
          amount: '100000000000',
          decimals: 9,
          isNativeToken: true,
        },
      },
    ],
  },
  cold: {
    total: 2,
    items: [
      {
        chain: 'avalanche',
        address: cold,
        balance: {
          tokenId: joe,
          name: 'JOE',
          amount: '9007199254740993999999999',
          decimals: 6,
          isNativeToken: false,
        },
      },
      {
        chain: 'avalanche',
        address: cold,
        balance: {
          tokenId: 'avax',
          name: 'AVAX',
          amount: '500000000000',
          decimals: 9,
          isNativeToken: true,
        },
      },
    ],
  },
};

/** Distinct significant scales expose accidental raw-unit or repeated wrapping conversions. */
export const tokenConfig = [
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
      type: 'EIP-004',
      residency: 'wrapped',
      extra: {},
    },
  },
  {
    avalanche: {
      tokenId: joe,
      name: 'JOE',
      decimals: 18,
      type: 'ERC-20',
      residency: 'native',
      extra: {},
    },
    ergo: {
      tokenId: 'bb'.repeat(32),
      name: 'rsJOE',
      decimals: 6,
      type: 'EIP-004',
      residency: 'wrapped',
      extra: {},
    },
  },
] satisfies RosenTokens;
