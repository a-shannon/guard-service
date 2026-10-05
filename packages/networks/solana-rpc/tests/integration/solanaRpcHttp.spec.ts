import { describe, expect, it } from 'vitest';

import type {
  SolanaEventContext,
  SolanaRpcRequest,
} from '@rosen-chains/solana';

import { SolanaRpcNetwork } from '../../lib/solanaRpcNetwork';
import { validSignatureStatusResult } from '../solanaRpcNetworkTestData';
import { startLocalRpcServer } from '../solanaRpcNetworkTestUtils';

describe('SolanaRpcNetwork HTTP integration', () => {
  /** Target: default Axios RPC transport. Dependencies: local loopback HTTP fixture only. Scenario: the server returns a duplicate key inside getSignatureStatuses. Expected: preserve raw bytes so duplicate-key validation rejects the response; no public RPC endpoint is contacted. */
  it('preserves raw loopback HTTP text for duplicate-key rejection', async () => {
    const server = await startLocalRpcServer(
      () =>
        '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":100},"value":[{"slot":98,"slot":99,"confirmations":3,"confirmationStatus":"confirmed","err":null}]}}',
    );
    try {
      const network = new SolanaRpcNetwork({
        context: {} as SolanaEventContext,
        locateBlock: async () => undefined,
        url: server.url,
      });
      await expect(network.getTxConfirmation('sig')).rejects.toThrow(
        'SOLANA_RPC_DUPLICATE_JSON_KEY',
      );
    } finally {
      await server.close();
    }
  });

  /** Target: default Axios getSignatureStatuses request and response contract. Dependencies: local loopback HTTP fixture and official-shaped result. Scenario: the server echoes the request ID and one valid status. Expected: return its confirmation count and send the exact single-signature request parameters; no public RPC endpoint is contacted. */
  it('reads an official-shaped status through the default HTTP client', async () => {
    const requests: SolanaRpcRequest[] = [];
    const server = await startLocalRpcServer((requestBody) => {
      const request = JSON.parse(requestBody) as SolanaRpcRequest;
      requests.push(request);
      return JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: validSignatureStatusResult,
      });
    });
    try {
      const network = new SolanaRpcNetwork({
        context: {} as SolanaEventContext,
        locateBlock: async () => undefined,
        url: server.url,
      });
      await expect(network.getTxConfirmation('sig')).resolves.toBe(3);
      expect(requests).toEqual([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [['sig'], { searchTransactionHistory: true }],
        },
      ]);
    } finally {
      await server.close();
    }
  });

  /** Target: default Axios RPC transport and exact integer validation. Dependencies: local loopback HTTP fixture only. Scenario: a fractional response rounds to a safe JavaScript integer. Expected: preserve raw text and reject the original token; no public RPC endpoint is contacted. */
  it('preserves and rejects rounded fractional loopback HTTP numbers', async () => {
    const server = await startLocalRpcServer(
      () => '{"jsonrpc":"2.0","id":1,"result":1.00000000000000001}',
    );
    try {
      const network = new SolanaRpcNetwork({
        context: {} as SolanaEventContext,
        locateBlock: async () => undefined,
        url: server.url,
      });
      await expect(network.getHeight()).rejects.toThrow(
        'SOLANA_RPC_INVALID_BLOCK_HEIGHT',
      );
    } finally {
      await server.close();
    }
  });
});
