import { SOLANA_PROJECTOR_VERSION } from '@rosen-bridge/rosen-extractor';
import type { SolanaResolvedProfile } from '@rosen-bridge/rosen-extractor';

export const SIGNATURE = 'request-signature';
export const BLOCKHASH = 'request-blockhash';
export const GENESIS = 'cluster-genesis';
export const RAW_TRANSACTION =
  '{"transaction":{"signatures":["request-signature"]},"blockhash":"request-blockhash","slot":42,"clusterGenesisHash":"cluster-genesis","destinationNetwork":"mainnet","meta":{"fee":18446744073709551615}}';

/** Build a deeply frozen profile fixture with one resolved asset. */
export const createTestProfile = (
  projectorVersion = SOLANA_PROJECTOR_VERSION,
): SolanaResolvedProfile => {
  const asset = Object.freeze({
    assetId: 'source-asset',
    programId: 'source-program',
    mint: null,
    vaultTokenAccount: null,
    sourceDecimals: 9,
    destinationDecimals: 9,
    destinationTokenId: 'destination-asset',
    minAmount: '1',
    maxAmount: '1000000000',
    networkFee: '0',
    bridgeFee: '0',
  });
  return Object.freeze({
    genesisHash: GENESIS,
    destinationChain: 'ergo' as const,
    destinationNetwork: 'mainnet' as const,
    vaultOwner: 'vault-owner',
    memoVersion: 1 as const,
    projectorVersion,
    assets: Object.freeze([asset]),
  });
};
