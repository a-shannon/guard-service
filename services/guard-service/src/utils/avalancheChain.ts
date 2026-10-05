import { AbstractLogger } from '@rosen-bridge/abstract-logger';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  AvalancheChain,
  captureAvalancheAssets,
} from '@rosen-chains/avalanche';
import { AvalancheRpcNetwork } from '@rosen-chains/avalanche-rpc';
import { EvmChainSignMediator } from '@rosen-chains/evm';

import {
  GuardsAvalancheConfig,
  GuardsAvalancheConfigs,
} from '../configs/guardsAvalancheConfigs';
import { readAvalancheBridgeContracts } from '../configs/rosenConfig';
import { AvalancheBridgeContracts } from '../types/contract';
import { AVALANCHE_LOCK_EXTRACTOR_ID } from './avalancheScanner';

export interface AvalancheChainDependencies {
  dataSource: DataSource;
  tokens: TokenMap;
  createSignMediator: (
    chainCode: string,
    path: number[],
  ) => EvmChainSignMediator;
  logger?: AbstractLogger;
}

/** Captures native chain policy; registration must reject source token-map drift. */
export const createAvalancheChain = async (
  input: GuardsAvalancheConfig,
  inputContracts: AvalancheBridgeContracts,
  dependencies: AvalancheChainDependencies,
) => {
  const {
    dataSource,
    createSignMediator,
    logger,
    tokens: sourceTokens,
  } = dependencies;
  if (
    typeof dataSource?.getRepository !== 'function' ||
    typeof createSignMediator !== 'function'
  )
    throw new Error('Invalid Avalanche factory dependencies');
  /** Requires the exact route-policy shape without activating runtime operations. */
  const validRoutes = (
    value: unknown,
  ): value is GuardsAvalancheConfig['routes'] =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === 3 &&
    ['cold', 'manual', 'arbitrary'].every(
      (route) =>
        Object.hasOwn(value, route) &&
        typeof (value as Record<string, unknown>)[route] === 'boolean',
    );
  if (!validRoutes(input?.routes))
    throw new Error('Invalid Avalanche management routes');
  const config = structuredClone(input);
  if (!validRoutes(config.routes))
    throw new Error('Invalid Avalanche management routes');
  Object.freeze(config.routes);
  const contracts = readAvalancheBridgeContracts(inputContracts);
  /** Narrows a runtime value to a positive safe integer. */
  const positiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const timeoutMs = config.rpc?.timeout * 1000;
  if (
    config.enabled !== true ||
    config.chainNetworkName !== 'rpc' ||
    ![43113, 43114].includes(config.chainId) ||
    typeof config.rpc?.timeout !== 'number' ||
    !positiveInteger(timeoutMs) ||
    timeoutMs > 2147483647 ||
    !positiveInteger(config.maxParallelTx) ||
    !positiveInteger(config.confirmations?.observation) ||
    !positiveInteger(config.confirmations?.payment) ||
    !positiveInteger(config.confirmations?.cold) ||
    !positiveInteger(config.confirmations?.manual) ||
    !positiveInteger(config.confirmations?.arbitrary)
  )
    throw new Error('Invalid Avalanche chain configuration');
  if (
    typeof config.rpc.url !== 'string' ||
    config.rpc.url.trim() !== config.rpc.url ||
    !['http:', 'https:'].includes(new URL(config.rpc.url).protocol) ||
    (config.rpc.authToken !== undefined &&
      typeof config.rpc.authToken !== 'string')
  )
    throw new Error('Invalid Avalanche RPC configuration');
  for (const field of [
    'gasPriceSlippage',
    'gasLimitSlippage',
    'gasLimitMultiplier',
    'gasLimitCap',
  ] as const) {
    const value = config[field];
    if (
      typeof value !== 'bigint' ||
      value <
        (field === 'gasPriceSlippage' || field === 'gasLimitSlippage'
          ? 0n
          : 1n) ||
      value >= 1n << 256n ||
      (field !== 'gasLimitCap' && value > BigInt(Number.MAX_SAFE_INTEGER))
    )
      throw new Error(`Invalid Avalanche ${field}`);
  }
  if (
    typeof config.tssChainCode !== 'string' ||
    !config.tssChainCode ||
    config.tssChainCode.trim() !== config.tssChainCode ||
    !Array.isArray(config.derivationPath) ||
    config.derivationPath.length < 1 ||
    config.derivationPath.length > 255 ||
    Array.from(config.derivationPath).some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31,
    )
  )
    throw new Error('Invalid Avalanche signer configuration');

  const tokenConfig = sourceTokens.getRawConfig();
  const tokenFingerprint = JSON.stringify(tokenConfig);
  const native = tokenConfig.filter(
    (set) =>
      set.avalanche?.tokenId === 'avax' || set.avalanche?.type === 'native',
  );
  const asset = native[0]?.avalanche;
  const wrapped = native[0]?.ergo;
  if (
    native.length !== 1 ||
    asset?.tokenId !== 'avax' ||
    asset.type !== 'native' ||
    asset.decimals !== 18 ||
    asset.residency !== 'native' ||
    !wrapped ||
    typeof wrapped.tokenId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(wrapped.tokenId) ||
    /^0+$/.test(wrapped.tokenId) ||
    !Number.isSafeInteger(wrapped.decimals) ||
    wrapped.decimals < 0 ||
    wrapped.decimals > 18
  )
    throw new Error(
      'Avalanche requires one bridgeable native AVAX mapping with 18 decimals',
    );
  // TokenMap resolves IDs across every chain and derives scale from every member.
  if (
    Object.values(native[0]).some(
      (member) =>
        !member ||
        !Number.isSafeInteger(member.decimals) ||
        member.decimals < 0,
    )
  )
    throw new Error('Invalid Avalanche native token-set decimals');
  for (const tokenId of [asset.tokenId, wrapped.tokenId]) {
    const matches = tokenConfig.filter((set) =>
      Object.values(set).some((member) => member?.tokenId === tokenId),
    );
    if (matches.length !== 1 || matches[0] !== native[0])
      throw new Error('Ambiguous Avalanche native token-set identifier');
  }
  captureAvalancheAssets(sourceTokens);
  /** Rejects source token-map drift from the configuration captured by this factory. */
  const assertTokenMapUnchanged = (): void => {
    if (JSON.stringify(sourceTokens.getRawConfig()) !== tokenFingerprint)
      throw new Error('Avalanche source token map changed after construction');
  };
  const tokens = new TokenMap(logger);
  await tokens.updateConfigByJson(tokenConfig);
  assertTokenMapUnchanged();
  const chainConfigs = GuardsAvalancheConfigs.createChainConfigs(
    config,
    contracts,
  );
  const path = Object.freeze([...config.derivationPath]) as unknown as number[];
  const mediator = createSignMediator(config.tssChainCode, path);
  if (
    typeof mediator?.sign !== 'function' ||
    typeof mediator.isInSign !== 'function'
  )
    throw new Error('Invalid Avalanche signing mediator');
  const signMediator = Object.freeze({
    sign: mediator.sign.bind(mediator),
    isInSign: mediator.isInSign.bind(mediator),
  });
  const network = new AvalancheRpcNetwork(
    config.rpc.url,
    dataSource,
    contracts.addresses.lock,
    BigInt(config.chainId),
    AVALANCHE_LOCK_EXTRACTOR_ID,
    timeoutMs,
    config.rpc.authToken,
    logger,
  );
  const chain = new AvalancheChain(
    network,
    chainConfigs,
    tokens,
    signMediator,
    logger,
  );
  return Object.freeze({ chain, network, assertTokenMapUnchanged });
};
