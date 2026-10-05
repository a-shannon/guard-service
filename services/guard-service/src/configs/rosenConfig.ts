import { getAddress } from 'ethers';
import fs from 'fs';

import { chainValidators } from '@rosen-bridge/address-codec';

import { SupportedChain } from '../types/config';
import {
  AllChainsConfigs,
  AvalancheContracts,
  AvalancheBridgeContracts,
} from '../types/contract';
import { SUPPORTED_CHAINS } from '../utils/constants';
import Configs from './configs';

/** Validates and normalizes the Avalanche lock address. */
export const readAvalancheContracts = (value: unknown): AvalancheContracts => {
  const lock = (value as { addresses?: { lock?: unknown } } | null)?.addresses
    ?.lock;
  if (typeof lock !== 'string')
    throw new Error('Missing Avalanche lock address');
  const normalized = getAddress(lock).toLowerCase();
  if (normalized === '0x' + '0'.repeat(40))
    throw new Error('Invalid Avalanche lock address');
  return Object.freeze({ addresses: Object.freeze({ lock: normalized }) });
};

/** Captures bridge addresses independently of the chain's enabled operations. */
export const readAvalancheBridgeContracts = (
  value: unknown,
): AvalancheBridgeContracts => {
  const base = readAvalancheContracts(value);
  const raw = value as {
    addresses: Record<string, unknown>;
    tokens?: { RWTId?: unknown };
  };
  const rawCold = raw.addresses.cold;
  let cold: string;
  try {
    if (typeof rawCold !== 'string' || !rawCold || rawCold.trim() !== rawCold)
      throw new Error('Invalid cold address');
    cold = getAddress(rawCold).toLowerCase();
    if (cold === '0x' + '0'.repeat(40)) throw new Error('Invalid cold address');
  } catch {
    throw new Error('Invalid Avalanche cold address');
  }
  /** Validates one required Ergo bridge-contract address from the captured input. */
  const address = (field: string): string => {
    const result = raw.addresses[field];
    if (typeof result !== 'string' || !result || result.trim() !== result)
      throw new Error(`Invalid Avalanche ${field} address`);
    chainValidators.ergo(result);
    return result;
  };
  const rwt = raw.tokens?.RWTId;
  if (
    typeof rwt !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(rwt) ||
    /^0+$/.test(rwt)
  )
    throw new Error('Invalid Avalanche RWTId');
  return Object.freeze({
    addresses: Object.freeze({
      lock: base.addresses.lock,
      cold,
      WatcherPermit: address('WatcherPermit'),
      Fraud: address('Fraud'),
      WatcherTriggerEvent: address('WatcherTriggerEvent'),
      Commitment: address('Commitment'),
    }),
    tokens: Object.freeze({ RWTId: rwt.toLowerCase() }),
  });
};

class RosenConfig {
  readonly guardSignAddress: string;
  readonly RSN: string;
  readonly guardNFT: string;
  readonly minFeeNFT: string;
  readonly contractVersion: string;

  readonly contract: AllChainsConfigs;

  constructor() {
    const rosenConfigPath = Configs.contractsPath;
    if (!fs.existsSync(rosenConfigPath)) {
      throw new Error(
        `rosenConfig file with path ${rosenConfigPath} doesn't exist`,
      );
    } else {
      const configJson = fs.readFileSync(rosenConfigPath, 'utf8');
      this.contract = JSON.parse(configJson) as AllChainsConfigs;
      const chainConfig = this.contract[SUPPORTED_CHAINS[0]];
      this.guardSignAddress = chainConfig.addresses.guardSign;
      this.RSN = this.contract.tokens.RSN;
      this.guardNFT = this.contract.tokens.GuardNFT;
      this.minFeeNFT = this.contract.tokens.MinFeeNFT;
      this.contractVersion = this.contract.version;
    }
  }

  /**
   * Returns the ContractConfig of the related network
   * @param network
   */
  contractReader = (network: SupportedChain) => {
    const contracts = this.contract[network];
    if (!contracts) {
      throw Error(`${network} contracts and token config is not set`);
    }
    return contracts;
  };

  /** Reads the Avalanche contract configuration through the configured parser. */
  avalancheContractReader = (): AvalancheContracts =>
    readAvalancheContracts(this.contract.avalanche);

  /** Reads the Avalanche bridge-contract configuration through the configured parser. */
  avalancheBridgeContractReader = (): AvalancheBridgeContracts =>
    readAvalancheBridgeContracts(this.contract.avalanche);
}

export const rosenConfig = new RosenConfig();
export { RosenConfig };
