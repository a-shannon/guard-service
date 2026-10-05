import { Signature, Transaction } from 'ethers';

import {
  AddressTxsEntity,
  migrations,
} from '@rosen-bridge/evm-address-tx-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import AvalancheRpcNetwork, {
  AVALANCHE_TX_EXTRACTOR,
} from '../lib/avalancheRpcNetwork';
import {
  blockHash,
  frontierHash,
  otherHash,
  address,
} from './avalancheTestData';
import {
  mockNetworkRpc,
  mockForbiddenFinality,
} from './mocked/networkRpc.mock';

/** Build a synthetic 32-byte hash from a repeated nibble. */
export const hash = (byte: string) => `0x${byte.repeat(64)}`;
// Public synthetic scalar fixtures; no wallet or signing operation is used.
/** Build a synthetic type-2 signed transaction without a wallet operation. */
export const signed = () =>
  Transaction.from({
    type: 2,
    chainId: 43113n,
    to: address,
    nonce: 7,
    value: 31n,
    data: '0xabcd',
    gasLimit: 30000n,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 2n,
    signature: Signature.from({
      r: '0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      s: hash('2'),
      yParity: 0,
    }),
  });

/** Generate matching synthetic network transaction and block fields. */
export const createNetworkData = () => {
  const transaction = signed();
  const tx = {
    ...transaction.toJSON(),
    chainId: transaction.chainId,
    signature: transaction.signature,
    hash: transaction.hash!,
    from: transaction.from!,
    blockHash,
    blockNumber: 10,
    index: 0,
    ...mockForbiddenFinality(),
  };
  const block = {
    hash: blockHash,
    parentHash: otherHash,
    number: 10,
    transactions: [tx.hash],
  };
  const frontier = {
    hash: frontierHash,
    parentHash: blockHash,
    number: 12,
    transactions: [],
  };
  const receipt = {
    hash: tx.hash,
    blockHash,
    blockNumber: 10,
    index: 0,
    status: 1,
  };
  return { transaction, tx, block, frontier, receipt };
};
/** Construct the real RPC adapter with deterministic network dependencies. */
export const setup = (database?: DataSource) => {
  const data = createNetworkData();
  const { transaction, tx, block, frontier, receipt } = data;
  const { rpc, find } = mockNetworkRpc(data);
  const db =
    database ?? ({ getRepository: () => ({ find }) } as unknown as DataSource);
  const network = new AvalancheRpcNetwork(
    'http://unused.invalid',
    db,
    transaction.from!,
    43113n,
    AVALANCHE_TX_EXTRACTOR,
    1000,
  );
  Object.defineProperty(network, 'provider', { value: rpc });
  return { network, rpc, tx, receipt, block, frontier, find, transaction, db };
};
/** Build a stored transaction provenance row for a selected extractor. */
export const createRow = (
  f: ReturnType<typeof setup>,
  extractor = AVALANCHE_TX_EXTRACTOR,
) => ({
  address: f.transaction.from!.toLowerCase(),
  extractor,
  unsignedHash: f.transaction.unsignedHash,
  signedHash: f.transaction.hash!,
  blockId: blockHash,
  nonce: 7,
  status: 'succeed',
});

/** Initialize a fresh in-memory provenance database with the real extractor migrations. */
export const createDatabase = async () => {
  const db = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [AddressTxsEntity],
    migrations: [...migrations.sqlite],
    synchronize: false,
    logging: false,
  });
  await db.initialize();
  await db.runMigrations();
  return db;
};

export {
  blockHash,
  frontierHash,
  otherHash,
  address,
} from './avalancheTestData';
