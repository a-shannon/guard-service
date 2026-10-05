import { describe, expect, it, vi } from 'vitest';

import { createProducerHarness } from './mocked/solanaEventRequestProducer.mock';
import {
  requestContext,
  validHistory,
} from './solanaEventRequestProducerTestData';
import {
  blockResult,
  defaultReplies,
  rpcResponse,
  transactionResult,
} from './solanaEventRequestProducerTestUtils';
import { BLOCKHASH, GENESIS, SIGNATURE } from './testData';

/** Assert the unavailable error while pinning its field-level cause. */
const expectUnavailableCause = (promise: Promise<unknown>, cause: string) =>
  expect(promise).rejects.toMatchObject({
    message: 'SOLANA_REQUEST_UNAVAILABLE',
    cause: { message: cause },
  });

describe('createSolanaEventRequestProducer', () => {
  /** Target: finalized RPC request construction. Dependencies: local transport. Scenario: all source reads succeed. Expected: methods, IDs and fixed options are exact. */
  it('requests genesis, transaction and containing block in order with fixed finalized options', async () => {
    const { producer, transport } = createProducerHarness();
    const carrier = await producer.getTransaction(SIGNATURE, BLOCKHASH);

    expect(
      transport.mock.calls.map(([request]) => [request?.method, request?.id]),
    ).toEqual([
      ['getGenesisHash', 1],
      ['getTransaction', 2],
      ['getBlock', 3],
    ]);
    expect(
      transport.mock.calls.every(
        ([request]) =>
          Object.isFrozen(request) && Object.isFrozen(request?.params),
      ),
    ).toBe(true);
    expect(transport.mock.calls[1]?.[0]?.params).toEqual([
      SIGNATURE,
      {
        commitment: 'finalized',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    expect(transport.mock.calls[2]?.[0]?.params).toEqual([
      42,
      {
        commitment: 'finalized',
        encoding: 'json',
        transactionDetails: 'full',
        rewards: true,
        maxSupportedTransactionVersion: 0,
      },
    ]);
    expect(carrier.observedSignature).toBe(SIGNATURE);
    expect(carrier.rosenBlockHeight).toBe(37);
  });

  /** Target: raw extractor input. Dependencies: RPC transaction result. Scenario: transaction contains an integer outside JavaScript's safe range. Expected: exact decimal token survives enrichment. */
  it('retains the exact wide integer token from the RPC result', async () => {
    const { producer, context } = createProducerHarness();
    const carrier = await producer.getTransaction(SIGNATURE, BLOCKHASH);
    expect(context.serializeTx(carrier)).toContain('18446744073709551615');
  });

  /** Target: history context join. Dependencies: six coordinate adapter. Scenario: adapter returns matching tuple and object JSON. Expected: raw history text is embedded unchanged. */
  it('embeds matching history text without normalizing it', async () => {
    const rawHistory =
      '{ "sourceTxId" : "request-signature", "slot":42,"clusterGenesisHash":"cluster-genesis" }';
    const history = vi.fn(() => ({
      requestContext,
      extractorHistory: rawHistory,
    }));
    const { producer, context } = createProducerHarness(
      defaultReplies(),
      history,
    );
    const carrier = await producer.getTransaction(SIGNATURE, BLOCKHASH);
    expect(context.serializeTx(carrier)).toContain(`"history":${rawHistory}`);
    expect(history).toHaveBeenCalledWith(requestContext);
  });

  /** Target: history context join. Dependencies: returned six-tuple. Scenario: declared transaction index differs. Expected: request is unavailable. */
  it('rejects a history tuple whose transaction index differs', async () => {
    expect.assertions(1);
    const history = () => ({
      requestContext: { ...requestContext, transactionIndex: 1 },
      extractorHistory: validHistory,
    });
    await expectUnavailableCause(
      createProducerHarness(defaultReplies(), history).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_HISTORY_CONTEXT_MISMATCH',
    );
  });

  /** Target: history tuple join. Dependencies: all six adapter coordinates. Scenario: each coordinate is changed independently. Expected: every change rejects the carrier. */
  it.each([
    ['signature', 'other-signature'],
    ['slot', 43],
    ['blockhash', 'other-block'],
    ['blockHeight', 38],
    ['transactionIndex', 1],
    ['genesis', 'other-genesis'],
  ] as const)(
    'rejects a history tuple with a different %s',
    async (field, value) => {
      expect.assertions(1);
      const coordinates = { ...requestContext, [field]: value };
      const history = () => ({
        requestContext: coordinates,
        extractorHistory: validHistory,
      });
      await expectUnavailableCause(
        createProducerHarness(
          defaultReplies(),
          history,
        ).producer.getTransaction(SIGNATURE, BLOCKHASH),
        'SOLANA_RPC_HISTORY_CONTEXT_MISMATCH',
      );
    },
  );

  /** Target: history snapshot. Dependencies: adapter object getters. Scenario: each field changes after its first read. Expected: each adapter value is read once and the original snapshot is used. */
  it('snapshots every history field and raw string once', async () => {
    const readCounts = new Map<string, number>();
    const coordinateObject = Object.fromEntries(
      Object.entries(requestContext).map(([key, value]) => [
        key,
        {
          enumerable: true,
          get: () => {
            const count = (readCounts.get(key) ?? 0) + 1;
            readCounts.set(key, count);
            return count === 1 ? value : `changed-${key}`;
          },
        },
      ]),
    );
    let rawReads = 0;
    const history = () => ({
      requestContext: Object.defineProperties(
        {},
        coordinateObject,
      ) as typeof requestContext,
      get extractorHistory() {
        rawReads++;
        return rawReads === 1 ? validHistory : '[]';
      },
    });
    const { producer } = createProducerHarness(defaultReplies(), history);
    await expect(
      producer.getTransaction(SIGNATURE, BLOCKHASH),
    ).resolves.toBeDefined();
    expect([...readCounts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(rawReads).toBe(1);
  });

  /** Target: optional history. Dependencies: local RPC reads. Scenario: history adapter has no record. Expected: valid source transaction can still be bound. */
  it('allows a valid SOL request when optional history is absent', async () => {
    const { producer, context } = createProducerHarness(
      defaultReplies(),
      () => undefined,
    );
    const carrier = await producer.getTransaction(SIGNATURE, BLOCKHASH);
    expect(context.serializeTx(carrier)).not.toContain('"history"');
  });

  /** Target: genesis binding. Dependencies: captured extractor profile. Scenario: RPC genesis differs. Expected: fail before transaction or block calls. */
  it('stops when RPC genesis differs from the captured profile', async () => {
    expect.assertions(2);
    const replies = defaultReplies();
    replies[0] = rpcResponse(1, JSON.stringify('other-genesis'));
    const { producer, transport } = createProducerHarness(replies);
    await expectUnavailableCause(
      producer.getTransaction(SIGNATURE, BLOCKHASH),
      'SOLANA_RPC_GENESIS_MISMATCH',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing RPC genesis before consuming transaction data', async () => {
    expect.assertions(2);
    const replies = defaultReplies();
    replies[0] = rpcResponse(1, 'null');
    const { producer, transport } = createProducerHarness(replies);
    await expectUnavailableCause(
      producer.getTransaction(SIGNATURE, BLOCKHASH),
      'SOLANA_RPC_GENESIS_MISSING',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  /** Target: transaction response. Dependencies: transaction result. Scenario: RPC returns null. Expected: unavailable request. */
  it('rejects a null transaction result', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[1] = rpcResponse(2, 'null');
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_INVALID_TRANSACTION',
    );
  });

  /** Target: JSON-RPC envelope. Dependencies: expected call ID. Scenario: response uses another ID. Expected: fail closed. */
  it('rejects a mismatched JSON-RPC response ID', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[1] = rpcResponse(9, transactionResult());
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_ID_MISMATCH',
    );
  });

  /** Target: JSON-RPC version. Dependencies: RPC envelope. Scenario: version is not 2.0. Expected: reject before consuming the result. */
  it('rejects a mismatched JSON-RPC version', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[0] = replies[0].replace('2.0', '1.0');
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_VERSION_MISMATCH',
    );
  });

  /** Target: RPC JSON parsing. Dependencies: response bytes. Scenario: the response is malformed. Expected: preserve the parser failure as the unavailable cause. */
  it('rejects malformed RPC JSON with its parser cause', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[0] = '{malformed';
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_INVALID_JSON',
    );
  });

  /** Target: RPC response envelope. Dependencies: successful-response members. Scenario: result is absent. Expected: reject the incomplete envelope. */
  it('rejects an RPC envelope with no result member', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[0] = '{"jsonrpc":"2.0","id":1}';
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_INVALID_ENVELOPE',
    );
  });

  /** Target: transport failure. Dependencies: local transport promise. Scenario: transport rejects. Expected: retain the transport cause and classify the request unavailable. */
  it('preserves a rejected transport cause', async () => {
    expect.assertions(1);
    await expectUnavailableCause(
      createProducerHarness(
        defaultReplies(),
        undefined,
        new Error('socket unavailable'),
      ).producer.getTransaction(SIGNATURE, BLOCKHASH),
      'socket unavailable',
    );
  });

  /** Target: duplicate-key protection. Dependencies: RPC parser only. Scenario: envelope contains a repeated ID with the same value. Expected: reject duplicate members before joining transaction data. */
  it('rejects duplicate JSON keys in the RPC envelope', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[0] = '{"jsonrpc":"2.0","id":1,"id":1,"result":"cluster-genesis"}';
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_DUPLICATE_JSON_KEY',
    );
  });

  /** Target: JSON-RPC envelope. Dependencies: transport. Scenario: response includes an error member. Expected: fail closed. */
  it('rejects RPC error envelopes', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[0] =
      '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"offline"}}';
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_ERROR_RESPONSE',
    );
  });

  /** Target: transaction identity. Dependencies: requested signature. Scenario: result first signature differs. Expected: reject the join. */
  it('rejects a transaction whose first signature differs', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[1] = rpcResponse(
      2,
      transactionResult({ signature: 'other-signature' }),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_TRANSACTION_SIGNATURE_MISMATCH',
    );
  });

  /** Target: transaction metadata presence. Dependencies: RPC transaction result. Scenario: meta is missing. Expected: reject before block membership is considered. */
  it('rejects a transaction response with missing metadata', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[1] = rpcResponse(
      2,
      transactionResult().replace(
        ',"meta":{"fee":18446744073709551615,"err":null}',
        '',
      ),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_INVALID_META',
    );
  });

  /** Target: containing block identity. Dependencies: requested blockhash. Scenario: returned block hash differs. Expected: reject the join. */
  it('rejects a different containing block hash', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(3, blockResult({ blockhash: 'other-block' }));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_CONTAINING_BLOCKHASH_MISMATCH',
    );
  });

  /** Target: block membership. Dependencies: full transaction list. Scenario: signature occurs twice. Expected: reject ambiguous membership. */
  it('rejects duplicate signature membership in the block', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(3, blockResult({ copies: 2 }));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_BLOCK_MEMBERSHIP_CARDINALITY',
    );
  });

  /** Target: block membership. Dependencies: full transaction list. Scenario: requested signature is absent. Expected: reject zero matches. */
  it('rejects a block with no matching signature', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(3, blockResult({ copies: 0 }));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_BLOCK_MEMBERSHIP_CARDINALITY',
    );
  });

  /** Target: containing block response shape. Dependencies: transaction list. Scenario: transactions member is absent. Expected: reject an incomplete block response. */
  it('rejects a block response without transactions', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(3, blockResult({ includeTransactions: false }));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_BLOCK_TRANSACTIONS_MISSING',
    );
  });

  /** Target: optional transaction index. Dependencies: full block membership. Scenario: RPC transaction index disagrees with the matched index. Expected: reject the independent coordinate. */
  it('rejects an RPC transaction index that disagrees with block membership', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[1] = rpcResponse(
      2,
      transactionResult().replace(
        '{"slot":42,',
        '{"slot":42,"transactionIndex":7,',
      ),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_TRANSACTION_INDEX_MISMATCH',
    );
  });

  /** Target: block membership index. Dependencies: full transaction list. Scenario: one unrelated transaction precedes the requested transaction. Expected: derive index one and bind the request. */
  it('accepts a uniquely matched transaction at a nonzero block index', async () => {
    const replies = defaultReplies();
    replies[2] = rpcResponse(
      3,
      blockResult({ prefixSignatures: ['preceding-signature'] }),
    );
    const { producer } = createProducerHarness(replies);
    const carrier = await producer.getTransaction(SIGNATURE, BLOCKHASH);
    expect(carrier.rosenBlockHeight).toBe(37);
  });

  /** Target: independent RPC read agreement. Dependencies: transaction meta. Scenario: block metadata fee differs. Expected: reject inconsistent reads. */
  it('rejects transaction and block metadata that disagree', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(3, blockResult({ fee: '99' }));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_READS_DISAGREE',
    );
  });

  /** Target: transaction subtree agreement. Dependencies: equal signature, metadata and version. Scenario: the block's account keys differ. Expected: reject the independently observed transaction contents. */
  it('rejects transaction and block transaction contents that disagree', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(
      3,
      blockResult().replace(
        '"accountKeys":["payer"]',
        '"accountKeys":["other"]',
      ),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_READS_DISAGREE',
    );
  });

  /** Target: exact numeric read agreement. Dependencies: wide integer metadata tokens. Scenario: tokens differ but round to the same JavaScript number. Expected: reject the unequal source observations. */
  it('rejects distinct wide integer tokens that round to the same number', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(3, blockResult({ fee: '18446744073709551614' }));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_READS_DISAGREE',
    );
  });

  /** Target: structural equality. Dependencies: transaction and block results. Scenario: equivalent object members use different key order. Expected: accept key-order-independent equality. */
  it('accepts structurally equal transaction results with different key order', async () => {
    const replies = defaultReplies();
    const original = `{"transaction":{"signatures":["${SIGNATURE}"],"message":{"accountKeys":["payer"],"instructions":[]}},"meta":{"fee":18446744073709551615,"err":null},"version":"legacy"}`;
    const reordered = `{"version":"legacy","meta":{"err":null,"fee":18446744073709551615},"transaction":{"message":{"instructions":[],"accountKeys":["payer"]},"signatures":["${SIGNATURE}"]}}`;
    replies[2] = rpcResponse(3, blockResult().replace(original, reordered));
    const { producer } = createProducerHarness(replies);
    await expect(
      producer.getTransaction(SIGNATURE, BLOCKHASH),
    ).resolves.toMatchObject({
      observedSignature: SIGNATURE,
      observedSlot: 42,
    });
  });

  /** Target: independent RPC version agreement. Dependencies: both RPC results. Scenario: each version is individually supported but differs. Expected: reject conflicting observations. */
  it('rejects individually supported transaction versions that disagree', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(3, blockResult({ version: '0' }));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_READS_DISAGREE',
    );
  });

  /** Target: parser byte bound. Dependencies: ignored block-result field. Scenario: otherwise valid result exceeds one MiB. Expected: reject at the producer parser boundary. */
  it('caps oversized ignored fields in RPC responses', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(
      3,
      blockResult({
        extraFields: `"ignored":${JSON.stringify('x'.repeat(1_048_576))}`,
      }),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_RESPONSE_TOO_LARGE',
    );
  });

  /** Target: parser depth bound. Dependencies: ignored block-result field. Scenario: a valid transaction is accompanied by over-deep unrelated JSON. Expected: reject before carrier binding. */
  it('caps nesting depth in ignored RPC fields', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    const nested = `${'['.repeat(66)}0${']'.repeat(66)}`;
    replies[2] = rpcResponse(
      3,
      blockResult({ extraFields: `"ignored":${nested}` }),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_DEPTH_LIMIT',
    );
  });

  /** Target: parser node bound. Dependencies: ignored block-result array. Scenario: otherwise valid result exceeds the node budget. Expected: reject at the producer parser boundary. */
  it('caps node count in ignored RPC fields', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    const manyNodes = `[${'0,'.repeat(100_000)}0]`;
    replies[2] = rpcResponse(
      3,
      blockResult({ extraFields: `"ignored":${manyNodes}` }),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_NODE_LIMIT',
    );
  });

  /** Target: version support. Dependencies: transaction result. Scenario: unsupported version. Expected: reject before block acceptance. */
  it('rejects unsupported transaction versions', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[1] = rpcResponse(2, transactionResult().replace('"legacy"', '1'));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_UNSUPPORTED_VERSION',
    );
  });

  /** Target: slot parsing. Dependencies: raw integer lexeme. Scenario: slot is fractionally encoded. Expected: reject unsafe coordinate representation. */
  it('rejects fractional slot tokens', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[1] = rpcResponse(
      2,
      transactionResult().replace('"slot":42', '"slot":42.0'),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_INVALID_SLOT',
    );
  });

  /** Target: block height parsing. Dependencies: block result. Scenario: block height is unsafe. Expected: reject before request binding. */
  it('rejects unsafe block height integers', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(
      3,
      blockResult({ blockHeight: '9007199254740992' }),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_UNSAFE_BLOCKHEIGHT',
    );
  });

  /** Target: block height parsing. Dependencies: block result. Scenario: block height is fractional. Expected: reject before request binding. */
  it('rejects fractional block height tokens', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[2] = rpcResponse(3, blockResult({ blockHeight: '37.0' }));
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_INVALID_BLOCKHEIGHT',
    );
  });

  /** Target: reserved enrichment keys. Dependencies: upstream result object. Scenario: result already supplies blockhash. Expected: reject field collision. */
  it('rejects reserved enrichment fields in the source result', async () => {
    expect.assertions(1);
    const replies = defaultReplies();
    replies[1] = rpcResponse(
      2,
      transactionResult().replace(
        '"version":"legacy"',
        '"version":"legacy","blockhash":"other"',
      ),
    );
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_RESERVED_FIELD:blockhash',
    );
  });

  /** Target: reserved enrichment field protection. Dependencies: transaction result object. Scenario: each key owned by the producer is already present. Expected: reject the field collision. */
  it.each([
    'clusterGenesisHash',
    'destinationNetwork',
    'commitment',
    'blockhash',
    'history',
  ])('rejects a preexisting reserved field %s', async (field) => {
    expect.assertions(1);
    const replies = defaultReplies();
    const value = field === 'history' ? '{}' : '"conflicting"';
    const source = transactionResult().replace(
      '"version":"legacy"}',
      `"version":"legacy","${field}":${value}}`,
    );
    replies[1] = rpcResponse(2, source);
    await expectUnavailableCause(
      createProducerHarness(replies).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      `SOLANA_RPC_RESERVED_FIELD:${field}`,
    );
  });

  /** Target: extractor history validation. Dependencies: embedded history JSON. Scenario: source history has malformed syntax. Expected: preserve the parser failure. */
  it('rejects malformed embedded history JSON', async () => {
    expect.assertions(1);
    const history = () => ({ requestContext, extractorHistory: '{broken' });
    await expectUnavailableCause(
      createProducerHarness(defaultReplies(), history).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_INVALID_JSON',
    );
  });

  /** Target: embedded history identity. Dependencies: raw source-history fields. Scenario: each identity field disagrees with the RPC join. Expected: request context validation rejects the carrier. */
  it.each([
    [
      'sourceTxId',
      'other-signature',
      'SOLANA_REQUEST_HISTORY_SIGNATURE_MISMATCH',
    ],
    ['slot', '43', 'SOLANA_REQUEST_HISTORY_SLOT_MISMATCH'],
    [
      'clusterGenesisHash',
      'other-genesis',
      'SOLANA_REQUEST_HISTORY_GENESIS_MISMATCH',
    ],
  ] as const)(
    'rejects embedded history with a mismatched %s',
    async (field, value, cause) => {
      expect.assertions(1);
      const historyRaw = validHistory.replace(
        field === 'sourceTxId'
          ? 'request-signature'
          : field === 'slot'
            ? '42'
            : 'cluster-genesis',
        value,
      );
      const history = () => ({ requestContext, extractorHistory: historyRaw });
      await expectUnavailableCause(
        createProducerHarness(
          defaultReplies(),
          history,
        ).producer.getTransaction(SIGNATURE, BLOCKHASH),
        cause,
      );
    },
  );

  /** Target: history JSON. Dependencies: tuple adapter. Scenario: returned history is an array. Expected: reject non-object history bytes. */
  it('rejects non-object history JSON', async () => {
    expect.assertions(1);
    const history = () => ({ requestContext, extractorHistory: '[]' });
    await expectUnavailableCause(
      createProducerHarness(defaultReplies(), history).producer.getTransaction(
        SIGNATURE,
        BLOCKHASH,
      ),
      'SOLANA_RPC_INVALID_HISTORY',
    );
  });

  /** Target: concurrent request IDs. Dependencies: shared transport. Scenario: two transactions resolve concurrently. Expected: IDs remain unique and monotonic. */
  it('allocates unique IDs across concurrent requests', async () => {
    const transport = vi.fn(async (request: { id: number; method: string }) => {
      const result =
        request.method === 'getGenesisHash'
          ? JSON.stringify(GENESIS)
          : request.method === 'getTransaction'
            ? transactionResult()
            : blockResult();
      return rpcResponse(request.id, result);
    });
    const { context } = createProducerHarness();
    const { createSolanaEventRequestProducer } = await import(
      '../lib/solanaEventRequestProducer'
    );
    const producer = createSolanaEventRequestProducer({ context, transport });
    await Promise.all([
      producer.getTransaction(SIGNATURE, BLOCKHASH),
      producer.getTransaction(SIGNATURE, BLOCKHASH),
    ]);
    const ids = transport.mock.calls.map(([request]) => request.id);
    expect(new Set(ids).size).toBe(6);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /** Target: factory input snapshot. Dependencies: mutable options object. Scenario: transport property changes after creation. Expected: calls continue through the captured transport. */
  it('captures the transport function when the producer is created', async () => {
    const { context } = createProducerHarness();
    const replies = defaultReplies();
    const originalTransport = vi.fn(
      async (request: { id: number }) => replies[request.id - 1],
    );
    const options = { context, transport: originalTransport };
    const { createSolanaEventRequestProducer } = await import(
      '../lib/solanaEventRequestProducer'
    );
    const producer = createSolanaEventRequestProducer(options);
    options.transport = vi.fn(async () => {
      throw new Error('replacement transport used');
    });
    await expect(
      producer.getTransaction(SIGNATURE, BLOCKHASH),
    ).resolves.toBeDefined();
    expect(originalTransport).toHaveBeenCalledTimes(3);
  });
});
