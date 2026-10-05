import { describe, expect, it, vi } from 'vitest';

import type { SolanaRpcRequest } from '@rosen-chains/solana';

import { SolanaRpcNetwork } from '../lib/solanaRpcNetwork';
import {
  failedSignatureStatusResult,
  missingSignatureStatusResult,
  validSignatureStatusResult,
} from './solanaRpcNetworkTestData';
import {
  makeMockNetwork,
  makeRawMockNetwork,
  rawStatusResponse,
} from './solanaRpcNetworkTestUtils';

describe('SolanaRpcNetwork', () => {
  describe('getSignatureStatus', () => {
    /**
     * @target SolanaRpcNetwork.getSignatureStatus
     * returns one validated status and searches transaction history
     * @dependencies
     * - correlated mocked JSON-RPC transport
     * @scenario
     * - the provider returns one finalized transaction with an execution error
     * @expected
     * - preserve the transaction slot, confirmation fields, and error payload.
     */
    it('returns one validated status and searches transaction history', async () => {
      const requests: SolanaRpcRequest[] = [];
      const network = makeMockNetwork((request) => {
        requests.push(request);
        return failedSignatureStatusResult;
      });
      await expect(network.getSignatureStatus('sig')).resolves.toEqual({
        slot: 98,
        confirmations: null,
        confirmationStatus: 'finalized',
        err: { InstructionError: [0, 'Custom'] },
      });
      expect(requests).toEqual([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [['sig'], { searchTransactionHistory: true }],
        },
      ]);
    });

    /**
     * @target SolanaRpcNetwork.getSignatureStatus
     * returns null for an absent transaction status
     * @dependencies
     * - mocked JSON-RPC response with a null status entry
     * @scenario
     * - the requested signature has no available status
     * @expected
     * - return null without converting absence into confirmation policy.
     */
    it('returns null for an absent transaction status', async () => {
      const network = makeMockNetwork(() => missingSignatureStatusResult);
      await expect(network.getSignatureStatus('sig')).resolves.toBeNull();
    });

    /**
     * @target SolanaRpcNetwork.getSignatureStatus
     * rejects one malformed confirmation status
     * @dependencies
     * - otherwise valid single-status response
     * @scenario
     * - confirmationStatus is outside the three Solana RPC values
     * @expected
     * - reject the status as invalid.
     */
    it('rejects one malformed confirmation status', async () => {
      const network = makeMockNetwork(() => ({
        context: { slot: 100 },
        value: [
          {
            slot: 98,
            confirmations: 3,
            confirmationStatus: 'rooted',
            err: null,
          },
        ],
      }));
      await expect(network.getSignatureStatus('sig')).rejects.toThrow(
        'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
      );
    });

    /**
     * @target SolanaRpcNetwork.getSignatureStatus
     * rejects a response correlated to another request
     * @dependencies
     * - mocked raw JSON-RPC transport
     * @scenario
     * - the response id differs from the generated request id
     * @expected
     * - reject the mismatched envelope.
     */
    it('rejects a mismatched JSON-RPC response id', async () => {
      const network = makeRawMockNetwork(
        () =>
          '{"jsonrpc":"2.0","id":99,"result":{"context":{"slot":1},"value":[null]}}',
      );
      await expect(network.getSignatureStatus('sig')).rejects.toThrow(
        'SOLANA_RPC_ID_MISMATCH',
      );
    });

    /**
     * @target SolanaRpcNetwork.getSignatureStatus
     * propagates a JSON-RPC error response
     * @dependencies
     * - mocked correlated JSON-RPC error envelope
     * @scenario
     * - the endpoint returns an error instead of a result
     * @expected
     * - reject the response without fabricating a missing status.
     */
    it('propagates a JSON-RPC error response', async () => {
      const network = makeRawMockNetwork(
        () =>
          '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"fixture"}}',
      );
      await expect(network.getSignatureStatus('sig')).rejects.toThrow(
        'SOLANA_RPC_ERROR_RESPONSE',
      );
    });
  });

  describe('getHeight', () => {
    /**
     * @target SolanaRpcNetwork.getHeight
     * uses correlated finalized getBlockHeight JSON-RPC requests
     * @dependencies
     * - mocked JSON-RPC transport
     * @scenario
     * - getHeight is called once
     * @expected
     * - send a correlated finalized request and return its safe height.
     */
    it('uses correlated finalized getBlockHeight JSON-RPC requests', async () => {
      const requests: SolanaRpcRequest[] = [];
      const network = makeMockNetwork((request) => {
        requests.push(request);
        return 42;
      });
      await expect(network.getHeight()).resolves.toEqual(42);
      expect(requests).toEqual([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBlockHeight',
          params: [{ commitment: 'finalized' }],
        },
      ]);
    });

    /**
     * @target SolanaRpcNetwork.getHeight
     * rejects non-integer raw height token %s
     * @dependencies
     * - raw synthetic JSON-RPC response
     * @scenario
     * - a fractional token rounds to a safe integer when parsed by JavaScript
     * @expected
     * - reject the original token.
     */
    it.each(['1.00000000000000001', '1e0', '-0'])(
      'rejects non-integer raw height token %s',
      async (height) => {
        const network = makeRawMockNetwork(
          () => `{"jsonrpc":"2.0","id":1,"result":${height}}`,
        );
        await expect(network.getHeight()).rejects.toThrow(
          'SOLANA_RPC_INVALID_BLOCK_HEIGHT',
        );
      },
    );

    /**
     * @target SolanaRpcNetwork.getHeight
     * rejects a mismatched JSON-RPC response id
     * @dependencies
     * - mocked raw transport
     * @scenario
     * - response ID differs from the request
     * @expected
     * - reject the mismatched envelope.
     */
    it('rejects a mismatched JSON-RPC response id', async () => {
      const network = new SolanaRpcNetwork({
        context: {} as never,
        locateBlock: async () => undefined,
        transport: async () => '{"jsonrpc":"2.0","id":99,"result":1}',
      });
      await expect(network.getHeight()).rejects.toThrow(
        'SOLANA_RPC_ID_MISMATCH',
      );
    });

    /**
     * @target SolanaRpcNetwork.getHeight
     * rejects duplicate keys and oversized raw responses
     * @dependencies
     * - mocked raw transport
     * @scenario
     * - a duplicate key or response over one mebibyte is returned
     * @expected
     * - reject before decoding the result.
     */
    it('rejects duplicate keys and oversized raw responses', async () => {
      const duplicateNetwork = new SolanaRpcNetwork({
        context: {} as never,
        locateBlock: async () => undefined,
        transport: async () => '{"jsonrpc":"2.0","id":1,"result":1,"result":2}',
      });
      await expect(duplicateNetwork.getHeight()).rejects.toThrow(
        'SOLANA_RPC_DUPLICATE_JSON_KEY',
      );
      const oversized = new SolanaRpcNetwork({
        context: {} as never,
        locateBlock: async () => undefined,
        transport: async () =>
          `{"jsonrpc":"2.0","id":1,"result":"${'x'.repeat(1_048_577)}"}`,
      });
      await expect(oversized.getHeight()).rejects.toThrow(
        'SOLANA_RPC_RESPONSE_TOO_LARGE',
      );
    });
  });

  describe('getTxConfirmation', () => {
    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * maps valid signature confirmations and missing/error statuses
     * @dependencies
     * - official-shaped signature status fixtures
     * @scenario
     * - status is confirmed, absent, or on-chain failed
     * @expected
     * - retain numeric confirmations and map absent/error results to -1.
     */
    it('maps valid signature confirmations and missing/error statuses', async () => {
      const network = makeMockNetwork(() => validSignatureStatusResult);
      await expect(network.getTxConfirmation('sig')).resolves.toEqual(3);
      const missing = makeMockNetwork(() => missingSignatureStatusResult);
      await expect(missing.getTxConfirmation('sig')).resolves.toEqual(-1);
      const failed = makeMockNetwork(() => failedSignatureStatusResult);
      await expect(failed.getTxConfirmation('sig')).resolves.toEqual(-1);
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * preserves the existing finalized null-confirmation fallback
     * @dependencies
     * - one valid finalized status with no numeric confirmations
     * @scenario
     * - the status is successful, finalized, and has null confirmations
     * @expected
     * - retain the current numeric result of one.
     */
    it('preserves the existing finalized null-confirmation fallback', async () => {
      const network = makeMockNetwork(() => ({
        context: { slot: 100 },
        value: [
          {
            slot: 98,
            confirmations: null,
            confirmationStatus: 'finalized',
            err: null,
          },
        ],
      }));
      await expect(network.getTxConfirmation('sig')).resolves.toEqual(1);
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects a bare signature status array
     * @dependencies
     * - raw mocked JSON-RPC values
     * @scenario
     * - the official result carrier is replaced by a bare value array
     * @expected
     * - reject the malformed result shape.
     */
    it('rejects a bare signature status array', async () => {
      const network = makeMockNetwork(() => [
        validSignatureStatusResult.value[0],
      ]);
      await expect(network.getTxConfirmation('sig')).rejects.toThrow(
        'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
      );
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * accepts a unit-variant transaction error string
     * @dependencies
     * - valid status with a unit-variant TransactionError
     * @scenario
     * - Solana reports AccountNotFound as a string
     * @expected
     * - preserve failed-transaction mapping to minus one.
     */
    it('accepts a unit-variant transaction error string', async () => {
      const network = makeMockNetwork(() => ({
        context: { slot: 100 },
        value: [
          { ...validSignatureStatusResult.value[0], err: 'AccountNotFound' },
        ],
      }));
      await expect(network.getTxConfirmation('sig')).resolves.toEqual(-1);
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects malformed transaction error %j
     * @dependencies
     * - one changed field in an otherwise valid status
     * @scenario
     * - err is a boolean, number or array instead of object, unit-variant string or null
     * @expected
     * - reject provider corruption as an invalid status.
     */
    it.each([false, true, 0, []])(
      'rejects malformed transaction error %j',
      async (err) => {
        const network = makeMockNetwork(() => ({
          context: { slot: 100 },
          value: [{ ...validSignatureStatusResult.value[0], err }],
        }));
        await expect(network.getTxConfirmation('sig')).rejects.toThrow(
          'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
        );
      },
    );

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects a missing status context
     * @dependencies
     * - synthetic status result
     * @scenario
     * - context is missing
     * @expected
     * - reject before reading signature status.
     */
    it('rejects a missing status context', async () => {
      const network = makeMockNetwork(() => ({ value: [null] }));
      await expect(network.getTxConfirmation('sig')).rejects.toThrow(
        'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
      );
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects an unsafe context slot
     * @dependencies
     * - synthetic status result
     * @scenario
     * - context slot exceeds Number.MAX_SAFE_INTEGER
     * @expected
     * - reject the unsafe integer.
     */
    it('rejects an unsafe context slot', async () => {
      const network = makeMockNetwork(() => ({
        context: { slot: Number.MAX_SAFE_INTEGER + 1 },
        value: [null],
      }));
      await expect(network.getTxConfirmation('sig')).rejects.toThrow(
        'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
      );
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects a signature status list with the wrong length
     * @dependencies
     * - synthetic status result
     * @scenario
     * - value has no entry for the one requested signature
     * @expected
     * - reject the incomplete result.
     */
    it('rejects a signature status list with the wrong length', async () => {
      const network = makeMockNetwork(() => ({
        context: { slot: 100 },
        value: [],
      }));
      await expect(network.getTxConfirmation('sig')).rejects.toThrow(
        'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
      );
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects two valid statuses for one requested signature
     * @dependencies
     * - two otherwise valid statuses
     * @scenario
     * - the provider returns more entries than the single requested signature
     * @expected
     * - reject at the cardinality check rather than consume the first entry.
     */
    it('rejects two valid statuses for one requested signature', async () => {
      const network = makeMockNetwork(() => ({
        context: { slot: 100 },
        value: [
          validSignatureStatusResult.value[0],
          validSignatureStatusResult.value[0],
        ],
      }));
      await expect(network.getTxConfirmation('sig')).rejects.toThrow(
        'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
      );
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects a status with missing %s
     * @dependencies
     * - valid synthetic result with one removed field
     * @scenario
     * - status slot, confirmations, confirmationStatus, or err is missing
     * @expected
     * - reject each isolated incomplete status.
     */
    it.each(['slot', 'confirmations', 'confirmationStatus', 'err'] as const)(
      'rejects a status with missing %s',
      async (field) => {
        const status = {
          ...validSignatureStatusResult.value[0],
        } as Record<string, unknown>;
        delete status[field];
        const network = makeMockNetwork(() => ({
          context: { slot: 100 },
          value: [status],
        }));
        await expect(network.getTxConfirmation('sig')).rejects.toThrow(
          'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
        );
      },
    );

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects invalid status slot %s
     * @dependencies
     * - synthetic status result
     * @scenario
     * - status slot is negative or unsafe
     * @expected
     * - reject each malformed slot.
     */
    it.each([-1, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid status slot %s',
      async (slot) => {
        const network = makeMockNetwork(() => ({
          context: { slot: 100 },
          value: [{ ...validSignatureStatusResult.value[0], slot }],
        }));
        await expect(network.getTxConfirmation('sig')).rejects.toThrow(
          'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
        );
      },
    );

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects a non-integer raw %s token
     * @dependencies
     * - raw synthetic JSON-RPC response
     * @scenario
     * - context slot, status slot, or confirmations contain a fraction that rounds to a safe integer
     * @expected
     * - reject the original token before JavaScript conversion.
     */
    it.each([
      ['context slot', '1.00000000000000001', '98', '3'],
      ['status slot', '100', '1.00000000000000001', '3'],
      ['confirmations', '100', '98', '9007199254740990.5'],
      ['exponent confirmation', '100', '98', '1e0'],
      ['negative zero status slot', '100', '-0', '3'],
    ])(
      'rejects a non-integer raw %s token',
      async (_field, contextSlot, statusSlot, confirmations) => {
        const network = makeRawMockNetwork(() =>
          rawStatusResponse(contextSlot, statusSlot, confirmations),
        );
        await expect(network.getTxConfirmation('sig')).rejects.toThrow(
          'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
        );
      },
    );

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects invalid confirmations %s
     * @dependencies
     * - synthetic status result
     * @scenario
     * - confirmations is negative or unsafe
     * @expected
     * - reject each malformed count.
     */
    it.each([-1, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid confirmations %s',
      async (confirmations) => {
        const network = makeMockNetwork(() => ({
          context: { slot: 100 },
          value: [{ ...validSignatureStatusResult.value[0], confirmations }],
        }));
        await expect(network.getTxConfirmation('sig')).rejects.toThrow(
          'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
        );
      },
    );

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * rejects an unknown confirmation status
     * @dependencies
     * - synthetic status result
     * @scenario
     * - a non-null status uses an unsupported confirmation label
     * @expected
     * - reject the malformed label.
     */
    it('rejects an unknown confirmation status', async () => {
      const network = makeMockNetwork(() => ({
        context: { slot: 100 },
        value: [
          {
            ...validSignatureStatusResult.value[0],
            confirmationStatus: 'rooted',
          },
        ],
      }));
      await expect(network.getTxConfirmation('sig')).rejects.toThrow(
        'SOLANA_RPC_INVALID_SIGNATURE_STATUS',
      );
    });

    /**
     * @target SolanaRpcNetwork.getTxConfirmation
     * maps finalized without a count to one
     * @dependencies
     * - official-shaped status without a numeric count
     * @scenario
     * - confirmationStatus is finalized and confirmations is null
     * @expected
     * - keep the existing numeric mapping of one while Rosen policy remains unresolved.
     */
    it('maps finalized without a count to one', async () => {
      const network = makeMockNetwork(() => ({
        context: { slot: 100 },
        value: [
          {
            ...validSignatureStatusResult.value[0],
            confirmations: null,
            confirmationStatus: 'finalized',
          },
        ],
      }));
      await expect(network.getTxConfirmation('sig')).resolves.toEqual(1);
      const processed = makeMockNetwork(() => ({
        context: { slot: 100 },
        value: [
          {
            ...validSignatureStatusResult.value[0],
            confirmations: null,
            confirmationStatus: 'processed',
          },
        ],
      }));
      await expect(processed.getTxConfirmation('sig')).resolves.toEqual(-1);
    });
  });

  describe('getBlockTransactionIds/getBlockInfo/getTransaction', () => {
    /**
     * @target SolanaRpcNetwork.getBlockTransactionIds/getBlockInfo/getTransaction
     * delegates block reads to a request-bound session
     * @dependencies
     * - mocked event read session
     * @scenario
     * - block IDs and transaction IDs are requested
     * @expected
     * - preserve locator hash and delegate each request unchanged.
     */
    it('delegates block reads to a request-bound session', async () => {
      const network = makeMockNetwork(() => null);
      const session = {
        getBlockTransactionIds: vi.fn(async (blockhash: string) => [
          blockhash + '-tx',
        ]),
        getBlockInfo: vi.fn(async (blockhash: string) => ({
          hash: blockhash,
          parentHash: 'parent',
          height: 3,
        })),
        getTransaction: vi.fn(async (signature: string) => ({
          observedSignature: signature,
        })),
      };
      vi.spyOn(network, 'createEventReadSession').mockResolvedValue(
        session as never,
      );
      await expect(network.getBlockTransactionIds('block')).resolves.toEqual([
        'block-tx',
      ]);
      await expect(network.getBlockInfo('block')).resolves.toEqual({
        hash: 'block',
        parentHash: 'parent',
        height: 3,
      });
      await expect(network.getTransaction('sig', 'block')).resolves.toEqual({
        observedSignature: 'sig',
      });
      expect(session.getBlockTransactionIds).toHaveBeenCalledWith('block');
      expect(session.getBlockInfo).toHaveBeenCalledWith('block');
      expect(session.getTransaction).toHaveBeenCalledWith('sig', 'block');
    });
  });

  describe('getMempoolTransactions/submitTransaction', () => {
    /**
     * @target SolanaRpcNetwork.getMempoolTransactions/submitTransaction
     * fails closed for ordinary operations
     * @dependencies
     * - mocked provider
     * @scenario
     * - mempool and submission methods are invoked
     * @expected
     * - both unsupported operations fail closed.
     */
    it('fails closed for ordinary operations', async () => {
      const network = makeMockNetwork(() => null);
      await expect(network.getMempoolTransactions()).rejects.toThrow(
        'SOLANA_RPC_OPERATION_UNSUPPORTED',
      );
      await expect(network.submitTransaction()).rejects.toThrow(
        'SOLANA_RPC_OPERATION_UNSUPPORTED',
      );
    });
  });

  describe('getAddressAssets/getTokenDetail', () => {
    /**
     * @target SolanaRpcNetwork.getAddressAssets/getTokenDetail
     * rejects asset reads without a captured network profile
     * @dependencies
     * - provider fixture lacking its resolved profile, canonical wallet and native token ID
     * @scenario
     * - request supported asset methods without a captured network identity
     * @expected
     * - fail closed with an unavailable request whose cause identifies the missing configuration.
     */
    it('rejects asset reads without a captured network profile', async () => {
      const network = makeMockNetwork(() => null);
      const expected = {
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: 'SOLANA_ASSET_EXPECTED_GENESIS_INVALID' },
      };
      await expect(
        network.getAddressAssets('11111111111111111111111111111111'),
      ).rejects.toMatchObject(expected);
      await expect(network.getTokenDetail('sol')).rejects.toMatchObject(
        expected,
      );
    });
  });

  describe('constructor', () => {
    /**
     * @target SolanaRpcNetwork.constructor
     * rejects endpoint credentials and non-http schemes
     * @dependencies
     * - constructor options
     * @scenario
     * - URL includes credentials or uses a non-HTTP scheme
     * @expected
     * - reject both endpoint forms.
     */
    it('rejects endpoint credentials and non-http schemes', () => {
      const options = {
        context: {} as never,
        locateBlock: async () => undefined,
      };
      expect(
        () =>
          new SolanaRpcNetwork({
            ...options,
            url: 'https://user:password@example.test/rpc',
          }),
      ).toThrow('INVALID_SOLANA_RPC_ENDPOINT');
      expect(
        () => new SolanaRpcNetwork({ ...options, url: 'file:///tmp/rpc' }),
      ).toThrow('INVALID_SOLANA_RPC_ENDPOINT');
    });
  });
});
