import { TssSigningKey } from '../../src/signing/tssAuthorizationRegistry';

/** Canonical synthetic ECDSA key used by authorization-registry controls. */
export const registryKey: TssSigningKey = {
  algorithm: 'ecdsa',
  chainCode: 'SyntheticChainCode',
  derivationPath: [44, 60, 0, 0],
};
/** Digest bound to the registry's synthetic key. */
export const registryIdentity = { ...registryKey, message: 'ab'.repeat(32) };
/** Distinct synthetic signing-context key. */
export const contextKey = {
  algorithm: 'ecdsa' as const,
  chainCode: 'SyntheticChainCode',
  derivationPath: [44, 60],
};
/** Context digest used for local authorization without signing material. */
export const contextMessage = 'ab'.repeat(32);
/** Independent digests used by actual installed signer-adapter controls. */
export const signerMessage = '11'.repeat(32);
export const nextSignerMessage = '22'.repeat(32);
/** Synthetic peer identity for mocked transport and detection. */
export const signerGuard = {
  publicKey: 'fixture-guard',
  peerId: 'fixture-peer',
  index: 0,
};
