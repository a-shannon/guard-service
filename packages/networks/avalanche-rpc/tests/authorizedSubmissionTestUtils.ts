import { FetchRequest, Signature, Transaction, toUtf8Bytes } from 'ethers';
import { vi } from 'vitest';

import { DataSource } from '@rosen-bridge/extended-typeorm';

import { submitAuthorizedAvalanche } from '../lib/authorizedSubmission';
import AvalancheRpcNetwork from '../lib/avalancheRpcNetwork';
import { closeSubmissionHttp } from './mocked/authorizedHttp.mock';
import { mockResponseTransport } from './mocked/authorizedTransport.mock';

/** Build a deterministic protected transaction from public synthetic signature fields. */
export const signed = () =>
  Transaction.from({
    type: 2,
    chainId: 43113n,
    to: '0x' + '11'.repeat(20),
    nonce: 7,
    value: 31n,
    data: '0xabcd',
    gasLimit: 30000n,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 2n,
    signature: Signature.from({
      r: '0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      s: '0x' + '22'.repeat(32),
      yParity: 0,
    }),
  });
/** Allow asynchronous fixture callbacks to advance for the requested duration. */
export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
/** Build a manually released promise for one delayed preflight/authority stage. */
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
/** Encode a successful synthetic JSON-RPC response for the selected transaction hash. */
export const ok = (hash = signed().hash) => ({
  statusCode: 200,
  statusMessage: 'OK',
  headers: {},
  body: toUtf8Bytes(JSON.stringify({ jsonrpc: '2.0', id: 1, result: hash })),
});
/** Build an SDK request with a mocked successful submission transport. */
export const connection = () => {
  const request = new FetchRequest('https://fixture.invalid/rpc/token');
  request.timeout = 1000;
  request.getUrlFunc = mockResponseTransport();
  return request;
};
/** Invoke the real qualified helper with a synthetic protected transaction and callback fixtures. */
export const call = (
  request: FetchRequest,
  authorize: (start: () => void) => Promise<void> = async (start) => start(),
  before: () => Promise<void> = async () => undefined,
  fresh = () => undefined,
) =>
  submitAuthorizedAvalanche(
    request,
    signed().serialized,
    43113n,
    authorize,
    before,
    fresh,
  );

const networks: AvalancheRpcNetwork[] = [];
/** Build a real RPC adapter and track its provider for cleanup. */
export const network = (
  url = 'https://fixture.invalid/rpc',
  timeout = 1000,
) => {
  const result = new AvalancheRpcNetwork(
    url,
    { getRepository: () => ({}) } as unknown as DataSource,
    '0x' + '11'.repeat(20),
    43113n,
    'avalanche-lock-address',
    timeout,
  );
  networks.push(result);
  return result;
};

/** Restore method spies and close all providers/listeners created by submission fixtures. */
export const closeSubmissionFixtures = async () => {
  vi.restoreAllMocks();
  networks.splice(0).forEach((network) => network['provider'].destroy());
  await closeSubmissionHttp();
};
export { listen } from './mocked/authorizedHttp.mock';
