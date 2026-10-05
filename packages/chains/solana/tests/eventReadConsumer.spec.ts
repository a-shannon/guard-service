import { describe, expect, it, vi } from 'vitest';

import type { SolanaEventReadSession } from '../lib/abstractSolanaNetwork';
import { createSolanaEventContext } from '../lib/requestBoundEventContext';
import type { SolanaEventContext } from '../lib/requestBoundEventContext';
import {
  EVENT_A,
  EVENT_B,
  EVENT_MUTATION_CASES,
  CALLBACK_MUTATION_FIELDS,
  EVENT_NOT_IN_BLOCK,
  EVENT_READ_FEES,
  EVENT_READ_FIXTURES,
  EVENT_A_BLOCKHASH,
  TEST_GENESIS,
} from './eventReadConsumerTestData';
import {
  createSessionOptions,
  deferred,
  type MutableSessionOptions,
} from './eventReadConsumerTestUtils';
import {
  createEventExtractor,
  TestSolanaEventChain,
  TestSolanaNetwork,
} from './mocked/eventReadConsumer.mock';

describe('AbstractSolanaEventChain event reads', () => {
  /**
   * @target the abstract consumer exposes canonical Solana identifiers
   * @dependencies the public chain fields and extractor-published native token id
   * @scenario construct the consumer with its focused network and extractor
   * @expected CHAIN is the public literal and NATIVE_TOKEN_ID matches the fixture
   */
  it('exposes the Solana chain and native token identities', () => {
    const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES);
    const network = new TestSolanaNetwork(sessionFixture.options);
    const { extractor } = createEventExtractor(EVENT_READ_FIXTURES);
    const chain = new TestSolanaEventChain(network, extractor);

    expect(chain.CHAIN).toBe('solana');
    expect(chain.NATIVE_TOKEN_ID).toBe(EVENT_A.sourceChainTokenId);
  });

  /**
   * @target each event verification owns one fresh Solana read session
   * @dependencies real context/session factories, two distinct events, deferred RPC
   * @scenario hold event A's transaction read while event B completes
   * @expected both events use the same chain context through isolated readers
   */
  it('isolates interleaved events while reusing one captured context', async () => {
    const transactionStarted = deferred<void>();
    const releaseTransaction = deferred<void>();
    const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES, {
      beforeTransaction: async ({ event }) => {
        if (event.sourceTxId === EVENT_A.sourceTxId) {
          transactionStarted.resolve(undefined);
          await releaseTransaction.promise;
        }
      },
    });
    const network = new TestSolanaNetwork(sessionFixture.options);
    const { extractor, getResolvedProfile, getWithContext, get } =
      createEventExtractor(EVENT_READ_FIXTURES);
    const originalFactory = network.createEventReadSession;
    const contexts: SolanaEventContext[] = [];
    const capturedFactory = vi.fn(
      (context: SolanaEventContext, blockhash: string) => {
        contexts.push(context);
        return originalFactory(context, blockhash);
      },
    );
    const replacementFactory = vi.fn(capturedFactory);
    let factoryPropertyReads = 0;
    Object.defineProperty(network, 'createEventReadSession', {
      configurable: true,
      get: () => {
        factoryPropertyReads++;
        return factoryPropertyReads === 1
          ? capturedFactory
          : replacementFactory;
      },
    });
    const chain = new TestSolanaEventChain(network, extractor);

    const verificationA = chain.verifyEvent(EVENT_A, EVENT_READ_FEES);
    await transactionStarted.promise;
    await expect(chain.verifyEvent(EVENT_B, EVENT_READ_FEES)).resolves.toBe(
      true,
    );
    releaseTransaction.resolve(undefined);
    await expect(verificationA).resolves.toBe(true);

    expect(factoryPropertyReads).toBe(1);
    expect(capturedFactory).toHaveBeenCalledTimes(2);
    expect(replacementFactory).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(getResolvedProfile).toHaveBeenCalledTimes(1);
    expect(getWithContext).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(sessionFixture.transport).toHaveBeenCalled();
    expect(network.defaultReads.getBlockTransactionIds).not.toHaveBeenCalled();
    expect(network.defaultReads.getTransaction).not.toHaveBeenCalled();
    expect(network.defaultReads.getBlockInfo).not.toHaveBeenCalled();
  });

  /**
   * @target event verification snapshots its scalar input before its first await
   * @dependencies a held block locator, original event A and one-field B mutations
   * @scenario mutate one caller-owned event field after the locator receives A
   * @expected the read session and event comparison continue to use A coordinates
   */
  it.each(EVENT_MUTATION_CASES)(
    'keeps the original event when $field changes during block location',
    async ({ field, value }) => {
      const mutableEvent = { ...EVENT_A };
      const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES);
      const originalLocateBlock = sessionFixture.locateBlock;
      const locatorStarted = deferred<string>();
      const releaseLocator = deferred<void>();
      const heldLocateBlock = vi.fn(async (blockhash: string) => {
        locatorStarted.resolve(blockhash);
        await releaseLocator.promise;
        return originalLocateBlock(blockhash);
      });
      sessionFixture.options.locateBlock = heldLocateBlock;
      const network = new TestSolanaNetwork(sessionFixture.options);
      const { extractor, getWithContext, get } =
        createEventExtractor(EVENT_READ_FIXTURES);
      const chain = new TestSolanaEventChain(network, extractor);

      const verification = chain.verifyEvent(mutableEvent, EVENT_READ_FEES);
      const locatedHash = await locatorStarted.promise;
      Object.assign(mutableEvent, { [field]: value });
      releaseLocator.resolve(undefined);

      await expect(verification).resolves.toBe(true);

      expect(locatedHash).toBe(EVENT_A_BLOCKHASH);
      expect(heldLocateBlock).toHaveBeenCalledTimes(1);
      expect(heldLocateBlock).toHaveBeenCalledWith(EVENT_A_BLOCKHASH);
      expect(originalLocateBlock).toHaveBeenCalledTimes(1);
      expect(originalLocateBlock).toHaveBeenCalledWith(EVENT_A_BLOCKHASH);

      const requests = sessionFixture.transport.mock.calls.map(
        ([request]) => request,
      );
      const blockRequest = requests.find(
        (request) => request.method === 'getBlock',
      );
      const transactionRequest = requests.find(
        (request) => request.method === 'getTransaction',
      );
      expect(blockRequest?.params[0]).toBe(EVENT_READ_FIXTURES[0].slot);
      expect(transactionRequest?.params[0]).toBe(EVENT_A.sourceTxId);
      expect(sessionFixture.getHistory).toHaveBeenCalledTimes(1);
      expect(sessionFixture.getHistory.mock.calls[0]?.[0]).toEqual({
        signature: EVENT_A.sourceTxId,
        slot: EVENT_READ_FIXTURES[0].slot,
        blockhash: EVENT_A_BLOCKHASH,
        blockHeight: EVENT_A.sourceChainHeight,
        transactionIndex: 0,
        genesis: TEST_GENESIS,
      });

      expect(getWithContext).toHaveBeenCalledTimes(1);
      const contextualInput = JSON.parse(
        getWithContext.mock.calls[0]?.[0] ?? 'null',
      );
      expect(contextualInput).toMatchObject({
        blockhash: EVENT_A_BLOCKHASH,
        clusterGenesisHash: TEST_GENESIS,
        slot: EVENT_READ_FIXTURES[0].slot,
        transaction: { signatures: [EVENT_A.sourceTxId] },
      });
      expect(get).toHaveBeenCalledTimes(1);
      const extractedInput = JSON.parse(get.mock.calls[0]?.[0] ?? 'null');
      expect(extractedInput).toMatchObject({
        blockhash: EVENT_A_BLOCKHASH,
        transaction: { signatures: [EVENT_A.sourceTxId] },
      });
      expect(mutableEvent[field]).toBe(value);
      expect(EVENT_A[field]).not.toBe(value);
    },
  );

  /**
   * @target event membership short-circuits later transaction reads
   * @dependencies one real session whose block omits the event signature
   * @scenario verify an event with a block hash present but transaction absent
   * @expected false without a transaction RPC, history lookup or default read
   */
  it('returns false when the event transaction is absent from its block', async () => {
    const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES);
    const network = new TestSolanaNetwork(sessionFixture.options);
    const { extractor } = createEventExtractor(EVENT_READ_FIXTURES);
    const chain = new TestSolanaEventChain(network, extractor);

    await expect(
      chain.verifyEvent(EVENT_NOT_IN_BLOCK, EVENT_READ_FEES),
    ).resolves.toBe(false);

    expect(sessionFixture.transport).toHaveBeenCalledTimes(2);
    expect(sessionFixture.getHistory).not.toHaveBeenCalled();
    expect(network.defaultReads.getBlockTransactionIds).not.toHaveBeenCalled();
    expect(network.defaultReads.getTransaction).not.toHaveBeenCalled();
    expect(network.defaultReads.getBlockInfo).not.toHaveBeenCalled();
  });

  /**
   * @target session creation errors remain visible to the caller
   * @dependencies a locator that has no record for the requested block
   * @scenario verify an event before its block can be located
   * @expected reject with the factory's unavailable error and original cause
   */
  it('propagates an unavailable session factory result', async () => {
    const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES);
    sessionFixture.options.locateBlock = vi.fn(async () => undefined);
    const network = new TestSolanaNetwork(sessionFixture.options);
    const { extractor } = createEventExtractor(EVENT_READ_FIXTURES);
    const chain = new TestSolanaEventChain(network, extractor);

    await expect(
      chain.verifyEvent(EVENT_A, EVENT_READ_FEES),
    ).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_SESSION_BLOCK_LOCATION_MISSING' },
    });
    expect(sessionFixture.transport).not.toHaveBeenCalled();
    expect(network.defaultReads.getBlockTransactionIds).not.toHaveBeenCalled();
  });

  /**
   * @target transaction availability errors retain the existing skip-event rejection
   * @dependencies a valid session and one failing transaction RPC response
   * @scenario fail only the requested transaction after its block was captured
   * @expected reject through AbstractChain's existing retryable error path
   */
  it('throws when the captured transaction read is unavailable', async () => {
    const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES, {
      failedTransactionSignature: EVENT_A.sourceTxId,
    });
    const network = new TestSolanaNetwork(sessionFixture.options);
    const { extractor } = createEventExtractor(EVENT_READ_FIXTURES);
    const chain = new TestSolanaEventChain(network, extractor);

    await expect(chain.verifyEvent(EVENT_A, EVENT_READ_FEES)).rejects.toThrow(
      /Skipping event .* validation: Error: SOLANA_REQUEST_UNAVAILABLE/,
    );
    expect(network.defaultReads.getBlockTransactionIds).not.toHaveBeenCalled();
    expect(network.defaultReads.getTransaction).not.toHaveBeenCalled();
    expect(network.defaultReads.getBlockInfo).not.toHaveBeenCalled();
  });

  /**
   * @target contextual lock verification accepts only carriers from its chain context
   * @dependencies two independently issued Solana event contexts
   * @scenario pass a valid foreign carrier to the chain's actual lock hook
   * @expected reject before consulting the local extractor
   */
  it('rejects a carrier issued by another event context at the lock hook', async () => {
    const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES);
    const network = new TestSolanaNetwork(sessionFixture.options);
    const local = createEventExtractor(EVENT_READ_FIXTURES);
    const chain = new TestSolanaEventChain(network, local.extractor);
    const foreign = createEventExtractor(EVENT_READ_FIXTURES);
    const foreignContext = createSolanaEventContext(foreign.extractor);
    const foreignCarrier = foreignContext.bindRequest({
      extractorInput: JSON.stringify({
        transaction: { signatures: [EVENT_A.sourceTxId] },
        blockhash: EVENT_A.sourceBlockId,
        slot: EVENT_READ_FIXTURES[0].slot,
        clusterGenesisHash: 'cluster-genesis',
        destinationNetwork: 'mainnet',
      }),
      requestedTxId: EVENT_A.sourceTxId,
      requestedBlockhash: EVENT_A.sourceBlockId,
      observedSlot: EVENT_READ_FIXTURES[0].slot,
      rosenBlockHeight: EVENT_A.sourceChainHeight,
    });

    await expect(
      chain.verifyLockTransactionExtraConditions(foreignCarrier, {
        hash: EVENT_A_BLOCKHASH,
        parentHash: 'parent-request-blockhash',
        height: EVENT_A.sourceChainHeight,
      }),
    ).rejects.toThrow('SOLANA_REQUEST_CARRIER_MISSING');
    expect(local.getWithContext).not.toHaveBeenCalled();
  });

  /**
   * @target network callbacks are captured by reference at construction
   * @dependencies mutable option object and one complete actual session read
   * @scenario replace exactly one callback reference after construction
   * @expected the session continues to use all three original callbacks
   */
  it.each(CALLBACK_MUTATION_FIELDS)(
    'keeps the original callback after %s option mutation',
    async (field) => {
      const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES);
      const options = sessionFixture.options;
      const network = new TestSolanaNetwork(options);
      const replacementTransport = vi.fn(async (): Promise<string> => {
        throw new Error('replacement transport used');
      });
      const replacementHistory = vi.fn(async () => {
        throw new Error('replacement history used');
      });
      const replacementLocator = vi.fn(async () => undefined);
      if (field === 'transport') options.transport = replacementTransport;
      else if (field === 'getHistory') options.getHistory = replacementHistory;
      else options.locateBlock = replacementLocator;
      const { extractor } = createEventExtractor(EVENT_READ_FIXTURES);
      const context = createSolanaEventContext(extractor);

      const transaction = network
        .createEventReadSession(context, EVENT_A.sourceBlockId)
        .then((session: SolanaEventReadSession) =>
          session.getTransaction(EVENT_A.sourceTxId, EVENT_A.sourceBlockId),
        );
      await expect(transaction).resolves.toMatchObject({
        observedSignature: EVENT_A.sourceTxId,
      });

      expect(sessionFixture.transport).toHaveBeenCalled();
      expect(sessionFixture.getHistory).toHaveBeenCalledTimes(1);
      expect(sessionFixture.locateBlock).toHaveBeenCalledTimes(1);
      expect(replacementTransport).not.toHaveBeenCalled();
      expect(replacementHistory).not.toHaveBeenCalled();
      expect(replacementLocator).not.toHaveBeenCalled();
    },
  );

  /**
   * @target callback option accessors are read once by the network constructor
   * @dependencies changing getters for transport, history and block location
   * @scenario create a complete transaction session after the first getter read
   * @expected no callback option getter is evaluated again
   */
  it('reads callback getters once and keeps their first values', async () => {
    const sessionFixture = createSessionOptions(EVENT_READ_FIXTURES);
    let transportReads = 0;
    let historyReads = 0;
    let locatorReads = 0;
    const replacementTransport = vi.fn(async (): Promise<string> => {
      throw new Error('replacement transport getter used');
    });
    const replacementHistory = vi.fn(async () => {
      throw new Error('replacement history getter used');
    });
    const replacementLocator = vi.fn(async () => undefined);
    const options: MutableSessionOptions = {
      get transport() {
        transportReads++;
        return transportReads === 1
          ? sessionFixture.transport
          : replacementTransport;
      },
      get getHistory() {
        historyReads++;
        return historyReads === 1
          ? sessionFixture.getHistory
          : replacementHistory;
      },
      get locateBlock() {
        locatorReads++;
        return locatorReads === 1
          ? sessionFixture.locateBlock
          : replacementLocator;
      },
    };
    const network = new TestSolanaNetwork(options);
    const { extractor } = createEventExtractor(EVENT_READ_FIXTURES);
    const context = createSolanaEventContext(extractor);
    const session = await network.createEventReadSession(
      context,
      EVENT_A.sourceBlockId,
    );
    await session.getTransaction(EVENT_A.sourceTxId, EVENT_A.sourceBlockId);

    expect(transportReads).toBe(1);
    expect(historyReads).toBe(1);
    expect(locatorReads).toBe(1);
    expect(sessionFixture.transport).toHaveBeenCalled();
    expect(sessionFixture.getHistory).toHaveBeenCalledTimes(1);
    expect(sessionFixture.locateBlock).toHaveBeenCalledTimes(1);
    expect(replacementTransport).not.toHaveBeenCalled();
    expect(replacementHistory).not.toHaveBeenCalled();
    expect(replacementLocator).not.toHaveBeenCalled();
  });
});
