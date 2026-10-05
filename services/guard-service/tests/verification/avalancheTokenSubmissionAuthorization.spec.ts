import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';

import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import {
  corruptTokenProof,
  proofFaults,
  tokenExecutionFixture,
} from './avalancheTokenExecutionTestUtils';

describe('PaymentSubmissionAuthorization', () => {
  let fixture: Awaited<ReturnType<typeof tokenExecutionFixture>>;
  afterEach(() => {
    fixture?.network['provider'].destroy();
    vi.restoreAllMocks();
  });
  describe('prepareUnderScannerLease', () => {
    /**
     * @target PaymentSubmissionAuthorization.prepareUnderScannerLease completes a proven mainnet JOE payment
     * @dependencies Actual mapped chain, RPC receipt adapter, order authorization and SQLite DAO
     * @scenario A sent JOE payment has one exact executed Transfer and a qualified scanned block
     * @expected DAO completes only the captured signed bytes and advances the event to pending reward
     */
    it('completes a proven mainnet JOE payment', async () => {
      fixture = await tokenExecutionFixture();
      const checks = await fixture.prepare();
      await expect(
        fixture.db.finalizeTxIfUnchanged(fixture.expected, {
          ...checks,
          assertActive: () => {},
        }),
      ).resolves.toEqual(true);
      const row = (await fixture.db.getTxById(fixture.expected.txId))!;
      expect(row.status).toEqual(TransactionStatus.completed);
      expect(row.txJson).toEqual(fixture.payment.toJson());
      expect(
        (await fixture.db.getEventById(fixture.expected.eventId!))!.status,
      ).toEqual(EventStatus.pendingReward);
      expect(fixture.rpc.getTransaction).not.toHaveBeenCalledWith(
        fixture.expected.txId,
      );
    });
    /**
     * @target PaymentSubmissionAuthorization.prepareUnderScannerLease reconciles a proven token submission
     * @dependencies Actual RPC and DAO sent transition
     * @scenario The scanner already observed the exact signed ERC20 transaction
     * @expected It is marked sent without authorizing another dispatch
     */
    it('reconciles a proven token submission', async () => {
      fixture = await tokenExecutionFixture(TransactionStatus.signed);
      const checks = await fixture.prepare('submission');
      const start = vi.fn();
      await expect(checks.authorize(start)).rejects.toThrow(
        'cannot be submitted',
      );
      expect(start).not.toHaveBeenCalled();
      await expect(
        fixture.db.setTxStatusIfUnchanged(
          fixture.expected,
          TransactionStatus.sent,
          { ...checks, assertActive: () => {} },
        ),
      ).resolves.toEqual(true);
      expect(
        (await fixture.db.getTxById(fixture.expected.txId))!.status,
      ).toEqual(TransactionStatus.sent);
    });
    /**
     * @target PaymentSubmissionAuthorization.prepareUnderScannerLease refuses successful token execution with %s
     * @dependencies Actual immutable receipt producer and mapped payment predicate
     * @scenario One Transfer field differs while calldata, receipt success and order remain valid
     * @expected No completion authority and no payment/event database change
     */
    it.each(proofFaults)(
      'refuses successful token execution with %s',
      async (fault) => {
        fixture = await tokenExecutionFixture();
        const row = await fixture.db.getTxById(fixture.expected.txId);
        const event = await fixture.db.getEventById(fixture.expected.eventId!);
        corruptTokenProof(fixture, fault);
        await expect(fixture.prepare()).rejects.toThrow();
        expect(await fixture.db.getTxById(fixture.expected.txId)).toEqual(row);
        expect(
          await fixture.db.getEventById(fixture.expected.eventId!),
        ).toEqual(event);
      },
    );
    /**
     * @target PaymentSubmissionAuthorization.prepareUnderScannerLease refuses late %s drift
     * @dependencies Actual receipt read, mapped policy and SQL authority rechecks
     * @scenario One input changes after the first valid receipt snapshot
     * @expected The second proof or current-authority check denies completion
     */
    it.each(['Transfer', 'verifier', 'reader', 'map', 'scanner record'])(
      'refuses late %s drift',
      async (fault) => {
        fixture = await tokenExecutionFixture();
        const read = fixture.network.getSettledTransactionReceiptEvidence.bind(
          fixture.network,
        );
        let first = true;
        vi.spyOn(
          fixture.network,
          'getSettledTransactionReceiptEvidence',
        ).mockImplementation(async (...args) => {
          const result = await read(...args);
          if (first) {
            first = false;
            if (fault === 'Transfer')
              corruptTokenProof(fixture, 'wrong amount');
            if (fault === 'verifier')
              fixture.chain.verifySettledPaymentEvidence = vi.fn(() => true);
            if (fault === 'reader')
              fixture.network.getSettledTransactionReceiptEvidence = vi.fn(
                async () => result,
              );
            if (fault === 'map') {
              const map = fixture.tokens.getRawConfig();
              map[1].avalanche.decimals = 17;
              await fixture.tokens.updateConfigByJson(map);
            }
            if (fault === 'scanner record')
              await fixture.db.dataSource
                .getRepository(AddressTxsEntity)
                .update({ id: fixture.record.id }, { nonce: 1 });
          }
          return result;
        });
        await expect(fixture.prepare()).rejects.toThrow();
        expect(
          (await fixture.db.getTxById(fixture.expected.txId))!.status,
        ).toEqual(TransactionStatus.sent);
      },
    );
  });
});
