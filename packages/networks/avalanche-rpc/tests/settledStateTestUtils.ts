import { DataSource } from '@rosen-bridge/extended-typeorm';

import AvalancheRpcNetwork from '../lib/avalancheRpcNetwork';
import { address, token, stateHash as hash } from './avalancheTestData';
import { mockStateRpc } from './mocked/stateRpc.mock';

/** Encode a synthetic uint256 ABI return word. */
export const word = (value: bigint) =>
  `0x${value.toString(16).padStart(64, '0')}`;

/** Generate matching synthetic state transaction and block fields. */
export const createStateData = () => {
  const block = { number: 42, hash, parentHash: `0x${'bb'.repeat(32)}` };
  return { block };
};
/** Construct the real RPC adapter with deterministic state dependencies. */
export const setup = () => {
  const data = createStateData();
  const { block } = data;
  const { rpc } = mockStateRpc(data);
  const db = { getRepository: () => ({}) } as unknown as DataSource;
  const network = new AvalancheRpcNetwork(
    'http://unused.invalid',
    db,
    address,
    43113n,
    'avalanche-lock-address',
    1000,
  );
  Object.defineProperty(network, 'provider', { value: rpc });
  return { network, rpc, block };
};
/** Public read operations and their JSON-RPC method names for settled state cases. */
export const reads: readonly (readonly [
  string,
  (network: AvalancheRpcNetwork) => Promise<number | bigint>,
  string,
])[] = [
  [
    'native',
    (network: AvalancheRpcNetwork) =>
      network.getAddressBalanceForNativeToken(address),
    'eth_getBalance',
  ],
  [
    'erc20',
    (network: AvalancheRpcNetwork) =>
      network.getAddressBalanceForERC20Asset(address, token),
    'eth_call',
  ],
  [
    'nonce',
    (network: AvalancheRpcNetwork) =>
      network.getAddressNextAvailableNonce(address),
    'eth_getTransactionCount',
  ],
] as const;

export { address, token, stateHash as hash } from './avalancheTestData';
