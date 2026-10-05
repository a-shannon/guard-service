import { vi } from 'vitest';

import type { SolanaRosenExtractor } from '@rosen-bridge/rosen-extractor';

import { createSolanaEventContext } from '../../lib/requestBoundEventContext';
import {
  createSolanaEventRequestProducer,
  type SolanaRpcRequest,
} from '../../lib/solanaEventRequestProducer';
import { defaultReplies } from '../solanaEventRequestProducerTestUtils';
import { createMockSolanaExtractor } from './requestBoundEventContext.mock';

/** Make a producer backed by a deterministic, inspectable local RPC transport. */
export const createProducerHarness = (
  replies = defaultReplies(),
  history?: Parameters<
    typeof createSolanaEventRequestProducer
  >[0]['getHistory'],
  transportError?: Error,
) => {
  const transport = vi.fn(async (request: SolanaRpcRequest) => {
    if (transportError) throw transportError;
    const reply = replies[request.id - 1];
    if (reply === undefined) throw new Error('UNEXPECTED_RPC_CALL');
    return reply;
  });
  const extractor = createMockSolanaExtractor() as SolanaRosenExtractor;
  const context = createSolanaEventContext(extractor);
  const producer = createSolanaEventRequestProducer({
    context,
    transport,
    ...(history === undefined ? {} : { getHistory: history }),
  });
  return { producer, transport, context, extractor };
};
