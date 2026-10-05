import { vi } from 'vitest';

import type {
  SolanaEventBlockLocation,
  SolanaEventReadSessionOptions,
  SolanaHistoryRequestContext,
  SolanaRpcRequest,
} from '../lib/solanaEventRequestProducer';
import type { EventReadFixture } from './eventReadConsumerTestData';
import { TEST_GENESIS } from './eventReadConsumerTestData';

/** Mutable callback references used to prove the network captures options once. */
export interface MutableSessionOptions {
  transport: SolanaEventReadSessionOptions['transport'];
  getHistory: NonNullable<SolanaEventReadSessionOptions['getHistory']>;
  locateBlock: SolanaEventReadSessionOptions['locateBlock'];
}

/** Hold one transaction read until another event reaches its own reader. */
export interface SessionFixtureControls {
  readonly beforeTransaction?: (
    fixture: EventReadFixture,
  ) => Promise<void> | void;
  readonly failedTransactionSignature?: string;
}

/** Resolve a deferred signal without timers or background tasks. */
export const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

/** Build a successful JSON-RPC response while preserving the result text. */
const rpcSuccess = (id: number, result: string): string =>
  `{"jsonrpc":"2.0","id":${id},"result":${result}}`;

/** Build a transaction response matching one fixture's signature and slot. */
const transactionResult = (fixture: EventReadFixture): string =>
  `{"slot":${fixture.slot},"transactionIndex":0,"transaction":{"signatures":[${JSON.stringify(fixture.event.sourceTxId)}],"message":{"accountKeys":["payer"],"instructions":[]}},"meta":{"fee":18446744073709551615,"err":null},"version":"legacy"}`;

/** Build a containing block with the matching transaction and parent coordinates. */
const blockResult = (fixture: EventReadFixture, signature: string): string =>
  `{"blockhash":${JSON.stringify(fixture.event.sourceBlockId)},"blockHeight":${fixture.blockHeight},"transactions":[{"transaction":{"signatures":[${JSON.stringify(signature)}],"message":{"accountKeys":["payer"],"instructions":[]}},"meta":{"fee":18446744073709551615,"err":null},"version":"legacy"}],"previousBlockhash":${JSON.stringify(fixture.parentHash)},"parentSlot":${fixture.slot - 1}}`;

/** Return callbacks and request spies for deterministic real session creation. */
export const createSessionOptions = (
  fixtures: readonly EventReadFixture[],
  controls: SessionFixtureControls = {},
) => {
  const locateBlock = vi.fn(
    async (
      blockhash: string,
    ): Promise<SolanaEventBlockLocation | undefined> => {
      const fixture = fixtures.find(
        (candidate) => candidate.event.sourceBlockId === blockhash,
      );
      if (!fixture) return undefined;
      return {
        genesisHash: TEST_GENESIS,
        blockhash: fixture.event.sourceBlockId,
        slot: fixture.slot,
        blockHeight: fixture.blockHeight,
        parentHash: fixture.parentHash,
      };
    },
  );

  const getHistory = vi.fn(
    async (expected: Readonly<SolanaHistoryRequestContext>) => ({
      requestContext: expected,
      extractorHistory: JSON.stringify({
        sourceTxId: expected.signature,
        slot: expected.slot,
        clusterGenesisHash: expected.genesis,
      }),
    }),
  );

  const transport = vi.fn(
    async (request: SolanaRpcRequest): Promise<string> => {
      if (request.method === 'getGenesisHash')
        return rpcSuccess(request.id, JSON.stringify(TEST_GENESIS));

      if (request.method === 'getBlock') {
        const slot = Number(request.params[0]);
        const fixture = fixtures.find((candidate) => candidate.slot === slot);
        if (!fixture) throw new Error('UNEXPECTED_SOLANA_BLOCK_SLOT');
        return rpcSuccess(
          request.id,
          blockResult(fixture, fixture.event.sourceTxId),
        );
      }

      if (request.method === 'getTransaction') {
        const signature = String(request.params[0]);
        const fixture = fixtures.find(
          (candidate) => candidate.event.sourceTxId === signature,
        );
        if (!fixture)
          throw new Error('UNEXPECTED_SOLANA_TRANSACTION_SIGNATURE');
        await controls.beforeTransaction?.(fixture);
        if (signature === controls.failedTransactionSignature)
          return `{"jsonrpc":"2.0","id":${request.id},"error":{"code":-32000,"message":"rpc unavailable"}}`;
        return rpcSuccess(request.id, transactionResult(fixture));
      }

      throw new Error(`UNEXPECTED_SOLANA_RPC_METHOD:${request.method}`);
    },
  );

  const options: MutableSessionOptions = {
    transport,
    getHistory,
    locateBlock,
  };
  return { options, transport, getHistory, locateBlock };
};
