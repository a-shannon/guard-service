import {
  QualifiedEcdsaSigner,
  QualifiedEddsaSigner,
  QualifiedTssOptions,
  TssAuthorizationPolicy,
} from '../../src/signing/qualifiedTssSigner';
import { createSignerConfig } from './mocked/qualifiedTssSigner.mock';
import {
  signerGuard as guard,
  signerMessage as message,
} from './signingTestData';
import { tick } from './signingTestUtils';

/** Construct an actual installed signer adapter with explicitly mocked external dependencies. */
export const makeSigner = (
  policy: TssAuthorizationPolicy,
  submit: ReturnType<typeof vi.fn>,
  algorithm: 'ecdsa' | 'eddsa' = 'ecdsa',
  overrides: Partial<QualifiedTssOptions> = {},
) => {
  const options = {
    policy,
    signingTimeoutMs: 150,
    httpTimeoutMs: 40,
    maxPending: 4,
    ...overrides,
  };
  return algorithm === 'ecdsa'
    ? new QualifiedEcdsaSigner(createSignerConfig(submit), options)
    : new QualifiedEddsaSigner(createSignerConfig(submit), options);
};
/** Queue real signer work and retain both outcomes for teardown. */
export const queueSigner = (
  pending: Promise<unknown>[],
  signer: ReturnType<typeof makeSigner>,
  algorithm = 'ecdsa',
  msg = message,
) => {
  const result = signer.signPromised(
    msg,
    'fixture-chain',
    algorithm === 'ecdsa' ? [44, 60] : undefined,
  );
  const outcome = result.then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  pending.push(outcome);
  return { result, outcome };
};
/** Exercise the real protected outbound hook through the mocked transport boundary. */
export const emit = async (
  signer: ReturnType<typeof makeSigner>,
  type: string,
  msg = message,
  extra = {},
) => {
  await signer['sendMessage'](type, { msg, ...extra }, [guard.peerId]);
  await tick();
};
