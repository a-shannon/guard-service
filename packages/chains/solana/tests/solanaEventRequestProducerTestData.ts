import { GENESIS } from './testData';

/** Expected six-coordinate adapter context for the standard RPC fixture. */
export const requestContext = Object.freeze({
  signature: 'request-signature',
  slot: 42,
  blockhash: 'request-blockhash',
  blockHeight: 37,
  transactionIndex: 0,
  genesis: GENESIS,
});

/** Valid object history bytes matching the standard RPC fixture. */
export const validHistory =
  '{"sourceTxId":"request-signature","slot":42,"clusterGenesisHash":"cluster-genesis"}';
