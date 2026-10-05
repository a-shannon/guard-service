import { describe, expect, it, vi } from 'vitest';

import { createSolanaEventContext } from '../lib/requestBoundEventContext';
import { createSolanaEventReadSession } from '../lib/solanaEventRequestProducer';
import type {
  SolanaEventReadSessionOptions,
  SolanaRpcRequest,
} from '../lib/solanaEventRequestProducer';
import { createMockSolanaExtractor } from './mocked/requestBoundEventContext.mock';
import { createSessionHarness } from './mocked/solanaEventReadSession.mock';
import {
  INVALID_SESSION_SIGNATURE_BLOCKS,
  BLOCK_HEIGHT,
  PARENT_HASH,
  SECOND_SIGNATURE,
  SLOT,
} from './solanaEventReadSessionTestData';
import {
  multiSignatureBlockResult,
  sessionReplies,
} from './solanaEventReadSessionTestUtils';
import {
  blockResult,
  rpcResponse,
  transactionResult,
} from './solanaEventRequestProducerTestUtils';
import { BLOCKHASH, GENESIS, SIGNATURE } from './testData';

describe('createSolanaEventReadSession', () => {
  /** Target: one immutable block snapshot. Dependencies: locator and finalized block RPC. Scenario: all reads succeed. Expected: IDs, block info and transaction join share the captured coordinates. */
  it('captures one block and correlates all session reads to it', async () => {
    const { create, transport } = createSessionHarness();
    const session = await create();

    expect(await session.getBlockTransactionIds(BLOCKHASH)).toEqual([
      SIGNATURE,
    ]);
    expect(await session.getBlockInfo(BLOCKHASH)).toEqual({
      hash: BLOCKHASH,
      parentHash: PARENT_HASH,
      height: BLOCK_HEIGHT,
    });
    const transaction = await session.getTransaction(SIGNATURE, BLOCKHASH);

    expect(transaction.observedSignature).toEqual(SIGNATURE);
    expect(transaction.observedSlot).toEqual(SLOT);
    expect(
      transport.mock.calls.map(([request]) => [request.method, request.id]),
    ).toEqual([
      ['getGenesisHash', 1],
      ['getBlock', 2],
      ['getGenesisHash', 3],
      ['getTransaction', 4],
    ]);
  });

  /** Target: locator binding. Dependencies: caller-supplied block locator. Scenario: locator returns another hash. Expected: fail closed before any RPC call. */
  it('rejects a locator hash that differs from the requested block', async () => {
    const { create, transport } = createSessionHarness(
      sessionReplies(),
      () => ({
        genesisHash: GENESIS,
        blockhash: 'other-blockhash',
        slot: SLOT,
        blockHeight: BLOCK_HEIGHT,
        parentHash: PARENT_HASH,
      }),
    );

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_LOCATION_HASH_MISMATCH' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  /** Target: locator presence. Dependencies: caller-supplied lookup. Scenario: lookup has no record. Expected: fail closed before a genesis or block request. */
  it('rejects a missing locator record before reading the network', async () => {
    const { create, transport } = createSessionHarness(
      sessionReplies(),
      () => undefined,
    );

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_BLOCK_LOCATION_MISSING' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * @target createSolanaEventReadSession request identity validation
   * @dependencies caller-supplied requested blockhash and locator
   * @scenario call session creation with an empty or non-string identity
   * @expected the missing-identity cause is returned without lookup or RPC
   */
  it.each([
    ['empty', ''],
    ['null', null],
    ['number', 42],
  ] as const)(
    'rejects a %s requested blockhash before lookup or RPC',
    async (_name, requestedBlockhash) => {
      const { create, transport } = createSessionHarness();

      await expect(create(requestedBlockhash as string)).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: 'SOLANA_REQUEST_IDENTITY_MISSING' },
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  /**
   * @target createSolanaEventReadSession locator-shape validation
   * @dependencies caller-supplied block locator
   * @scenario return a null, array, or primitive instead of a location record
   * @expected each malformed shape fails before any RPC call
   */
  it.each([
    ['null', null],
    ['array', []],
    ['string', 'not-a-location'],
  ] as const)(
    'rejects a locator with %s shape before RPC',
    async (_name, located) => {
      const { create, transport } = createSessionHarness(
        sessionReplies(),
        () => located as never,
      );

      await expect(create()).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: 'SOLANA_SESSION_BLOCK_LOCATION_MISSING' },
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  /**
   * @target createSolanaEventReadSession genesis-slot boundary
   * @dependencies caller-supplied block locator
   * @scenario locate a non-genesis hash at slot zero
   * @expected capture rejects the unsupported genesis slot before RPC
   */
  it('rejects a located block at slot zero before RPC', async () => {
    const { create, transport } = createSessionHarness(
      sessionReplies(),
      () => ({
        genesisHash: GENESIS,
        blockhash: BLOCKHASH,
        slot: 0,
        blockHeight: BLOCK_HEIGHT,
        parentHash: PARENT_HASH,
      }),
    );

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_GENESIS_SLOT_UNSUPPORTED' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  /** Target: locator snapshot. Dependencies: mutable caller-owned record. Scenario: caller mutates the record after capture. Expected: session methods keep the captured coordinates. */
  it('snapshots locator coordinates before caller mutation', async () => {
    const location = {
      genesisHash: GENESIS,
      blockhash: BLOCKHASH,
      slot: SLOT,
      blockHeight: BLOCK_HEIGHT,
      parentHash: PARENT_HASH,
    };
    const { create } = createSessionHarness(sessionReplies(), () => location);
    const session = await create();
    location.blockhash = 'caller-mutated-hash';
    location.slot = 99;
    location.blockHeight = 99;
    location.parentHash = 'caller-mutated-parent';

    expect(await session.getBlockInfo(BLOCKHASH)).toEqual({
      hash: BLOCKHASH,
      parentHash: PARENT_HASH,
      height: BLOCK_HEIGHT,
    });
    expect(await session.getBlockTransactionIds(BLOCKHASH)).toEqual([
      SIGNATURE,
    ]);
  });

  /** Target: locator coordinate bounds. Dependencies: locator scalar validation. Scenario: one identity or coordinate is malformed at a time. Expected: each malformed field is rejected before RPC. */
  it.each([
    ['genesisHash', '', 'SOLANA_SESSION_INVALID_LOCATION:genesisHash'],
    ['blockhash', '', 'SOLANA_SESSION_INVALID_LOCATION:blockhash'],
    ['parentHash', '', 'SOLANA_SESSION_INVALID_LOCATION:parentHash'],
    ['slot', -1, 'SOLANA_SESSION_INVALID_LOCATION:slot'],
    ['slot', 1.5, 'SOLANA_SESSION_INVALID_LOCATION:slot'],
    [
      'slot',
      Number.MAX_SAFE_INTEGER + 1,
      'SOLANA_SESSION_INVALID_LOCATION:slot',
    ],
    ['genesisHash', 7, 'SOLANA_SESSION_INVALID_LOCATION:genesisHash'],
    ['blockhash', 7, 'SOLANA_SESSION_INVALID_LOCATION:blockhash'],
    ['parentHash', 7, 'SOLANA_SESSION_INVALID_LOCATION:parentHash'],
    ['blockHeight', -1, 'SOLANA_SESSION_INVALID_LOCATION:blockHeight'],
    [
      'blockHeight',
      Number.MAX_SAFE_INTEGER + 1,
      'SOLANA_SESSION_INVALID_LOCATION:blockHeight',
    ],
  ] as const)(
    'rejects malformed locator field %s',
    async (field, value, cause) => {
      const { create, transport } = createSessionHarness(
        sessionReplies(),
        () => {
          const location = {
            genesisHash: GENESIS,
            blockhash: BLOCKHASH,
            slot: SLOT,
            blockHeight: BLOCK_HEIGHT,
            parentHash: PARENT_HASH,
          };
          (location as Record<string, unknown>)[field] = value;
          return location;
        },
      );

      await expect(create()).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: cause },
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  /** Target: cluster binding. Dependencies: resolved profile and locator. Scenario: located block belongs to another cluster. Expected: no RPC call is made. */
  it('rejects a locator from another genesis cluster', async () => {
    const { create, transport } = createSessionHarness(
      sessionReplies(),
      () => ({
        genesisHash: 'other-genesis',
        blockhash: BLOCKHASH,
        slot: SLOT,
        blockHeight: BLOCK_HEIGHT,
        parentHash: PARENT_HASH,
      }),
    );

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_LOCATION_GENESIS_MISMATCH' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * @target createSolanaEventReadSession RPC cluster binding
   * @dependencies finalized genesis-hash RPC response
   * @scenario the RPC endpoint reports a genesis hash different from profile
   * @expected capture rejects with the RPC genesis cause after one call
   */
  it('rejects an RPC endpoint whose genesis hash differs from the profile', async () => {
    const { create, transport } = createSessionHarness([
      rpcResponse(1, JSON.stringify('other-genesis')),
    ]);

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_RPC_GENESIS_MISMATCH' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  /**
   * @target createSolanaEventReadSession response correlation
   * @dependencies genesis-hash and finalized block RPC responses
   * @scenario return a response ID that does not match each capture request
   * @expected capture rejects with the ID cause and stops at the bad response
   */
  it.each([
    ['genesis response', [rpcResponse(99, JSON.stringify(GENESIS))], 1],
    [
      'block response',
      [
        rpcResponse(1, JSON.stringify(GENESIS)),
        rpcResponse(
          99,
          blockResult({
            extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
          }),
        ),
      ],
      2,
    ],
  ] as const)(
    'rejects a mismatched ID in the %s',
    async (_stage, replies, rpcCount) => {
      const { create, transport } = createSessionHarness([...replies]);

      await expect(create()).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: 'SOLANA_RPC_ID_MISMATCH' },
      });
      expect(transport).toHaveBeenCalledTimes(rpcCount);
    },
  );

  /**
   * @target createSolanaEventReadSession finalized block validation
   * @dependencies getBlock result envelope
   * @scenario the result is null or omits the transactions array
   * @expected capture rejects with the specific block cause after two RPCs
   */
  it.each([
    ['null block', 'null', 'SOLANA_RPC_INVALID_BLOCK'],
    [
      'missing transactions',
      blockResult({
        includeTransactions: false,
        extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
      }),
      'SOLANA_RPC_BLOCK_TRANSACTIONS_MISSING',
    ],
  ] as const)(
    'rejects a finalized block with %s',
    async (_case, block, cause) => {
      const { create, transport } = createSessionHarness([
        rpcResponse(1, JSON.stringify(GENESIS)),
        rpcResponse(2, block),
      ]);

      await expect(create()).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: cause },
      });
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  /**
   * @target createSolanaEventReadSession captured transaction list
   * @dependencies a valid finalized block with no transaction entries
   * @scenario capture an empty transactions array and read both session views
   * @expected the empty list and validated block information remain available
   */
  it('accepts an empty finalized block and returns its captured information', async () => {
    const emptyBlock = blockResult({
      copies: 0,
      extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
    });
    const { create } = createSessionHarness(sessionReplies(emptyBlock));
    const session = await create();

    expect(await session.getBlockTransactionIds(BLOCKHASH)).toEqual([]);
    expect(await session.getBlockInfo(BLOCKHASH)).toEqual({
      hash: BLOCKHASH,
      parentHash: PARENT_HASH,
      height: BLOCK_HEIGHT,
    });
  });

  /**
   * @target createSolanaEventReadSession block signature capture
   * @dependencies finalized block transaction entries
   * @scenario an entry has no usable first signature string
   * @expected capture rejects each malformed signature before exposing a session
   */
  it.each(INVALID_SESSION_SIGNATURE_BLOCKS)(
    'rejects a block entry with a $name first signature',
    async ({ result }) => {
      const { create, transport } = createSessionHarness([
        rpcResponse(1, JSON.stringify(GENESIS)),
        rpcResponse(2, result),
      ]);

      await expect(create()).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: 'SOLANA_SESSION_BLOCK_SIGNATURE_MISSING' },
      });
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  /**
   * @target session-bound transaction slot validation
   * @dependencies captured block snapshot and getTransaction response
   * @scenario the selected transaction reports a slot outside the captured block
   * @expected the session returns the slot-mismatch cause after four RPC calls
   */
  it('rejects a selected transaction from a different slot', async () => {
    const replies = [
      rpcResponse(1, JSON.stringify(GENESIS)),
      rpcResponse(
        2,
        blockResult({
          extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
        }),
      ),
      rpcResponse(3, JSON.stringify(GENESIS)),
      rpcResponse(4, transactionResult({ slot: '43' })),
    ];
    const { create, transport } = createSessionHarness(replies);
    const session = await create();

    await expect(
      session.getTransaction(SIGNATURE, BLOCKHASH),
    ).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_TRANSACTION_SLOT_MISMATCH' },
    });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  /**
   * @target createSolanaEventReadSession input snapshot
   * @dependencies getter-backed options, locator coordinates, and RPC transport
   * @scenario options await locator; then source fields change before RPC begins
   * @expected captured functions and coordinates are each read once and retained
   */
  it('snapshots option getters and locator fields before RPC awaits', async () => {
    const counts = {
      context: 0,
      transport: 0,
      getHistory: 0,
      locateBlock: 0,
      genesisHash: 0,
      blockhash: 0,
      slot: 0,
      blockHeight: 0,
      parentHash: 0,
    };
    const values = {
      genesisHash: GENESIS,
      blockhash: BLOCKHASH,
      slot: SLOT,
      blockHeight: BLOCK_HEIGHT,
      parentHash: PARENT_HASH,
    };
    const location = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(values).map(([field]) => [
          field,
          {
            enumerable: true,
            get: () => {
              counts[field as keyof typeof values]++;
              return values[field as keyof typeof values];
            },
          },
        ]),
      ),
    );
    let releaseLocator!: () => void;
    const locatorGate = new Promise<void>((resolve) => {
      releaseLocator = resolve;
    });
    let activeTransport: SolanaEventReadSessionOptions['transport'];
    let activeHistory: SolanaEventReadSessionOptions['getHistory'];
    const context = createSolanaEventContext(createMockSolanaExtractor());
    const originalProfile = context.resolvedProfile;
    const replacementContext = createSolanaEventContext(
      createMockSolanaExtractor(),
    );
    const history = vi.fn(async () => undefined);
    const originalTransport = vi.fn(async (request: SolanaRpcRequest) => {
      if (request.id === 1) {
        Object.assign(values, {
          blockhash: 'mutated-blockhash',
          slot: 99,
          blockHeight: 99,
          parentHash: 'mutated-parent',
        });
        return rpcResponse(1, JSON.stringify(GENESIS));
      }
      return rpcResponse(
        2,
        blockResult({
          extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
        }),
      );
    });
    const replacementTransport = vi.fn(async () => {
      throw new Error('REPLACEMENT_TRANSPORT_USED');
    });
    const replacementHistory = vi.fn(async () => undefined);
    const active = {
      context,
      transport: originalTransport,
      getHistory: history,
      locateBlock: async () => {
        await locatorGate;
        return location as never;
      },
    };
    activeTransport = active.transport;
    activeHistory = active.getHistory;
    const options = Object.defineProperties(
      {},
      {
        context: {
          get: () => {
            counts.context++;
            return active.context;
          },
        },
        transport: {
          get: () => {
            counts.transport++;
            return activeTransport;
          },
        },
        getHistory: {
          get: () => {
            counts.getHistory++;
            return activeHistory;
          },
        },
        locateBlock: {
          get: () => {
            counts.locateBlock++;
            return active.locateBlock;
          },
        },
      },
    ) as SolanaEventReadSessionOptions;

    const pending = createSolanaEventReadSession(options, BLOCKHASH);
    await Promise.resolve();
    activeTransport = replacementTransport;
    activeHistory = replacementHistory;
    active.context = replacementContext;
    releaseLocator();
    const session = await pending;

    expect(counts).toEqual({
      context: 1,
      transport: 1,
      getHistory: 1,
      locateBlock: 1,
      genesisHash: 1,
      blockhash: 1,
      slot: 1,
      blockHeight: 1,
      parentHash: 1,
    });
    expect(originalTransport).toHaveBeenCalledTimes(2);
    expect(replacementTransport).not.toHaveBeenCalled();
    expect(await session.getBlockInfo(BLOCKHASH)).toEqual({
      hash: BLOCKHASH,
      parentHash: PARENT_HASH,
      height: BLOCK_HEIGHT,
    });
    const transactionReplies = [
      rpcResponse(3, JSON.stringify(GENESIS)),
      rpcResponse(4, transactionResult()),
    ];
    originalTransport.mockImplementation(
      async () => transactionReplies.shift() ?? '',
    );
    const transaction = await session.getTransaction(SIGNATURE, BLOCKHASH);
    expect(transaction.observedSlot).toEqual(SLOT);
    expect(transaction.resolvedProfile).toBe(originalProfile);
    expect(history).toHaveBeenCalledTimes(1);
    expect(replacementHistory).not.toHaveBeenCalled();
  });

  /** Target: finalized block coordinates. Dependencies: located tuple and full-block RPC. Scenario: one returned block coordinate disagrees at a time. Expected: the session rejects each disagreement. */
  it.each([
    [
      'block hash',
      blockResult({
        blockhash: 'rpc-other-blockhash',
        extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
      }),
      'SOLANA_RPC_CONTAINING_BLOCKHASH_MISMATCH',
    ],
    [
      'block height',
      blockResult({
        blockHeight: '38',
        extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
      }),
      'SOLANA_SESSION_BLOCK_HEIGHT_MISMATCH',
    ],
    [
      'parent hash',
      blockResult({
        extraFields: '"previousBlockhash":"rpc-other-parent","parentSlot":41',
      }),
      'SOLANA_SESSION_PARENT_HASH_MISMATCH',
    ],
  ] as const)(
    'rejects a finalized block with a mismatched %s',
    async (_field, block, cause) => {
      const { create } = createSessionHarness(sessionReplies(block));

      await expect(create()).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: cause },
      });
    },
  );

  /** Target: block membership uniqueness. Dependencies: full-block signature list. Scenario: one signature appears twice. Expected: session capture rejects duplicate ownership. */
  it('rejects duplicate transaction signatures in the captured block', async () => {
    const { create } = createSessionHarness(
      sessionReplies(
        blockResult({
          copies: 2,
          extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
        }),
      ),
    );

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_DUPLICATE_SIGNATURE' },
    });
  });

  /** Target: session ownership. Dependencies: captured block identity. Scenario: a foreign hash is passed to each read method. Expected: no foreign read is issued and every method rejects. */
  it('rejects foreign block hashes after capture without issuing RPC', async () => {
    const { create, transport } = createSessionHarness();
    const session = await create();
    const callsBefore = transport.mock.calls.length;

    await expect(
      session.getBlockTransactionIds('foreign'),
    ).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_FOREIGN_BLOCK' },
    });
    await expect(session.getBlockInfo('foreign')).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_FOREIGN_BLOCK' },
    });
    await expect(
      session.getTransaction(SIGNATURE, 'foreign'),
    ).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_FOREIGN_BLOCK' },
    });

    expect(transport.mock.calls).toHaveLength(callsBefore);
  });

  /** Target: returned-value isolation. Dependencies: captured signatures and block info. Scenario: caller mutates returned values. Expected: future reads remain unchanged. */
  it('returns independent transaction IDs and immutable block coordinates', async () => {
    const { create } = createSessionHarness();
    const session = await create();
    const ids = await session.getBlockTransactionIds(BLOCKHASH);
    ids.push('caller-only-signature');
    expect(await session.getBlockTransactionIds(BLOCKHASH)).toEqual([
      SIGNATURE,
    ]);

    const info = await session.getBlockInfo(BLOCKHASH);
    expect(() => {
      (info as { height: number }).height = 99;
    }).toThrow();
    expect(await session.getBlockInfo(BLOCKHASH)).toEqual({
      hash: BLOCKHASH,
      parentHash: PARENT_HASH,
      height: BLOCK_HEIGHT,
    });
  });

  /** Target: session ownership. Dependencies: two independent transports and locators. Scenario: sessions are created and read in an interleaved order. Expected: each session retains its own block coordinates and RPC counter. */
  it('keeps interleaved sessions independent', async () => {
    const secondHash = 'second-blockhash';
    const secondParent = 'second-parenthash';
    const first = createSessionHarness();
    const second = createSessionHarness(
      [
        rpcResponse(1, JSON.stringify(GENESIS)),
        rpcResponse(
          2,
          blockResult({
            blockhash: secondHash,
            blockHeight: '48',
            signature: SECOND_SIGNATURE,
            extraFields: `"previousBlockhash":"${secondParent}","parentSlot":52`,
          }),
        ),
        rpcResponse(3, JSON.stringify(GENESIS)),
        rpcResponse(
          4,
          transactionResult({ slot: '53', signature: SECOND_SIGNATURE }),
        ),
      ],
      () => ({
        genesisHash: GENESIS,
        blockhash: secondHash,
        slot: 53,
        blockHeight: 48,
        parentHash: secondParent,
      }),
    );
    const [firstSession, secondSession] = await Promise.all([
      first.create(),
      second.create(secondHash),
    ]);

    expect(await secondSession.getBlockInfo(secondHash)).toEqual({
      hash: secondHash,
      parentHash: secondParent,
      height: 48,
    });
    expect(await firstSession.getBlockInfo(BLOCKHASH)).toEqual({
      hash: BLOCKHASH,
      parentHash: PARENT_HASH,
      height: BLOCK_HEIGHT,
    });
    await expect(secondSession.getBlockInfo(BLOCKHASH)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_FOREIGN_BLOCK' },
    });
    const [firstTransaction, secondTransaction] = await Promise.all([
      firstSession.getTransaction(SIGNATURE, BLOCKHASH),
      secondSession.getTransaction(SECOND_SIGNATURE, secondHash),
    ]);
    expect(firstTransaction.observedSignature).toEqual(SIGNATURE);
    expect(firstTransaction.observedSlot).toEqual(SLOT);
    expect(secondTransaction.observedSignature).toEqual(SECOND_SIGNATURE);
    expect(secondTransaction.observedSlot).toEqual(53);
    expect(first.transport.mock.calls.map(([request]) => request.id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(second.transport.mock.calls.map(([request]) => request.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  /**
   * @target concurrent reads from one captured session
   * @dependencies two captured signature entries and out-of-order RPC responses
   * @scenario request two matching transactions with responses completing in reverse order
   * @expected each result retains its signature and slot despite completion order
   */
  it('joins concurrent transactions by signature when RPC replies arrive out of order', async () => {
    const block = multiSignatureBlockResult([SIGNATURE, SECOND_SIGNATURE], {
      blockhash: BLOCKHASH,
      blockHeight: BLOCK_HEIGHT,
      parentHash: PARENT_HASH,
      parentSlot: 41,
    });
    const completionOrder: string[] = [];
    const transport = vi.fn(async (request: SolanaRpcRequest) => {
      if (request.method === 'getGenesisHash')
        return rpcResponse(request.id, JSON.stringify(GENESIS));
      if (request.method === 'getBlock') return rpcResponse(request.id, block);
      if (request.method === 'getTransaction') {
        const signature = request.params[0] as string;
        await new Promise((resolve) =>
          setTimeout(resolve, signature === SIGNATURE ? 20 : 0),
        );
        completionOrder.push(signature);
        return rpcResponse(request.id, transactionResult({ signature }));
      }
      throw new Error('UNEXPECTED_RPC_METHOD');
    });
    const context = createSolanaEventContext(createMockSolanaExtractor());
    const session = await createSolanaEventReadSession(
      {
        context,
        transport,
        locateBlock: () => ({
          genesisHash: GENESIS,
          blockhash: BLOCKHASH,
          slot: SLOT,
          blockHeight: BLOCK_HEIGHT,
          parentHash: PARENT_HASH,
        }),
      },
      BLOCKHASH,
    );

    const [first, second] = await Promise.all([
      session.getTransaction(SIGNATURE, BLOCKHASH),
      session.getTransaction(SECOND_SIGNATURE, BLOCKHASH),
    ]);

    expect(completionOrder).toEqual([SECOND_SIGNATURE, SIGNATURE]);
    expect(first.observedSignature).toEqual(SIGNATURE);
    expect(first.observedSlot).toEqual(SLOT);
    expect(second.observedSignature).toEqual(SECOND_SIGNATURE);
    expect(second.observedSlot).toEqual(SLOT);
    expect(transport).toHaveBeenCalledTimes(6);
  });

  /** Target: block ancestry. Dependencies: finalized block response. Scenario: parent slot is not before the located slot. Expected: capture rejects before exposing a session. */
  it('rejects a block whose parent slot is not older than the located slot', async () => {
    const { create } = createSessionHarness(
      sessionReplies(
        blockResult({
          extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":42`,
        }),
      ),
    );

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_PARENT_SLOT_ORDER' },
    });
  });

  /**
   * @target createSolanaEventReadSession parent-slot parsing
   * @dependencies finalized block response with a missing parentSlot
   * @scenario parent hash is valid but parentSlot is absent
   * @expected capture rejects the missing integer with the parser failure code
   */
  it('rejects a finalized block with no parent slot', async () => {
    const { create, transport } = createSessionHarness(
      sessionReplies(
        blockResult({
          extraFields: `"previousBlockhash":"${PARENT_HASH}"`,
        }),
      ),
    );

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_RPC_INVALID_PARENTSLOT' },
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  /**
   * @target createSolanaEventReadSession parent-slot parsing
   * @dependencies finalized block response with a fractional parentSlot
   * @scenario parent hash is valid and parentSlot cannot be parsed as an integer
   * @expected capture rejects the fractional value with the parser failure code
   */
  it('rejects a finalized block with a fractional parent slot', async () => {
    const { create, transport } = createSessionHarness(
      sessionReplies(
        blockResult({
          extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41.5`,
        }),
      ),
    );

    await expect(create()).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_RPC_INVALID_PARENTSLOT' },
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
