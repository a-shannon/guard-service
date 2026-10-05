import { EvmConfigs } from '@rosen-chains/evm';

import { AvalancheBridgeContracts } from '../types/contract';

export interface AvalancheConfigReader {
  has(path: string): boolean;
  get<T>(path: string): T;
}

export interface GuardsAvalancheConfig {
  enabled: true;
  chainNetworkName: 'rpc';
  chainId: 43113 | 43114;
  sourceId: string;
  rpc: {
    url: string;
    authToken?: string;
    timeout: number;
    scannerInterval: number;
    initialHeight: number;
  };
  /** Operator estimate for health checks, not a finality rule. */
  blockTime: number;
  maxParallelTx: number;
  gasPriceSlippage: bigint;
  gasLimitSlippage: bigint;
  gasLimitMultiplier: bigint;
  gasLimitCap: bigint;
  confirmations: {
    observation: number;
    payment: number;
    cold: number;
    manual: number;
    arbitrary: number;
  };
  /** Explicit operator opt-ins; runtime authorization remains a separate guard. */
  routes: { cold: boolean; manual: boolean; arbitrary: boolean };
  tssChainCode: string;
  derivationPath: number[];
}

const MAX_TIMER_SECONDS = 2147483647 / 1000;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Reads only operator configuration; contracts and runtime activation are separate. */
const parseAvalancheConfig = (
  reader: AvalancheConfigReader,
): GuardsAvalancheConfig | undefined => {
  if (!reader.has('avalanche.enabled')) return undefined;
  const enabled = reader.get<unknown>('avalanche.enabled');
  if (typeof enabled !== 'boolean')
    throw new Error('Invalid avalanche.enabled');
  if (!enabled) return undefined;

  /** Reads a required field beneath the enabled Avalanche configuration. */
  const required = (field: string): unknown => {
    const path = `avalanche.${field}`;
    if (!reader.has(path)) throw new Error(`Missing ${path}`);
    return reader.get<unknown>(path);
  };
  /** Rejects a malformed field using its configuration key without its value. */
  const invalid = (field: string): never => {
    throw new Error(`Invalid avalanche.${field}`);
  };
  /** Reads a safe integer at or above the field's required minimum. */
  const integer = (field: string, minimum: number): number => {
    const value = required(field);
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < minimum
    )
      return invalid(field);
    return value;
  };
  /** Reads a finite positive number bounded by the field's optional maximum. */
  const positive = (field: string, maximum = Infinity): number => {
    const value = required(field);
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > maximum
    )
      return invalid(field);
    return value;
  };
  /** Reads nonempty text and rejects surrounding whitespace. */
  const text = (field: string): string => {
    const value = required(field);
    if (typeof value !== 'string' || !value.length || value.trim() !== value)
      return invalid(field);
    return value;
  };

  const routes: GuardsAvalancheConfig['routes'] = {
    cold: false,
    manual: false,
    arbitrary: false,
  };
  if (reader.has('avalanche.routes')) {
    const raw = reader.get<unknown>('avalanche.routes');
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.prototype.toString.call(raw) !== '[object Object]'
    )
      return invalid('routes');
    for (const key of Reflect.ownKeys(raw)) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
      // node-config attaches its shared helpers as hidden own properties.
      if (
        typeof key === 'string' &&
        ['util', 'get', 'has'].includes(key) &&
        descriptor.enumerable === false &&
        'value' in descriptor &&
        descriptor.value !== undefined &&
        descriptor.value === Reflect.get(reader, key)
      )
        continue;
      if (
        !['cold', 'manual', 'arbitrary'].includes(String(key)) ||
        typeof key !== 'string'
      )
        return invalid('routes');
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value !== 'boolean') return invalid(`routes.${key}`);
      routes[key as keyof typeof routes] = value;
    }
  }

  const chainId = required('chainId');
  if (chainId !== 43113 && chainId !== 43114) return invalid('chainId');
  const sourceId = text('sourceId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceId))
    return invalid('sourceId');
  const url = text('rpc.url');
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname)
      return invalid('rpc.url');
  } catch {
    return invalid('rpc.url');
  }
  let authToken: string | undefined;
  if (reader.has('avalanche.rpc.authToken')) {
    const value = reader.get<unknown>('avalanche.rpc.authToken');
    if (typeof value !== 'string') return invalid('rpc.authToken');
    authToken = value;
  }

  const rawCap = required('gasLimitCap');
  let gasLimitCap: bigint;
  if (typeof rawCap === 'string' && /^[1-9][0-9]*$/.test(rawCap))
    gasLimitCap = BigInt(rawCap);
  else if (
    typeof rawCap === 'number' &&
    Number.isSafeInteger(rawCap) &&
    rawCap > 0
  )
    gasLimitCap = BigInt(rawCap);
  else return invalid('gasLimitCap');
  if (gasLimitCap > MAX_UINT256) return invalid('gasLimitCap');

  // The ECDSA backend consumes raw chain-code text and non-hardened indices.
  const tssChainCode = text('tssChainCode');
  const derivationPath = required('derivationPath');
  if (
    !Array.isArray(derivationPath) ||
    derivationPath.length < 1 ||
    derivationPath.length > 255 ||
    Array.from(derivationPath).some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31,
    )
  )
    return invalid('derivationPath');

  return {
    enabled: true,
    chainNetworkName: 'rpc',
    chainId,
    sourceId,
    rpc: {
      url,
      authToken,
      timeout: positive('rpc.timeout', MAX_TIMER_SECONDS),
      scannerInterval: positive('rpc.scannerInterval', MAX_TIMER_SECONDS),
      initialHeight: integer('rpc.initialHeight', -1),
    },
    blockTime: positive('healthCheck.blockTime'),
    maxParallelTx: integer('maxParallelTx', 1),
    gasPriceSlippage: BigInt(integer('gasPriceSlippage', 0)),
    gasLimitSlippage: BigInt(integer('gasLimitSlippage', 0)),
    gasLimitMultiplier: BigInt(integer('gasLimitMultiplier', 1)),
    gasLimitCap,
    confirmations: {
      observation: integer('confirmation.observation', 1),
      payment: integer('confirmation.payment', 1),
      cold: integer('confirmation.cold', 1),
      manual: integer('confirmation.manual', 1),
      arbitrary: integer('confirmation.arbitrary', 1),
    },
    routes,
    tssChainCode,
    derivationPath: [...derivationPath],
  };
};

