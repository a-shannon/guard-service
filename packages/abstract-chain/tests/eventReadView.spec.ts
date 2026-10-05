import { NotFoundError } from '../lib';
import {
  readerEventA,
  readerEventB,
  readerFees,
  readerMethods,
} from './eventReadViewTestData';
import { deferred } from './eventReadViewTestUtils';
import { createReader, createReaderHarness } from './mocked/eventReadView.mock';

describe('AbstractChain explicit event reader', () => {
  /**
   * @target verifyEventWithReader uses only its explicit reader
   * @dependencies reader and extractor mocks
   * @scenario verify a valid event while every default network read throws
   * @expected true with the exact three reader arguments and no default reads
   */
  it('uses the supplied view for every event read', async () => {
    const reader = createReader(readerEventA, 'transaction-a');
    const { chain, networkSpies, lockCheck } = createReaderHarness([
      { event: readerEventA, transaction: 'transaction-a' },
    ]);

    await expect(
      chain.verifyUsingReader(readerEventA, readerFees, reader),
    ).resolves.toEqual(true);

    expect(reader.getBlockTransactionIds).toHaveBeenCalledExactlyOnceWith(
      readerEventA.sourceBlockId,
    );
    expect(reader.getTransaction).toHaveBeenCalledExactlyOnceWith(
      readerEventA.sourceTxId,
      readerEventA.sourceBlockId,
    );
    expect(reader.getBlockInfo).toHaveBeenCalledExactlyOnceWith(
      readerEventA.sourceBlockId,
    );
    expect(lockCheck).toHaveBeenCalledExactlyOnceWith('transaction-a', {
      hash: readerEventA.sourceBlockId,
      parentHash: `parent-${readerEventA.sourceBlockId}`,
      height: readerEventA.sourceChainHeight,
    });
    for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
  });

  /**
   * @target verifyEventWithReader short-circuits missing membership
   * @dependencies reader and extractor mocks
   * @scenario omit only the requested transaction from the explicit IDs
   * @expected false without reading a transaction or block info
   */
  it('rejects missing membership before later reader calls', async () => {
    const reader = createReader(readerEventA, 'transaction-a');
    reader.getBlockTransactionIds.mockResolvedValue([]);
    const { chain, networkSpies } = createReaderHarness([
      { event: readerEventA, transaction: 'transaction-a' },
    ]);

    await expect(
      chain.verifyUsingReader(readerEventA, readerFees, reader),
    ).resolves.toEqual(false);

    expect(reader.getTransaction).not.toHaveBeenCalled();
    expect(reader.getBlockInfo).not.toHaveBeenCalled();
    for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
  });

  /**
   * @target verifyEventWithReader preserves NotFoundError behavior at each read
   * @dependencies reader and extractor mocks
   * @scenario fail one reader method while the other methods remain valid
   * @expected false with no default network fallback
   */
  it.each(readerMethods)(
    'returns false for NotFoundError from %s',
    async (method) => {
      const reader = createReader(readerEventA, 'transaction-a');
      reader[method].mockRejectedValue(
        new NotFoundError('missing observation'),
      );
      const { chain, networkSpies } = createReaderHarness([
        { event: readerEventA, transaction: 'transaction-a' },
      ]);

      await expect(
        chain.verifyUsingReader(readerEventA, readerFees, reader),
      ).resolves.toEqual(false);
      for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
    },
  );

  /**
   * @target verifyEventWithReader preserves retryable errors at each read
   * @dependencies reader and extractor mocks
   * @scenario fail only one reader method with an ordinary availability error
   * @expected rejection through the existing skipping-event error path
   */
  it.each(readerMethods)(
    'propagates availability errors from %s',
    async (method) => {
      const reader = createReader(readerEventA, 'transaction-a');
      reader[method].mockRejectedValue(Error('rpc unavailable'));
      const { chain, networkSpies } = createReaderHarness([
        { event: readerEventA, transaction: 'transaction-a' },
      ]);

      await expect(
        chain.verifyUsingReader(readerEventA, readerFees, reader),
      ).rejects.toThrow(/Skipping event .* validation: Error: rpc unavailable/);
      for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
    },
  );

  /**
   * @target verifyEventWithReader retains each overlapping invocation's view
   * @dependencies two readers, deferred promises and transaction-keyed extractor
   * @scenario suspend A's ID read, start B and reach its transaction read, then
   * resume A and finish it before releasing B's transaction read
   * @expected both events validate against their own transaction and block
   */
  it('isolates two verifications with interleaved reader completion', async () => {
    const readerA = createReader(readerEventA, 'transaction-a');
    const readerB = createReader(readerEventB, 'transaction-b');
    const idsStarted = deferred<void>();
    const idsRelease = deferred<string[]>();
    const transactionStarted = deferred<void>();
    const transactionRelease = deferred<string>();
    readerA.getBlockTransactionIds.mockImplementation(async () => {
      idsStarted.resolve(undefined);
      return idsRelease.promise;
    });
    readerB.getTransaction.mockImplementation(async () => {
      transactionStarted.resolve(undefined);
      return transactionRelease.promise;
    });
    const { chain, networkSpies, lockCheck } = createReaderHarness([
      { event: readerEventA, transaction: 'transaction-a' },
      { event: readerEventB, transaction: 'transaction-b' },
    ]);

    const verificationA = chain.verifyUsingReader(
      readerEventA,
      readerFees,
      readerA,
    );
    await idsStarted.promise;
    const verificationB = chain.verifyUsingReader(
      readerEventB,
      readerFees,
      readerB,
    );
    await transactionStarted.promise;
    idsRelease.resolve([readerEventA.sourceTxId]);
    await expect(verificationA).resolves.toEqual(true);
    expect(lockCheck).toHaveBeenCalledTimes(1);
    transactionRelease.resolve('transaction-b');
    await expect(verificationB).resolves.toEqual(true);

    for (const [reader, event] of [
      [readerA, readerEventA],
      [readerB, readerEventB],
    ] as const) {
      expect(reader.getBlockTransactionIds).toHaveBeenCalledExactlyOnceWith(
        event.sourceBlockId,
      );
      expect(reader.getTransaction).toHaveBeenCalledExactlyOnceWith(
        event.sourceTxId,
        event.sourceBlockId,
      );
      expect(reader.getBlockInfo).toHaveBeenCalledExactlyOnceWith(
        event.sourceBlockId,
      );
    }
    expect(lockCheck).toHaveBeenNthCalledWith(1, 'transaction-a', {
      hash: readerEventA.sourceBlockId,
      parentHash: `parent-${readerEventA.sourceBlockId}`,
      height: readerEventA.sourceChainHeight,
    });
    expect(lockCheck).toHaveBeenNthCalledWith(2, 'transaction-b', {
      hash: readerEventB.sourceBlockId,
      parentHash: `parent-${readerEventB.sourceBlockId}`,
      height: readerEventB.sourceChainHeight,
    });
    for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
  });
});
