import type { AssetBalance } from '@rosen-chains/abstract-chain';

import ChainHandler from '../../../src/handlers/chainHandler';
import { cold, lock } from '../avalancheColdBalanceTestData';

/** Supply stable custody identities and controlled qualified-chain boundary methods. */
export const mockColdBalanceCustody = () => {
  const config = { addresses: { lock, cold: cold as unknown } };
  const hotRead =
    vi.fn<(address: string, tokens?: string[]) => Promise<AssetBalance>>();
  const coldRead = vi.fn<(tokens?: string[]) => Promise<AssetBalance>>();
  hotRead.mockRejectedValue(new Error('Cached API must not read chain state'));
  coldRead.mockRejectedValue(new Error('Cached API must not read chain state'));
  const chain = {
    CHAIN_ID: 43114n as unknown,
    getChainConfigs: () => config,
    getAddressAssets: hotRead,
    getColdAddressAssets: coldRead,
  };
  const owner = { getChain: () => chain };
  const spy = vi
    .spyOn(ChainHandler, 'getInstance')
    .mockReturnValue(owner as unknown as ChainHandler);
  return { config, chain, owner, hotRead, coldRead, spy };
};