/** Validated operator snapshot; bridge contracts remain a separate startup input. */
export class GuardsAvalancheConfigs implements GuardsAvalancheConfig {
  readonly enabled = true;
  readonly chainNetworkName = 'rpc';
  readonly chainId: GuardsAvalancheConfig['chainId'];
  readonly sourceId: string;
  readonly rpc: GuardsAvalancheConfig['rpc'];
  readonly blockTime: number;
  readonly maxParallelTx: number;
  readonly gasPriceSlippage: bigint;
  readonly gasLimitSlippage: bigint;
  readonly gasLimitMultiplier: bigint;
  readonly gasLimitCap: bigint;
  readonly confirmations: GuardsAvalancheConfig['confirmations'];
  readonly routes: GuardsAvalancheConfig['routes'];
  readonly tssChainCode: string;
  readonly derivationPath: number[];

  /** Captures validated configuration without retaining caller-owned collections. */
  private constructor(config: GuardsAvalancheConfig) {
    this.chainId = config.chainId;
    this.sourceId = config.sourceId;
    this.rpc = Object.freeze({ ...config.rpc });
    this.blockTime = config.blockTime;
    this.maxParallelTx = config.maxParallelTx;
    this.gasPriceSlippage = config.gasPriceSlippage;
    this.gasLimitSlippage = config.gasLimitSlippage;
    this.gasLimitMultiplier = config.gasLimitMultiplier;
    this.gasLimitCap = config.gasLimitCap;
    this.confirmations = Object.freeze({ ...config.confirmations });
    this.routes = Object.freeze({ ...config.routes });
    this.tssChainCode = config.tssChainCode;
    this.derivationPath = Object.freeze([
      ...config.derivationPath,
    ]) as unknown as number[];
    Object.freeze(this);
  }

  /** Validates enabled inputs and leaves disabled-chain configuration unread. */
  static read = (
    reader: AvalancheConfigReader,
  ): GuardsAvalancheConfigs | undefined => {
    const config = parseAvalancheConfig(reader);
    return config ? new GuardsAvalancheConfigs(config) : undefined;
  };

  /** Projects the factory's cloned policy and validated contracts without rereading either source. */
  static createChainConfigs = (
    config: GuardsAvalancheConfig,
    contracts: AvalancheBridgeContracts,
  ): EvmConfigs => {
    return Object.freeze({
      fee: 0n, // Unused EVM compatibility field; fees are obtained from RPC.
      confirmations: Object.freeze({
        observation: config.confirmations.observation,
        payment: config.confirmations.payment,
        cold: config.confirmations.cold,
        manual: config.confirmations.manual,
        arbitrary: config.confirmations.arbitrary,
      }),
      addresses: Object.freeze({
        lock: contracts.addresses.lock,
        cold: contracts.addresses.cold,
        permit: contracts.addresses.WatcherPermit,
        fraud: contracts.addresses.Fraud,
      }),
      rwtId: contracts.tokens.RWTId,
      maxParallelTx: config.maxParallelTx,
      gasPriceSlippage: config.gasPriceSlippage,
      gasLimitSlippage: config.gasLimitSlippage,
      gasLimitMultiplier: config.gasLimitMultiplier,
      gasLimitCap: config.gasLimitCap,
    });
  };
}

/** Preserves the operator-reader API while returning the validated config class. */
export const readAvalancheConfig = (
  reader: AvalancheConfigReader,
): GuardsAvalancheConfig | undefined => GuardsAvalancheConfigs.read(reader);

export default GuardsAvalancheConfigs;
