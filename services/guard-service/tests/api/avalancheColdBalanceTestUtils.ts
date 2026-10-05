import { TokenMap } from '@rosen-bridge/tokens';

import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { tokenConfig } from './avalancheColdBalanceTestData';

/** Build the real token policy with synthetic counterpart identities. */
export const createColdTokenMap = async () => {
  const map = new TokenMap();
  await map.updateConfigByJson(structuredClone(tokenConfig));
  return map;
};

/** Insert an exact wrapped-unit row through the actual DAO and SQLite transformer. */
export const insertColdBalance = async (
  address: string,
  tokenId: string,
  balance: bigint,
) =>
  DatabaseActionMock.testDatabase.upsertChainAddressBalances([
    { address, chain: 'avalanche', tokenId, balance, lastUpdate: '1' },
  ]);
