import { Address, NetworkPrefix } from 'ergo-lib-wasm-nodejs';
import { createRequire } from 'node:module';

import { AvalancheConfigReader } from '../../src/configs/guardsAvalancheConfigs';
import { valid } from './avalancheConfigTestData';

/** Deterministic public-key address for valid Ergo contract fixtures. */
export const address = Address.p2pk_from_pk_bytes(
  Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex',
  ),
);
/** Testnet encoding of the synthetic contract address. */
export const ergo = address.to_base58(NetworkPrefix.Testnet);
/** Creates independent contract address and RWT records. */
export const contracts = () => ({
  addresses: {
    lock: '0x' + '12'.repeat(20),
    cold: '0x' + '34'.repeat(20),
    WatcherPermit: ergo,
    Fraud: ergo,
    WatcherTriggerEvent: ergo,
    Commitment: ergo,
  },
  tokens: { RWTId: 'ab'.repeat(32) },
});
/** Builds a typed configuration reader over a synthetic key-value record. */
export const reader = (
  data: Record<string, unknown>,
): AvalancheConfigReader => ({
  has: (key) => Object.hasOwn(data, key),
  get: <T>(key: string) => data[key] as T,
});

/** Creates a fresh valid balance schedule for timer and batch controls. */
export const createBalanceConfig = () => ({
  updateInterval: 20,
  updateBatchInterval: 0.5,
  tokensPerIteration: { rpc: 3 },
});

/** Creates raw exact-wei and scanner-age policy strings and numbers. */
export const createRawHealthConfig = () => ({
  nativeWarnWei: '9007199254740993',
  nativeCriticalWei: '9007199254740992',
  scannerWarnAgeSeconds: 10,
  scannerCriticalAgeSeconds: 20,
});

/** Loads a fresh node-config reader from synthetic NODE_CONFIG input, restoring the environment and prior module cache before returning. */
export const realAvalancheConfigReader = (
  routes: unknown,
  chainId: 43113 | 43114 = 43114,
): AvalancheConfigReader => {
  const require = createRequire(import.meta.url);
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(valid)) {
    const segments = key.split('.');
    let owner = values;
    for (const segment of segments.slice(0, -1)) {
      owner[segment] ??= {};
      owner = owner[segment] as Record<string, unknown>;
    }
    owner[segments.at(-1)!] = value;
  }
  const avalanche = values.avalanche as Record<string, unknown>;
  avalanche.chainId = chainId;
  avalanche.routes = routes;
  const modulePath = require.resolve('config');
  const previousModule = require.cache[modulePath];
  const previousInput = process.env.NODE_CONFIG;
  delete require.cache[modulePath];
  process.env.NODE_CONFIG = JSON.stringify(values);
  try {
    return require('config') as AvalancheConfigReader;
  } finally {
    if (previousModule) require.cache[modulePath] = previousModule;
    else delete require.cache[modulePath];
    if (previousInput === undefined) delete process.env.NODE_CONFIG;
    else process.env.NODE_CONFIG = previousInput;
  }
};
