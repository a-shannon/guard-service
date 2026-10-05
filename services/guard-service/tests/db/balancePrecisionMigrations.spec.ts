import { DataSource, QueryRunner } from '@rosen-bridge/extended-typeorm';

import { ChainAddressBalanceEntity } from '../../src/db/entities/chainAddressBalanceEntity';
import migrations from '../../src/db/migrations';
import { BalancePrecision1790812800000 as PostgresPrecision } from '../../src/db/migrations/postgres/1790812800000-migration';
import { BalancePrecision1790812800000 as SqlitePrecision } from '../../src/db/migrations/sqlite/1790812800000-migration';

describe('SQLite balance precision migration', () => {
  let source: DataSource;
  let runner: QueryRunner;

  beforeEach(async () => {
    source = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [ChainAddressBalanceEntity],
    });
    await source.initialize();
    runner = source.createQueryRunner();
    await runner.query(`CREATE TABLE chain_address_balance_entity (
      chain varchar NOT NULL, address varchar NOT NULL, tokenId varchar NOT NULL,
      lastUpdate varchar NOT NULL, balance bigint NOT NULL,
      PRIMARY KEY (chain, address, tokenId))`);
  });
  afterEach(async () => {
    await runner.release();
    await source.destroy();
  });
  /**
   * @target BalancePrecision1790812800000.up 'preserves exact SQL integers above the JS safe boundary and the composite key'
   * @dependencies Real in-memory SQLite migration, repository and exact balance fixtures.
   * @scenario Insert exact SQLite integers above the JS safe boundary and distinct composite keys; run up; load the repository and attempt a duplicate key.
   * @expected Preserve exact bigint values and all composite-key fields; reject the duplicate key.
   */

  it('preserves exact SQL integers above the JS safe boundary and the composite key', async () => {
    await runner.query(`INSERT INTO chain_address_balance_entity VALUES
      ('ethereum', 'address', 'asset', '7', 9007199254740993),
      ('avalanche', 'address', 'asset', '8', 9223372036854775807),
      ('avalanche', 'other', 'asset', '9', 0)`);
    await new SqlitePrecision().up(runner);
    const rows = await source
      .getRepository(ChainAddressBalanceEntity)
      .find({ order: { lastUpdate: 'ASC' } });
    expect(rows.map((row) => row.balance)).toEqual([
      9007199254740993n,
      9223372036854775807n,
      0n,
    ]);
    expect(
      rows.map(({ chain, address, tokenId, lastUpdate }) => ({
        chain,
        address,
        tokenId,
        lastUpdate,
      })),
    ).toEqual([
      {
        chain: 'ethereum',
        address: 'address',
        tokenId: 'asset',
        lastUpdate: '7',
      },
      {
        chain: 'avalanche',
        address: 'address',
        tokenId: 'asset',
        lastUpdate: '8',
      },
      {
        chain: 'avalanche',
        address: 'other',
        tokenId: 'asset',
        lastUpdate: '9',
      },
    ]);
    await expect(
      runner.query(
        "INSERT INTO chain_address_balance_entity VALUES ('ethereum','address','asset','10','1')",
      ),
    ).rejects.toThrow();
  });
  /**
   * @target BalancePrecision1790812800000.up 'rejects unsafe original value %s before changing schema or data'
   * @dependencies Real in-memory SQLite migration, repository and exact balance fixtures.
   * @scenario Insert each unsafe legacy SQL literal; capture its storage type/value; run up and inspect the table and copy-table presence.
   * @expected Reject unsafe balances, preserve the original storage type/value and leave no copy table.
   */

  it.each(['1.5', '1e30', '-1', "'corrupt'", "X'31'"])(
    'rejects unsafe original value %s before changing schema or data',
    async (literal) => {
      await runner.query(
        `INSERT INTO chain_address_balance_entity VALUES ('avalanche','a','avax','1',${literal})`,
      );
      const before = await runner.query(
        'SELECT typeof(balance) AS kind, CAST(balance AS TEXT) AS value FROM chain_address_balance_entity',
      );
      await expect(new SqlitePrecision().up(runner)).rejects.toThrow(
        'unsafe cached balances',
      );
      expect(
        await runner.query(
          'SELECT typeof(balance) AS kind, CAST(balance AS TEXT) AS value FROM chain_address_balance_entity',
        ),
      ).toEqual(before);
      expect(
        await runner.query(
          "SELECT name FROM sqlite_master WHERE name='balance_precision_copy'",
        ),
      ).toEqual([]);
    },
  );
  /**
   * @target BalancePrecision1790812800000.up 'rejects noncanonical or overflowing legacy text %j'
   * @dependencies Real in-memory SQLite migration, repository and exact balance fixtures.
   * @scenario Create a legacy table without affinity; insert each noncanonical or overflowing text value; run up.
   * @expected Reject every table entry before accepting cached balances.
   */

  it.each([
    '',
    '01',
    '+1',
    '1.0',
    ' 1',
    '1\n',
    '1\0',
    null,
    (1n << 256n).toString(),
    '1'.repeat(79),
  ])('rejects noncanonical or overflowing legacy text %j', async (value) => {
    // No affinity permits exercising genuinely stored legacy text.
    await runner.query('DROP TABLE chain_address_balance_entity');
    await runner.query(
      'CREATE TABLE chain_address_balance_entity (chain, address, tokenId, lastUpdate, balance)',
    );
    await runner.query(
      "INSERT INTO chain_address_balance_entity VALUES ('avalanche','a','avax','1',?)",
      [value],
    );
    await expect(new SqlitePrecision().up(runner)).rejects.toThrow(
      'unsafe cached balances',
    );
  });
  /**
   * @target BalancePrecision1790812800000.up 'preserves canonical uint256 text exactly'
   * @dependencies Real in-memory SQLite migration, repository and exact balance fixtures.
   * @scenario Create legacy text storage; insert the maximum uint256 as exact decimal text; run up and read it through the entity.
   * @expected Read exactly 2^256 - 1 as bigint without rounding.
   */

  it('preserves canonical uint256 text exactly', async () => {
    await runner.query('DROP TABLE chain_address_balance_entity');
    await runner.query(
      'CREATE TABLE chain_address_balance_entity (chain, address, tokenId, lastUpdate, balance TEXT)',
    );
    const maximum = ((1n << 256n) - 1n).toString();
    await runner.query(
      "INSERT INTO chain_address_balance_entity VALUES ('avalanche','a','avax','1',?)",
      [maximum],
    );
    await new SqlitePrecision().up(runner);
    expect(
      (await source.getRepository(ChainAddressBalanceEntity).find())[0].balance,
    ).toBe(BigInt(maximum));
  });
  /**
   * @target BalancePrecision1790812800000.down 'refuses rollback without changing the schema'
   * @dependencies Real in-memory SQLite migration, repository and exact balance fixtures.
   * @scenario Run SQLite up, attempt down and inspect PRAGMA table_info.
   * @expected Refuse unsupported rollback and retain TEXT balance storage.
   */

  it('refuses rollback without changing the schema', async () => {
    await new SqlitePrecision().up(runner);
    await expect(new SqlitePrecision().down()).rejects.toThrow(
      'rollback is unsupported',
    );
    expect(
      (
        await runner.query('PRAGMA table_info(chain_address_balance_entity)')
      ).find((column: { name: string }) => column.name === 'balance').type,
    ).toBe('TEXT');
  });
});

