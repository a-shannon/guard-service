import { Transaction } from 'ethers';

import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { createManagementProcessorFixture } from '../transaction/avalancheManagementProcessorTestUtils';

type Fixture = Awaited<ReturnType<typeof createManagementProcessorFixture>>;
let fixture: Fixture | undefined;
const routes = [
  TransactionType.coldStorage,
  TransactionType.manual,
  TransactionType.arbitrary,
];
const cases = routes.flatMap((type) => [
  { type, token: false, name: 'native' },
  { type, token: true, name: 'JOE' },
]);

/** Creates an admitted unsigned row using the PostgreSQL DAO and scanner selected by the test setup. */
const setup = async (type: TransactionType, token = false) => {
  const f = (fixture = await createManagementProcessorFixture(
    type,
    true,
    token,
  ));
  if (f.database.dataSource.options.type !== 'postgres')
    throw new Error('Expected the dedicated PostgreSQL management fixture');
  await f.updateStatus('approved');
  const unsigned = await f.current();
  const bound = await f.runtime.context.bind(unsigned, ['approved']);
  return { f, unsigned, bound };
};

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
});

describe('TransactionSigningContext', () => {
  describe('persistResult', () => {
    /**
     * @target TransactionSigningContext.persistResult persists exact $name $type signed bytes on PostgreSQL
     * @dependencies
     * - Actual service PostgreSQL DAO, migrations, scanner, signing runtime and Avalanche chain/RPC adapters.
     * - Synthetic public key, policy and provider responses from createManagementProcessorFixture.
     * @scenario
     * - Queue an approved unsigned native or mainnet JOE row, bind its in-sign state and persist its exact signed result.
     * @expected
     * - Signed bytes, identity, quorum, counters, check metadata and order association persist without a POST.
     */
    it.each(cases)(
      'persists exact $name $type signed bytes on PostgreSQL',
      async ({ type, token }) => {
        const { f, unsigned, bound } = await setup(type, token);
        await bound.withPersistence('queue', async (expected, authority) => {
          expect(
            await f.database.setTxStatusIfUnchanged(
              expected,
              'in-sign',
              authority,
            ),
          ).toEqual(true);
        });
        const tx = Transaction.from(f.tx.unsignedSerialized);
        tx.signature = f.key.sign(tx.unsignedHash);
        const signed = new PaymentTransaction(
          'avalanche',
          tx.unsignedHash,
          f.payment().eventId,
          Buffer.from(tx.serialized.slice(2), 'hex'),
          type,
        );
        const signing = await f.runtime.context.bind(await f.current(), [
          'in-sign',
        ]);
        await f.runtime.context.persistResult(
          signing,
          signed,
          async (json, expected, authority) => {
            expect(
              await f.database.updateWithSignedTxIfUnchanged(
                expected,
                json,
                authority,
              ),
            ).toEqual(true);
          },
        );
        const current = await f.current();
        expect(current.status).toEqual('signed');
        expect(JSON.parse(current.txJson)).toEqual(JSON.parse(signed.toJson()));
        expect(current.txId).toEqual(unsigned.txId);
        expect(current.requiredSign).toEqual(2);
        expect(current.lastCheck).toEqual(12);
        expect(current.signFailedCount).toEqual(2);
        expect(current.failedInSign).toEqual(false);
        expect(current.event).toBeNull();
        expect(current.order?.id ?? null).toEqual(unsigned.order?.id ?? null);
        expect(f.requests).toHaveLength(0);
        expect(f.legacy).not.toHaveBeenCalled();
      },
    );
  });

  describe('withPersistence', () => {
    /**
     * @target TransactionSigningContext.withPersistence records $name $type failure after balance consumption on PostgreSQL
     * @dependencies
     * - Actual service PostgreSQL DAO, migrations, scanner and mapped/native signing persistence authorization.
     * - Synthetic admitted row, cold balance and provider responses from createManagementProcessorFixture.
     * @scenario
     * - Queue an unsigned native or mainnet JOE row, consume its AVAX lock balance and persist the in-sign failure.
     * @expected
     * - Failure bookkeeping increments once, preserving unsigned bytes, quorum, checks and order without a POST.
     */
    it.each(cases)(
      'records $name $type failure after balance consumption on PostgreSQL',
      async ({ type, token }) => {
        const { f, unsigned, bound } = await setup(type, token);
        await bound.withPersistence('queue', async (expected, authority) => {
          expect(
            await f.database.setTxStatusIfUnchanged(
              expected,
              'in-sign',
              authority,
            ),
          ).toEqual(true);
        });
        f.cold.locked.nativeToken = 1n;
        const signing = await f.runtime.context.bind(await f.current(), [
          'in-sign',
        ]);
        await signing.withPersistence(
          'failure',
          async (expected, authority) => {
            expect(
              await f.database.setTxStatusIfUnchanged(
                expected,
                'sign-failed',
                authority,
              ),
            ).toEqual(true);
          },
        );
        const current = await f.current();
        expect(current.status).toEqual('sign-failed');
        expect(current.txJson).toEqual(unsigned.txJson);
        expect(current.requiredSign).toEqual(2);
        expect(current.lastCheck).toEqual(12);
        expect(current.signFailedCount).toEqual(3);
        expect(current.failedInSign).toEqual(true);
        expect(current.order?.id ?? null).toEqual(unsigned.order?.id ?? null);
        expect(current.event).toBeNull();
        expect(f.requests).toHaveLength(0);
        expect(f.legacy).not.toHaveBeenCalled();
      },
    );
  });
});
