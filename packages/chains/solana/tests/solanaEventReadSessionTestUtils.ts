import { PARENT_HASH } from './solanaEventReadSessionTestData';
import {
  blockResult,
  rpcResponse,
  transactionResult,
} from './solanaEventRequestProducerTestUtils';
import { GENESIS } from './testData';

/** Build the standard genesis, block, genesis, and transaction replies. */
export const sessionReplies = (
  block = blockResult({
    extraFields: `"previousBlockhash":"${PARENT_HASH}","parentSlot":41`,
  }),
) => [
  rpcResponse(1, JSON.stringify(GENESIS)),
  rpcResponse(2, block),
  rpcResponse(3, JSON.stringify(GENESIS)),
  rpcResponse(4, transactionResult()),
];

/** Build a finalized block whose entries each carry one matching signature. */
export const multiSignatureBlockResult = (
  signatures: readonly string[],
  options: {
    readonly blockhash: string;
    readonly blockHeight: number;
    readonly parentHash: string;
    readonly parentSlot: number;
  },
) => {
  const entries = signatures.map(
    (signature) =>
      `{"transaction":{"signatures":[${JSON.stringify(signature)}],"message":{"accountKeys":["payer"],"instructions":[]}},"meta":{"fee":18446744073709551615,"err":null},"version":"legacy"}`,
  );
  return `{"blockhash":${JSON.stringify(options.blockhash)},"blockHeight":${options.blockHeight},"transactions":[${entries.join(',')}],"previousBlockhash":${JSON.stringify(options.parentHash)},"parentSlot":${options.parentSlot}}`;
};
