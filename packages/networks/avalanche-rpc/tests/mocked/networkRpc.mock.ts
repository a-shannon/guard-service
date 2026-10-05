import { vi } from 'vitest';

import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';

import type { createNetworkData } from '../avalancheRpcTestUtils';
import { blockHash } from '../avalancheTestData';

/** Mock network RPC methods and the fixture repository lookup. */
export const mockNetworkRpc = (data: ReturnType<typeof createNetworkData>) => {
  const { tx, block, frontier, receipt } = data;
  const rpc = {
    send: vi.fn(async (method: string): Promise<string> => {
      if (method === 'eth_chainId') return '0xa869';
      if (method === 'eth_baseFee') return '0xa';
      if (method === 'eth_maxPriorityFeePerGas') return '0x2';
      throw new Error(`unexpected method ${method}`);
    }),
    getBlock: vi.fn(async (tag: string | number) => {
      if (tag === 'finalized' || tag === frontier.number) return frontier;
      if (tag === blockHash || tag === block.number) return block;
      throw new Error(`unexpected block ${tag}`);
    }),
    getTransaction: vi.fn<(id: string) => Promise<typeof tx>>(async () => tx),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlockNumber: vi.fn(() => {
      throw new Error('forbidden latest height');
    }),
    estimateGas: vi.fn(async () => 30000n),
    broadcastTransaction: vi.fn(async () => undefined),
  };
  const find = vi.fn(async () => [] as Partial<AddressTxsEntity>[]);

  return { rpc, find };
};

/** Fail if a settled read consults provider confirmation or wait helpers. */
export const mockForbiddenFinality = () => ({
  confirmations: vi.fn(() => {
    throw new Error('forbidden confirmations');
  }),
  wait: vi.fn(() => {
    throw new Error('forbidden wait');
  }),
});
