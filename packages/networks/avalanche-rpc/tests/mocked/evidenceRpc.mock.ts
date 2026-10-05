import { vi } from 'vitest';

import type { createEvidenceData } from '../settledTransactionTestUtils';

/** Mock evidence RPC methods and the fixture repository lookup. */
export const mockEvidenceRpc = (
  data: ReturnType<typeof createEvidenceData>,
  chainId: bigint,
) => {
  const { tx, receipt, block, frontier } = data;
  const rpc = {
    send: vi.fn(async () => '0x' + chainId.toString(16)),
    getTransaction: vi.fn(async (): Promise<typeof tx | null> => tx),
    getTransactionReceipt: vi.fn(
      async (): Promise<typeof receipt | null> => receipt,
    ),
    getBlock: vi.fn(async (tag: string | number) => {
      if (tag === 'finalized' || tag === frontier.number) return frontier;
      if (tag === block.number) return block;
      throw Error('Unexpected block query');
    }),
  };
  const find = vi.fn(() => {
    throw Error('Exact evidence must not resolve aliases');
  });
  return { rpc, find };
};
