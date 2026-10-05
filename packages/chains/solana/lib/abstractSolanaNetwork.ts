import type { AbstractLogger } from '@rosen-bridge/abstract-logger';
import { AbstractChainNetwork } from '@rosen-chains/abstract-chain';

import type {
  SolanaEventContext,
  SolanaEventTransaction,
} from './requestBoundEventContext';
import {
  createSolanaEventReadSession,
  type SolanaEventReadSessionOptions,
} from './solanaEventRequestProducer';

/** The immutable reader returned for one event verification. */
export type SolanaEventReadSession = Awaited<
  ReturnType<typeof createSolanaEventReadSession>
>;

/** Abstract network boundary that binds each event to a fresh Solana session. */
export abstract class AbstractSolanaNetwork<
  TOrdinary = SolanaEventTransaction,
> extends AbstractChainNetwork<TOrdinary> {
  private readonly capturedReadOptions: Omit<
    SolanaEventReadSessionOptions,
    'context'
  >;

  /** Create a new read session for the supplied context and block. */
  readonly createEventReadSession: (
    context: SolanaEventContext,
    requestedBlockhash: string,
  ) => Promise<SolanaEventReadSession>;

  /** Capture caller callbacks once so later option mutation cannot redirect reads. */
  constructor(
    options: Omit<SolanaEventReadSessionOptions, 'context'>,
    logger?: AbstractLogger,
  ) {
    super(logger);
    const transport = options.transport;
    const getHistory = options.getHistory;
    const locateBlock = options.locateBlock;
    this.capturedReadOptions = Object.freeze({
      transport,
      getHistory,
      locateBlock,
    });
    const capturedReadOptions = this.capturedReadOptions;
    this.createEventReadSession = (context, requestedBlockhash) =>
      createSolanaEventReadSession(
        { ...capturedReadOptions, context },
        requestedBlockhash,
      );
  }
}
