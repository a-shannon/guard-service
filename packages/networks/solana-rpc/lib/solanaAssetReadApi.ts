import {
  getSolanaAssetIdentityKey,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
  validateSolanaAddress,
} from '@rosen-bridge/address-codec-solana';
import type { AssetBalance, TokenDetail } from '@rosen-chains/abstract-chain';
import { readSolanaRpcU64 } from '@rosen-chains/solana';
import type { validateSolanaRpcResponse } from '@rosen-chains/solana';

import {
  decodeSolanaAssetMint,
  decodeSolanaAssetTokenAccount,
  WRAPPED_SOL_MINT,
} from './solanaAssetAccount';

type JsonNode = ReturnType<typeof validateSolanaRpcResponse>['result'];
type RpcCall = (
  method: string,
  params: readonly unknown[],
) => Promise<JsonNode>;

const FINALIZED = Object.freeze({ commitment: 'finalized' });
const ACCOUNT_PROGRAM_FILTER = Object.freeze({
  programId: SOLANA_TOKEN_PROGRAM_ID,
});
const ACCOUNT_READ_ENCODING = Object.freeze({
  commitment: 'finalized',
  encoding: 'base64',
});
const MAX_READ_ATTEMPTS = 3;
const U64_MAX = 18_446_744_073_709_551_615n;

export interface SolanaAssetReadApiOptions {
  readonly expectedGenesisHash: string;
  readonly callRpc: RpcCall;
}

export interface SolanaAssetReadApi {
  readonly getAddressAssets: (address: string) => Promise<AssetBalance>;
  readonly getTokenDetail: (tokenId: string) => Promise<TokenDetail>;
}

/** Read an object member without re-parsing or converting numeric tokens. */
const member = (node: JsonNode | undefined, key: string) =>
  node?.kind === 'object' ? node.members.get(key) : undefined;

/** Read a string from the exact JSON tree. */
const stringValue = (node: JsonNode | undefined) =>
  node?.kind === 'string' ? node.value : undefined;

/** Require an object carrier for a particular response field. */
const object = (node: JsonNode | undefined, code: string) => {
  if (node?.kind !== 'object') throw new Error(code);
  return node;
};

/** Require a present response field before interpreting its shape. */
const requiredMember = (node: JsonNode | undefined, key: string): JsonNode => {
  const value = member(node, key);
  if (!value) throw new Error(`SOLANA_ASSET_RESPONSE_FIELD_MISSING:${key}`);
  return value;
};

/** Read an exact u64 context slot for matched finalized account views. */
const contextSlot = (result: JsonNode): bigint => {
  const context = object(
    member(result, 'context'),
    'SOLANA_ASSET_CONTEXT_INVALID',
  );
  return readSolanaRpcU64(member(context, 'slot'));
};

/** Extract the RPC account fields needed by the complete binary decoder. */
const rpcAccount = (node: JsonNode | undefined) => {
  const account = object(node, 'SOLANA_ASSET_ACCOUNT_INVALID');
  const owner = stringValue(member(account, 'owner'));
  const executable = member(account, 'executable');
  const data = member(account, 'data');
  if (
    owner === undefined ||
    executable?.kind !== 'atom' ||
    typeof executable.value !== 'boolean' ||
    data?.kind !== 'array' ||
    data.items.length !== 2
  )
    throw new Error('SOLANA_ASSET_ACCOUNT_INVALID');
  const encoded = stringValue(data.items[0]);
  const encoding = stringValue(data.items[1]);
  if (encoded === undefined || encoding === undefined)
    throw new Error('SOLANA_ASSET_ACCOUNT_INVALID');
  return { owner, executable: executable.value, data: [encoded, encoding] };
};

/** Require a canonical 32-byte base58 key for a wallet or genesis identity. */
const canonicalKey = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  try {
    validateSolanaAddress(value);
  } catch {
    throw new Error(code);
  }
  return value;
};

type RequestedAsset =
  | { readonly kind: 'native' }
  | { readonly kind: 'spl'; readonly mint: string };

/** Resolve a native ID or a cluster-bound original-SPL identity. */
const requestedAsset = (tokenId: string, genesis: string): RequestedAsset => {
  const nativeId = getSolanaAssetIdentityKey({
    kind: 'native',
    clusterGenesisHash: genesis,
  });
  if (tokenId === 'sol' || tokenId === nativeId) return { kind: 'native' };
  if (typeof tokenId !== 'string')
    throw new Error('SOLANA_ASSET_TOKEN_ID_INVALID');
  const parts = tokenId.split(':');
  if (
    parts.length !== 3 ||
    parts[0] !== genesis ||
    parts[1] === SOLANA_SYSTEM_PROGRAM_ID ||
    parts[1] !== SOLANA_TOKEN_PROGRAM_ID
  )
    throw new Error('SOLANA_ASSET_TOKEN_ID_INVALID');
  const mint = canonicalKey(parts[2], 'SOLANA_ASSET_TOKEN_ID_INVALID');
  if (mint === WRAPPED_SOL_MINT)
    throw new Error('SOLANA_ASSET_TOKEN_ID_INVALID');
  const canonical = getSolanaAssetIdentityKey({
    kind: 'spl',
    clusterGenesisHash: genesis,
    tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
    mint,
  });
  if (canonical !== tokenId) throw new Error('SOLANA_ASSET_TOKEN_ID_INVALID');
  return { kind: 'spl', mint };
};

