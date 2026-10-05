import { FeeData } from 'ethers';

import { AvalancheRpcNetwork } from '@rosen-chains/avalanche-rpc';

/** Mock all chain RPC boundaries while leaving token accounting and envelope policy real. */
export const mockErc20Network = (network: AvalancheRpcNetwork) => ({
  qualify: vi.spyOn(network, 'assertNetwork').mockResolvedValue(),
  native: vi
    .spyOn(network, 'getAddressBalanceForNativeToken')
    .mockResolvedValue(10n ** 20n),
  token: vi
    .spyOn(network, 'getAddressBalanceForERC20Asset')
    .mockResolvedValue(10n ** 20n),
  nonce: vi.spyOn(network, 'getAddressNextAvailableNonce').mockResolvedValue(0),
  gas: vi.spyOn(network, 'getGasRequired').mockResolvedValue(40000n),
  fee: vi
    .spyOn(network, 'getFeeData')
    .mockResolvedValue(new FeeData(null, 20n, 2n)),
});
