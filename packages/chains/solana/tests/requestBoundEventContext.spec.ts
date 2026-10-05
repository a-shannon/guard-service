import { describe, expect, it } from 'vitest';

import type { SolanaResolvedProfile } from '@rosen-bridge/rosen-extractor';

import {
  createSolanaEventContext,
  type SolanaEventRequest,
} from '../lib/requestBoundEventContext';
import { createMockSolanaExtractor as makeExtractor } from './mocked/requestBoundEventContext.mock';
import {
  BLOCKHASH,
  GENESIS,
  RAW_TRANSACTION,
  SIGNATURE,
  createTestProfile as makeProfile,
} from './testData';
import { createTestRequest as makeRequest } from './testUtils';

describe('requestBoundEventContext', () => {
  describe('createSolanaEventContext', () => {
    /** Target: extractor profile capture. Dependencies: extractor descriptor. Scenario: projector version differs. Expected: creation rejects the unsupported projector. */
    it('rejects an unexpected projector version', () => {
      const extractor = makeExtractor(
        undefined,
        makeProfile('older-projector'),
      );
      expect(() => createSolanaEventContext(extractor)).toThrow(
        'SOLANA_PROJECTOR_VERSION_MISMATCH',
      );
    });

    /** Target: extractor profile capture. Dependencies: extractor descriptor. Scenario: descriptor is mutable. Expected: creation rejects mutable configuration. */
    it('requires the captured profile to be deeply frozen', () => {
      const mutable = { ...makeProfile(), assets: [] };
      const extractor = makeExtractor(
        undefined,
        mutable as SolanaResolvedProfile,
      );
      expect(() => createSolanaEventContext(extractor)).toThrow(
        'SOLANA_RESOLVED_PROFILE_NOT_IMMUTABLE',
      );
    });

    /** Target: extractor profile capture. Dependencies: nested resolved asset policy. Scenario: root and array are frozen while an asset remains mutable. Expected: creation rejects the profile. */
    it('requires nested asset policies to be deeply frozen', () => {
      const base = makeProfile();
      const mutableAsset = { ...base.assets[0] };
      const profile = Object.freeze({
        ...base,
        assets: Object.freeze([mutableAsset]),
      });
      expect(() =>
        createSolanaEventContext(makeExtractor(undefined, profile)),
      ).toThrow('SOLANA_RESOLVED_PROFILE_NOT_IMMUTABLE');
    });
  });

  describe('bindRequest', () => {
    /** Target: request binding. Dependencies: frozen extractor profile. Scenario: valid enriched input contains an integer above JavaScript's safe range. Expected: exact original text is retained. */
    it('retains the exact raw input, including wide integer tokens', () => {
      const extractor = makeExtractor();
      const context = createSolanaEventContext(extractor);
      const raw = RAW_TRANSACTION.replace(
        '18446744073709551615',
        '9007199254740993123456789',
      );
      const carrier = context.bindRequest(makeRequest({ extractorInput: raw }));

      expect(context.serializeTx(carrier)).toBe(raw);
      expect(carrier.observedSignature).toBe(SIGNATURE);
      expect(carrier.resolvedProfile).toBe(context.resolvedProfile);
      expect(Object.isFrozen(carrier)).toBe(true);
    });

    /** Target: request binding. Dependencies: requested transaction ID. Scenario: first raw signature differs. Expected: carrier creation fails before classification. */
    it('rejects a signature that differs from the requested transaction', () => {
      const raw = RAW_TRANSACTION.replace(SIGNATURE, 'other-signature');
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_SIGNATURE_MISMATCH');
    });

    /** Target: request binding. Dependencies: caller transaction ID. Scenario: requested ID is absent. Expected: reject before parsing transaction bytes. */
    it('rejects a missing requested transaction ID', () => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ requestedTxId: '' }),
        ),
      ).toThrow('SOLANA_REQUEST_IDENTITY_MISSING');
    });

    /** Target: request binding. Dependencies: caller transaction ID. Scenario: runtime value is not a string. Expected: reject before parsing transaction bytes. */
    it('rejects a non-string requested transaction ID', () => {
      const request = {
        ...makeRequest(),
        requestedTxId: 42,
      } as unknown as SolanaEventRequest;
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(request),
      ).toThrow('SOLANA_REQUEST_IDENTITY_MISSING');
    });

    /** Target: request binding. Dependencies: caller block hash. Scenario: requested block hash is absent. Expected: reject before parsing transaction bytes. */
    it('rejects a missing requested block hash', () => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ requestedBlockhash: '' }),
        ),
      ).toThrow('SOLANA_REQUEST_IDENTITY_MISSING');
    });

    /** Target: request binding. Dependencies: caller block hash. Scenario: runtime value is not a string. Expected: reject before parsing transaction bytes. */
    it('rejects a non-string requested block hash', () => {
      const request = {
        ...makeRequest(),
        requestedBlockhash: 42,
      } as unknown as SolanaEventRequest;
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(request),
      ).toThrow('SOLANA_REQUEST_IDENTITY_MISSING');
    });

    /** Target: request binding. Dependencies: raw extractor input. Scenario: runtime value is not a string. Expected: reject before JSON parsing. */
    it('rejects a non-string extractor input', () => {
      const request = {
        ...makeRequest(),
        extractorInput: 42,
      } as unknown as SolanaEventRequest;
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(request),
      ).toThrow('SOLANA_REQUEST_INVALID_JSON');
    });

    /** Target: request binding. Dependencies: requested block hash. Scenario: raw block hash differs. Expected: carrier creation fails. */
    it('rejects a block hash that differs from the request', () => {
      const raw = RAW_TRANSACTION.replace(BLOCKHASH, 'other-blockhash');
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_BLOCKHASH_MISMATCH');
    });

    /** Target: request binding. Dependencies: observed slot. Scenario: raw slot differs from the request. Expected: carrier creation fails. */
    it('rejects a slot that differs from the request', () => {
      const raw = RAW_TRANSACTION.replace('"slot":42', '"slot":43');
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_SLOT_MISMATCH');
    });

    /** Target: request binding. Dependencies: raw RPC slot token. Scenario: slot uses exponent or fractional notation. Expected: reject non-integer token forms. */
    it.each([
      ['exponent', '42e0'],
      ['fraction', '42.0'],
    ])('rejects a raw slot written with %s notation', (_form, token) => {
      const raw = RAW_TRANSACTION.replace('"slot":42', `"slot":${token}`);
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_SLOT_INVALID');
    });

    /** Target: request binding. Dependencies: raw RPC slot token. Scenario: slot exceeds the safe integer range. Expected: reject instead of rounding. */
    it('rejects an unsafe raw slot', () => {
      const raw = RAW_TRANSACTION.replace(
        '"slot":42',
        '"slot":9007199254740992',
      );
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_UNSAFE_SLOT');
    });

    /** Target: request binding. Dependencies: extractor profile genesis. Scenario: raw transaction names another cluster. Expected: carrier creation fails. */
    it('rejects a genesis hash outside the captured profile', () => {
      const raw = RAW_TRANSACTION.replace(GENESIS, 'other-genesis');
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_GENESIS_MISMATCH');
    });

    /** Target: request binding. Dependencies: extractor destination network. Scenario: raw transaction names another Rosen network. Expected: carrier creation fails. */
    it('rejects a destination network outside the captured profile', () => {
      const raw = RAW_TRANSACTION.replace('"mainnet"', '"testnet"');
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_DESTINATION_NETWORK_MISMATCH');
    });

    /** Target: request binding. Dependencies: optional history identity. Scenario: history names another signature. Expected: carrier creation fails. */
    it('rejects conflicting optional history identity', () => {
      const raw = RAW_TRANSACTION.replace(
        '"destinationNetwork":"mainnet"',
        '"destinationNetwork":"mainnet","history":{"sourceTxId":"other","slot":42,"clusterGenesisHash":"cluster-genesis"}',
      );
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_HISTORY_SIGNATURE_MISMATCH');
    });

    /** Target: request binding. Dependencies: optional history node. Scenario: history is a non-null scalar. Expected: reject malformed history instead of ignoring it. */
    it('rejects a non-object history scalar', () => {
      const raw = RAW_TRANSACTION.replace(
        '"destinationNetwork":"mainnet"',
        '"destinationNetwork":"mainnet","history":false',
      );
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_HISTORY_INVALID');
    });

    /** Target: request binding. Dependencies: optional history slot. Scenario: history slot differs from transaction slot. Expected: reject the inconsistent history record. */
    it('rejects a conflicting history slot', () => {
      const raw = RAW_TRANSACTION.replace(
        '"destinationNetwork":"mainnet"',
        '"destinationNetwork":"mainnet","history":{"sourceTxId":"request-signature","slot":43,"clusterGenesisHash":"cluster-genesis"}',
      );
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_HISTORY_SLOT_MISMATCH');
    });

    /** Target: request binding. Dependencies: optional history genesis. Scenario: history names another cluster. Expected: reject the inconsistent history record. */
    it('rejects a conflicting history genesis hash', () => {
      const raw = RAW_TRANSACTION.replace(
        '"destinationNetwork":"mainnet"',
        '"destinationNetwork":"mainnet","history":{"sourceTxId":"request-signature","slot":42,"clusterGenesisHash":"other-genesis"}',
      );
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_HISTORY_GENESIS_MISMATCH');
    });

    /** Target: request binding. Dependencies: JSON parser. Scenario: duplicate identity key is present. Expected: ambiguous input is rejected. */
    it('rejects duplicate JSON keys', () => {
      const raw = RAW_TRANSACTION.replace(
        '"blockhash":"request-blockhash"',
        '"blockhash":"request-blockhash","blockhash":"request-blockhash"',
      );
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow('SOLANA_REQUEST_DUPLICATE_JSON_KEY');
    });

    /** Target: request binding. Dependencies: required raw identity fields. Scenario: one authorizing field is absent. Expected: reject the input with that field's missing-data error. */
    it.each([
      [
        'transaction signatures',
        RAW_TRANSACTION.replace(
          '"transaction":{"signatures":["request-signature"]},',
          '"transaction":{},',
        ),
        'SOLANA_REQUEST_SIGNATURE_MISSING',
      ],
      [
        'block hash',
        RAW_TRANSACTION.replace('"blockhash":"request-blockhash",', ''),
        'SOLANA_REQUEST_BLOCKHASH_MISSING',
      ],
      [
        'slot',
        RAW_TRANSACTION.replace('"slot":42,', ''),
        'SOLANA_REQUEST_SLOT_INVALID',
      ],
      [
        'genesis hash',
        RAW_TRANSACTION.replace('"clusterGenesisHash":"cluster-genesis",', ''),
        'SOLANA_REQUEST_GENESIS_MISSING',
      ],
      [
        'destination network',
        RAW_TRANSACTION.replace('"destinationNetwork":"mainnet",', ''),
        'SOLANA_REQUEST_DESTINATION_NETWORK_MISSING',
      ],
    ])('rejects missing raw %s', (_field, raw, expected) => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ extractorInput: raw }),
        ),
      ).toThrow(expected);
    });

    /** Target: request binding. Dependencies: bounded JSON parser. Scenario: a JSON token is malformed. Expected: reject before identity fields are read. */
    it.each([
      ['truncated object', '{"key":'],
      ['invalid escape', '"\\q"'],
      ['leading zero', '[01]'],
      ['trailing array comma', '[1,]'],
      ['invalid literal', 'NaN'],
    ])('rejects malformed JSON with %s', (_form, raw) => {
      const context = createSolanaEventContext(makeExtractor());
      expect(() =>
        context.bindRequest(makeRequest({ extractorInput: raw })),
      ).toThrow('SOLANA_REQUEST_INVALID_JSON');
    });

    /** Target: request binding. Dependencies: bounded JSON parser. Scenario: nesting exceeds the fixed depth. Expected: reject at the depth limit. */
    it('rejects excessive JSON depth', () => {
      const context = createSolanaEventContext(makeExtractor());
      const nestedValue = `${'['.repeat(66)}0${']'.repeat(66)}`;
      const deeplyNested = `${RAW_TRANSACTION.slice(0, -1)},"ignored":${nestedValue}}`;
      expect(() =>
        context.bindRequest(makeRequest({ extractorInput: deeplyNested })),
      ).toThrow('SOLANA_REQUEST_JSON_DEPTH_LIMIT');
    });

    /** Target: request binding. Dependencies: bounded JSON parser. Scenario: value count exceeds the fixed node limit. Expected: reject before traversing unbounded input. */
    it('rejects excessive JSON node count', () => {
      const context = createSolanaEventContext(makeExtractor());
      const nodeValue = `[${'0,'.repeat(99_999)}0]`;
      const manyNodes = `${RAW_TRANSACTION.slice(0, -1)},"ignored":${nodeValue}}`;
      expect(() =>
        context.bindRequest(makeRequest({ extractorInput: manyNodes })),
      ).toThrow('SOLANA_REQUEST_JSON_NODE_LIMIT');
    });

    /** Target: request binding. Dependencies: bounded JSON parser. Scenario: input exceeds the byte limit. Expected: reject before parsing. */
    it('rejects oversized JSON input', () => {
      const context = createSolanaEventContext(makeExtractor());
      const longValue = 'a'.repeat(1_048_577);
      const oversized = `${RAW_TRANSACTION.slice(0, -1)},"ignored":"${longValue}"}`;
      expect(() =>
        context.bindRequest(makeRequest({ extractorInput: oversized })),
      ).toThrow('SOLANA_REQUEST_INPUT_TOO_LARGE');
    });

    /** Target: request binding. Dependencies: caller request coordinates. Scenario: observed slot is not a safe integer. Expected: the request is rejected before parsing. */
    it('rejects unsafe caller coordinates', () => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ observedSlot: Number.MAX_SAFE_INTEGER + 1 }),
        ),
      ).toThrow('SOLANA_REQUEST_INVALID_COORDINATE');
    });

    /** Target: request binding. Dependencies: caller observed slot. Scenario: slot is negative. Expected: reject before parsing. */
    it('rejects a negative caller slot', () => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ observedSlot: -1 }),
        ),
      ).toThrow('SOLANA_REQUEST_INVALID_COORDINATE');
    });

    /** Target: request binding. Dependencies: caller observed slot. Scenario: slot is fractional. Expected: reject before parsing. */
    it('rejects a fractional caller slot', () => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ observedSlot: 42.5 }),
        ),
      ).toThrow('SOLANA_REQUEST_INVALID_COORDINATE');
    });

    /** Target: request binding. Dependencies: caller Rosen height. Scenario: height is negative. Expected: reject before parsing. */
    it('rejects a negative caller block height', () => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ rosenBlockHeight: -1 }),
        ),
      ).toThrow('SOLANA_REQUEST_INVALID_COORDINATE');
    });

    /** Target: request binding. Dependencies: caller Rosen height. Scenario: height is fractional. Expected: reject before parsing. */
    it('rejects a fractional caller block height', () => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ rosenBlockHeight: 7.5 }),
        ),
      ).toThrow('SOLANA_REQUEST_INVALID_COORDINATE');
    });

    /** Target: request binding. Dependencies: caller Rosen height. Scenario: height exceeds the safe integer range. Expected: reject before parsing. */
    it('rejects an unsafe caller block height', () => {
      expect(() =>
        createSolanaEventContext(makeExtractor()).bindRequest(
          makeRequest({ rosenBlockHeight: Number.MAX_SAFE_INTEGER + 1 }),
        ),
      ).toThrow('SOLANA_REQUEST_INVALID_COORDINATE');
    });

    /** Target: request binding. Dependencies: caller-owned request object. Scenario: request is mutated after binding. Expected: carrier keeps its original snapshot. */
    it('keeps the request snapshot after caller mutation', () => {
      const context = createSolanaEventContext(makeExtractor());
      const request = makeRequest();
      const carrier = context.bindRequest(request);
      Object.assign(request, {
        extractorInput: 'changed',
        requestedTxId: 'changed',
        requestedBlockhash: 'changed',
        observedSlot: 99,
        rosenBlockHeight: 99,
      });

      expect(context.serializeTx(carrier)).toBe(RAW_TRANSACTION);
      expect(carrier.requestedTxId).toBe(SIGNATURE);
      expect(carrier.observedSlot).toBe(42);
      expect(carrier.rosenBlockHeight).toBe(7);
    });
  });

  describe('serializeTx', () => {
    /** Target: carrier issuer binding. Dependencies: two independently created contexts. Scenario: carrier from another context is passed in. Expected: serialization rejects it. */
    it('rejects carriers issued by a different context', () => {
      const first = createSolanaEventContext(makeExtractor());
      const second = createSolanaEventContext(makeExtractor());
      const carrier = first.bindRequest(makeRequest());
      expect(() => second.serializeTx(carrier)).toThrow(
        'SOLANA_REQUEST_CARRIER_MISSING',
      );
    });

    /** Target: carrier issuer binding. Dependencies: valid bound transaction. Scenario: caller clones the carrier object. Expected: serializer rejects the clone. */
    it('rejects a cloned carrier', () => {
      const context = createSolanaEventContext(makeExtractor());
      const carrier = context.bindRequest(makeRequest());
      const clone = { ...carrier };
      expect(() => context.serializeTx(clone)).toThrow(
        'SOLANA_REQUEST_CARRIER_MISSING',
      );
    });

    /** Target: carrier immutability. Dependencies: valid bound transaction. Scenario: caller attempts to change request identity. Expected: frozen carrier retains its captured value. */
    it('keeps carrier identity immutable after binding', () => {
      const context = createSolanaEventContext(makeExtractor());
      const carrier = context.bindRequest(makeRequest());
      expect(() => {
        (carrier as { requestedTxId: string }).requestedTxId = 'changed';
      }).toThrow();
      expect(context.serializeTx(carrier)).toBe(RAW_TRANSACTION);
      expect(carrier.requestedTxId).toBe(SIGNATURE);
    });
  });

  describe('verifyLockTransactionExtraConditions', () => {
    /** Target: carrier issuer binding. Dependencies: two independent event contexts. Scenario: a foreign carrier is sent to the hook. Expected: reject before invoking the extractor. */
    it('rejects a carrier from another context before extraction', async () => {
      const extractor = makeExtractor();
      const localContext = createSolanaEventContext(extractor);
      const foreignCarrier =
        createSolanaEventContext(makeExtractor()).bindRequest(makeRequest());
      await expect(
        localContext.verifyLockTransactionExtraConditions(foreignCarrier, {
          hash: BLOCKHASH,
          height: 7,
        }),
      ).rejects.toThrow('SOLANA_REQUEST_CARRIER_MISSING');
      expect(extractor.getWithContext).not.toHaveBeenCalled();
    });

    /** Target: carrier issuer binding. Dependencies: valid bound transaction. Scenario: caller clones the carrier object. Expected: hook rejects the clone before invoking the extractor. */
    it('rejects a cloned carrier before extraction', async () => {
      const extractor = makeExtractor();
      const context = createSolanaEventContext(extractor);
      const carrier = context.bindRequest(makeRequest());
      const clone = { ...carrier };
      await expect(
        context.verifyLockTransactionExtraConditions(clone, {
          hash: BLOCKHASH,
          height: 7,
        }),
      ).rejects.toThrow('SOLANA_REQUEST_CARRIER_MISSING');
      expect(extractor.getWithContext).not.toHaveBeenCalled();
    });

    /** Target: block identity gate. Dependencies: bound request and extractor. Scenario: Guard block hash differs. Expected: reject before calling the extractor. */
    it('checks block hash before classification', async () => {
      const extractor = makeExtractor();
      const context = createSolanaEventContext(extractor);
      const carrier = context.bindRequest(makeRequest());
      await expect(
        context.verifyLockTransactionExtraConditions(carrier, {
          hash: 'other-blockhash',
          height: 7,
        }),
      ).rejects.toThrow('SOLANA_REQUEST_BLOCKINFO_HASH_MISMATCH');
      expect(extractor.getWithContext).not.toHaveBeenCalled();
    });

    /** Target: Rosen block-height gate. Dependencies: bound request and extractor. Scenario: Guard height differs. Expected: reject before calling the extractor. */
    it('checks Rosen block height before classification', async () => {
      const extractor = makeExtractor();
      const context = createSolanaEventContext(extractor);
      const carrier = context.bindRequest(makeRequest());
      await expect(
        context.verifyLockTransactionExtraConditions(carrier, {
          hash: BLOCKHASH,
          height: 8,
        }),
      ).rejects.toThrow('SOLANA_REQUEST_BLOCKINFO_HEIGHT_MISMATCH');
      expect(extractor.getWithContext).not.toHaveBeenCalled();
    });

    /** Target: extraction hook. Dependencies: captured extractor. Scenario: contextual projector returns a matching deposit. Expected: accept only after exact request identity matches. */
    it('accepts a deposit whose full source context matches the request', async () => {
      const extractor = makeExtractor({
        type: 'deposit',
        data: {},
        context: {
          clusterGenesisHash: GENESIS,
          sourceTxId: SIGNATURE,
          sourceSlot: 42,
          sourceBlockhash: BLOCKHASH,
        },
      });
      const context = createSolanaEventContext(extractor);
      const carrier = context.bindRequest(makeRequest());

      await expect(
        context.verifyLockTransactionExtraConditions(carrier, {
          hash: BLOCKHASH,
          height: 7,
        }),
      ).resolves.toBe(true);
      expect(extractor.getWithContext).toHaveBeenCalledWith(RAW_TRANSACTION);
    });

    /** Target: extraction hook. Dependencies: contextual projector result. Scenario: each source identity field is changed independently. Expected: reject each mismatched deposit. */
    const mismatchedContextFields: Array<
      [
        string,
        Partial<{
          sourceTxId: string;
          sourceBlockhash: string;
          sourceSlot: number;
          clusterGenesisHash: string;
        }>,
      ]
    > = [
      ['signature', { sourceTxId: 'other-signature' }],
      ['block hash', { sourceBlockhash: 'other-blockhash' }],
      ['slot', { sourceSlot: 43 }],
      ['genesis', { clusterGenesisHash: 'other-genesis' }],
    ];
    it.each(mismatchedContextFields)(
      'rejects a deposit with mismatched %s',
      async (_field, changed) => {
        const matching = {
          clusterGenesisHash: GENESIS,
          sourceTxId: SIGNATURE,
          sourceSlot: 42,
          sourceBlockhash: BLOCKHASH,
          ...changed,
        };
        const extractor = makeExtractor({
          type: 'deposit',
          data: {},
          context: matching,
        });
        const context = createSolanaEventContext(extractor);
        const carrier = context.bindRequest(makeRequest());
        await expect(
          context.verifyLockTransactionExtraConditions(carrier, {
            hash: BLOCKHASH,
            height: 7,
          }),
        ).rejects.toThrow('SOLANA_REQUEST_EXTRACTOR_CONTEXT_MISMATCH');
      },
    );

    /** Target: extraction classification. Dependencies: contextual projector result. Scenario: valid non-deposit is returned. Expected: return false. */
    it('returns false only for a known non-deposit result', async () => {
      const context = createSolanaEventContext(makeExtractor());
      const carrier = context.bindRequest(makeRequest());
      await expect(
        context.verifyLockTransactionExtraConditions(carrier, {
          hash: BLOCKHASH,
          height: 7,
        }),
      ).resolves.toBe(false);
    });

    /** Target: extraction availability. Dependencies: contextual projector result. Scenario: projection is unavailable. Expected: throw an ordinary retryable error rather than return false. */
    it('throws when contextual extraction is unavailable', async () => {
      const context = createSolanaEventContext(
        makeExtractor({ type: 'unavailable', reason: 'MISSING_META' }),
      );
      const carrier = context.bindRequest(makeRequest());
      await expect(
        context.verifyLockTransactionExtraConditions(carrier, {
          hash: BLOCKHASH,
          height: 7,
        }),
      ).rejects.toThrow('SOLANA_EXTRACTION_UNAVAILABLE:MISSING_META');
    });

    /** Target: extraction outcome gate. Dependencies: contextual projector result. Scenario: result has an unknown tag and matching-looking context. Expected: fail closed as unavailable. */
    it('rejects an unknown outcome tag even with matching context', async () => {
      const context = createSolanaEventContext(
        makeExtractor({
          type: 'unknown',
          context: {
            clusterGenesisHash: GENESIS,
            sourceTxId: SIGNATURE,
            sourceSlot: 42,
            sourceBlockhash: BLOCKHASH,
          },
        }),
      );
      const carrier = context.bindRequest(makeRequest());
      await expect(
        context.verifyLockTransactionExtraConditions(carrier, {
          hash: BLOCKHASH,
          height: 7,
        }),
      ).rejects.toThrow('SOLANA_EXTRACTION_UNAVAILABLE:UNKNOWN_OUTCOME');
    });

    /** Target: request-local concurrency. Dependencies: one immutable context. Scenario: two requests are checked concurrently. Expected: each exact input reaches its own extractor call. */
    it('keeps concurrent calls bound to their own raw input', async () => {
      const extractor = makeExtractor();
      const context = createSolanaEventContext(extractor);
      const firstRaw = RAW_TRANSACTION;
      const secondRaw = RAW_TRANSACTION.replace(
        '"meta":',
        '"other":true,"meta":',
      );
      const first = context.bindRequest(
        makeRequest({ extractorInput: firstRaw }),
      );
      const second = context.bindRequest(
        makeRequest({ extractorInput: secondRaw }),
      );

      await Promise.all([
        context.verifyLockTransactionExtraConditions(first, {
          hash: BLOCKHASH,
          height: 7,
        }),
        context.verifyLockTransactionExtraConditions(second, {
          hash: BLOCKHASH,
          height: 7,
        }),
      ]);
      expect(extractor.getWithContext).toHaveBeenNthCalledWith(1, firstRaw);
      expect(extractor.getWithContext).toHaveBeenNthCalledWith(2, secondRaw);
    });
  });
});
