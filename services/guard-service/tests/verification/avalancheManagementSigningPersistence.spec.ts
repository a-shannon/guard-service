import { Transaction } from 'ethers';

import { DataSource } from '@rosen-bridge/extended-typeorm';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { DatabaseAction } from '../../src/db/databaseAction';
import { dataSource as configuredSource } from '../../src/db/dataSource';
import { ArbitraryEntity } from '../../src/db/entities/arbitraryEntity';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import type { SigningRowPreimage } from '../../src/signing/transactionSigningContext';
import { prepareAvalancheManagementSigningPersistence } from '../../src/verification/avalancheManagementSigningPersistence';
import { createManagementAuthorizationFixture } from './avalancheManagementAuthorizationTestUtils';

const fixtures: { close(): void | Promise<void> }[] = [];

/** Loads one admitted native transaction through the service's actual SQLite schema. */
const setup = async (
  type = TransactionType.manual,
  status = 'approved',
  token = false,
) => {
  const f = await createManagementAuthorizationFixture(type, token);
  fixtures.push(f);
  if (configuredSource.options.type !== 'sqlite')
    throw new Error('Expected actual SQLite configuration');
  const source = await new DataSource({
    ...configuredSource.options,
    type: 'sqlite',
    database: ':memory:',
  }).initialize();
  fixtures.push({ close: () => source.destroy() });
  await source.runMigrations();
  DatabaseAction.init(source);
  const database = DatabaseAction.getInstance();
  const order =
    type === TransactionType.arbitrary
      ? await source.getRepository(ArbitraryEntity).save({
          ...f.order,
          firstTry: '0',
          unexpectedFails: 0,
        })
      : null;
  await source.getRepository(TransactionEntity).save({
    ...f.row,
    status,
    event: null,
    order,
    lastCheck: 0,
    lastStatusUpdate: '0',
    failedInSign: false,
    signFailedCount: 0,
  });
  const row = (await database.getTxById(f.row.txId))!;
  const expected = preimage(row);
  const tx = Transaction.from(f.tx.unsignedSerialized);
  tx.signature = f.key.sign(tx.unsignedHash);
  const signedJson = new PaymentTransaction(
    'avalanche',
    tx.unsignedHash,
    f.payment().eventId,
    Buffer.from(tx.serialized.slice(2), 'hex'),
    type,
  ).toJson();
  const ports: Parameters<
    typeof prepareAvalancheManagementSigningPersistence
  >[0] = {
    getPolicy: f.getPolicy,
    getChain: () => f.chain,
    getTx: f.getTx,
    decode: (json) => f.chain.PaymentTransactionFromJson(json),
    getOrder: f.getOrder,
    getOrderTxIds: f.getOrderTxIds,
    getColdState: f.getColdState,
    assertTokenMapUnchanged: f.unchanged,
    getDatabase: () => database,
  };
  return { ...f, source, database, row, expected, signedJson, ports };
};

/** Selects the admitted row values required by the public persistence-check interface. */
const preimage = (row: TransactionEntity): SigningRowPreimage => ({
  txId: row.txId,
  txJson: row.txJson,
  chain: row.chain,
  type: row.type,
  status: row.status,
  requiredSign: row.requiredSign,
  eventId: row.event?.id ?? null,
  orderId: row.order?.id ?? null,
});

