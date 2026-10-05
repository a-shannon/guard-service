import type {
  Block as EthersBlock,
  TransactionReceipt,
  TransactionResponse,
} from 'ethers';

import type { AvalancheScannerConfig } from '@rosen-bridge/evm-scanner';

import type { AvalancheScannerInstance } from '../../../src/utils/avalancheScanner';
import { hash, signed } from '../avalancheScannerTestUtils';

// Reload the factory and its scanner class together after service setup imports.
vi.hoisted(() => vi.resetModules());

const hook = vi.hoisted(() => ({
  beforeRegister: undefined as undefined | (() => Promise<void>),
}));
vi.mock('@rosen-bridge/evm-scanner', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@rosen-bridge/evm-scanner')>();
  return {
    ...actual,
    AvalancheRpcScanner: class extends actual.AvalancheRpcScanner {
      /** Intercepts only extractor registration on the actual scanner class. */
      constructor(config: AvalancheScannerConfig) {
        super(config);
        const register = this.registerExtractor;
        this.registerExtractor = async (extractor) => {
          await hook.beforeRegister?.();
          await register(extractor);
        };
      }
    },
  };
});

/** Supplies canonical block, receipt and network responses to a real provider. */
export const mockBlock = (instance: AvalancheScannerInstance, status = 1) => {
  const provider = instance.network['provider'];
  const tx = {
    type: signed.type,
    chainId: signed.chainId,
    nonce: signed.nonce,
    to: signed.to,
    from: signed.from,
    gasLimit: signed.gasLimit,
    maxFeePerGas: signed.maxFeePerGas,
    maxPriorityFeePerGas: signed.maxPriorityFeePerGas,
    value: signed.value,
    data: signed.data,
    accessList: signed.accessList,
    signature: signed.signature,
    hash: signed.hash,
    blockHash: hash('1'),
    blockNumber: 1,
    index: 0,
    provider,
  } as unknown as TransactionResponse;
  const block = {
    number: 1,
    hash: hash('1'),
    parentHash: hash('0'),
    timestamp: 100,
    length: 1,
    transactions: [tx.hash],
    prefetchedTransactions: [tx],
  } as unknown as EthersBlock;
  const receipt = {
    hash: tx.hash,
    blockHash: tx.blockHash,
    blockNumber: 1,
    index: 0,
    status,
    to: tx.to,
    from: tx.from,
    contractAddress: null,
    logsBloom: '0x' + '00'.repeat(256),
    gasUsed: 25000n,
    cumulativeGasUsed: 25000n,
    gasPrice: 1n,
    type: 2,
    root: null,
    logs: [],
  } as unknown as TransactionReceipt;
  vi.spyOn(provider, 'send').mockResolvedValue('0xa869');
  vi.spyOn(provider, 'getBlock').mockResolvedValue(block);
  vi.spyOn(provider, 'getTransactionReceipt').mockResolvedValue(receipt);
  return { provider, block };
};

export { hook };
