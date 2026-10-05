import { Transaction } from 'ethers';

import { TokenMap } from '@rosen-bridge/tokens';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { EvmConfigs } from '@rosen-chains/evm';

import { managementNativeMapping } from './avalancheManagementTestData';
import { address, configs, eventId } from './avalancheTestData';
import { createChainFixture, key } from './avalancheTestUtils';
import { mockManagementGeneration } from './mocked/avalancheManagement.mock';

/** Distinct synthetic cold destination, without any deployed contract assumption. */
export const coldAddress = '0x' + '22'.repeat(20);

/** Build a configured native chain with real asset accounting and isolated RPC mocks. */
export const createManagementFixture = (
  balance = 10000000n,
  gasEstimate = 21000n,
  chainId = 43113n,
  gasPolicy?: Partial<
    Pick<EvmConfigs, 'gasLimitCap' | 'gasLimitMultiplier' | 'maxParallelTx'>
  >,
  tokens?: TokenMap,
) => {
  const config = structuredClone(configs);
  config.addresses.cold = coldAddress;
  if (gasPolicy !== undefined) Object.assign(config, gasPolicy);
  const fixture = createChainFixture(chainId, config, tokens);
  return {
    ...fixture,
    ...mockManagementGeneration(fixture.network, balance, gasEstimate),
  };
};
/** Constructs the real native mapping before the chain captures its immutable asset authority. */
export const createMappedManagementFixture = async (balance = 10000000n) => {
  const tokens = new TokenMap();
  await tokens.updateConfigByJson(managementNativeMapping);
  return createManagementFixture(balance, 21000n, 43113n, undefined, tokens);
};

/** Build a self-consistent unsigned or synthetic signed native route envelope. */
export const createManagementPayment = (
  type: TransactionType,
  chainId = 43113n,
  signed = false,
  gasLimit = 42000n,
  nonce = 4,
) => {
  const event =
    type === TransactionType.manual || type === TransactionType.coldStorage
      ? ''
      : eventId;
  const tx = Transaction.from({
    type: 2,
    chainId,
    nonce,
    to: type === TransactionType.coldStorage ? coldAddress : address,
    value: 1000n,
    gasLimit,
    data: '0x' + event,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
  if (signed) tx.signature = key.sign(tx.unsignedHash);
  return new PaymentTransaction(
    'avalanche',
    tx.unsignedHash,
    event,
    Buffer.from(
      (signed ? tx.serialized : tx.unsignedSerialized).slice(2),
      'hex',
    ),
    type,
  );
};
