import { Address, NetworkPrefix } from 'ergo-lib-wasm-nodejs';

import { RosenTokens } from '@rosen-bridge/tokens';

import { GuardsAvalancheConfig } from '../../src/configs/guardsAvalancheConfigs';
import { readAvalancheBridgeContracts } from '../../src/configs/rosenConfig';
import contractTokens from './contractTokensTestData.json';

/** Deterministic public-key Ergo address for the source contracts. */
export const ergo = Address.p2pk_from_pk_bytes(
  Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex',
  ),
).to_base58(NetworkPrefix.Testnet);
/** Creates validated independent source-event contracts. */
export const contracts = () =>
  readAvalancheBridgeContracts({
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
/** Creates a fresh complete enabled chain factory configuration. */
export const config = (): GuardsAvalancheConfig => ({
  enabled: true,
  chainNetworkName: 'rpc',
  chainId: 43113,
  sourceId: 'fixture',
  rpc: {
    url: 'http://127.0.0.1:1',
    authToken: 'synthetic',
    timeout: 0.125,
    scannerInterval: 1,
    initialHeight: 0,
  },
  blockTime: 0.5,
  maxParallelTx: 1,
  gasPriceSlippage: 0n,
  gasLimitSlippage: 0n,
  gasLimitMultiplier: 1n,
  gasLimitCap: 50000n,
  confirmations: {
    observation: 1,
    payment: 2,
    cold: 3,
    manual: 4,
    arbitrary: 5,
  },
  routes: { cold: false, manual: false, arbitrary: false },
  tssChainCode: 'synthetic-chain',
  derivationPath: [44, 60],
});
/** Creates independent native AVAX and wrapped Ergo token mappings. */
export const mapping = (): RosenTokens => [
  {
    avalanche: {
      tokenId: 'avax',
      name: 'AVAX',
      decimals: 18,
      type: 'native',
      residency: 'native',
      extra: {},
    },
    ergo: {
      tokenId: 'cd'.repeat(32),
      name: 'wrapped fixture',
      decimals: 9,
      type: 'token',
      residency: 'wrapped',
      extra: {},
    },
  },
];
/** Mainnet JOE source with a synthetic Ergo counterpart; used without live endpoint requests. */
export const tokenMapping = (): RosenTokens =>
  structuredClone(contractTokens.tokens);