describe('PostgreSQL precision migration SQL contract (no PostgreSQL execution)', () => {
  /**
   * @target BalancePrecision1790812800000.up 'uses only a server-side exact cast and is registered for the correct engines'
   * @dependencies PostgreSQL SQL contract through a query fixture; no PostgreSQL execution.
   * @scenario Invoke PostgreSQL up with an empty-invalid-row query fixture; inspect the two SQL statements and both migration registries.
   * @expected Check negatives before the exact server-side text cast and register each engine-specific migration.
   */

  it('uses only a server-side exact cast and is registered for the correct engines', async () => {
    const query = vi.fn().mockResolvedValue([]);
    await new PostgresPrecision().up({ query } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain('WHERE "balance" < 0');
    expect(query.mock.calls[1][0]).toContain('TYPE text USING "balance"::text');
    expect(migrations.sqlite).toContain(SqlitePrecision);
    expect(migrations.postgres).toContain(PostgresPrecision);
  });
  /**
   * @target BalancePrecision1790812800000.up 'rejects negative legacy values before altering storage'
   * @dependencies PostgreSQL SQL contract through a query fixture; no PostgreSQL execution.
   * @scenario Return one invalid row from the PostgreSQL query fixture; invoke up.
   * @expected Refuse unsafe balances after the first query and issue no storage alteration.
   */

  it('rejects negative legacy values before altering storage', async () => {
    const query = vi.fn().mockResolvedValue([{ invalid: 1 }]);
    await expect(
      new PostgresPrecision().up({ query } as unknown as QueryRunner),
    ).rejects.toThrow('unsafe cached balances');
    expect(query).toHaveBeenCalledTimes(1);
  });
  /**
   * @target BalancePrecision1790812800000.down 'refuses lossy rollback'
   * @dependencies PostgreSQL SQL contract through a query fixture; no PostgreSQL execution.
   * @scenario Invoke PostgreSQL down.
   * @expected Refuse unsupported rollback.
   */

  it('refuses lossy rollback', async () => {
    await expect(new PostgresPrecision().down()).rejects.toThrow(
      'rollback is unsupported',
    );
  });
});
