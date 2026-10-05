import ChainHandler from '../../../src/handlers/chainHandler';

/** Supply absent cold metadata while keeping cached API cases independent of state reads. */
export const createColdAddressMock = () => vi.fn((): string => '');

/** Mock stable Avalanche configuration and unchanged legacy address lookup. */
export const mockApiBalanceChain = (address: string, cold: () => string) => {
  const config = {
    addresses: {
      lock: address,
      get cold() {
        return cold();
      },
    },
  };
  const avalanche = { CHAIN_ID: 43114n, getChainConfigs: () => config };
  return vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
    getChain: (chain: string) =>
      chain === 'avalanche'
        ? avalanche
        : {
            getChainConfigs: () => ({
              addresses: { lock: address, cold: 'legacy-cold' },
            }),
          },
  } as unknown as ChainHandler);
};
