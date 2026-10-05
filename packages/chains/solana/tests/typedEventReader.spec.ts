import { describe, expect, it, vi } from 'vitest';

import type { SolanaEventReadSession } from '../lib/abstractSolanaNetwork';
import { createSolanaEventContext } from '../lib/requestBoundEventContext';
import type {
  SolanaEventContext,
  SolanaEventTransaction,
} from '../lib/requestBoundEventContext';
import {
  EVENT_A,
  EVENT_READ_FEES,
  EVENT_READ_FIXTURES,
  TEST_GENESIS,
} from './eventReadConsumerTestData';
import { createSessionOptions } from './eventReadConsumerTestUtils';
import {
  createEventExtractor,
  TestSolanaEventChain,
  TestSolanaNetwork,
} from './mocked/eventReadConsumer.mock';

const requestFor = (context: SolanaEventContext): SolanaEventTransaction =>
  context.bindRequest({
    extractorInput: JSON.stringify({
      transaction: { signatures: [EVENT_A.sourceTxId] },
      blockhash: EVENT_A.sourceBlockId,
      slot: EVENT_READ_FIXTURES[0].slot,
      clusterGenesisHash: TEST_GENESIS,
      destinationNetwork: 'mainnet',
      history: null,
    }),
    requestedTxId: EVENT_A.sourceTxId,
    requestedBlockhash: EVENT_A.sourceBlockId,
    observedSlot: EVENT_READ_FIXTURES[0].slot,
    rosenBlockHeight: EVENT_A.sourceChainHeight,
  });

/** Inject a deliberate runtime reader violation at the session seam. */
const networkWithTransaction = (
  read: (context: SolanaEventContext) => unknown,
) => {
  const fixture = createSessionOptions(EVENT_READ_FIXTURES);
  const network = new TestSolanaNetwork(fixture.options);
  Object.defineProperty(network, 'createEventReadSession', {
    configurable: true,
    value: async (context: SolanaEventContext) => ({
      getBlockTransactionIds: async () => [EVENT_A.sourceTxId],
      getTransaction: async () => read(context),
      getBlockInfo: async () => ({
        hash: EVENT_A.sourceBlockId,
        parentHash: 'parent-request-blockhash',
        height: EVENT_A.sourceChainHeight,
      }),
    }),
  });
  return network;
};

type HookOptions = {
  readonly accept?: boolean;
  readonly changeSerialization?: boolean;
};

class TestHookProbeChain extends TestSolanaEventChain {
  readonly serializer = vi.fn((transaction: SolanaEventTransaction) =>
    this.changeSerialization
      ? `${transaction.extractorInput} `
      : transaction.extractorInput,
  );
  readonly verifier = vi.fn(
    async (
      transaction: SolanaEventTransaction,
      blockInfo: Awaited<ReturnType<SolanaEventReadSession['getBlockInfo']>>,
    ) => this.accept && transaction.requestedBlockhash === blockInfo.hash,
  );
  private readonly accept: boolean;
  private readonly changeSerialization: boolean;

  constructor(
    network: TestSolanaNetwork,
    extractor: ReturnType<typeof createEventExtractor>['extractor'],
    options: HookOptions = {},
  ) {
    super(network, extractor);
    this.accept = options.accept ?? true;
    this.changeSerialization = options.changeSerialization ?? false;
  }

  protected override serializeTx = (
    transaction: SolanaEventTransaction,
  ): string => this.serializer(transaction);

  override verifyLockTransactionExtraConditions = async (
    transaction: SolanaEventTransaction,
    blockInfo: Awaited<ReturnType<SolanaEventReadSession['getBlockInfo']>>,
  ): Promise<boolean> => this.verifier(transaction, blockInfo);
}

