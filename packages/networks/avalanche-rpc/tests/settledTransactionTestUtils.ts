import { SigningKey, Transaction } from 'ethers';

import { DataSource } from '@rosen-bridge/extended-typeorm';

import AvalancheRpcNetwork from '../lib/avalancheRpcNetwork';
import { blockHash, frontierHash } from './avalancheTestData';
import { mockEvidenceRpc } from './mocked/evidenceRpc.mock';

/** Build a synthetic 32-byte hash from a repeated nibble. */
export const hash = (digit: string) => '0x' + digit.repeat(64);
/** Public synthetic signing key used only for deterministic evidence fixtures. */
export const key = new SigningKey('0x' + '11'.repeat(32)); // Public synthetic fixture.
/** Generate matching synthetic evidence transaction and block fields. */
export const createEvidenceData = (chainId = 43113n, type = 2) => {
  const signed = Transaction.from({
    type,
    chainId,
    nonce: 7,
    to: '0x' + '22'.repeat(20),
    value: 9007199254740993n,
    gasLimit: 30000n,
    ...(type === 2
      ? { maxFeePerGas: 30n, maxPriorityFeePerGas: 2n }
      : { gasPrice: 30n }),
    data: '0xabcd',
  });
  signed.signature = key.sign(signed.unsignedHash);
  const tx = {
    ...signed.toJSON(),
    chainId,
    hash: signed.hash!,
    from: signed.from!,
    signature: signed.signature,
    blockHash,
    blockNumber: 10,
    index: 0,
  };
  const receipt = {
    hash: tx.hash,
    blockHash,
    blockNumber: 10,
    index: 0,
    status: 1,
  };
  const block = {
    hash: blockHash,
    parentHash: hash('c'),
    number: 10,
    transactions: [tx.hash],
  };
  const frontier = {
    hash: frontierHash,
    parentHash: blockHash,
    number: 12,
    transactions: [] as string[],
  };
  return { signed, tx, receipt, block, frontier };
};
/** Construct the real RPC adapter with deterministic evidence dependencies. */
export const fixture = (chainId = 43113n, type = 2) => {
  const data = createEvidenceData(chainId, type);
  const { signed, tx, receipt, block, frontier } = data;
  const { rpc, find } = mockEvidenceRpc(data, chainId);
  const network = new AvalancheRpcNetwork(
    'http://unused.invalid',
    { getRepository: () => ({ find }) } as unknown as DataSource,
    signed.from!,
    chainId,
    'avalanche-lock-address',
    1000,
  );
  Object.defineProperty(network, 'provider', { value: rpc });
  return { network, rpc, tx, receipt, block, frontier, signed, find };
};

export { blockHash, frontierHash } from './avalancheTestData';

/** Read exact settled evidence for the fixture signed hash and required block. */
export const read = (f: ReturnType<typeof fixture>) =>
  f.network.getSettledTransactionEvidence(f.signed.hash!, blockHash);
