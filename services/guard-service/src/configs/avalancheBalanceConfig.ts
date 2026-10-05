export interface AvalancheBalanceConfig {
  readonly updateInterval: number;
  readonly updateBatchInterval: number;
  readonly tokensPerIteration: { readonly rpc: number };
}

/** Explicit enabled-chain scheduling, independent of legacy chain defaults. */
export const readAvalancheBalanceConfig = (
  raw: unknown,
): AvalancheBalanceConfig => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Missing or invalid balanceHandler.avalanche');
  const input = raw as Record<string, unknown>;
  /** Reads a positive interval in seconds that fits a millisecond Node timer. */
  const interval = (field: string): number => {
    const value = input[field];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      !Number.isSafeInteger(value * 1000) ||
      value * 1000 > 2147483647
    )
      throw new Error(`Invalid balanceHandler.avalanche.${field}`);
    return value;
  };
  const batch = input.tokensPerIteration;
  if (
    !batch ||
    typeof batch !== 'object' ||
    Array.isArray(batch) ||
    !('rpc' in batch) ||
    typeof batch.rpc !== 'number' ||
    !Number.isSafeInteger(batch.rpc) ||
    batch.rpc < 1
  )
    throw new Error('Invalid balanceHandler.avalanche.tokensPerIteration.rpc');
  return Object.freeze({
    updateInterval: interval('updateInterval'),
    updateBatchInterval: interval('updateBatchInterval'),
    tokensPerIteration: Object.freeze({ rpc: batch.rpc }),
  });
};
