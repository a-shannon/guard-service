import { Interface, Transaction } from 'ethers';

import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap, RosenTokens } from '@rosen-bridge/tokens';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import {
  AvalancheRpcNetwork,
  AVALANCHE_TX_EXTRACTOR,
} from '@rosen-chains/avalanche-rpc';
import { transferABI } from '@rosen-chains/evm';

import { AvalancheChain } from '../lib';
import { erc20Mapping, joe, recipient } from './avalancheErc20TestData';
import { configs, address, eventId } from './avalancheTestData';
import { key } from './avalancheTestUtils';
import { mockErc20Network } from './mocked/avalancheErc20.mock';

const networks: AvalancheRpcNetwork[] = [];
/** Destroy inert providers after each test; no listener or real endpoint is used. */
export const closeErc20Fixtures = () =>
  networks.splice(0).forEach((network) => network['provider'].destroy());
/** Build the real mainnet chain and real mapped units with mocked endpoint and signer boundaries. */
export const createErc20Fixture = async (
  mapping: RosenTokens = structuredClone(erc20Mapping),
  paymentConfirmations = configs.confirmations.payment,
  coldAddress = configs.addresses.cold,
) => {
  const tokens = new TokenMap();
  await tokens.updateConfigByJson(mapping);
  const network = new AvalancheRpcNetwork(
    'http://127.0.0.1:1',
    { getRepository: () => ({ find: vi.fn() }) } as unknown as DataSource,
    address,
    43114n,
    AVALANCHE_TX_EXTRACTOR,
    1000,
  );
  networks.push(network);
  const mocks = mockErc20Network(network);
  const sign = vi.fn(async (bytes: Uint8Array) => {
    const signature = key.sign(bytes);
    return {
      signature: signature.r.slice(2) + signature.s.slice(2),
      signatureRecovery: signature.yParity.toString(),
    };
  });
  const policy = structuredClone(configs);
  policy.confirmations.payment = paymentConfirmations;
  policy.addresses.cold = coldAddress;
  const chain = new AvalancheChain(network, policy, tokens, {
    sign,
    isInSign: vi.fn(),
  });
  return { chain, tokens, network, sign, ...mocks };
};
/** Construct one wrapped JOE order; the corresponding raw transfer amount is ten billion units. */
export const tokenOrder = () => [
  {
    address: recipient,
    assets: { nativeToken: 0n, tokens: [{ id: joe, value: 10n }] },
  },
];
/** Build a canonical unsigned token envelope, optionally varying one transaction field. */
export const tokenPayment = (
  changes: Record<string, unknown> = {},
  type = TransactionType.payment,
  event = eventId,
) => {
  const tx = Transaction.from({
    type: 2,
    chainId: 43114n,
    nonce: 0,
    to: joe,
    value: 0n,
    gasLimit: 80000n,
    maxFeePerGas: 20n,
    maxPriorityFeePerGas: 2n,
    data:
      new Interface(transferABI).encodeFunctionData('transfer', [
        recipient,
        10n ** 10n,
      ]) + event,
    ...changes,
  });
  return new PaymentTransaction(
    'avalanche',
    tx.unsignedHash,
    event,
    Buffer.from(tx.unsignedSerialized.slice(2), 'hex'),
    type,
  );
};