describe('AbstractSolanaEventChain', () => {
  describe('verifyEvent', () => {
    /**
     * @target AbstractSolanaEventChain rejects raw and foreign session transactions
     * @dependencies injected event session, captured local context, and subclass hooks
     * @scenario return either a string or another context's valid carrier from the session
     * @expected verification rejects before subclass hooks or ordinary reads
     */
    it.each(['raw', 'foreign-context-carrier'] as const)(
      'rejects %s before invoking subclass hooks or ordinary reads',
      async (kind) => {
        const local = createEventExtractor(EVENT_READ_FIXTURES);
        const foreign = createEventExtractor(EVENT_READ_FIXTURES);
        const read =
          kind === 'raw'
            ? () => 'raw-transaction'
            : () => requestFor(createSolanaEventContext(foreign.extractor));
        const network = networkWithTransaction(read);
        const chain = new TestHookProbeChain(network, local.extractor);

        await expect(
          chain.verifyEvent(EVENT_A, EVENT_READ_FEES),
        ).rejects.toThrow('SOLANA_REQUEST_CARRIER_MISSING');

        expect(chain.verifier).not.toHaveBeenCalled();
        expect(chain.serializer).not.toHaveBeenCalled();
        expect(local.getWithContext).not.toHaveBeenCalled();
        expect(local.get).not.toHaveBeenCalled();
        expect(
          network.defaultReads.getBlockTransactionIds,
        ).not.toHaveBeenCalled();
        expect(network.defaultReads.getTransaction).not.toHaveBeenCalled();
        expect(network.defaultReads.getBlockInfo).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AbstractSolanaEventChain keeps subclass lock vetoes after context validation
     * @dependencies owned event carrier, captured context, and a rejecting subclass hook
     * @scenario verify an owned carrier while the subclass vetoes the lock check
     * @expected false is returned before serialization and final extraction
     */
    it('allows a subclass verifier to veto an owned carrier', async () => {
      let owned: SolanaEventTransaction | undefined;
      const network = networkWithTransaction((context) => {
        owned = requestFor(context);
        return owned;
      });
      const { extractor, getWithContext, get } =
        createEventExtractor(EVENT_READ_FIXTURES);
      const chain = new TestHookProbeChain(network, extractor, {
        accept: false,
      });

      await expect(chain.verifyEvent(EVENT_A, EVENT_READ_FEES)).resolves.toBe(
        false,
      );

      expect(owned).toBeDefined();
      expect(getWithContext).toHaveBeenCalledOnce();
      expect(chain.verifier).toHaveBeenCalledExactlyOnceWith(owned, {
        hash: EVENT_A.sourceBlockId,
        parentHash: 'parent-request-blockhash',
        height: EVENT_A.sourceChainHeight,
      });
      expect(chain.serializer).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(network.defaultReads.getTransaction).not.toHaveBeenCalled();
    });

    /**
     * @target AbstractSolanaEventChain dispatches a matching subclass serializer
     * @dependencies owned event carrier, captured context, serializer and extractor spies
     * @scenario serialize the carrier to its canonical bound input during verification
     * @expected the hook runs once and its output reaches the extractor unchanged
     */
    it('dispatches a matching subclass serializer for an owned carrier', async () => {
      let owned: SolanaEventTransaction | undefined;
      const network = networkWithTransaction((context) => {
        owned = requestFor(context);
        return owned;
      });
      const { extractor, getWithContext, get } =
        createEventExtractor(EVENT_READ_FIXTURES);
      const chain = new TestHookProbeChain(network, extractor);

      await expect(chain.verifyEvent(EVENT_A, EVENT_READ_FEES)).resolves.toBe(
        true,
      );

      expect(owned).toBeDefined();
      expect(getWithContext).toHaveBeenCalledOnce();
      expect(chain.verifier).toHaveBeenCalledExactlyOnceWith(owned, {
        hash: EVENT_A.sourceBlockId,
        parentHash: 'parent-request-blockhash',
        height: EVENT_A.sourceChainHeight,
      });
      expect(chain.serializer).toHaveBeenCalledExactlyOnceWith(owned);
      expect(get).toHaveBeenCalledExactlyOnceWith(owned?.extractorInput);
      expect(network.defaultReads.getTransaction).not.toHaveBeenCalled();
    });

    /**
     * @target AbstractSolanaEventChain rejects changed subclass serialization
     * @dependencies owned event carrier, captured context, and a noncanonical serializer
     * @scenario append bytes to the request-bound input during event verification
     * @expected the mismatch rejects before extractor data is accepted
     */
    it('rejects a subclass serializer that changes the bound input', async () => {
      const network = networkWithTransaction(requestFor);
      const { extractor, get } = createEventExtractor(EVENT_READ_FIXTURES);
      const chain = new TestHookProbeChain(network, extractor, {
        changeSerialization: true,
      });

      await expect(chain.verifyEvent(EVENT_A, EVENT_READ_FEES)).rejects.toThrow(
        'SOLANA_EVENT_SERIALIZATION_MISMATCH',
      );

      expect(chain.verifier).toHaveBeenCalledOnce();
      expect(chain.serializer).toHaveBeenCalledOnce();
      expect(get).not.toHaveBeenCalled();
      expect(network.defaultReads.getTransaction).not.toHaveBeenCalled();
    });
  });
});
