import { FeeData, Interface, JsonRpcProvider, Transaction } from 'ethers';

import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import { AvalancheRpcNetwork } from '@rosen-chains/avalanche-rpc';
import { transferABI } from '@rosen-chains/evm';

import Configs from '../../src/configs/configs';
import { GuardsAvalancheConfigs } from '../../src/configs/guardsAvalancheConfigs';
import { DatabaseAction } from '../../src/db/databaseAction';
import DatabaseHandler from '../../src/db/databaseHandler';
import ChainHandler from '../../src/handlers/chainHandler';
import * as ScannerStartup from '../../src/jobs/initScanner';
import { valid } from '../configs/avalancheConfigTestData';
import { reader } from '../configs/avalancheConfigTestUtils';
import { chainHandlerInstance } from '../handlers/chainHandler.mock';
import {
  contracts,
  config,
  tokenMapping,
} from '../utils/avalancheChainTestUtils';

/** Builds an actual public native chain with inert network/read ports for admission. */
export const admissionFixture = async (token = false) => {
  const joe = '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd';
  const routes = { cold: true, manual: true, arbitrary: true };
  const captured = GuardsAvalancheConfigs.read(
    reader({
      ...valid,
      'avalanche.routes': routes,
      'avalanche.chainId': token ? 43114 : 43113,
    }),
  )!;
  const prepared = vi
    .spyOn(ScannerStartup, 'getPreparedAvalancheInputs')
    .mockReturnValue({ config: captured, contracts: contracts() });
  const rpc = vi
    .spyOn(JsonRpcProvider.prototype, 'send')
    .mockRejectedValue(new Error('Unexpected live RPC'));
  const network = new AvalancheRpcNetwork(
    'http://127.0.0.1:1',
    { getRepository: () => ({ find: vi.fn() }) } as unknown as DataSource,
    contracts().addresses.lock,
    BigInt(captured.chainId),
    'synthetic-lock-extractor',
    1000,
  );
  vi.spyOn(network, 'assertNetwork').mockResolvedValue();
  vi.spyOn(network, 'getGasRequired').mockResolvedValue(21000n);
  vi.spyOn(network, 'getFeeData').mockResolvedValue(new FeeData(null, 20n, 2n));
  const balance = vi
    .spyOn(network, 'getAddressBalanceForNativeToken')
    .mockResolvedValue(token ? 2000000n * 1000000000n : 1000000n);
  const tokenBalance = vi
    .spyOn(network, 'getAddressBalanceForERC20Asset')
    .mockResolvedValue(2000000n * 1000000000n);
  const tokens = new TokenMap();
  if (token) await tokens.updateConfigByJson(tokenMapping());
  const cfg = config();
  cfg.chainId = captured.chainId;
  const signer = vi.fn().mockRejectedValue(new Error('Unexpected signer'));
  const chain = new AvalancheChain(
    network,
    GuardsAvalancheConfigs.createChainConfigs(cfg, contracts()),
    tokens,
    { sign: signer, isInSign: vi.fn() },
  );
  vi.spyOn(ChainHandler, 'getInstance').mockReturnValue(
    chainHandlerInstance as unknown as ChainHandler,
  );
  const registry = vi
    .spyOn(chainHandlerInstance, 'getChain')
    .mockReturnValue(chain);
  const threshold = { low: 100000n, high: 900000n };
  const thresholds = vi.spyOn(Configs, 'thresholds').mockImplementation(() => {
    const configured: Record<string, { low: bigint; high: bigint }> = {
      avax: { ...threshold },
    };
    if (token) configured[joe] = { low: 1250000n, high: 1500000n };
    return { avalanche: { tokens: configured, maxNativeTransfer: 0n } };
  });
  const forbidden = vi
    .spyOn(DatabaseHandler, 'getWaitingEventsRequiredTokens')
    .mockResolvedValue([]);
  const active = vi
    .spyOn(DatabaseAction.getInstance(), 'getActiveColdStorageTxsInChain')
    .mockResolvedValue([]);
  const payment = (type = TransactionType.coldStorage, patch = {}) => {
    const event = type === TransactionType.arbitrary ? '11'.repeat(32) : '';
    const tx = Transaction.from({
      type: 2,
      chainId: captured.chainId,
      nonce: 0,
      to: token ? joe : contracts().addresses.cold,
      value: token ? 0n : 1000n,
      gasLimit: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      data: token
        ? new Interface(transferABI).encodeFunctionData('transfer', [
            contracts().addresses.cold,
            750000n * 1000000000n,
          ]) + event
        : '0x' + event,
      ...patch,
    });
    return new PaymentTransaction(
      'avalanche',
      tx.unsignedHash,
      event,
      Buffer.from(tx.unsignedSerialized.slice(2), 'hex'),
      type,
    );
  };
  return {
    chain,
    network,
    prepared,
    rpc,
    balance,
    tokenBalance,
    joe,
    signer,
    registry,
    threshold,
    thresholds,
    forbidden,
    active,
    payment,
    close: () => network['provider'].destroy(),
  };
};
