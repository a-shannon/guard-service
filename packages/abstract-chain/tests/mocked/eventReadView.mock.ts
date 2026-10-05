import { ChainMinimumFee } from '@rosen-bridge/minimum-fee';
import { TokenMap } from '@rosen-bridge/tokens';

import { EventReadView, EventTrigger } from '../../lib';
import { readerConfig } from '../eventReadViewTestData';
import TestChainNetwork from '../network/testChainNetwork';
import TestChain from '../testChain';

class ReaderTestChain extends TestChain {
  /** Expose the protected reader join through the actual base implementation. */
  verifyUsingReader = (
    event: EventTrigger,
    fees: ChainMinimumFee,
    reader: EventReadView<string>,
  ) => this.verifyEventWithReader(event, fees, reader);

  /** Return the test extractor so fixtures can bind transactions to events. */
  getEventExtractor = () => this.extractor;
}

/** Supply a reader whose three methods describe one valid fixture event. */
export const createReader = (event: EventTrigger, transaction: string) => ({
  getBlockTransactionIds: vi.fn(async () => [event.sourceTxId]),
  getTransaction: vi.fn(async () => transaction),
  getBlockInfo: vi.fn(async () => ({
    hash: event.sourceBlockId,
    parentHash: `parent-${event.sourceBlockId}`,
    height: event.sourceChainHeight,
  })),
});

/** Fail every default network read and extract events by their transaction. */
export const createReaderHarness = (
  transactions: readonly { event: EventTrigger; transaction: string }[],
) => {
  const network = new TestChainNetwork();
  const chain = new ReaderTestChain(network, readerConfig, new TokenMap());
  const networkSpies = [
    vi.spyOn(network, 'getBlockTransactionIds'),
    vi.spyOn(network, 'getTransaction'),
    vi.spyOn(network, 'getBlockInfo'),
  ];
  for (const spy of networkSpies)
    spy.mockImplementation(() => {
      throw Error('Default network must not be read');
    });
  const extracted = new Map(
    transactions.map(({ event, transaction }) => [
      transaction,
      { ...event, rawData: 'fixture' },
    ]),
  );
  vi.spyOn(chain.getEventExtractor(), 'get').mockImplementation((transaction) =>
    extracted.get(transaction),
  );
  const lockCheck = vi
    .spyOn(chain, 'verifyLockTransactionExtraConditions')
    .mockResolvedValue(true);
  return { chain, networkSpies, lockCheck };
};
