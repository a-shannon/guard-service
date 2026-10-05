import { RosenTokens } from '@rosen-bridge/tokens';

/** Official mainnet JOE contract identity; every chain observation in tests is synthetic. */
export const joe = '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd';
/** Synthetic recipient distinct from the fixture custody signer. */
export const recipient = '0x' + '22'.repeat(20);
/** AVAX and JOE mappings with synthetic Ergo counterparts and nine significant decimals. */
export const erc20Mapping: RosenTokens = [
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
      name: 'fixture AVAX',
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
      tokenId: 'ef'.repeat(32),
      name: 'fixture JOE',
      decimals: 9,
      type: 'EIP-004',
      residency: 'wrapped',
      extra: {},
    },
  },
];

/** Independent mapping authority faults, each changing only one field or member. */
export const assetMappingFaults = [
  'native-counterpart-type',
  'native-counterpart-residency',
  'token-two-native-origins',
  'token-no-native-origin',
  'token-counterpart-type',
  'token-counterpart-residency',
  'intraset-case-alias',
  'native-intraset-alias',
] as const;
/** Apply one isolated fault to a disposable real TokenMap input. */
export const applyAssetMappingFault = (
  mapping: RosenTokens,
  fault: (typeof assetMappingFaults)[number],
) => {
  if (fault === 'native-counterpart-type') mapping[0].ergo.type = 'unsupported';
  if (fault === 'native-counterpart-residency')
    mapping[0].ergo.residency = 'native';
  if (fault === 'token-two-native-origins')
    mapping[1].ergo.residency = 'native';
  if (fault === 'token-no-native-origin')
    mapping[1].avalanche.residency = 'wrapped';
  if (fault === 'token-counterpart-type') mapping[1].ergo.type = 'unsupported';
  if (fault === 'token-counterpart-residency')
    mapping[1].ergo.residency =
      'invalid' as (typeof mapping)[1]['ergo']['residency'];
  if (fault === 'intraset-case-alias')
    mapping[1].ethereum = {
      ...mapping[1].avalanche,
      tokenId: joe.toUpperCase().replace('0X', '0x'),
      residency: 'wrapped',
    };
  if (fault === 'native-intraset-alias')
    mapping[0].ethereum = {
      ...mapping[0].ergo,
      tokenId: 'AVAX',
      residency: 'wrapped',
    };
};
