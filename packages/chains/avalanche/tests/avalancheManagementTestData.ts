import { RosenTokens } from '@rosen-bridge/tokens';

/** Native AVAX eighteen-decimal fixture mapped to nine-decimal wrapped Ergo units. */
export const managementNativeMapping: RosenTokens = [
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
      tokenId: 'cd'.repeat(32),
      name: 'wrapped fixture',
      decimals: 9,
      type: 'token',
      residency: 'wrapped',
      extra: {},
    },
  },
];
