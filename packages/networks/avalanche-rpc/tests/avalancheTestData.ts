/** Canonical synthetic transaction block hash. */
export const blockHash = '0x' + 'a'.repeat(64);
/** Synthetic settled frontier distinct from the transaction block. */
export const frontierHash = '0x' + 'b'.repeat(64);
/** Synthetic conflicting canonical identity. */
export const otherHash = '0x' + 'c'.repeat(64);
/** Synthetic account used for RPC state and payment requests. */
export const address = '0x' + '11'.repeat(20);
/** Synthetic ERC20 contract for shared EVM state-read coverage. */
export const token = '0x' + '22'.repeat(20);
/** Synthetic settled state block identity at height 42. */
export const stateHash = '0x' + 'aa'.repeat(32);
