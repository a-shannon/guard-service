import { PaymentTransaction } from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import { BoundSigningAction } from '../../src/signing/tssAuthorizationRegistry';

/** Generate a canonical synthetic block hash for real scanner fixtures. */
export const hash = (height: number) =>
  '0x' + height.toString(16).padStart(64, '0');
/** Generate an authorization binding whose action keeps the original callback. */
export const binding = (id = '11'.repeat(32)): BoundSigningAction => ({
  bindingId: id,
  withAction: async (action) => action(),
});
/** Decode complete transaction JSON with the actual Ergo transaction class. */
export const decode = (json: string): PaymentTransaction => {
  const value = JSON.parse(json);
  return value.network === 'ergo'
    ? ErgoTransaction.fromJson(json)
    : new PaymentTransaction(
        value.network,
        value.txId,
        value.eventId,
        Buffer.from(value.txBytes, 'hex'),
        value.txType,
      );
};
/** Advance one event-loop turn for installed signer callbacks. */
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Wait across the real monotonic deadline used by signer expiry controls. */
export const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
