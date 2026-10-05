import { vi } from 'vitest';

import type { createStateData } from '../settledStateTestUtils';
import { word } from '../settledStateTestUtils';

/** Mock state RPC methods and the fixture repository lookup. */
export const mockStateRpc = (data: ReturnType<typeof createStateData>) => {
  const { block } = data;
  const rpc = {
    send: vi.fn<(method: string, params: unknown[]) => Promise<unknown>>(
      async (method) => {
        if (method === 'eth_chainId') return '0xa869';
        if (method === 'eth_call') return word(9n);
        if (method === 'eth_getBlockByNumber')
          return { ...block, number: `0x${block.number.toString(16)}` };
        return '0x9';
      },
    ),
    getBlock: vi.fn<(tag: unknown) => Promise<typeof block | null>>(
      async () => ({ ...block }),
    ),
    getBalance: vi.fn(async () => 9n),
    getTransactionCount: vi.fn(async () => 9),
    call: vi.fn(async () => word(9n)),
  };
  return { rpc };
};
