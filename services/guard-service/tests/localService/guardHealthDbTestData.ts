/** Fixed synthetic scanner identity used only by the local composition fixture. */
export const scanner = 'ethereum';
/** Controlled timestamp at which the synthetic scanner block is initially fresh. */
export const initialMilliseconds = 1800000000000;
/** Exact persisted scanner record selected by the actual DatabaseAction reader. */
export const savedBlock = {
  height: 101,
  hash: 'synthetic-ethereum-block-101',
  parentHash: 'synthetic-ethereum-block-100',
  scanner,
  timestamp: initialMilliseconds / 1000,
};
/** Explicit local scanner-age thresholds, with no production policy implication. */
export const agePolicy = {
  warnDifference: 5,
  criticalDifference: 10,
  blockTime: 1,
};
/** Internal scanner status literal documented by BlockEntity; not a barrel export. */
export const processingStatus = 'PROCESSING';
