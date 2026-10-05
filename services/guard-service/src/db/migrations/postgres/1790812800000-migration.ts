import {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

export class BalancePrecision1790812800000 implements MigrationInterface {
  name = 'BalancePrecision1790812800000';

  /** Migrates stored balance amounts to the precision-preserving representation. */
  public async up(queryRunner: QueryRunner): Promise<void> {
    const invalid = await queryRunner.query(`
      SELECT 1 FROM "chain_address_balance_entity" WHERE "balance" < 0 LIMIT 1
    `);
    if (invalid.length)
      throw new Error(
        'Balance precision migration refuses unsafe cached balances',
      );
    // PostgreSQL performs the conversion exactly, without a JS numeric value.
    await queryRunner.query(`
      ALTER TABLE "chain_address_balance_entity"
      ALTER COLUMN "balance" TYPE text USING "balance"::text
    `);
  }

  /** Refuses rollback because numeric storage can lose balance precision. */
  public async down(): Promise<void> {
    throw new Error(
      'Balance precision rollback is unsupported: numeric storage can lose precision',
    );
  }
}
