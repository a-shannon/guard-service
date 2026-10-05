import config from 'config';

import { chainValidators } from '@rosen-bridge/address-codec';
import { ERGO_CHAIN, ErgoConfigs } from '@rosen-chains/ergo';
import { EXPLORER_NETWORK } from '@rosen-chains/ergo-explorer-network';
import { NODE_NETWORK } from '@rosen-chains/ergo-node-network';

import { FeeDistribution } from '../types/config';
import { LEGACY_SUPPORTED_CHAINS } from '../utils/constants';
import { getChainNetworkName, getConfigIntKeyOrDefault } from './configs';
import { AvalancheConfigReader } from './guardsAvalancheConfigs';
import { rosenConfig } from './rosenConfig';

/** Validates and captures the enabled Avalanche reward fee distribution. */
export const readAvalancheFeeDistribution = (
  reader: AvalancheConfigReader,
): FeeDistribution | undefined => {
  if (!reader.has('avalanche.enabled')) return undefined;
  const enabled = reader.get<unknown>('avalanche.enabled');
  if (typeof enabled !== 'boolean')
    throw new Error('Invalid avalanche.enabled');
  if (!enabled) return undefined;
  const path = 'reward.bridgeFee.avalanche';
  if (!reader.has(path)) throw new Error(`Missing ${path}`);
  const raw = reader.get<unknown>(path);
  if (!Array.isArray(raw)) throw new Error(`Invalid ${path}`);
  let total = 0;
  const distribution = raw.map((entry: unknown) => {
    const value = entry as { address?: unknown; percent?: unknown } | null;
    if (
      !value ||
      typeof value.address !== 'string' ||
      !value.address ||
      value.address.trim() !== value.address ||
      typeof value.percent !== 'number' ||
      !Number.isSafeInteger(value.percent) ||
      value.percent < 0
    )
      throw new Error(`Invalid ${path} entry`);
    chainValidators.ergo(value.address);
    total += value.percent;
    return Object.freeze({ address: value.address, percent: value.percent });
  });
  if (total >= 100) throw new Error(`Invalid ${path} total`);
  return Object.freeze(distribution) as unknown as FeeDistribution;
};

class GuardsErgoConfigs {
  // service configs
  static chainNetworkName = getChainNetworkName('ergo.chainNetwork', [
    NODE_NETWORK,
    EXPLORER_NETWORK,
  ]);
  static explorer = {
    url: config.get<string>('ergo.explorer.url'),
    timeout: config.get<number>('ergo.explorer.timeout'), // seconds
  };
  static node = {
    url: config.get<string>('ergo.node.url'),
    timeout: config.get<number>('ergo.node.timeout'), // seconds
  };

  // value configs
  static minimumErg = BigInt(config.get<string>('ergo.minBoxValue'));
  static additionalErgOnPayment = BigInt(
    config.get<string>('ergo.additionalErgOnPayment'),
  );
  static txFee = BigInt(config.get<string>('ergo.fee'));

  // reward configs
  static emissionTokenId: string = config.get<string>('reward.emissionTokenId');
  static emissionTokenName: string = config.get<string>(
    'reward.emissionTokenName',
  );
  static emissionTokenDecimal: number = config.get<number>(
    'reward.emissionTokenDecimal',
  );
  static emissionAddress: string = config.get<string>('reward.emissionAddress');
  static networkFeeRepoAddress: string = config.get<string>(
    'reward.networkFeeRepoAddress',
  );
  static watchersSharePercent = BigInt(
    getConfigIntKeyOrDefault('reward.watchersSharePercent', 50),
  );
  static watchersEmissionSharePercent = BigInt(
    getConfigIntKeyOrDefault('reward.watchersEmissionSharePercent', 0),
  );

  // bridge fee configs
  static bridgeFeeDefaultAddress: string = config.get<string>(
    'reward.bridgeFee.defaultAddress',
  );
  static bridgeFeeDefaultDistribution: FeeDistribution =
    config.get<FeeDistribution>('reward.bridgeFee.defaultDistribution');
  static chainBridgeFeeDistribution: Record<string, FeeDistribution> = {
    ...LEGACY_SUPPORTED_CHAINS.map((chain) => {
      // check if there is a specific distribution for the chain
      const distribution = config.has(`reward.bridgeFee.${chain}`)
        ? config.get<FeeDistribution>(`reward.bridgeFee.${chain}`)
        : // if not, use the default distribution
          this.bridgeFeeDefaultDistribution;
      // validate distribution (sum should be less than 100)
      const sumDistributionPercent = distribution
        .map((distribution) => distribution.percent)
        .reduce((a, b) => a + b, 0);
      if (sumDistributionPercent >= 100)
        throw new Error(
          `Invalid bridge fee distribution for chain [${chain}]: expected sum to be less than 100, found [${sumDistributionPercent}]`,
        );
      return { [chain]: distribution };
    }).reduce((a, b) => ({ ...a, ...b }), {}),
    ...((): Record<string, FeeDistribution> => {
      const distribution = readAvalancheFeeDistribution(config);
      return distribution === undefined ? {} : { avalanche: distribution };
    })(),
  };
  static bridgeFeeAddresses = new Set<string>(
    Object.values(this.chainBridgeFeeDistribution)
      .flatMap((distribution) => distribution.map((address) => address.address))
      .concat([this.bridgeFeeDefaultAddress]),
  );

  // confirmation configs
  static observationConfirmation = getConfigIntKeyOrDefault(
    'ergo.confirmation.observation',
    14,
  );
  static eventConfirmation = getConfigIntKeyOrDefault(
    'ergo.confirmation.event',
    5,
  );
  static paymentTxConfirmation = getConfigIntKeyOrDefault(
    'ergo.confirmation.payment',
    14,
  );
  static coldTxConfirmation = getConfigIntKeyOrDefault(
    'ergo.confirmation.cold',
    14,
  );
  static manualTxConfirmation = getConfigIntKeyOrDefault(
    'ergo.confirmation.manual',
    14,
  );
  static arbitraryTxConfirmation = getConfigIntKeyOrDefault(
    'ergo.confirmation.arbitrary',
    14,
  );

  // scanner configs
  static initialHeight = getConfigIntKeyOrDefault('ergo.initialHeight', 925000);
  static scannerInterval = getConfigIntKeyOrDefault(
    'ergo.scannerInterval',
    180,
  );

  // the ergo-related contract, addresses and tokens in rosen bridge
  static ergoContractConfig = rosenConfig.contractReader(ERGO_CHAIN);

  // ErgoChain required configs
  static chainConfigs: ErgoConfigs = {
    fee: this.txFee,
    confirmations: {
      observation: this.observationConfirmation,
      payment: this.paymentTxConfirmation,
      cold: this.coldTxConfirmation,
      manual: this.manualTxConfirmation,
      arbitrary: this.arbitraryTxConfirmation,
    },
    addresses: {
      lock: this.ergoContractConfig.addresses.lock,
      cold: this.ergoContractConfig.addresses.cold,
      permit: this.ergoContractConfig.addresses.WatcherPermit,
      fraud: this.ergoContractConfig.addresses.Fraud,
    },
    rwtId: this.ergoContractConfig.tokens.RWTId,
    minBoxValue: this.minimumErg,
    eventTxConfirmation: this.eventConfirmation,
  };
}

export default GuardsErgoConfigs;
