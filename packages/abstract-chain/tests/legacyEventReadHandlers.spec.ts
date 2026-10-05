import { describe, expect, it, vi } from 'vitest';

import { readerEventA, readerFees } from './eventReadViewTestData';
import { createReader, createReaderHarness } from './mocked/eventReadView.mock';

describe('AbstractChain', () => {
  describe('verifyEventWithReader', () => {
    /**
     * @target AbstractChain.verifyEventWithReader uses the subclass serializer
     * @dependencies explicit reader, extractor mock, and subclass serializer
     * @scenario verify a valid event while the subclass returns its serialized bytes
     * @expected the subclass output is passed unchanged to the extractor
     */
    it('uses the subclass serializer output in the explicit reader path', async () => {
      const rawTransaction = 'transaction-a';
      const serializedTransaction = `legacy:${rawTransaction}`;
      const reader = createReader(readerEventA, rawTransaction);
      const { chain, networkSpies } = createReaderHarness([
        { event: readerEventA, transaction: serializedTransaction },
      ]);
      const serializer = vi.fn(
        (transaction: string) => `legacy:${transaction}`,
      );
      Object.defineProperty(chain, 'serializeTx', {
        configurable: true,
        value: serializer,
      });

      await expect(
        chain.verifyUsingReader(readerEventA, readerFees, reader),
      ).resolves.toBe(true);

      expect(serializer).toHaveBeenCalledExactlyOnceWith(rawTransaction);
      expect(chain.getEventExtractor().get).toHaveBeenCalledExactlyOnceWith(
        serializedTransaction,
      );
      for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
    });

    /**
     * @target AbstractChain.verifyEventWithReader respects subclass lock vetoes
     * @dependencies explicit reader, extractor mock, and subclass lock verifier
     * @scenario reject lock verification for an otherwise valid event
     * @expected false is returned before serialization or extraction
     */
    it('rejects an event when subclass lock verification fails', async () => {
      const rawTransaction = 'transaction-a';
      const serializedTransaction = `legacy:${rawTransaction}`;
      const reader = createReader(readerEventA, rawTransaction);
      const { chain, lockCheck } = createReaderHarness([
        { event: readerEventA, transaction: serializedTransaction },
      ]);
      const serializer = vi.fn(
        (transaction: string) => `legacy:${transaction}`,
      );
      Object.defineProperty(chain, 'serializeTx', {
        configurable: true,
        value: serializer,
      });
      lockCheck.mockResolvedValueOnce(false);

      await expect(
        chain.verifyUsingReader(readerEventA, readerFees, reader),
      ).resolves.toBe(false);

      expect(lockCheck).toHaveBeenCalledExactlyOnceWith(rawTransaction, {
        hash: readerEventA.sourceBlockId,
        parentHash: `parent-${readerEventA.sourceBlockId}`,
        height: readerEventA.sourceChainHeight,
      });
      expect(serializer).not.toHaveBeenCalled();
      expect(chain.getEventExtractor().get).not.toHaveBeenCalled();
    });
  });
});
