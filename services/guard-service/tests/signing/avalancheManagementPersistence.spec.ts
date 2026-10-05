import { SigningKey, Transaction } from 'ethers';

import { DataSource } from '@rosen-bridge/extended-typeorm';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { DatabaseAction } from '../../src/db/databaseAction';
import { dataSource as configuredSource } from '../../src/db/dataSource';
import { ArbitraryEntity } from '../../src/db/entities/arbitraryEntity';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { createManagementSigningFixture } from './avalancheManagementSigningTestUtils';

const fixtures: { close(): Promise<void> }[] = [];

/** Creates the selected actual service database and its admitted native row. */
const setup = async (type = TransactionType.coldStorage) => {
  const f = await createManagementSigningFixture(type);
  fixtures.push(f);
  if (configuredSource.options.type !== 'sqlite')
    throw new Error('Expected actual SQLite configuration');
  const source = await new DataSource({
    ...configuredSource.options,
    type: 'sqlite',
    database: ':memory:',
  }).initialize();
  await source.runMigrations();
  fixtures.push({ close: () => source.destroy() });
  DatabaseAction.init(source);
  const db = DatabaseAction.getInstance();
  vi.spyOn(
    PublicStatusHandler.getInstance(),
    'updatePublicTxStatus',
  ).mockResolvedValue(undefined);
  const order =
    type === TransactionType.arbitrary
      ? await source.getRepository(ArbitraryEntity).save({
          id: f.order.id,
          chain: f.order.chain,
          status: f.order.status,
          orderJson: f.order.orderJson,
          firstTry: '0',
          unexpectedFails: 0,
        })
      : null;
  await source.getRepository(TransactionEntity).save({
    ...f.row,
    event: null,
    order,
    status: 'approved',
    lastCheck: 0,
    lastStatusUpdate: '0',
    failedInSign: false,
    signFailedCount: 0,
  });
  f.getTx.mockImplementation(() => db.getTxById(f.row.txId));
  const row = (await db.getTxById(f.row.txId))!;
  const bound = await f.runtime.context.bind(row, ['approved', 'in-sign']);
  return { ...f, source, db, row, bound };
};
describe('TransactionSigningContext', () => {
  afterEach(async () => {
    for (const f of fixtures.splice(0).reverse()) await f.close();
    vi.restoreAllMocks();
  });

  describe('bind', () => {
    /**
     * @target TransactionSigningContext.bind rejects policy drift inside its SQL transaction
     * @dependencies
     * - Bound context returned by TransactionSigningContext.bind and its withPersistence port.
     * - Actual owned transaction manager and native policy/result persistence checks.
     * @scenario
     * - Disable the route after the manager reads the row and before it can update status.
     * @expected
     * - The transaction aborts and the approved row remains unchanged.
     */
    it('rejects policy drift inside its SQL transaction', async () => {
      const f = await setup(TransactionType.manual);
      await expect(
        f.bound.withPersistence('queue', (expected, authority) =>
          f.db.setTxStatusIfUnchanged(expected, 'in-sign', {
            ...authority,
            assertBefore: async (manager, row) => {
              Object.assign(f.policy, { manualRequests: false });
              await authority.assertBefore(manager, row);
            },
          }),
        ),
      ).rejects.toThrow('authority changed');
      expect((await f.db.getTxById(f.row.txId))?.status).toEqual('approved');
    });

    /**
     * @target TransactionSigningContext.bind refuses a reserve that cannot cover the actual input before queue SQL
     * @dependencies
     * - Bound context returned by TransactionSigningContext.bind and its withPersistence port.
     * - Real value-plus-fee accounting and native SQL queue transition.
     * @scenario
     * - Lower current lock balance after binding but before queue persistence.
     * @expected
     * - No callback runs and no row enters in-sign.
     */
    it('refuses a reserve that cannot cover the actual input before queue SQL', async () => {
      const f = await setup();
      f.cold.locked.nativeToken = 1600000n;
      const persist = vi.fn();
      await expect(f.bound.withPersistence('queue', persist)).rejects.toThrow(
        'reserve',
      );
      expect(persist).not.toHaveBeenCalled();
      expect((await f.db.getTxById(f.row.txId))?.status).toEqual('approved');
    });

    /**
     * @target TransactionSigningContext.bind persists signing failure after the cold trigger is consumed
     * @dependencies
     * - Bound context returned by TransactionSigningContext.bind and its withPersistence port.
     * - Actual signing context and DAO failure transition.
     * @scenario
     * - A signing attempt fails after the live cold trigger has been consumed.
     * @expected
     * - Failure bookkeeping preserves unsigned bytes and increments its counter once.
     */
    it('persists signing failure after the cold trigger is consumed', async () => {
      const f = await setup();
      await f.source
        .getRepository(TransactionEntity)
        .update({ txId: f.row.txId }, { status: 'in-sign' });
      f.cold.locked.nativeToken = 1n;
      const current = (await f.db.getTxById(f.row.txId))!;
      const signing = await f.runtime.context.bind(current, ['in-sign']);
      await signing.withPersistence('failure', async (expected, authority) => {
        expect(
          await f.db.setTxStatusIfUnchanged(expected, 'sign-failed', authority),
        ).toEqual(true);
      });
      const result = (await f.db.getTxById(f.row.txId))!;
      expect(result.status).toEqual('sign-failed');
      expect(result.txJson).toEqual(current.txJson);
      expect(result.signFailedCount).toEqual(1);
      expect(result.failedInSign).toEqual(true);
    });

    /**
     * @target TransactionSigningContext.bind rolls back an altered queue afterimage
     * @dependencies
     * - Bound context returned by TransactionSigningContext.bind and its withPersistence port.
     * - Actual transaction manager, context and CAS transition.
     * @scenario
     * - The manager changes quorum after the queue write and before final authorization.
     * @expected
     * - The complete SQL transaction rolls back, including the earlier status write.
     */
    it('rolls back an altered queue afterimage', async () => {
      const f = await setup(TransactionType.arbitrary);
      await expect(
        f.bound.withPersistence('queue', (expected, authority) =>
          f.db.setTxStatusIfUnchanged(expected, 'in-sign', {
            ...authority,
            assertAfter: async (manager, row) => {
              await manager
                .getRepository(TransactionEntity)
                .update({ txId: row.txId }, { requiredSign: 1 });
              await authority.assertAfter(manager, row);
            },
          }),
        ),
      ).rejects.toThrow('row changed');
      const result = (await f.db.getTxById(f.row.txId))!;
      expect(result.status).toEqual('approved');
      expect(result.requiredSign).toEqual(2);
    });

    /**
     * @target TransactionSigningContext.bind requires an active owned SQL manager
     * @dependencies
     * - Bound context returned by TransactionSigningContext.bind and its withPersistence port.
     * - Actual service SQLite manager and scanner-bound persistence authority.
     * @scenario
     * - The callback supplies its nontransactional manager for the beforeimage.
     * @expected
     * - Authorization refuses before any row can leave approved.
     */
    it('requires an active owned SQL manager', async () => {
      const f = await setup(TransactionType.manual);
      await expect(
        f.bound.withPersistence('queue', (expected, authority) =>
          authority.assertBefore(f.source.manager, expected),
        ),
      ).rejects.toThrow('owned active SQL manager');
      expect((await f.db.getTxById(f.row.txId))?.status).toEqual('approved');
    });

    /**
     * @target TransactionSigningContext.bind refuses a different database with identical fields
     * @dependencies
     * - Bound context returned by TransactionSigningContext.bind and its withPersistence port.
     * - Two actual SQLite databases and their distinct active transaction managers.
     * @scenario
     * - Another database contains the exact same admitted transaction row.
     * @expected
     * - Its manager receives no write authority and neither row changes.
     */
    it('refuses a different database with identical fields', async () => {
      const f = await setup(TransactionType.manual);
      if (configuredSource.options.type !== 'sqlite')
        throw new Error('Expected actual SQLite configuration');
      const foreign = await new DataSource({
        ...configuredSource.options,
        type: 'sqlite',
        database: ':memory:',
      }).initialize();
      fixtures.push({ close: () => foreign.destroy() });
      await foreign.runMigrations();
      await foreign
        .getRepository(TransactionEntity)
        .save({ ...f.row, event: null, order: null });
      await expect(
        f.bound.withPersistence('queue', (expected, authority) =>
          foreign.transaction(async (manager) => {
            await authority.assertBefore(manager, expected);
            await manager
              .getRepository(TransactionEntity)
              .update({ txId: expected.txId }, { status: 'in-sign' });
          }),
        ),
      ).rejects.toThrow('owned active SQL manager');
      expect((await f.db.getTxById(f.row.txId))?.status).toEqual('approved');
      expect(
        (
          await foreign
            .getRepository(TransactionEntity)
            .findOneByOrFail({ txId: f.row.txId })
        ).status,
      ).toEqual('approved');
    });

    /**
     * @target TransactionSigningContext.bind rejects changed arbitrary output semantics inside SQL
     * @dependencies
     * - Bound context returned by TransactionSigningContext.bind and its withPersistence port.
     * - Actual arbitrary order codec, transaction manager and rollback.
     * @scenario
     * - The order is changed to an empty array before the manager checks its first snapshot.
     * @expected
     * - Native-output comparison refuses and rolls back the order mutation.
     */
    it('rejects changed arbitrary output semantics inside SQL', async () => {
      const f = await setup(TransactionType.arbitrary);
      await expect(
        f.bound.withPersistence('queue', (expected, authority) =>
          f.db.setTxStatusIfUnchanged(expected, 'in-sign', {
            ...authority,
            assertBefore: async (manager, row) => {
              await manager
                .getRepository(ArbitraryEntity)
                .update({ id: row.orderId! }, { orderJson: '[]' });
              await authority.assertBefore(manager, row);
            },
          }),
        ),
      ).rejects.toThrow('differs from native outputs');
      expect((await f.db.getTxById(f.row.txId))?.status).toEqual('approved');
      expect((await f.db.getOrderById(f.row.order!.id))?.orderJson).toEqual(
        f.order.orderJson,
      );
    });

    /**
     * @target TransactionSigningContext.bind rejects changed chain identity inside SQL
     * @dependencies
     * - Bound context returned by TransactionSigningContext.bind and its withPersistence port.
     * - Actual native chain configuration and owned manager.
     * @scenario
     * - The adapter chain ID is replaced after preparation but before its SQL beforeimage.
     * @expected
     * - The row stays approved and no authority survives the changed chain.
     */
    it('rejects changed chain identity inside SQL', async () => {
      const f = await setup(TransactionType.manual);
      await expect(
        f.bound.withPersistence('queue', (expected, authority) =>
          f.db.setTxStatusIfUnchanged(expected, 'in-sign', {
            ...authority,
            assertBefore: async (manager, row) => {
              Object.assign(f.chain, { CHAIN_ID: 43114n });
              await authority.assertBefore(manager, row);
            },
          }),
        ),
      ).rejects.toThrow('authority changed');
      expect((await f.db.getTxById(f.row.txId))?.status).toEqual('approved');
    });
  });

  describe('persistResult', () => {
    /**
     * @target TransactionSigningContext.persistResult persists native %s queue and signed result through owned SQL
     * @dependencies
     * - Real native accounting/envelope/fee checks, runtime, scanner lease, service migrations and DAO.
     * - Synthetic balance and RPC acquisition, test key and public status callback.
     * @scenario
     * - Transition an admitted approved row to in-sign and then persist its exact native signed body.
     * @expected
     * - The final DAO row contains signed bytes with unchanged identity/quorum/order association.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])(
      'persists native %s queue and signed result through owned SQL',
      async (type) => {
        const f = await setup(type);
        await f.bound.withPersistence('queue', async (expected, authority) => {
          expect(
            await f.db.setTxStatusIfUnchanged(expected, 'in-sign', authority),
          ).toEqual(true);
        });
        const current = (await f.db.getTxById(f.row.txId))!;
        const signing = await f.runtime.context.bind(current, ['in-sign']);
        await f.runtime.context.persistResult(
          signing,
          f.signed(),
          async (json, expected, authority) => {
            expect(
              await f.db.updateWithSignedTxIfUnchanged(
                expected,
                json,
                authority,
              ),
            ).toEqual(true);
          },
        );
        const result = (await f.db.getTxById(f.row.txId))!;
        expect(result.status).toEqual('signed');
        expect(JSON.parse(result.txJson)).toEqual(
          JSON.parse(f.signed().toJson()),
        );
        expect(result.requiredSign).toEqual(2);
        expect(result.order?.id ?? null).toEqual(f.row.order?.id ?? null);
        expect(result.event).toBeNull();
      },
    );

    /**
     * @target TransactionSigningContext.persistResult refuses a changed result lock signer before SQL
     * @dependencies
     * - Actual native serialization and RPC-free signed-result check.
     * @scenario
     * - Sign the unchanged native body using another public test key.
     * @expected
     * - Preparation refuses before a SQL manager or result callback is used.
     */
    it('refuses a changed result lock signer before SQL', async () => {
      const f = await setup(TransactionType.manual);
      await f.source
        .getRepository(TransactionEntity)
        .update({ txId: f.row.txId }, { status: 'in-sign' });
      const current = (await f.db.getTxById(f.row.txId))!;
      const signing = await f.runtime.context.bind(current, ['in-sign']);
      const tx = Transaction.from(f.tx.unsignedSerialized);
      tx.signature = new SigningKey('0x' + '22'.repeat(32)).sign(
        tx.unsignedHash,
      );
      const wrong = new PaymentTransaction(
        'avalanche',
        tx.unsignedHash,
        '',
        Buffer.from(tx.serialized.slice(2), 'hex'),
        TransactionType.manual,
      );
      const persist = vi.fn();
      await expect(
        f.runtime.context.persistResult(signing, wrong, persist),
      ).rejects.toThrow('signed result');
      expect(persist).not.toHaveBeenCalled();
    });
  });
});
