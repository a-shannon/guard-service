import { expect } from 'vitest';

import type {
  SolanaEventContext,
  SolanaRpcRequest,
} from '@rosen-chains/solana';

import { SolanaRpcNetwork } from '../lib/solanaRpcNetwork';
import {
  MINT,
  TEST_GENESIS,
  ORIGINAL_SPL_PROGRAM_ID,
  WALLET,
} from './assetReadTestData';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a canonical synthetic fixture key to its fixed-width bytes. */
export const testKeyBytes = (address: string): Buffer => {
  const digits = new Map(
    [...BASE58].map((character, index) => [character, BigInt(index)]),
  );
  let value = 0n;
  for (const character of address) {
    const digit = digits.get(character);
    if (digit === undefined) throw new Error('INVALID_TEST_BASE58');
    value = value * 58n + digit;
  }
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
};

/** Encode an original Token Program account with independent fields. */
export const tokenAccountData = (
  options: {
    readonly mint?: string;
    readonly owner?: string;
    readonly amount?: bigint;
    readonly state?: number;
    readonly delegateTag?: number;
    readonly nativeReserve?: bigint | null;
    readonly nativeTag?: number;
    readonly closeAuthorityTag?: number;
  } = {},
): string => {
  const {
    mint = MINT,
    owner = WALLET,
    amount = 0n,
    state = 1,
    delegateTag = 0,
    nativeReserve = null,
    nativeTag = nativeReserve === null ? 0 : 1,
    closeAuthorityTag = 0,
  } = options;
  const bytes = Buffer.alloc(165);
  testKeyBytes(mint).copy(bytes, 0);
  testKeyBytes(owner).copy(bytes, 32);
  bytes.writeBigUInt64LE(amount, 64);
  bytes.writeUInt32LE(delegateTag, 72);
  bytes.fill(0xa5, 76, 108);
  bytes[108] = state;
  bytes.writeUInt32LE(nativeTag, 109);
  if (nativeReserve !== null) bytes.writeBigUInt64LE(nativeReserve, 113);
  bytes.writeUInt32LE(closeAuthorityTag, 129);
  bytes.fill(0x5a, 133, 165);
  return bytes.toString('base64');
};

/** Encode an original mint with independently varied precision/authority flags. */
export const mintData = (
  options: {
    readonly decimals?: number;
    readonly initialized?: number;
    readonly mintOptionTag?: number;
    readonly freezeAuthorityTag?: number;
  } = {},
): string => {
  const {
    decimals = 6,
    initialized = 1,
    mintOptionTag = 0,
    freezeAuthorityTag = 0,
  } = options;
  const bytes = Buffer.alloc(82);
  bytes.writeUInt32LE(mintOptionTag, 0);
  bytes.fill(0xa5, 4, 36);
  bytes[44] = decimals;
  bytes[45] = initialized;
  bytes.writeUInt32LE(freezeAuthorityTag, 46);
  bytes.fill(0x5a, 50, 82);
  return bytes.toString('base64');
};

/** Build one RPC inventory entry with a separately selectable program owner. */
export const tokenAccountItem = (
  address: string,
  data: string,
  rpcOwner = ORIGINAL_SPL_PROGRAM_ID,
) => ({
  pubkey: address,
  account: {
    lamports: 2_039_280,
    owner: rpcOwner,
    data: [data, 'base64'],
    executable: false,
    rentEpoch: 0,
  },
});

/** Build one RPC mint entry with a separately selectable program owner. */
export const mintAccount = (
  data = mintData(),
  rpcOwner = ORIGINAL_SPL_PROGRAM_ID,
) => ({
  lamports: 1_461_600,
  owner: rpcOwner,
  data: [data, 'base64'],
  executable: false,
  rentEpoch: 0,
});

/** Return one correlated response while preserving numeric result lexemes. */
export const rpcResponse = (
  request: SolanaRpcRequest,
  resultJson: string,
): string => `{"jsonrpc":"2.0","id":${request.id},"result":${resultJson}}`;

/** Assert the stable asset-read wrapper and exact underlying failure code. */
export const expectAssetCause = async (
  promise: Promise<unknown>,
  code: string,
) => {
  await expect(promise).rejects.toMatchObject({
    message: 'SOLANA_REQUEST_UNAVAILABLE',
    cause: { message: code },
  });
};

/** Build an RPC network with a captured synthetic cluster and scripted transport. */
export const makeAssetReadNetwork = (
  handler: (request: SolanaRpcRequest, requestIndex: number) => string,
  genesisHash = TEST_GENESIS,
) => {
  const requests: SolanaRpcRequest[] = [];
  const network = new SolanaRpcNetwork({
    context: {
      resolvedProfile: { genesisHash, assets: [] },
    } as unknown as SolanaEventContext,
    locateBlock: async () => undefined,
    transport: async (request) => {
      requests.push(request);
      return handler(request, requests.length);
    },
  });
  return { network, requests };
};

/** Reply to a genesis request using the exact supplied hash. */
export const genesisResponse = (
  request: SolanaRpcRequest,
  genesisHash = TEST_GENESIS,
) => rpcResponse(request, JSON.stringify(genesisHash));

/** Return the JSON-RPC result fragment for a finalized native balance. */
export const balanceResult = (slot: string, lamports: string) =>
  `{"context":{"slot":${slot}},"value":${lamports}}`;

/** Return the JSON-RPC result fragment for a finalized token-account list. */
export const tokenAccountsResult = (
  slot: string,
  accounts: readonly unknown[],
) => `{"context":{"slot":${slot}},"value":${JSON.stringify(accounts)}}`;

/** Return the JSON-RPC result fragment for one finalized mint account. */
export const mintResult = (slot: string, account: unknown) =>
  `{"context":{"slot":${slot}},"value":${JSON.stringify(account)}}`;
