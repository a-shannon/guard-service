import { EvmTxStatus } from '@rosen-chains/evm';

import { hasAvalancheTransferProof } from '../lib/avalancheTransferProof';
import { recipient } from './avalancheErc20TestData';
import {
  signedToken,
  transferEvidence,
} from './avalancheTransferProofTestUtils';

describe('hasAvalancheTransferProof', () => {
  /**
   * @target hasAvalancheTransferProof accepts exact standard JOE movement bound to the signed mainnet execution
   * @dependencies Synthetic signed token transaction and otherwise qualified receipt snapshot.
   * @scenario Verify one standard emitted Transfer matching sender, recipient and exact raw amount.
   * @expected True; wrapped-unit equivalence alone is not used as proof.
   */
  it('accepts exact standard JOE movement bound to the signed mainnet execution', () => {
    const transaction = signedToken();
    expect(
      hasAvalancheTransferProof(
        transaction,
        transferEvidence(transaction),
        recipient.toLowerCase(),
        10000000000n,
      ),
    ).toEqual(true);
  });
  /**
   * @target hasAvalancheTransferProof refuses isolated evidence fault %s
   * @dependencies One canonical signed JOE transaction and mutable copies of its otherwise valid qualified evidence.
   * @scenario Change only the named signed execution, receipt or log field.
   * @expected False; no missing, duplicated, malformed, removed or conflicting movement is accepted.
   */
  it.each<[string, (evidence: ReturnType<typeof transferEvidence>) => void]>([
    [
      'signed bytes',
      (e) => {
        e.signedBytes = '0x';
      },
    ],
    [
      'transaction hash',
      (e) => {
        e.hash = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'unsigned hash',
      (e) => {
        e.unsignedHash = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'sender',
      (e) => {
        e.from = '0x' + 'cc'.repeat(20);
      },
    ],
    [
      'chain',
      (e) => {
        e.chainId = 43113n;
      },
    ],
    [
      'nonce',
      (e) => {
        e.nonce += 1;
      },
    ],
    [
      'failed execution',
      (e) => {
        e.status = EvmTxStatus.failed;
      },
    ],
    [
      'failed receipt',
      (e) => {
        e.receipt.status = 0;
      },
    ],
    [
      'receipt hash',
      (e) => {
        e.receipt.hash = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'receipt sender',
      (e) => {
        e.receipt.from = '0x' + 'cc'.repeat(20);
      },
    ],
    [
      'receipt contract',
      (e) => {
        e.receipt.to = recipient;
      },
    ],
    [
      'receipt block hash',
      (e) => {
        e.receipt.blockHash = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'receipt height',
      (e) => {
        e.receipt.blockNumber += 1;
      },
    ],
    [
      'receipt index',
      (e) => {
        e.receipt.index += 1;
      },
    ],
    [
      'missing Transfer',
      (e) => {
        e.receipt.logs = [];
      },
    ],
    [
      'duplicate Transfer',
      (e) => {
        e.receipt.logs.push({ ...e.receipt.logs[0], index: 1 });
      },
    ],
    [
      'wrong emitter',
      (e) => {
        e.receipt.logs[0].address = recipient;
      },
    ],
    [
      'removed Transfer',
      (e) => {
        e.receipt.logs[0].removed = true;
      },
    ],
    [
      'log hash',
      (e) => {
        e.receipt.logs[0].transactionHash = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'log block hash',
      (e) => {
        e.receipt.logs[0].blockHash = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'log height',
      (e) => {
        e.receipt.logs[0].blockNumber += 1;
      },
    ],
    [
      'log transaction index',
      (e) => {
        e.receipt.logs[0].transactionIndex += 1;
      },
    ],
    [
      'negative log index',
      (e) => {
        e.receipt.logs[0].index = -1;
      },
    ],
    [
      'fractional log index',
      (e) => {
        e.receipt.logs[0].index = 0.5;
      },
    ],
    [
      'duplicate log index',
      (e) => {
        e.receipt.logs.push({ ...e.receipt.logs[0], address: recipient });
      },
    ],
    [
      'wrong signature topic',
      (e) => {
        e.receipt.logs[0].topics[0] = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'wrong indexed sender',
      (e) => {
        e.receipt.logs[0].topics[1] = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'wrong indexed recipient',
      (e) => {
        e.receipt.logs[0].topics[2] = '0x' + 'cc'.repeat(32);
      },
    ],
    [
      'extra indexed topic',
      (e) => {
        e.receipt.logs[0].topics.push('0x' + '00'.repeat(32));
      },
    ],
    [
      'nonzero sender padding',
      (e) => {
        e.receipt.logs[0].topics[1] =
          '0x01' + e.receipt.logs[0].topics[1].slice(4);
      },
    ],
    [
      'short raw amount',
      (e) => {
        e.receipt.logs[0].data = '0x01';
      },
    ],
    [
      'invalid raw amount',
      (e) => {
        e.receipt.logs[0].data = '0x' + 'zz'.repeat(32);
      },
    ],
    [
      'raw mismatch below wrapped precision',
      (e) => {
        e.receipt.logs[0].data =
          '0x' + 10000000001n.toString(16).padStart(64, '0');
      },
    ],
  ])('refuses isolated evidence fault %s', (_name, mutate) => {
    const transaction = signedToken();
    const evidence = transferEvidence(transaction);
    mutate(evidence);
    expect(
      hasAvalancheTransferProof(
        transaction,
        evidence,
        recipient.toLowerCase(),
        10000000000n,
      ),
    ).toEqual(false);
  });
});
