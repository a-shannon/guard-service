import { vi } from 'vitest';

import type { AbstractLogger } from '@rosen-bridge/abstract-logger';
import { SOLANA_PROJECTOR_VERSION } from '@rosen-bridge/rosen-extractor';
import type {
  SolanaResolvedProfile,
  SolanaRosenExtractionOutcome,
  SolanaRosenExtractor,
} from '@rosen-bridge/rosen-extractor';
import { TokenMap } from '@rosen-bridge/tokens';
import type { BlockInfo } from '@rosen-chains/abstract-chain';

import { AbstractSolanaEventChain } from '../../lib/abstractSolanaEventChain';
import { AbstractSolanaNetwork } from '../../lib/abstractSolanaNetwork';
import type { SolanaEventTransaction } from '../../lib/requestBoundEventContext';
import type { EventReadFixture } from '../eventReadConsumerTestData';
import {
  EVENT_READ_CHAIN_CONFIG,
  TEST_GENESIS,
} from '../eventReadConsumerTestData';
import type { MutableSessionOptions } from '../eventReadConsumerTestUtils';

/** Make one deeply frozen profile accepted by the real request-context factory. */
const createProfile = (): SolanaResolvedProfile => {
  const asset = Object.freeze({
    assetId: 'source-asset',
    programId: 'source-program',
    mint: null,
    vaultTokenAccount: null,
    sourceDecimals: 9,
    destinationDecimals: 9,
    destinationTokenId: 'destination-asset',
    minAmount: '1',
    maxAmount: '1000000000',
    networkFee: '0',
    bridgeFee: '0',
  });
  return Object.freeze({
    genesisHash: TEST_GENESIS,
    destinationChain: 'ergo' as const,
    destinationNetwork: 'mainnet' as const,
    vaultOwner: 'vault-owner',
    memoVersion: 1 as const,
    projectorVersion: SOLANA_PROJECTOR_VERSION,
    assets: Object.freeze([asset]),
  });
};

/** Return Rosen fields from the event that owns the serialized transaction. */
const rosenDataFor = (fixture: EventReadFixture['event']) => ({
  toChain: fixture.toChain,
  toAddress: fixture.toAddress,
  bridgeFee: fixture.bridgeFee,
  networkFee: fixture.networkFee,
  fromAddress: fixture.fromAddress,
  sourceChainTokenId: fixture.sourceChainTokenId,
  amount: fixture.amount,
  targetChainTokenId: fixture.targetChainTokenId,
  sourceTxId: fixture.sourceTxId,
  rawData: 'fixture-memo',
});

/** Build a typed extractor double whose context reports parsed request identity. */
export const createEventExtractor = (fixtures: readonly EventReadFixture[]) => {
  const profile = createProfile();
  const bySignature = new Map(
    fixtures.map((fixture) => [fixture.event.sourceTxId, fixture]),
  );
  const getResolvedProfile = vi.fn(() => profile);
  const getWithContext = vi.fn(
    (serializedTransaction: string): SolanaRosenExtractionOutcome => {
      const input: {
        blockhash?: unknown;
        clusterGenesisHash?: unknown;
        slot?: unknown;
        transaction?: { signatures?: unknown };
      } = JSON.parse(serializedTransaction);
      const signatures = input.transaction?.signatures;
      const signature = Array.isArray(signatures) ? signatures[0] : undefined;
      const fixture =
        typeof signature === 'string' ? bySignature.get(signature) : undefined;
      if (!fixture) return { type: 'not-deposit', reason: 'NO_FIXTURE_EVENT' };
      return {
        type: 'deposit',
        data: rosenDataFor(fixture.event),
        context: {
          clusterGenesisHash:
            typeof input.clusterGenesisHash === 'string'
              ? input.clusterGenesisHash
              : '',
          sourceTxId: signature,
          sourceBlockhash:
            typeof input.blockhash === 'string' ? input.blockhash : '',
          sourceSlot: typeof input.slot === 'number' ? input.slot : -1,
        },
      };
    },
  );
  const get = vi.fn((serializedTransaction: string) => {
    const input: { transaction?: { signatures?: unknown } } = JSON.parse(
      serializedTransaction,
    );
    const signatures = input.transaction?.signatures;
    const signature = Array.isArray(signatures) ? signatures[0] : undefined;
    const fixture =
      typeof signature === 'string' ? bySignature.get(signature) : undefined;
    return fixture ? rosenDataFor(fixture.event) : undefined;
  });
  const extractor = {
    getResolvedProfile,
    getWithContext,
    get,
  } as unknown as SolanaRosenExtractor;
  return { extractor, getResolvedProfile, getWithContext, get };
};

/** Test network that fails if event verification uses its legacy read methods. */
export class TestSolanaNetwork extends AbstractSolanaNetwork {
  /** Reject network operations outside the event-read fixture. */
  private readonly notImplemented = (): never => {
    throw new Error('Not implemented by the event-read test network');
  };

  /** The three legacy reads that must remain unused by event verification. */
  readonly defaultReads = {
    getBlockTransactionIds: vi.fn(async (): Promise<string[]> => {
      throw new Error('Default network must not be read');
    }),
    getTransaction: vi.fn(async (): Promise<SolanaEventTransaction> => {
      throw new Error('Default network must not be read');
    }),
    getBlockInfo: vi.fn(async (): Promise<BlockInfo> => {
      throw new Error('Default network must not be read');
    }),
  };

  /** Keep the unrelated abstract network API unavailable in this focused fixture. */
  constructor(options: MutableSessionOptions, logger?: AbstractLogger) {
    super(options, logger);
  }

  override getHeight = this.notImplemented;
  override getTxConfirmation = this.notImplemented;
  override getAddressAssets = this.notImplemented;
  override getBlockTransactionIds = this.defaultReads.getBlockTransactionIds;
  override getBlockInfo = this.defaultReads.getBlockInfo;
  override getTransaction = this.defaultReads.getTransaction;
  override submitTransaction = this.notImplemented;
  override getMempoolTransactions = this.notImplemented;
  override getTokenDetail = this.notImplemented;
  override getActualTxId = this.notImplemented;
}

/** Minimal concrete chain used to exercise the abstract event-consumer join. */
export class TestSolanaEventChain extends AbstractSolanaEventChain {
  /** Reject payment and signing operations outside the event-read fixture. */
  private readonly notImplemented = (): never => {
    throw new Error('Not implemented by the event-consumer test chain');
  };

  /** Keep transaction construction and signing outside this read-join fixture. */
  constructor(
    network: AbstractSolanaNetwork,
    extractor: SolanaRosenExtractor,
    logger?: AbstractLogger,
  ) {
    super(network, EVENT_READ_CHAIN_CONFIG, new TokenMap(), extractor, logger);
  }

  override generateMultipleTransactions = this.notImplemented;
  override getTransactionAssets = this.notImplemented;
  override extractTransactionOrder = this.notImplemented;
  override verifyTransactionFee = this.notImplemented;
  override verifyTransactionExtraConditions = this.notImplemented;
  override isTxValid = this.notImplemented;
  override signTransaction = this.notImplemented;
  override isTransactionInSign = this.notImplemented;
  override submitTransaction = this.notImplemented;
  override isTxInMempool = this.notImplemented;
  override getMinimumNativeToken = this.notImplemented;
  override PaymentTransactionFromJson = this.notImplemented;
  override rawTxToPaymentTransaction = this.notImplemented;
  override verifyPaymentTransaction = this.notImplemented;
}
