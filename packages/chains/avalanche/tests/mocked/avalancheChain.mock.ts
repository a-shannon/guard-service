import { FeeData } from 'ethers';
import { vi } from 'vitest';

import { AvalancheRpcNetwork } from '@rosen-chains/avalanche-rpc';

import { AvalancheChain } from '../../lib';

/** Mock identity, gas, fee and synthetic signing boundaries for baseline payments. */
export const mockChainNetwork = (network: AvalancheRpcNetwork) => {
  const networkCheck = vi.spyOn(network, 'assertNetwork').mockResolvedValue();
  vi.spyOn(network, 'getGasRequired').mockResolvedValue(21000n);
  vi.spyOn(network, 'getFeeData').mockResolvedValue(new FeeData(null, 20n, 2n));
  const sign = vi.fn().mockRejectedValue(new Error('Synthetic signer reached'));
  return { networkCheck, sign, isInSign: vi.fn() };
};

/** Mock gas and native asset checks for the qualified submission preflight. */
export const mockAuthorizedChainPreflight = (
  chain: AvalancheChain,
  network: AvalancheRpcNetwork,
) => {
  vi.spyOn(network, 'assertNetwork').mockResolvedValue();
  const gas = vi.spyOn(network, 'getGasRequired').mockResolvedValue(21000n);
  const assets = vi.spyOn(chain, 'getTransactionAssets').mockResolvedValue({
    inputAssets: { nativeToken: 841000n, tokens: [] },
    outputAssets: { nativeToken: 841000n, tokens: [] },
  });
  const balance = vi
    .spyOn(network, 'getAddressBalanceForNativeToken')
    .mockResolvedValue(10000000n);
  return { gas, assets, balance };
};

/** Spy on qualified dispatch and invoke authority with a transport-start spy. */
export const mockSubmission = (network: AvalancheRpcNetwork) => {
  const start = vi.fn();
  const submit = vi
    .spyOn(network, 'submitAuthorizedTransaction')
    .mockImplementation(async (_tx, authorize) => {
      await authorize(start);
    });
  return { start, submit };
};
