import { FeeData } from 'ethers';
import { vi } from 'vitest';

import { AvalancheRpcNetwork } from '@rosen-chains/avalanche-rpc';

/** Supply deterministic native balances, fee estimates and nonce reads to the real builder. */
export const mockManagementGeneration = (
  network: AvalancheRpcNetwork,
  balance: bigint,
  gasEstimate: bigint,
) => ({
  nonce: vi.spyOn(network, 'getAddressNextAvailableNonce').mockResolvedValue(4),
  fees: vi
    .spyOn(network, 'getFeeData')
    .mockResolvedValue(new FeeData(null, 10n, 1n)),
  gas: vi.spyOn(network, 'getGasRequired').mockResolvedValue(gasEstimate),
  balance: vi
    .spyOn(network, 'getAddressBalanceForNativeToken')
    .mockResolvedValue(balance),
});
