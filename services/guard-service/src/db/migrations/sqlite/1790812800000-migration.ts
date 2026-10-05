import {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

export class BalancePrecision1790812800000 implements MigrationInterface {
  name = 'BalancePrecision1790812800000';

  /** Migrates stored balance amounts to the precision-preserving representation. */
  public async up(queryRunner: QueryRunner): Promise<void> {
    // CAST runs inside SQLite: fetching the original INTEGER into JS loses bits.
    // REAL rows may already be rounded; refuse rather than invent their value.
    const invalid = await queryRunner.query(`
      SELECT 1 FROM "chain_address_balance_entity"
      WHERE typeof("balance") NOT IN ('integer', 'text')
        OR CAST("balance" AS TEXT) = ''
        OR CAST("balance" AS TEXT) GLOB '*[^0-9]*'
        OR length(CAST("balance" AS BLOB)) != length(CAST("balance" AS TEXT))
        OR (length(CAST("balance" AS TEXT)) > 1
          AND substr(CAST("balance" AS TEXT), 1, 1) = '0')
        OR length(CAST("balance" AS TEXT)) > 78
        OR (length(CAST("balance" AS TEXT)) = 78
          AND CAST("balance" AS TEXT) COLLATE BINARY >
            '115792089237316195423570985008687907853269984665640564039457584007913129639935')
      LIMIT 1
    `);
    if (invalid.length)
      throw new Error(
        'Balance precision migration refuses unsafe cached balances',
      );

    await queryRunner.query(`
      CREATE TABLE "balance_precision_copy" (
        "chain" varchar NOT NULL,
        "address" varchar NOT NULL,
        "tokenId" varchar NOT NULL,
        "lastUpdate" varchar NOT NULL,
        "balance" text NOT NULL,
        PRIMARY KEY ("chain", "address", "tokenId")
      )
    `);
    await queryRunner.query(`
      INSERT INTO "balance_precision_copy"
        ("chain", "address", "tokenId", "lastUpdate", "balance")
      SELECT "chain", "address", "tokenId", "lastUpdate", CAST("balance" AS TEXT)
      FROM "chain_address_balance_entity"
    `);
    await queryRunner.query('DROP TABLE "chain_address_balance_entity"');
    await queryRunner.query(
      'ALTER TABLE "balance_precision_copy" RENAME TO "chain_address_balance_entity"',
    );
  }

  /** Refuses rollback because numeric storage can lose balance precision. */
  public async down(): Promise<void> {
    throw new Error(
      'Balance precision rollback is unsupported: numeric storage can lose precision',
    );
  }
}
