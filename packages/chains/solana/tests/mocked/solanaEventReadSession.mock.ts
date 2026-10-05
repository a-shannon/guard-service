import { vi } from 'vitest';

import { createSolanaEventContext } from '../../lib/requestBoundEventContext';
import {
  createSolanaEventReadSession,
  type SolanaEventBlockLocation,
  type SolanaRpcRequest,
} from '../../lib/solanaEventRequestProducer';
import {
  BLOCK_HEIGHT,
  PARENT_HASH,
  SLOT,
} from '../solanaEventReadSessionTestData';
import { sessionReplies } from '../solanaEventReadSessionTestUtils';
import { BLOCKHASH, GENESIS } from '../testData';
import { createMockSolanaExtractor } from './requestBoundEventContext.mock';

/** Build a request context and deterministic transport for one read session. */
export const createSessionHarness = (
  replies: readonly string[] = sessionReplies(),
  locateBlock: (
    blockhash: string,
  ) =>
    | SolanaEventBlockLocation
    | undefined
    | Promise<SolanaEventBlockLocation | undefined> = () => ({
    genesisHash: GENESIS,
    blockhash: BLOCKHASH,
    slot: SLOT,
    blockHeight: BLOCK_HEIGHT,
    parentHash: PARENT_HASH,
  }),
) => {
  const transport = vi.fn(async (request: SolanaRpcRequest) => {
    const reply = replies[request.id - 1];
    if (reply === undefined) throw new Error('UNEXPECTED_RPC_CALL');
    return reply;
  });
  const context = createSolanaEventContext(createMockSolanaExtractor());
  return {
    transport,
    context,
    create: (requestedBlockhash = BLOCKHASH) =>
      createSolanaEventReadSession(
        { context, transport, locateBlock },
        requestedBlockhash,
      ),
  };
};
