import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  SolanaEventContext,
  SolanaRpcRequest,
} from '@rosen-chains/solana';

import { SolanaRpcNetwork } from '../lib/solanaRpcNetwork';

/** Configure a synthetic provider without parsing the scripted raw JSON text. */
export const makeRawMockNetwork = (
  transport: (request: SolanaRpcRequest) => string,
) =>
  new SolanaRpcNetwork({
    context: {} as SolanaEventContext,
    locateBlock: async () => undefined,
    transport: async (request) => transport(request),
  });

/** Return one status response whose numeric tokens keep their exact spelling. */
export const rawStatusResponse = (
  contextSlot: string,
  statusSlot: string,
  confirmations: string,
) =>
  `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":${contextSlot}},"value":[{"slot":${statusSlot},"confirmations":${confirmations},"confirmationStatus":"confirmed","err":null}]}}`;

/** Serialize one synthetic JSON-RPC response for a captured request id. */
export const rpcResponse = (id: number, result: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, result });

/** Create a mocked provider whose transport returns only synthetic RPC data. */
export const makeMockNetwork = (
  handler: (request: SolanaRpcRequest) => unknown,
) =>
  new SolanaRpcNetwork({
    context: {} as SolanaEventContext,
    locateBlock: async (blockhash) => ({
      genesisHash: 'genesis',
      blockhash,
      slot: 7,
      blockHeight: 3,
      parentHash: 'parent',
    }),
    transport: async (request) => rpcResponse(request.id, handler(request)),
  });

/** Start a local HTTP fixture that returns the exact supplied response text. */
export const startLocalRpcServer = async (
  respond: (requestBody: string) => string,
) => {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(respond(body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('SOLANA_RPC_TEST_SERVER_ADDRESS_MISSING');
  const url = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return {
    url,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
