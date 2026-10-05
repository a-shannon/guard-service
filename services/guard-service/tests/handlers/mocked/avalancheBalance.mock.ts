import { AssetBalance } from '@rosen-chains/abstract-chain';

import ChainHandler from '../../../src/handlers/chainHandler';

/** Create a controllable external asset reader for balance collection cases. */
export const createAssetsMock = () =>
  vi.fn<(address: string, tokens?: string[]) => Promise<AssetBalance>>();
/** Restore deterministic external asset responses for one balance scenario. */
export const resetAssetsMock = (assets: ReturnType<typeof createAssetsMock>) =>
  assets.mockReset().mockImplementation(async (_address, tokens) => ({
    nativeToken: 9n,
    tokens: (tokens ?? []).map((id) => ({ id, value: 2n })),
  }));
/** Mock stable chain configuration with absent cold custody and controlled lock reads. */
export const mockBalanceChain = (
  address: string,
  assets: ReturnType<typeof createAssetsMock>,
) => {
  const config = { addresses: { lock: address, cold: '' } };
  const chain = {
    CHAIN_ID: 43114n,
    getChainConfigs: () => config,
    getAddressAssets: assets,
  };
  return vi
    .spyOn(ChainHandler, 'getInstance')
    .mockReturnValue({ getChain: () => chain } as unknown as ChainHandler);
};
