import {
  decodeSolanaAddress,
  SOLANA_TOKEN_PROGRAM_ID,
  validateSolanaAddress,
} from '@rosen-bridge/address-codec-solana';

const TOKEN_ACCOUNT_LENGTH = 165;
const MINT_LENGTH = 82;
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

type RecordValue = Record<string, unknown>;

export interface SolanaAssetTokenAccount {
  readonly address: string;
  readonly mint: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly state: 'initialized' | 'frozen';
  readonly nativeReserve: bigint | null;
}

export interface SolanaAssetMint {
  readonly address: string;
  readonly decimals: number;
}

/** Raise the account-layout fault identified by the caller. */
const fail = (code: string): never => {
  throw new Error(code);
};

/** Require a non-null object rather than an array or primitive. */
const asRecord = (value: unknown, code: string): RecordValue => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail(code);
  return value as RecordValue;
};

/** Require a canonical base58 public key with exactly 32 decoded bytes. */
const publicKey = (value: unknown, code: string): string => {
  if (typeof value !== 'string') return fail(code);
  try {
    validateSolanaAddress(value);
  } catch {
    return fail(code);
  }
  return value;
};

/** Encode a 32-byte public key from the original Token Program layout. */
const keyFromBytes = (bytes: Buffer): string => {
  try {
    return decodeSolanaAddress(bytes.toString('hex'));
  } catch {
    return fail('SOLANA_ASSET_ACCOUNT_ADDRESS_INVALID');
  }
};

/** Validate program ownership, canonical base64 and the complete layout size. */
const accountBytes = (value: unknown, expectedLength: number): Buffer => {
  const record = asRecord(value, 'SOLANA_ASSET_ACCOUNT_INVALID');
  if (record.owner !== SOLANA_TOKEN_PROGRAM_ID)
    return fail('SOLANA_ASSET_ACCOUNT_PROGRAM_OWNER_MISMATCH');
  if (record.executable !== false)
    return fail('SOLANA_ASSET_ACCOUNT_EXECUTABLE');
  const data = record.data;
  if (
    !Array.isArray(data) ||
    data.length !== 2 ||
    typeof data[0] !== 'string' ||
    data[1] !== 'base64'
  )
    return fail('SOLANA_ASSET_ACCOUNT_DATA_INVALID');
  const encoded = data[0];
  if (
    encoded.length !== Math.ceil(expectedLength / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  )
    return fail('SOLANA_ASSET_ACCOUNT_DATA_INVALID');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length !== expectedLength)
    return fail('SOLANA_ASSET_ACCOUNT_DATA_INVALID');
  return bytes;
};

/** Decode a four-byte COption tag and its optional 32-byte key. */
const cOptionKey = (bytes: Buffer, offset: number): string | null => {
  const tag = bytes.readUInt32LE(offset);
  if (tag === 0) return null;
  if (tag !== 1) return fail('SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID');
  return keyFromBytes(bytes.subarray(offset + 4, offset + 36));
};

/** Decode a complete original-program account bound to the queried wallet. */
export const decodeSolanaAssetTokenAccount = (
  addressValue: unknown,
  accountValue: unknown,
  requestedOwnerValue: unknown,
): SolanaAssetTokenAccount => {
  const address = publicKey(
    addressValue,
    'SOLANA_ASSET_ACCOUNT_ADDRESS_INVALID',
  );
  const requestedOwner = publicKey(
    requestedOwnerValue,
    'SOLANA_ASSET_WALLET_INVALID',
  );
  const bytes = accountBytes(accountValue, TOKEN_ACCOUNT_LENGTH);
  const mint = keyFromBytes(bytes.subarray(0, 32));
  const owner = keyFromBytes(bytes.subarray(32, 64));
  if (owner !== requestedOwner)
    return fail('SOLANA_ASSET_ACCOUNT_WALLET_OWNER_MISMATCH');
  const amount = bytes.readBigUInt64LE(64);
  cOptionKey(bytes, 72);
  const stateTag = bytes[108];
  const state =
    stateTag === 1 ? 'initialized' : stateTag === 2 ? 'frozen' : null;
  if (!state) return fail('SOLANA_ASSET_ACCOUNT_STATE_INVALID');
  const nativeTag = bytes.readUInt32LE(109);
  if (nativeTag !== 0 && nativeTag !== 1)
    return fail('SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID');
  const nativeReserve = nativeTag === 1 ? bytes.readBigUInt64LE(113) : null;
  if (nativeReserve !== null && mint !== WRAPPED_SOL_MINT)
    return fail('SOLANA_ASSET_NATIVE_RESERVE_MINT_MISMATCH');
  bytes.readBigUInt64LE(121);
  cOptionKey(bytes, 129);
  return Object.freeze({ address, mint, owner, amount, state, nativeReserve });
};

/** Decode an initialized original-program mint without claiming its name. */
export const decodeSolanaAssetMint = (
  addressValue: unknown,
  accountValue: unknown,
): SolanaAssetMint => {
  const address = publicKey(addressValue, 'SOLANA_ASSET_MINT_INVALID');
  const bytes = accountBytes(accountValue, MINT_LENGTH);
  cOptionKey(bytes, 0);
  bytes.readBigUInt64LE(36);
  const decimals = bytes[44];
  if (bytes[45] !== 1) return fail('SOLANA_ASSET_MINT_UNINITIALIZED');
  cOptionKey(bytes, 46);
  return Object.freeze({ address, decimals });
};
