import type { SolanaEventRequest } from '../lib/requestBoundEventContext';
import { BLOCKHASH, RAW_TRANSACTION, SIGNATURE } from './testData';

/** Create a request matching the fixed enriched-transaction fixture. */
export const createTestRequest = (
  overrides: Partial<SolanaEventRequest> = {},
): SolanaEventRequest => ({
  extractorInput: RAW_TRANSACTION,
  requestedTxId: SIGNATURE,
  requestedBlockhash: BLOCKHASH,
  observedSlot: 42,
  rosenBlockHeight: 7,
  ...overrides,
});
