import { Transaction } from 'ethers';

import { EvmTxStatus } from '@rosen-chains/evm';

import { recipient } from './avalancheErc20TestData';
import { tokenPayment } from './avalancheErc20TestUtils';
import { key } from './avalancheTestUtils';

/** Construct a signed synthetic JOE transaction; no production key or network operation occurs. */
export const signedToken = (changes: Record<string, unknown> = {}) => {
  const payment = tokenPayment(changes);
  const transaction = Transaction.from(
    '0x' + Buffer.from(payment.txBytes).toString('hex'),
  );
  transaction.signature = key.sign(transaction.unsignedHash);
  return transaction;
};

/** Create the exact qualified execution shape consumed by the pure proof helper. */
export const transferEvidence = (
  transaction = signedToken(),
  target = recipient.toLowerCase(),
) => {
  const blockHash = '0x' + 'aa'.repeat(32);
  const log = {
    address: transaction.to!.toLowerCase(),
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + transaction.from!.slice(2).toLowerCase().padStart(64, '0'),
      '0x' + target.slice(2).padStart(64, '0'),
    ],
    data: '0x' + 10000000000n.toString(16).padStart(64, '0'),
    removed: false,
    transactionHash: transaction.hash!,
    blockHash,
    blockNumber: 10,
    transactionIndex: 0,
    index: 0,
  };
  return {
    signedBytes: transaction.serialized,
    hash: transaction.hash!,
    unsignedHash: transaction.unsignedHash,
    from: transaction.from!.toLowerCase(),
    chainId: transaction.chainId,
    nonce: transaction.nonce,
    blockHash,
    blockNumber: 10,
    index: 0,
    finalizedBlockHash: '0x' + 'bb'.repeat(32),
    finalizedBlockNumber: 12,
    confirmations: 3,
    status: EvmTxStatus.succeed as EvmTxStatus.succeed | EvmTxStatus.failed,
    receipt: {
      hash: transaction.hash!,
      from: transaction.from!.toLowerCase(),
      to: transaction.to!.toLowerCase(),
      status: 1 as 0 | 1,
      blockHash,
      blockNumber: 10,
      index: 0,
      logs: [log],
    },
  };
};
