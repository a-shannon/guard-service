import { ChainMinimumFee } from '@rosen-bridge/minimum-fee';
import { SOLANA_NATIVE_TOKEN } from '@rosen-bridge/rosen-extractor';
import type { ChainConfigs, EventTrigger } from '@rosen-chains/abstract-chain';

/** One event and its finalized block coordinates for the read-session fixture. */
export interface EventReadFixture {
  readonly event: EventTrigger;
  readonly slot: number;
  readonly blockHeight: number;
  readonly parentHash: string;
}

/** The genesis identity used by the captured extractor profile and RPC replies. */
export const TEST_GENESIS = 'cluster-genesis';

/** The first event's finalized block hash. */
export const EVENT_A_BLOCKHASH = 'request-blockhash';

/** The second event's finalized block hash. */
export const EVENT_B_BLOCKHASH = 'second-request-blockhash';

/** First valid Solana event fixture. */
export const EVENT_A: EventTrigger = {
  height: 37,
  fromChain: 'solana',
  toChain: 'ergo',
  fromAddress: 'source-wallet-a',
  toAddress: 'destination-a',
  amount: '1000',
  bridgeFee: '0',
  networkFee: '0',
  sourceChainTokenId: SOLANA_NATIVE_TOKEN,
  targetChainTokenId: 'ergo-token-a',
  sourceTxId: 'request-signature',
  sourceChainHeight: 37,
  sourceBlockId: EVENT_A_BLOCKHASH,
  WIDsHash: 'event-a-wids-hash',
  WIDsCount: 1,
};

/** Second valid Solana event fixture with distinct transaction and block identity. */
export const EVENT_B: EventTrigger = {
  ...EVENT_A,
  height: 38,
  fromAddress: 'source-wallet-b',
  toAddress: 'destination-b',
  sourceTxId: 'second-request-signature',
  sourceChainHeight: 38,
  sourceBlockId: EVENT_B_BLOCKHASH,
  targetChainTokenId: 'ergo-token-b',
  WIDsHash: 'event-b-wids-hash',
};

/** One-field mutations applied while the event's original block is locating. */
export const EVENT_MUTATION_CASES = [
  {
    field: 'sourceBlockId',
    value: EVENT_B.sourceBlockId,
  },
  {
    field: 'sourceTxId',
    value: EVENT_B.sourceTxId,
  },
  {
    field: 'toAddress',
    value: EVENT_B.toAddress,
  },
] as const;

/** Events paired with the exact finalized coordinates returned by the locator. */
export const EVENT_READ_FIXTURES: readonly EventReadFixture[] = [
  {
    event: EVENT_A,
    slot: 42,
    blockHeight: 37,
    parentHash: 'parent-request-blockhash',
  },
  {
    event: EVENT_B,
    slot: 43,
    blockHeight: 38,
    parentHash: 'parent-second-request-blockhash',
  },
];

/** Event coordinates that deliberately do not appear in EVENT_A's block. */
export const EVENT_NOT_IN_BLOCK: EventTrigger = {
  ...EVENT_A,
  sourceTxId: 'unlisted-signature',
};

/** Callback fields mutated separately to isolate constructor snapshot ownership. */
export const CALLBACK_MUTATION_FIELDS = [
  'transport',
  'getHistory',
  'locateBlock',
] as const;

/** Zero-fee configuration keeps the tests focused on event-read ownership. */
export const EVENT_READ_FEES = new ChainMinimumFee({
  bridgeFee: 0n,
  networkFee: 0n,
  feeRatio: 0n,
  rsnRatio: 0n,
  rsnRatioDivisor: 10000000000000000n,
});

/** Minimal chain configuration required by AbstractChain construction. */
export const EVENT_READ_CHAIN_CONFIG: ChainConfigs = {
  fee: 0n,
  confirmations: {
    observation: 1,
    payment: 1,
    cold: 1,
    manual: 1,
    arbitrary: 1,
  },
  addresses: {
    lock: 'solana-lock-address',
    cold: 'solana-cold-address',
    permit: 'solana-permit-address',
    fraud: 'solana-fraud-address',
  },
  rwtId: 'rwt',
};