describe('prepareAvalancheManagementSigningPersistence', () => {
  afterEach(async () => {
    for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
    vi.restoreAllMocks();
  });
  /**
   * @target prepareAvalancheManagementSigningPersistence preserves mapped JOE $purpose for $type
   * @dependencies Actual mainnet token envelope, synthetic signer and SQLite migrations/owned manager
   * @scenario Apply queue, signed result or signing failure to an admitted token route
   * @expected Exact transaction fields persist through both SQL checks and cold balances remain unread
   */
  it.each([
    { purpose: 'queue' as const, type: TransactionType.coldStorage },
    { purpose: 'result' as const, type: TransactionType.coldStorage },
    { purpose: 'failure' as const, type: TransactionType.coldStorage },
    { purpose: 'queue' as const, type: TransactionType.manual },
    { purpose: 'result' as const, type: TransactionType.manual },
    { purpose: 'failure' as const, type: TransactionType.manual },
    { purpose: 'queue' as const, type: TransactionType.arbitrary },
    { purpose: 'result' as const, type: TransactionType.arbitrary },
    { purpose: 'failure' as const, type: TransactionType.arbitrary },
  ])('preserves mapped JOE $purpose for $type', async ({ purpose, type }) => {
    const f = await setup(
      type,
      purpose === 'queue' ? 'approved' : 'in-sign',
      true,
    );
    const checks = prepareAvalancheManagementSigningPersistence(
      f.ports,
      f.expected,
      purpose,
      purpose === 'result' ? f.signedJson : undefined,
    );
    const after = {
      ...f.expected,
      status:
        purpose === 'queue'
          ? 'in-sign'
          : purpose === 'result'
            ? 'signed'
            : 'sign-failed',
      txJson: purpose === 'result' ? f.signedJson : f.expected.txJson,
    };
    await f.source.transaction(async (manager) => {
      await checks.assertBefore(manager, f.expected);
      await manager
        .getRepository(TransactionEntity)
        .update(
          { txId: f.expected.txId },
          { status: after.status, txJson: after.txJson },
        );
      await checks.assertAfter(manager, after);
    });
    expect(preimage((await f.database.getTxById(f.row.txId))!)).toEqual(after);
    expect(f.getColdState).not.toHaveBeenCalled();
  });

  /**
   * @target prepareAvalancheManagementSigningPersistence refuses mapped result with changed %s
   * @dependencies Real mapped signed body and exact admitted unsigned identity
   * @scenario Sign a different raw token amount, recipient or contract under the same synthetic custody key
   * @expected Persistence checks reject before a write and the admitted unsigned row stays in-sign
   */
  it.each(['amount', 'recipient', 'asset'] as const)(
    'refuses mapped result with changed %s',
    async (field) => {
      const f = await setup(TransactionType.manual, 'in-sign', true);
      const wrong = Transaction.from(f.tx.unsignedSerialized);
      if (field === 'amount')
        wrong.data =
          wrong.data.slice(0, -64) +
          (750000n * 1000000000n + 1n).toString(16).padStart(64, '0');
      if (field === 'recipient')
        wrong.data =
          wrong.data.slice(0, 10) +
          '78'.repeat(20).padStart(64, '0') +
          wrong.data.slice(74);
      if (field === 'asset') wrong.to = '0x' + '78'.repeat(20);
      wrong.signature = f.key.sign(wrong.unsignedHash);
      const model = f.payment();
      model.txBytes = Buffer.from(wrong.serialized.slice(2), 'hex');
      expect(() =>
        prepareAvalancheManagementSigningPersistence(
          f.ports,
          f.expected,
          'result',
          model.toJson(),
        ),
      ).toThrow('persisted result');
      expect(preimage((await f.database.getTxById(f.row.txId))!)).toEqual(
        f.expected,
      );
    },
  );
  /**
   * @target prepareAvalancheManagementSigningPersistence checks the $purpose transition for native $type
   * @dependencies
   * - Actual native envelopes, synthetic lock signature, configured SQLite migrations and owned manager.
   * - Existing native policy/token-map fixture; no RPC acquisition is needed by the checks.
   * @scenario
   * - Prepare cold queue, manual result or arbitrary failure checks and apply the exact transition.
   * @expected
   * - Both manager snapshots pass and the committed row preserves every other owned field.
   */
  it.each([
    { purpose: 'queue' as const, type: TransactionType.coldStorage },
    { purpose: 'result' as const, type: TransactionType.manual },
    { purpose: 'failure' as const, type: TransactionType.arbitrary },
  ])(
    'checks the $purpose transition for native $type',
    async ({ purpose, type }) => {
      const f = await setup(type, purpose === 'queue' ? 'approved' : 'in-sign');
      const checks = prepareAvalancheManagementSigningPersistence(
        f.ports,
        f.expected,
        purpose,
        purpose === 'result' ? f.signedJson : undefined,
      );
      const after = {
        ...f.expected,
        status:
          purpose === 'queue'
            ? 'in-sign'
            : purpose === 'result'
              ? 'signed'
              : 'sign-failed',
        txJson: purpose === 'result' ? f.signedJson : f.expected.txJson,
      };
      await f.source.transaction(async (manager) => {
        await checks.assertBefore(manager, f.expected);
        await manager
          .getRepository(TransactionEntity)
          .update(
            { txId: f.expected.txId },
            { status: after.status, txJson: after.txJson },
          );
        await checks.assertAfter(manager, after);
      });
      expect(preimage((await f.database.getTxById(f.row.txId))!)).toEqual(
        after,
      );
      expect(f.getColdState).not.toHaveBeenCalled();
    },
  );

  /**
   * @target prepareAvalancheManagementSigningPersistence refuses a manager outside an active transaction
   * @dependencies
   * - Actual selected SQLite database and its outer manager.
   * @scenario
   * - Supply the outer manager for the unchanged queue beforeimage.
   * @expected
   * - Ownership refuses before a write and the row remains approved.
   */
  it('refuses a manager outside an active transaction', async () => {
    const f = await setup();
    const checks = prepareAvalancheManagementSigningPersistence(
      f.ports,
      f.expected,
      'queue',
    );
    await expect(
      checks.assertBefore(f.source.manager, f.expected),
    ).rejects.toThrow('owned active SQL manager');
    expect(preimage((await f.database.getTxById(f.row.txId))!)).toEqual(
      f.expected,
    );
  });

  /**
   * @target prepareAvalancheManagementSigningPersistence refuses a different database with the same admitted row
   * @dependencies
   * - Two real SQLite databases with identical admitted manual rows and active managers.
   * @scenario
   * - Supply the foreign database's transaction manager for the captured queue beforeimage.
   * @expected
   * - Exact row equality cannot grant ownership and both databases retain approved state.
   */
  it('refuses a different database with the same admitted row', async () => {
    const f = await setup();
    if (configuredSource.options.type !== 'sqlite')
      throw new Error('Expected actual SQLite configuration');
    const foreign = await new DataSource({
      ...configuredSource.options,
      type: 'sqlite',
      database: ':memory:',
    }).initialize();
    fixtures.push({ close: () => foreign.destroy() });
    await foreign.runMigrations();
    await foreign.getRepository(TransactionEntity).save({
      ...f.row,
      event: null,
      order: null,
    });
    const checks = prepareAvalancheManagementSigningPersistence(
      f.ports,
      f.expected,
      'queue',
    );
    await expect(
      foreign.transaction((manager) =>
        checks.assertBefore(manager, f.expected),
      ),
    ).rejects.toThrow('owned active SQL manager');
    expect(preimage((await f.database.getTxById(f.row.txId))!)).toEqual(
      f.expected,
    );
    expect(
      (
        await foreign.getRepository(TransactionEntity).findOneByOrFail({
          txId: f.row.txId,
        })
      ).status,
    ).toEqual('approved');
  });

  /**
   * @target prepareAvalancheManagementSigningPersistence rolls back changed arbitrary outputs before commit
   * @dependencies
   * - Actual arbitrary order codec, owned SQLite manager and native queue checks.
   * @scenario
   * - Admit the beforeimage, replace the order outputs, then request its matching queue afterimage.
   * @expected
   * - The output comparison refuses and SQL restores the original order and approved row.
   */
  it('rolls back changed arbitrary outputs before commit', async () => {
    const f = await setup(TransactionType.arbitrary);
    const checks = prepareAvalancheManagementSigningPersistence(
      f.ports,
      f.expected,
      'queue',
    );
    await expect(
      f.source.transaction(async (manager) => {
        await checks.assertBefore(manager, f.expected);
        await manager
          .getRepository(ArbitraryEntity)
          .update({ id: f.expected.orderId! }, { orderJson: '[]' });
        await manager
          .getRepository(TransactionEntity)
          .update({ txId: f.expected.txId }, { status: 'in-sign' });
        await checks.assertAfter(manager, { ...f.expected, status: 'in-sign' });
      }),
    ).rejects.toThrow('differs from native outputs');
    expect(preimage((await f.database.getTxById(f.row.txId))!)).toEqual(
      f.expected,
    );
    expect(
      (await f.database.getOrderById(f.expected.orderId!))?.orderJson,
    ).toEqual(f.order.orderJson);
  });
});
