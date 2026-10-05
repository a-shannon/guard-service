import { describe, expect, it } from 'vitest';

import {
  createRpcCaller,
  integerValue,
  parseJson,
  readU64Value,
  response,
  type SolanaRpcRequest,
} from '../lib/solanaRpcProtocol';

const validEnvelope = (fields = '') =>
  `{"jsonrpc":"2.0","id":7,"result":0${fields}}`;

describe('solanaRpcProtocol', () => {
  describe('response', () => {
    /** Target: response request identity. Dependencies: raw JSON-RPC envelope. Scenario: numeric response id differs from the request. Expected: reject with the stable mismatch code. */
    it('rejects a mismatched numeric request id', () => {
      expect(() => response('{"jsonrpc":"2.0","id":8,"result":0}', 7)).toThrow(
        'SOLANA_RPC_ID_MISMATCH',
      );
    });

    /** Target: response request identity. Dependencies: raw JSON-RPC envelope. Scenario: response id is a string containing the expected digits. Expected: reject without coercion. */
    it('rejects a string request id without coercion', () => {
      expect(() =>
        response('{"jsonrpc":"2.0","id":"7","result":0}', 7),
      ).toThrow('SOLANA_RPC_ID_MISMATCH');
    });

    /** Target: response request identity. Dependencies: raw JSON-RPC envelope. Scenario: response id uses a fractional numeric lexeme equal in JavaScript value. Expected: reject the non-exact integer spelling. */
    it('rejects a fractional request id lexeme', () => {
      expect(() =>
        response('{"jsonrpc":"2.0","id":7.0,"result":0}', 7),
      ).toThrow('SOLANA_RPC_ID_MISMATCH');
    });

    /** Target: response protocol version. Dependencies: raw JSON-RPC envelope. Scenario: the version is not 2.0. Expected: reject with the version mismatch code. */
    it('rejects a wrong JSON-RPC version', () => {
      expect(() => response('{"jsonrpc":"1.0","id":7,"result":0}', 7)).toThrow(
        'SOLANA_RPC_VERSION_MISMATCH',
      );
    });

    /** Target: response envelope shape. Dependencies: raw JSON-RPC envelope. Scenario: required result member is absent. Expected: reject as an invalid envelope. */
    it('rejects a missing result member', () => {
      expect(() => response('{"jsonrpc":"2.0","id":7}', 7)).toThrow(
        'SOLANA_RPC_INVALID_ENVELOPE',
      );
    });

    /** Target: response envelope shape. Dependencies: raw JSON-RPC envelope. Scenario: an undeclared member is present. Expected: reject as an invalid envelope. */
    it('rejects an extra envelope member', () => {
      expect(() => response(validEnvelope(',"extra":true'), 7)).toThrow(
        'SOLANA_RPC_INVALID_ENVELOPE',
      );
    });

    /** Target: response error handling. Dependencies: raw JSON-RPC envelope. Scenario: both result and error members are present. Expected: reject the error response. */
    it('rejects an error member even when result is present', () => {
      expect(() => response(validEnvelope(',"error":{"code":-1}'), 7)).toThrow(
        'SOLANA_RPC_ERROR_RESPONSE',
      );
    });

    /** Target: response JSON integrity. Dependencies: raw JSON-RPC envelope. Scenario: an envelope key occurs twice. Expected: reject before interpreting either value. */
    it('rejects a duplicate envelope key before interpreting it', () => {
      expect(() =>
        response('{"jsonrpc":"2.0","id":7,"id":7,"result":0}', 7),
      ).toThrow('SOLANA_RPC_DUPLICATE_JSON_KEY');
    });

    /** Target: response envelope root. Dependencies: raw JSON. Scenario: root value is an array. Expected: reject as an invalid envelope. */
    it('rejects a non-object root', () => {
      expect(() => response('[]', 7)).toThrow('SOLANA_RPC_INVALID_ENVELOPE');
    });

    /** Target: response JSON integrity. Dependencies: raw JSON-RPC envelope. Scenario: non-whitespace bytes follow a complete envelope. Expected: reject trailing invalid JSON. */
    it('rejects trailing invalid JSON after a valid envelope', () => {
      expect(() => response(`${validEnvelope()}x`, 7)).toThrow(
        'SOLANA_RPC_INVALID_JSON',
      );
    });
  });

  describe('createRpcCaller', () => {
    /** Target: immutable request construction and request IDs. Dependencies: two caller-owned transports. Scenario: callers send several requests independently. Expected: each request and params array is frozen, IDs start independently and increase, and request fields are exact. */
    it('freezes request parameters and allocates independent monotonic ids', async () => {
      const firstRequests: SolanaRpcRequest[] = [];
      const secondRequests: SolanaRpcRequest[] = [];
      const makeTransport =
        (captured: SolanaRpcRequest[]) => async (request: SolanaRpcRequest) => {
          captured.push(request);
          return `{"jsonrpc":"2.0","id":${request.id},"result":null}`;
        };
      const firstCaller = createRpcCaller(makeTransport(firstRequests));
      const secondCaller = createRpcCaller(makeTransport(secondRequests));

      await firstCaller('getBalance', [
        'wallet-a',
        { commitment: 'finalized' },
      ]);
      await firstCaller('getBlockHeight', []);
      await secondCaller('getBalance', ['wallet-b']);

      expect(firstRequests.map(({ id }) => id)).toEqual([1, 2]);
      expect(secondRequests.map(({ id }) => id)).toEqual([1]);
      for (const request of [...firstRequests, ...secondRequests]) {
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.params)).toBe(true);
      }
      expect(firstRequests[0]).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: ['wallet-a', { commitment: 'finalized' }],
      });
    });

    /** Target: request immutability. Dependencies: caller-owned transport. Scenario: transport inspects the request object upon receipt. Expected: request object is already frozen. */
    it('freezes the request object before transport receives it', async () => {
      let received: SolanaRpcRequest | undefined;
      const call = createRpcCaller(async (request) => {
        received = request;
        return `{"jsonrpc":"2.0","id":${request.id},"result":null}`;
      });
      await call('getBalance', ['wallet-a']);
      expect(received).toBeDefined();
      expect(Object.isFrozen(received)).toBe(true);
    });

    /** Target: params immutability. Dependencies: caller-owned transport. Scenario: transport inspects the params array upon receipt. Expected: params are already frozen. */
    it('freezes the params array before transport receives it', async () => {
      let received: SolanaRpcRequest | undefined;
      const call = createRpcCaller(async (request) => {
        received = request;
        return `{"jsonrpc":"2.0","id":${request.id},"result":null}`;
      });
      await call('getBalance', ['wallet-a']);
      expect(received).toBeDefined();
      expect(Object.isFrozen(received?.params)).toBe(true);
    });

    /** Target: caller-local request IDs. Dependencies: one caller-owned transport. Scenario: two sequential calls use one caller. Expected: IDs are independently allocated in monotonic order. */
    it('allocates monotonic request ids per caller', async () => {
      const ids: number[] = [];
      const call = createRpcCaller(async (request) => {
        ids.push(request.id);
        return `{"jsonrpc":"2.0","id":${request.id},"result":null}`;
      });
      await call('getBalance', []);
      await call('getBlockHeight', []);
      expect(ids).toEqual([1, 2]);
    });
  });

  describe('readU64Value', () => {
    /** Target: unsigned 64-bit integer decoding. Dependencies: bounded JSON parser. Scenario: minimum and maximum u64 tokens are supplied. Expected: preserve both endpoints exactly as bigint. */
    it('preserves both endpoints as exact bigint values', () => {
      expect(readU64Value(parseJson('0'))).toBe(0n);
      expect(readU64Value(parseJson('18446744073709551615'))).toBe(
        18_446_744_073_709_551_615n,
      );
    });

    /** Target: unsigned 64-bit integer validation. Dependencies: bounded JSON parser. Scenario: token is a string, negative, fractional, or exponent-form number. Expected: reject every non-canonical unsigned integer. */
    it('rejects strings and non-integer number lexemes', () => {
      for (const source of ['"7"', '-1', '1.0', '1e0']) {
        expect(() => readU64Value(parseJson(source))).toThrow(
          'SOLANA_RPC_INVALID_U64',
        );
      }
    });

    /** Target: unsigned 64-bit range. Dependencies: bounded JSON parser. Scenario: token exceeds the u64 maximum by one. Expected: reject with the range code. */
    it('rejects values above the unsigned 64-bit maximum', () => {
      expect(() => readU64Value(parseJson('18446744073709551616'))).toThrow(
        'SOLANA_RPC_U64_OUT_OF_RANGE',
      );
    });
  });

  describe('parseJson', () => {
    /** Target: parser resource bounds. Dependencies: raw JSON text. Scenario: byte, depth, and node counts are tested at their exact boundaries and one over. Expected: accept each maximum and reject each excess with its stable code. */
    it('retains exact byte, depth, and node cap boundaries', () => {
      const exactByteLimit = `"${'a'.repeat(1_048_574)}"`;
      expect(parseJson(exactByteLimit).kind).toBe('string');
      expect(() => parseJson(`"${'a'.repeat(1_048_575)}"`)).toThrow(
        'SOLANA_RPC_RESPONSE_TOO_LARGE',
      );

      const atDepthLimit = `${'['.repeat(64)}0${']'.repeat(64)}`;
      const overDepthLimit = `${'['.repeat(65)}0${']'.repeat(65)}`;
      expect(parseJson(atDepthLimit).kind).toBe('array');
      expect(() => parseJson(overDepthLimit)).toThrow('SOLANA_RPC_DEPTH_LIMIT');

      expect(parseJson(`[${'0,'.repeat(99_998)}0]`).kind).toBe('array');
      expect(() => parseJson(`[${'0,'.repeat(99_999)}0]`)).toThrow(
        'SOLANA_RPC_NODE_LIMIT',
      );
    });

    /** Target: parser byte bound. Dependencies: raw JSON text. Scenario: UTF-8 response is exactly 1 MiB and then one byte larger. Expected: accept the exact limit and reject the excess. */
    it('accepts the exact byte cap and rejects one byte over', () => {
      const atLimit = `"${'a'.repeat(1_048_574)}"`;
      const overLimit = `"${'a'.repeat(1_048_575)}"`;
      expect(Buffer.byteLength(atLimit, 'utf8')).toBe(1_048_576);
      expect(parseJson(atLimit).kind).toBe('string');
      expect(() => parseJson(overLimit)).toThrow(
        'SOLANA_RPC_RESPONSE_TOO_LARGE',
      );
    });

    /** Target: parser nesting bound. Dependencies: raw JSON arrays. Scenario: nested values have depth 64 and 65. Expected: accept 64 and reject 65. */
    it('accepts depth 64 and rejects depth 65', () => {
      const atLimit = `${'['.repeat(64)}0${']'.repeat(64)}`;
      const overLimit = `${'['.repeat(65)}0${']'.repeat(65)}`;
      expect(parseJson(atLimit).kind).toBe('array');
      expect(() => parseJson(overLimit)).toThrow('SOLANA_RPC_DEPTH_LIMIT');
    });

    /** Target: parser node bound. Dependencies: raw JSON array. Scenario: input contains 100000 nodes and then 100001. Expected: accept the limit and reject the excess. */
    it('accepts 100000 nodes and rejects node 100001', () => {
      const atLimit = `[${'0,'.repeat(99_998)}0]`;
      const overLimit = `[${'0,'.repeat(99_999)}0]`;
      expect(parseJson(atLimit).kind).toBe('array');
      expect(() => parseJson(overLimit)).toThrow('SOLANA_RPC_NODE_LIMIT');
    });
  });

  describe('integerValue', () => {
    /** Target: safe integer conversion. Dependencies: bounded JSON parser. Scenario: block height is one above JavaScript's safe integer limit. Expected: reject instead of rounding the JSON integer. */
    it('rejects an unsafe block-height JSON integer', () => {
      expect(() =>
        integerValue(parseJson('9007199254740992'), 'blockHeight'),
      ).toThrow('SOLANA_RPC_UNSAFE_BLOCKHEIGHT');
    });
  });
});
