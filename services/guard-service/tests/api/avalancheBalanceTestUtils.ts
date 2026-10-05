import { TokenMap } from '@rosen-bridge/tokens';

import { avalancheAddress as address } from '../avalancheRegistryTestData';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { avalancheTokenConfig } from './avalancheBalanceTestData';

/** Synthetic cached balance payload; no address validation or network is involved. */
export const balance = (amount: string | number, chain = 'avalanche') => ({
  ...(chain === 'avalanche' ? { chainId: 43114 } : {}),
  hot: {
    items: [
      {
        address: 'fixture',
        chain,
        balance: { tokenId: 'avax', amount, decimals: 18, isNativeToken: true },
      },
    ],
    total: 1,
  },
  cold: { items: [], total: 0 },
});

/** Store a synthetic exact cached balance in the in-memory repository. */
export const insert = (chain: string, tokenId: string, balance: bigint) =>
  DatabaseActionMock.testDatabase.upsertChainAddressBalances([
    { chain, address, tokenId, balance, lastUpdate: '1' },
  ]);
/** Build a fresh token map from the documented synthetic metadata. */
export const createAvalancheTokenMap = async () => {
  const tokens = new TokenMap();
  await tokens.updateConfigByJson(structuredClone(avalancheTokenConfig));
  return tokens;
};
