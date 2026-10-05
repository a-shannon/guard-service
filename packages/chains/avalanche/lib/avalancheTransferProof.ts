import { Transaction } from 'ethers';

import type { SettledAvalancheTransactionReceiptEvidence } from '@rosen-chains/avalanche-rpc';
import { EvmTxStatus } from '@rosen-chains/evm';

const transferTopic =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Checks one standard Transfer against exact signed bytes and qualified execution.
 * @param transaction Authoritatively mapped signed token transaction.
 * @param evidence Canonical receipt snapshot from the Avalanche RPC adapter.
 * @param recipient Expected decoded recipient, including the custody lock for inbound transfers.
 * @param amount Expected positive raw contract amount before decimal wrapping.
 * @returns False for absent, duplicate, removed, malformed or mismatched execution proof.
 */
export const hasAvalancheTransferProof = (
  transaction: Transaction,
  evidence: Readonly<SettledAvalancheTransactionReceiptEvidence>,
  recipient: string,
  amount: bigint,
): boolean => {
  try {
    const receipt = evidence.receipt;
    if (
      !transaction.isSigned() ||
      transaction.to === null ||
      transaction.value !== 0n ||
      transaction.serialized !== evidence.signedBytes ||
      transaction.hash !== evidence.hash ||
      transaction.unsignedHash !== evidence.unsignedHash ||
      transaction.from!.toLowerCase() !== evidence.from ||
      transaction.chainId !== evidence.chainId ||
      transaction.nonce !== evidence.nonce ||
      evidence.status !== EvmTxStatus.succeed ||
      receipt.status !== 1 ||
      receipt.hash !== evidence.hash ||
      receipt.from !== evidence.from ||
      receipt.to !== transaction.to.toLowerCase() ||
      receipt.blockHash !== evidence.blockHash ||
      receipt.blockNumber !== evidence.blockNumber ||
      receipt.index !== evidence.index ||
      !Number.isSafeInteger(evidence.blockNumber) ||
      evidence.blockNumber < 0 ||
      !Number.isSafeInteger(evidence.index) ||
      evidence.index < 0 ||
      !/^0x[0-9a-f]{64}$/.test(evidence.blockHash) ||
      typeof amount !== 'bigint' ||
      amount <= 0n ||
      amount >= 1n << 256n ||
      !/^0x[0-9a-f]{40}$/.test(recipient) ||
      !Array.isArray(receipt.logs)
    )
      return false;
    const transfers = receipt.logs.filter(
      (log) => log.address === receipt.to && log.topics[0] === transferTopic,
    );
    if (transfers.length !== 1) return false;
    const log = transfers[0];
    return (
      log.removed === false &&
      log.transactionHash === evidence.hash &&
      log.blockHash === evidence.blockHash &&
      log.blockNumber === evidence.blockNumber &&
      log.transactionIndex === evidence.index &&
      Number.isSafeInteger(log.index) &&
      log.index >= 0 &&
      receipt.logs.filter((candidate) => candidate.index === log.index)
        .length === 1 &&
      log.topics.length === 3 &&
      log.topics[1] === '0x' + evidence.from.slice(2).padStart(64, '0') &&
      log.topics[2] === '0x' + recipient.slice(2).padStart(64, '0') &&
      log.data.length === 66 &&
      /^0x[0-9a-f]{64}$/.test(log.data) &&
      BigInt(log.data) === amount
    );
  } catch {
    return false;
  }
};
