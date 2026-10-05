import { getAddress, Interface, Transaction } from 'ethers';

import { TokenMap } from '@rosen-bridge/tokens';
import { TransactionFormatError } from '@rosen-chains/abstract-chain';
import { transferABI } from '@rosen-chains/evm';

const zero = '0x0000000000000000000000000000000000000000';
const transfer = new Interface(transferABI);

/** Captures native identity and bridgeable ERC20 mappings; official types and historical token aliases are explicit. */
export const captureAvalancheAssets = (tokens: TokenMap) => {
  const raw = tokens.getRawConfig;
  const configured = tokens.getConfig;
  const fingerprint = JSON.stringify(raw.call(tokens));
  const source = raw.call(tokens);
  const scale = new Map<string, bigint>();
  // Retain TokenMap's identity conversion when a standalone adapter has no native map.
  let nativeScale = 1n;
  let nativeCount = 0;
  for (const set of source) {
    const asset = set.avalanche;
    if (!asset) continue;
    const wrapped = set.ergo;
    const members = Object.values(set);
    if (
      !wrapped ||
      !['EIP-004', 'token'].includes(wrapped.type) ||
      !/^[0-9a-f]{64}$/.test(wrapped.tokenId) ||
      /^0+$/.test(wrapped.tokenId) ||
      members.some(
        (member) =>
          !member ||
          typeof member.tokenId !== 'string' ||
          member.tokenId.length === 0 ||
          !['native', 'wrapped'].includes(member.residency) ||
          !Number.isSafeInteger(member.decimals) ||
          member.decimals < 0 ||
          member.decimals > 255,
      ) ||
      members.filter((member) => member.residency === 'native').length !== 1
    )
      throw new TransactionFormatError('Invalid Avalanche asset mapping');
    // TokenMap resolves identifiers globally; every member must have one owner,
    // including aliases within the same set and on another chain.
    const allMembers = source.flatMap((candidate) => Object.values(candidate));
    for (const member of members) {
      const identity = member.tokenId.toLowerCase();
      if (
        allMembers.filter(
          (candidate) => candidate?.tokenId?.toLowerCase() === identity,
        ).length !== 1
      )
        throw new TransactionFormatError(
          'Ambiguous Avalanche asset identifier',
        );
    }
    if (asset.type === 'native') {
      nativeCount += 1;
      if (
        nativeCount !== 1 ||
        asset.tokenId !== 'avax' ||
        asset.decimals !== 18 ||
        asset.residency !== 'native' ||
        wrapped.residency !== 'wrapped'
      )
        throw new TransactionFormatError('Invalid Avalanche native mapping');
      nativeScale =
        10n **
        BigInt(
          asset.decimals -
            Math.min(...members.map((member) => member.decimals)),
        );
      continue;
    }
    let id: string;
    try {
      id = getAddress(asset.tokenId).toLowerCase();
    } catch {
      throw new TransactionFormatError('Invalid Avalanche ERC20 identifier');
    }
    if (
      asset.tokenId !== id ||
      id === zero ||
      !['ERC-20', 'token'].includes(asset.type) ||
      !['native', 'wrapped'].includes(asset.residency) ||
      !wrapped ||
      !['EIP-004', 'token'].includes(wrapped.type) ||
      !/^[0-9a-f]{64}$/.test(wrapped.tokenId) ||
      /^0+$/.test(wrapped.tokenId) ||
      !['native', 'wrapped'].includes(wrapped.residency) ||
      Object.values(set).some(
        (member) =>
          !member ||
          !Number.isSafeInteger(member.decimals) ||
          member.decimals < 0 ||
          member.decimals > 255,
      ) ||
      scale.has(id)
    )
      throw new TransactionFormatError('Invalid Avalanche ERC20 mapping');
    if (
      !configured
        .call(tokens)
        .some((candidate) => JSON.stringify(candidate) === JSON.stringify(set))
    )
      throw new TransactionFormatError('Unbridgeable Avalanche ERC20 mapping');
    scale.set(
      id,
      10n **
        BigInt(
          asset.decimals -
            Math.min(...Object.values(set).map((member) => member.decimals)),
        ),
    );
  }
  const ids = Object.freeze([...scale.keys()]);
  /** Rejects map or supported-token drift before consuming the captured policy. */
  const assertFresh = (supported: readonly string[]) => {
    if (
      tokens.getRawConfig !== raw ||
      tokens.getConfig !== configured ||
      JSON.stringify(raw.call(tokens)) !== fingerprint ||
      supported.length !== ids.length ||
      supported.some((id, index) => id !== ids[index])
    )
      throw new TransactionFormatError('Avalanche asset policy changed');
  };
  /** Requires a canonical configured token and an exact uint256 amount. */
  const unwrap = (id: string, amount: bigint): bigint => {
    const factor = scale.get(id);
    if (
      factor === undefined ||
      typeof amount !== 'bigint' ||
      amount < 0n ||
      amount >= 1n << 256n ||
      amount * factor >= 1n << 256n
    )
      throw new TransactionFormatError('Invalid Avalanche ERC20 amount');
    return amount * factor;
  };
  /** Converts available raw units downward so fractional balances cannot fund a payment. */
  const available = (id: string, amount: bigint): bigint => {
    const factor = scale.get(id);
    if (
      factor === undefined ||
      typeof amount !== 'bigint' ||
      amount < 0n ||
      amount >= 1n << 256n
    )
      throw new TransactionFormatError('Invalid Avalanche ERC20 balance');
    return amount / factor;
  };
  /** Floors available wei while gas costs retain their upward conversion. */
  const nativeAvailable = (amount: bigint): bigint => {
    if (typeof amount !== 'bigint' || amount < 0n || amount >= 1n << 256n)
      throw new TransactionFormatError('Invalid Avalanche native balance');
    return amount / nativeScale;
  };
  /** Decodes only one canonical configured transfer, with exact event bytes and positive amount. */
  const decode = (tx: Transaction, event: string) => {
    if (tx.to === null || !ids.includes(tx.to.toLowerCase()) || tx.value !== 0n)
      throw new TransactionFormatError('Unsupported Avalanche ERC20 payment');
    const data = tx.data.slice(0, 138);
    const [recipient, amount] = transfer.decodeFunctionData('transfer', data);
    if (
      getAddress(recipient) === zero ||
      typeof amount !== 'bigint' ||
      amount <= 0n ||
      amount % scale.get(tx.to.toLowerCase())! !== 0n ||
      tx.data !==
        transfer.encodeFunctionData('transfer', [recipient, amount]) + event
    )
      throw new TransactionFormatError('Invalid Avalanche ERC20 transfer');
    return {
      id: tx.to.toLowerCase(),
      recipient: getAddress(recipient).toLowerCase(),
      amount,
    };
  };
  return Object.freeze({
    ids,
    assertFresh,
    unwrap,
    available,
    nativeAvailable,
    decode,
  });
};
