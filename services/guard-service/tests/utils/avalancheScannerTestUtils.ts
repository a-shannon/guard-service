import { Transaction } from 'ethers';

/** Creates a fixed-width synthetic hash from one hex digit. */
export const hash = (digit: string) => `0x${digit.repeat(64)}`;
/** Deterministic serialized type-2 fixture with public synthetic signature scalars. */
export const signed = Transaction.from({
  type: 2,
  chainId: 43113n,
  nonce: 7,
  to: `0x${'12'.repeat(20)}`,
  gasLimit: 25000n,
  maxFeePerGas: 10n,
  maxPriorityFeePerGas: 1n,
  value: 5n,
  signature: { r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}`, v: 27 },
});
