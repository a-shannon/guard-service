import { TransactionCheckPreimage } from '../../src/db/databaseAction';
import { TransactionStatus } from '../../src/utils/constants';
import {
  corruptTokenProof,
  proofFaults,
  tokenExecutionFixture,
} from './avalancheTokenExecutionTestUtils';

describe('PaymentRecoveryAuthorization', () => {
  let fixture: Awaited<ReturnType<typeof tokenExecutionFixture>>;
  afterEach(() => {
    fixture?.network['provider'].destroy();
    vi.restoreAllMocks();
  });
  describe('prepareUnderScannerLease', () => {
    /**
     * @target PaymentRecoveryAuthorization.prepareUnderScannerLease restores a proven mainnet JOE signature
     * @dependencies Actual unsigned/signed RPC identity, mapped policy and SQLite recovery DAO
     * @scenario A sign-failed unsigned row has a canonical successful execution of exactly its body
     * @expected Recovery stores the original signed bytes only after exact token movement and two matching proofs
     */
    it('restores a proven mainnet JOE signature', async () => {
      fixture = await tokenExecutionFixture();
      const row = await fixture.recoveryRow();
      const checks = await (
        await fixture.recovery.bindRecovery(row)
      ).prepareUnderScannerLease(() => {});
      expect(checks.signedJson).toEqual(fixture.payment.toJson());
      await expect(
        fixture.db.recoverSignedPaymentIfUnchanged(row, checks.signedJson, {
          assertActive: () => {},
          assertBefore: (manager, current) =>
            checks.assertBefore(manager, current as TransactionCheckPreimage),
          assertAfter: (manager, current) =>
            checks.assertAfter(manager, current as TransactionCheckPreimage),
        }),
      ).resolves.toEqual(true);
      const recovered = (await fixture.db.getTxById(row.txId))!;
      expect(recovered.txJson).toEqual(fixture.payment.toJson());
      expect(recovered.status).toEqual(TransactionStatus.sent);
    });
    /**
     * @target PaymentRecoveryAuthorization.prepareUnderScannerLease refuses successful token execution with %s
     * @dependencies Actual receipt producer, unsigned authority and SQLite row
     * @scenario The successful signed body has one invalid Transfer field
     * @expected The sign-failed unsigned representation remains unchanged
     */
    it.each(proofFaults)(
      'refuses successful token execution with %s',
      async (fault) => {
        fixture = await tokenExecutionFixture();
        const row = await fixture.recoveryRow();
        const before = await fixture.db.getTxById(row.txId);
        corruptTokenProof(fixture, fault);
        await expect(
          (await fixture.recovery.bindRecovery(row)).prepareUnderScannerLease(
            () => {},
          ),
        ).rejects.toThrow();
        expect(await fixture.db.getTxById(row.txId)).toEqual(before);
      },
    );
    /**
     * @target PaymentRecoveryAuthorization.prepareUnderScannerLease refuses late %s drift
     * @dependencies Actual two-read recovery proof and captured execution methods
     * @scenario One input changes after the first immutable token receipt
     * @expected Recovery remains sign-failed without promoting signed bytes
     */
    it.each(['Transfer', 'verifier', 'reader', 'map'])(
      'refuses late %s drift',
      async (fault) => {
        fixture = await tokenExecutionFixture();
        const row = await fixture.recoveryRow();
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
          }
          return result;
        });
        await expect(
          (await fixture.recovery.bindRecovery(row)).prepareUnderScannerLease(
            () => {},
          ),
        ).rejects.toThrow();
        expect((await fixture.db.getTxById(row.txId))!.status).toEqual(
          TransactionStatus.signFailed,
        );
      },
    );
  });
});
