import { Transaction } from 'ethers';

import { AssetBalance } from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';

import { TokenHandler } from '../handlers/tokenHandler';
import type { ChainThresholds } from './types';

/** Selects one eligible C-Chain cold asset, retaining the configured AVAX floor and the estimated maximum-fee gas budget. */
export const selectAvalancheColdAssets = async (
  chain: AvalancheChain,
  locked: AssetBalance,
  thresholds: ChainThresholds,
  forbidden: readonly string[],
): Promise<AssetBalance | undefined> => {
  const policy = structuredClone(thresholds.tokens);
  if (
    !policy.avax ||
    Object.entries(policy).some(
      ([id, threshold]) =>
        (id !== 'avax' && !chain.supportedTokens.includes(id)) ||
        typeof threshold?.low !== 'bigint' ||
        typeof threshold.high !== 'bigint' ||
        threshold.low < 0n ||
        threshold.high <= threshold.low,
    )
  )
    throw new Error('Invalid Avalanche cold thresholds');
  if (forbidden.includes('avax')) return undefined;
  // One active cold row owns the chain. Give eligible tokens their turn before
  // sweeping excess AVAX, instead of emitting several mutually blocking rows.
  for (const id of Object.keys(policy)
    .filter((id) => id !== 'avax')
    .sort()) {
    const balance = locked.tokens.find((token) => token.id === id);
    if (!forbidden.includes(id) && balance && balance.value > policy[id].high) {
      return {
        nativeToken: 0n,
        tokens: [{ id, value: balance.value - policy[id].low }],
      };
    }
  }
  if (locked.nativeToken <= policy.avax.high) return undefined;
  const config = chain.configs;
  const cap = config.gasLimitCap;
  const multiplier = config.gasLimitMultiplier;
  const network = chain.network;
  const getFee = network.getFeeData;
  const getGas = network.getGasRequired;
  const getNonce = network.getAddressNextAvailableNonce;
  const chainId = chain.CHAIN_ID;
  const lock = config.addresses.lock;
  const cold = config.addresses.cold;
  const tokenMap = TokenHandler.getInstance().getTokenMap();
  const wrap = tokenMap.wrapAmount;
  const unwrap = tokenMap.unwrapAmount;
  const fee = await getFee.call(network);
  const maxFee = fee.maxFeePerGas;
  const priorityFee = fee.maxPriorityFeePerGas;
  /** Refuses policy, reader and token-map changes across gas planning awaits. */
  const assertCurrent = () => {
    if (
      chain.configs !== config ||
      config.gasLimitCap !== cap ||
      config.gasLimitMultiplier !== multiplier ||
      config.addresses.lock !== lock ||
      config.addresses.cold !== cold ||
      chain.CHAIN_ID !== chainId ||
      chain.network !== network ||
      network.getFeeData !== getFee ||
      network.getGasRequired !== getGas ||
      network.getAddressNextAvailableNonce !== getNonce ||
      TokenHandler.getInstance().getTokenMap() !== tokenMap ||
      tokenMap.wrapAmount !== wrap ||
      tokenMap.unwrapAmount !== unwrap ||
      typeof maxFee !== 'bigint' ||
      maxFee <= 0n ||
      typeof priorityFee !== 'bigint' ||
      priorityFee < 0n ||
      priorityFee > maxFee ||
      cap <= 0n ||
      multiplier < 1n ||
      cap * multiplier * maxFee >= 1n << 256n
    )
      throw new Error('Avalanche cold gas authority changed or is invalid');
  };
  assertCurrent();
  const conservativeBudget = wrap.call(
    tokenMap,
    'avax',
    cap * multiplier * maxFee!,
    'avalanche',
  ).amount;
  const provisional = locked.nativeToken - policy.avax.low - conservativeBudget;
  const nonce = await getNonce.call(network, lock);
  assertCurrent();
  if (!Number.isSafeInteger(nonce) || nonce < 0)
    throw new Error('Invalid Avalanche cold nonce');
  const estimate = await getGas.call(
    network,
    Transaction.from({
      type: 2,
      chainId,
      nonce,
      to: cold,
      value: unwrap.call(
        tokenMap,
        'avax',
        provisional > 0n ? provisional : 1n,
        'avalanche',
      ).amount,
      data: '0x',
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
    }),
  );
  assertCurrent();
  if (typeof estimate !== 'bigint' || estimate <= 0n || estimate > cap)
    throw new Error('Invalid Avalanche cold gas estimate');
  const budget = wrap.call(
    tokenMap,
    'avax',
    estimate * multiplier * maxFee!,
    'avalanche',
  ).amount;
  if (typeof budget !== 'bigint' || budget <= 0n)
    throw new Error('Invalid Avalanche cold gas budget');
  const amount = locked.nativeToken - policy.avax.low - budget;
  return amount > 0n ? { nativeToken: amount, tokens: [] } : undefined;
};
