import { AxiosHeaders } from 'axios';

import { SignerConfig } from '@rosen-bridge/tss';

import { signerGuard as guard } from '../signingTestData';

/** Mock the HTTP adapter only; installed signer and authorization code remain real. */
export const createTransport = () =>
  vi.fn(async (config) => ({
    data: {},
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    config,
  }));
/** Create external message/detection dependencies without network or key material. */
export const createSignerConfig = (
  submit: ReturnType<typeof vi.fn>,
): SignerConfig => ({
  tssApiUrl: 'http://127.0.0.1:1',
  callbackUrl: 'http://127.0.0.1:1',
  guardsPk: [guard.publicKey],
  shares: ['fixture-share'],
  getPeerId: async () => guard.peerId,
  messageEnc: {
    getPk: async () => guard.publicKey,
    sign: async () => 'fixture-envelope-signature',
    verify: async () => true,
  } as unknown as SignerConfig['messageEnc'],
  detection: {
    activeGuards: async () => [guard],
  } as unknown as SignerConfig['detection'],
  submitMsg: submit,
  timeoutSeconds: 10,
});
