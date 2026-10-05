import {
  MINT,
  TEST_GENESIS,
  ORIGINAL_SPL_PROGRAM_ID,
} from './assetReadTestData';

/** Canonical original-SPL identity used by the boundary fixtures. */
export const BOUNDARY_TOKEN_ID = `${TEST_GENESIS}:${ORIGINAL_SPL_PROGRAM_ID}:${MINT}`;

/** Independently invalid finalized contexts and their owning error codes. */
export const boundaryContexts = [
  ['missing context', undefined, 'SOLANA_ASSET_CONTEXT_INVALID'],
  ['non-object context', 'null', 'SOLANA_ASSET_CONTEXT_INVALID'],
  ['missing slot', '{}', 'SOLANA_RPC_INVALID_U64'],
  ['string slot', '{"slot":"500"}', 'SOLANA_RPC_INVALID_U64'],
  ['negative slot', '{"slot":-1}', 'SOLANA_RPC_INVALID_U64'],
  ['exponent slot', '{"slot":5e2}', 'SOLANA_RPC_INVALID_U64'],
  [
    'overflow slot',
    '{"slot":18446744073709551616}',
    'SOLANA_RPC_U64_OUT_OF_RANGE',
  ],
] as const;
