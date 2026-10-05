import { getSolanaAssetIdentityKey } from '@rosen-bridge/address-codec-solana';

/** Original SPL Token Program; Token-2022 layouts are excluded. */
export const ORIGINAL_SPL_PROGRAM_ID =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Token-2022 program for independently invalid owner fixtures. */
export const EXTENDED_SPL_PROGRAM_ID =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Native SOL System Program identity. */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** Wrapped SOL mint; valid records are excluded from SPL inventory. */
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Synthetic cluster key encoding 32 bytes filled with five. */
export const TEST_GENESIS = 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY';
/** Queried owner encoding 32 bytes filled with six. */
export const WALLET = 'QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF';
/** Different owner encoding 32 bytes filled with seven. */
export const OTHER_WALLET = 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx';
/** First mint encoding 32 bytes filled with eight. */
export const MINT = 'YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf';
/** Second mint encoding 32 bytes filled with twelve. */
export const OTHER_MINT = 'p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV';
/** First token account encoding 32 bytes filled with nine. */
export const ACCOUNT_A = 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN';
/** Distinct token account encoding 32 bytes filled with ten. */
export const ACCOUNT_B = 'gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5';
/** Third account encoding 32 bytes filled with eleven. */
export const ACCOUNT_C = 'k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn';
/** Exact maximum raw native or per-mint token amount. */
export const U64_MAX = 18_446_744_073_709_551_615n;

/** First-mint identity as consumed by Guard and its token map. */
export const ASSET_TOKEN_ID = getSolanaAssetIdentityKey({
  kind: 'spl',
  clusterGenesisHash: TEST_GENESIS,
  tokenProgramId: ORIGINAL_SPL_PROGRAM_ID,
  mint: MINT,
});

/** Qualified native identity accepted alongside the Guard key `sol`. */
export const ASSET_NATIVE_ID = getSolanaAssetIdentityKey({
  kind: 'native',
  clusterGenesisHash: TEST_GENESIS,
});
