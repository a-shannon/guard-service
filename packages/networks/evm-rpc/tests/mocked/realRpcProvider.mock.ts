import type { FetchGetUrlFunc, JsonRpcProvider as RpcProvider } from 'ethers';
import { vi } from 'vitest';

/** Temporarily construct real ethers providers for isolated constructor controls. */
export const mockRealRpcProvider = async () => {
  const { JsonRpcProvider } = await import('ethers');
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  const provider = vi.mocked(JsonRpcProvider);
  const previous = provider.getMockImplementation();
  if (!previous) throw new Error('Expected constructor mock');
  provider.mockImplementation(
    (...args: ConstructorParameters<typeof RpcProvider>) =>
      new actual.JsonRpcProvider(...args),
  );
  return () => provider.mockImplementation(previous);
};

/** Synthetic transport reference; constructor controls never send a request. */
export const mockGetUrl = vi.fn<FetchGetUrlFunc>();
