import { SigningKey, Transaction } from 'ethers';

import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import {
  AVALANCHE_TX_EXTRACTOR,
  AvalancheRpcNetwork,
} from '@rosen-chains/avalanche-rpc';

import { AvalancheChain } from '../lib';
import { address, eventId, configs } from './avalancheTestData';
import {
  mockChainNetwork,
  mockAuthorizedChainPreflight,
} from './mocked/avalancheChain.mock';

/** Signing key derived solely from the public synthetic scalar fixture. */
export const key = new SigningKey('0x' + '11'.repeat(32));
const networks: AvalancheRpcNetwork[] = [];
/** Close real providers created by fixtures between independent test cases. */
export const closeChainFixtures = () =>
  networks.splice(0).forEach((network) => network['provider'].destroy());

/** Construct the real chain with deterministic network and signer mocks. */
export const createChainFixture = (
  chainId = 43113n,
  config = configs,
  tokens = new TokenMap(),
) => {
  const dataSource = {
    getRepository: () => ({ find: vi.fn() }),
  } as unknown as DataSource;
  const network = new AvalancheRpcNetwork(
    'http://127.0.0.1:1',
    dataSource,
    address,
    chainId,
    AVALANCHE_TX_EXTRACTOR,
    1000,
  );
  networks.push(network);
  const { networkCheck, sign, isInSign } = mockChainNetwork(network);
  const chain = new AvalancheChain(network, structuredClone(config), tokens, {
    sign,
    isInSign,
  });
  return { chain, network, networkCheck, sign };
};

/** Build an unsigned native payment for the selected chain, type and gas limit. */
export const createPayment = (
  chainId = 43113n,
  type = 2,
  gasLimit = 42000n,
) => {
  const tx = Transaction.from({
    type,
    chainId,
    nonce: 0,
    to: address,
    value: 1000n,
    gasLimit,
    data: '0x' + eventId,
    ...(type === 2
      ? { maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }
      : { gasPrice: 20n }),
  });
  return new PaymentTransaction(
    'avalanche',
    tx.unsignedHash,
    eventId,
    Buffer.from(tx.unsignedSerialized.slice(2), 'hex'),
    TransactionType.payment,
  );
};

/** Construct a signed payment and qualified preflight fixture. */
export const createAuthorizedChainFixture = (url = 'http://127.0.0.1:1') => {
  const network = new AvalancheRpcNetwork(
    url,
    { getRepository: () => ({ find: vi.fn() }) } as unknown as DataSource,
    address,
    43113n,
    AVALANCHE_TX_EXTRACTOR,
    1000,
  );
  networks.push(network);
  const chain = new AvalancheChain(
    network,
    structuredClone(configs),
    new TokenMap(),
    {
      sign: vi.fn(),
      isInSign: vi.fn(),
    },
  );
  const { gas, assets, balance } = mockAuthorizedChainPreflight(chain, network);
  const tx = Transaction.from({
    type: 2,
    chainId: 43113n,
    nonce: 0,
    to: address,
    value: 1000n,
    gasLimit: 42000n,
    data: '0x' + eventId,
    maxFeePerGas: 20n,
    maxPriorityFeePerGas: 2n,
  });
  tx.signature = key.sign(tx.unsignedHash);
  const payment = new PaymentTransaction(
    'avalanche',
    tx.unsignedHash,
    eventId,
    Buffer.from(tx.serialized.slice(2), 'hex'),
    TransactionType.payment,
  );
  return { network, chain, gas, assets, balance, tx, payment };
};
/** Invoke the synthetic authority start callback immediately. */
export const allow = async (start: () => void) => {
  start();
};
