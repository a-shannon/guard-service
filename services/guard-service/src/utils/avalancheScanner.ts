import { getAddress, TransactionResponse } from 'ethers';

import { AbstractLogger } from '@rosen-bridge/abstract-logger';
import { ScannerConfig } from '@rosen-bridge/abstract-scanner';
import { EvmTxExtractor } from '@rosen-bridge/evm-address-tx-extractor';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import { GuardsAvalancheConfig } from '../configs/guardsAvalancheConfigs';

export const AVALANCHE_LOCK_EXTRACTOR_ID = 'avalanche-lock-address';

export interface AvalancheScannerDependencies {
  dataSource: DataSource;
  lockAddress: string;
  logger: AbstractLogger;
  blockCleanupConfig: ScannerConfig<TransactionResponse>['blockCleanupConfig'];
}

export interface AvalancheScannerInstance {
  scanner: AvalancheRpcScanner;
  network: AvalancheRpcNetwork;
  extractor: EvmTxExtractor;
  intervalMs: number;
}

/** Converts positive seconds to safe milliseconds within the Node timer limit. */
const milliseconds = (seconds: number, field: string): number => {
  const value = seconds * 1000;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2147483647
  )
    throw new Error(`Invalid Avalanche ${field} in milliseconds`);
  return value;
};

/** Creates one registered scanner; the caller owns its update job and safety actions. */
export const createAvalancheScanner = async (
  config: GuardsAvalancheConfig,
  dependencies: AvalancheScannerDependencies,
): Promise<AvalancheScannerInstance> => {
  if (
    config.enabled !== true ||
    config.chainNetworkName !== 'rpc' ||
    (config.chainId !== 43113 && config.chainId !== 43114)
  )
    throw new Error('Invalid Avalanche scanner configuration');
  const timeoutMs = milliseconds(config.rpc.timeout, 'RPC timeout');
  const intervalMs = milliseconds(
    config.rpc.scannerInterval,
    'scanner interval',
  );
  const lockAddress = getAddress(dependencies.lockAddress).toLowerCase();
  if (lockAddress === '0x' + '0'.repeat(40))
    throw new Error('Invalid Avalanche lock address');
  const network = new AvalancheRpcNetwork(
    config.rpc.url,
    BigInt(config.chainId),
    timeoutMs,
    config.rpc.authToken,
  );
  const scanner = new AvalancheRpcScanner({
    network,
    dataSource: dependencies.dataSource,
    initialHeight: config.rpc.initialHeight,
    sourceId: config.sourceId,
    logger: dependencies.logger.child('avalanche-scanner'),
    blockCleanupConfig: dependencies.blockCleanupConfig,
  });
  const extractor = new EvmTxExtractor(
    dependencies.dataSource,
    AVALANCHE_LOCK_EXTRACTOR_ID,
    lockAddress,
    config.rpc.url,
    config.rpc.authToken,
    false,
    dependencies.logger.child('avalanche-lock-address-extractor'),
  );
  await scanner.registerExtractor(extractor);
  return { scanner, network, extractor, intervalMs };
};
