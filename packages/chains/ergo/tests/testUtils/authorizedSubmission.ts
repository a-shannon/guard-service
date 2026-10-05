import ErgoTransaction from '../../lib/ergoTransaction';
import { AuthorizedErgoSubmission } from '../../lib/network/authorizedSubmission';
import {
  transaction2PartialUnsignedPaymentTransaction,
  transaction2SignedSerialized,
} from '../transactionTestData';

/**
 * Creates the pinned signed payment passed to chain authorization cases.
 */
export const generateAuthorizedPayment = () => {
  const tx = ErgoTransaction.fromJson(
    transaction2PartialUnsignedPaymentTransaction,
  );
  tx.txBytes = Buffer.from(transaction2SignedSerialized, 'hex');
  return tx;
};

/**
 * Authorize immediately within the configured one-second timeout.
 */
export const generateSubmissionOptions = () => ({
  timeoutMs: 1000,
  /**
   * Start submission immediately when authorization is requested.
   */
  authorizeSubmit: async (start: () => void) => {
    start();
  },
});

/**
 * Wait the requested interval for concurrent authorization tests.
 */
export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Expose explicit resolve/reject controls for an in-flight promise.
 */
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};

/**
 * Build a synthetic authorized node request with isolated overrides.
 */
export const request = (
  changes: Partial<AuthorizedErgoSubmission> = {},
): AuthorizedErgoSubmission => ({
  baseUrl: 'https://fixture.invalid/prefix',
  target: 'node',
  body: 'abcd',
  timeoutMs: 1000,
  /**
   * Start submission immediately when authorization is requested.
   */
  authorizeSubmit: async (start) => {
    start();
  },
  ...changes,
});
