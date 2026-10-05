import type { AbstractLogger } from '@rosen-bridge/abstract-logger';
import type { ChainMinimumFee } from '@rosen-bridge/minimum-fee';
import { SOLANA_NATIVE_TOKEN } from '@rosen-bridge/rosen-extractor';
import type { SolanaRosenExtractor } from '@rosen-bridge/rosen-extractor';
import type { TokenMap } from '@rosen-bridge/tokens';
import {
  AbstractChain,
  type BlockInfo,
  type ChainConfigs,
  type EventReadHandlers,
  type EventTrigger,
} from '@rosen-chains/abstract-chain';

import { AbstractSolanaNetwork } from './abstractSolanaNetwork';
import type {
  SolanaEventContext,
  SolanaEventTransaction,
} from './requestBoundEventContext';
import { createSolanaEventContext } from './requestBoundEventContext';

/** Base event verifier that creates one request-bound read session per event. */
export abstract class AbstractSolanaEventChain<
  TOrdinary = SolanaEventTransaction,
> extends AbstractChain<TOrdinary> {
  /** Canonical chain name used by Rosen token and event mappings. */
  readonly CHAIN = 'solana';

  /** Native token id published by the Rosen extractor package. */
  readonly NATIVE_TOKEN_ID = SOLANA_NATIVE_TOKEN;

  /** The concrete extractor used for both contextual checks and Rosen data. */
  protected override extractor: SolanaRosenExtractor;

  private readonly eventContext: SolanaEventContext;

  private readonly eventReadHandlers: EventReadHandlers<SolanaEventTransaction>;

  private readonly createReadSessionForBlock: (
    requestedBlockhash: string,
  ) => ReturnType<AbstractSolanaNetwork<TOrdinary>['createEventReadSession']>;

  /** Construct and retain one request-bound context for this chain instance. */
  constructor(
    network: AbstractSolanaNetwork<TOrdinary>,
    configs: ChainConfigs,
    tokens: TokenMap,
    extractor: SolanaRosenExtractor,
    logger?: AbstractLogger,
  ) {
    super(network, configs, tokens, logger);
    this.extractor = extractor;
    const context = createSolanaEventContext(extractor);
    this.eventContext = context;
    const defaultVerifier = this.verifyLockTransactionExtraConditions;
    this.eventReadHandlers = Object.freeze({
      /** Require chain serialization to match the captured context's canonical form. */
      serializeTx: (transaction: SolanaEventTransaction) => {
        const canonical = context.serializeTx(transaction);
        const serialized = this.serializeTx(transaction);
        if (serialized !== canonical)
          throw new Error('SOLANA_EVENT_SERIALIZATION_MISMATCH');
        return serialized;
      },
      /** Check the captured context before invoking a customized chain verifier. */
      verifyLockTransactionExtraConditions: (
        transaction: SolanaEventTransaction,
        blockInfo: BlockInfo,
      ) => {
        const accepted = context.verifyLockTransactionExtraConditions(
          transaction,
          { hash: blockInfo.hash, height: blockInfo.height },
        );
        return accepted.then((isContextValid) =>
          !isContextValid
            ? false
            : this.verifyLockTransactionExtraConditions === defaultVerifier
              ? true
              : this.verifyLockTransactionExtraConditions(
                  transaction,
                  blockInfo,
                ),
        );
      },
    });
    const createEventReadSession = network.createEventReadSession.bind(network);
    this.createReadSessionForBlock = (requestedBlockhash) =>
      createEventReadSession(context, requestedBlockhash);
  }

  /** Serialize only carriers issued by this chain's captured context. */
  protected override serializeTx = (
    transaction: TOrdinary | SolanaEventTransaction,
  ): string => this.eventContext.serializeTx(transaction);

  /** Verify the factory-issued carrier through the same captured context. */
  override verifyLockTransactionExtraConditions = async (
    transaction: TOrdinary | SolanaEventTransaction,
    blockInfo: BlockInfo,
  ): Promise<boolean> =>
    this.eventContext.verifyLockTransactionExtraConditions(transaction, {
      hash: blockInfo.hash,
      height: blockInfo.height,
    });

  /** Verify an event with a fresh session; session creation errors stay visible. */
  override verifyEvent = async (
    event: EventTrigger,
    feeConfig: ChainMinimumFee,
  ): Promise<boolean> => {
    const capturedEvent = { ...event };
    const reader = await this.createReadSessionForBlock(
      capturedEvent.sourceBlockId,
    );
    return this.verifyEventWithReaderUsingHandlers(
      capturedEvent,
      feeConfig,
      reader,
      this.eventReadHandlers,
    );
  };
}