/** Validate all accounts, then total bridge-eligible non-frozen SPL inventory. */
const accountBalances = (
  result: JsonNode,
  address: string,
  genesis: string,
) => {
  const values = requiredMember(result, 'value');
  if (values.kind !== 'array')
    throw new Error('SOLANA_ASSET_ACCOUNT_LIST_INVALID');
  const seen = new Set<string>();
  const balances = new Map<string, bigint>();
  for (const entry of values.items) {
    const item = object(entry, 'SOLANA_ASSET_ACCOUNT_INVALID');
    const accountAddress = canonicalKey(
      stringValue(member(item, 'pubkey')),
      'SOLANA_ASSET_ACCOUNT_ADDRESS_INVALID',
    );
    if (seen.has(accountAddress))
      throw new Error('SOLANA_ASSET_DUPLICATE_ACCOUNT');
    seen.add(accountAddress);
    const decoded = decodeSolanaAssetTokenAccount(
      accountAddress,
      rpcAccount(member(item, 'account')),
      address,
    );
    if (decoded.state === 'frozen' || decoded.mint === WRAPPED_SOL_MINT)
      continue;
    const amount = (balances.get(decoded.mint) ?? 0n) + decoded.amount;
    if (amount > U64_MAX) throw new Error('SOLANA_ASSET_BALANCE_OUT_OF_RANGE');
    balances.set(decoded.mint, amount);
  }
  return [...balances]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([mint, value]) => ({
      id: getSolanaAssetIdentityKey({
        kind: 'spl',
        clusterGenesisHash: genesis,
        tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
        mint,
      }),
      value,
    }));
};

/** Build raw finalized reads using the provider's existing correlated RPC call. */
export const createSolanaAssetReadApi = (
  options: SolanaAssetReadApiOptions,
): SolanaAssetReadApi => {
  const genesis = canonicalKey(
    options.expectedGenesisHash,
    'SOLANA_ASSET_EXPECTED_GENESIS_INVALID',
  );
  const call = options.callRpc;
  if (typeof call !== 'function')
    throw new Error('SOLANA_ASSET_TRANSPORT_INVALID');

  /** Check endpoint cluster identity on both sides of the account read. */
  const readGenesis = async () => {
    const value = stringValue(await call('getGenesisHash', []));
    if (value === undefined) throw new Error('SOLANA_RPC_GENESIS_MISSING');
    if (value !== genesis) throw new Error('SOLANA_RPC_GENESIS_MISMATCH');
  };

  /** Return raw SOL and eligible SPL amounts from one matched finalized view. */
  const getAddressAssets = async (
    addressValue: string,
  ): Promise<AssetBalance> => {
    try {
      const address = canonicalKey(addressValue, 'SOLANA_ASSET_WALLET_INVALID');
      await readGenesis();
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
        const balance = await call('getBalance', [address, FINALIZED]);
        const accounts = await call('getTokenAccountsByOwner', [
          address,
          ACCOUNT_PROGRAM_FILTER,
          ACCOUNT_READ_ENCODING,
        ]);
        const balanceSlot = contextSlot(balance);
        const accountsSlot = contextSlot(accounts);
        const nativeToken = readSolanaRpcU64(member(balance, 'value'));
        const tokens = accountBalances(accounts, address, genesis);
        if (balanceSlot !== accountsSlot) continue;
        await readGenesis();
        return { nativeToken, tokens };
      }
      throw new Error('SOLANA_ASSET_CONTEXT_SLOT_MISMATCH');
    } catch (error) {
      throw new Error('SOLANA_REQUEST_UNAVAILABLE', { cause: error });
    }
  };

  /** Return constant SOL units or validated original-mint decimal precision. */
  const getTokenDetail = async (tokenId: string): Promise<TokenDetail> => {
    try {
      const asset = requestedAsset(tokenId, genesis);
      if (asset.kind === 'native')
        return Object.freeze({ tokenId, name: 'SOL', decimals: 9 });
      await readGenesis();
      const response = await call('getAccountInfo', [
        asset.mint,
        ACCOUNT_READ_ENCODING,
      ]);
      contextSlot(response);
      const value = member(response, 'value');
      if (!value || (value.kind === 'atom' && value.value === null))
        throw new Error('SOLANA_ASSET_MINT_NOT_FOUND');
      const mint = decodeSolanaAssetMint(asset.mint, rpcAccount(value));
      await readGenesis();
      return Object.freeze({
        tokenId,
        name: mint.address,
        decimals: mint.decimals,
      });
    } catch (error) {
      throw new Error('SOLANA_REQUEST_UNAVAILABLE', { cause: error });
    }
  };
  return Object.freeze({ getAddressAssets, getTokenDetail });
};
