/* eslint-disable check-file/filename-naming-convention -- RCS test filename mirrors the timestamped migration source. */
import { BalancePrecision1790812800000 } from '../../../../src/db/migrations/sqlite/1790812800000-migration';
import { mockQueryRunner } from './mocked/queryRunner.mock';

describe('BalancePrecision1790812800000', () => {
  describe('up', () => {
    /**
     * @target BalancePrecision1790812800000.up 'checks cached rows before altering balance storage'
     * @dependencies Capturing query runner; actual sqlite migration.
     * @scenario Run up with no unsafe rows and inspect ordered SQL calls.
     * @expected Validation is first and text conversion occurs in the database.
     */
    it('checks cached rows before altering balance storage', async () => {
      const { query, runner } = mockQueryRunner();
      await new BalancePrecision1790812800000().up(runner);
      expect(query).toHaveBeenCalledTimes(5);
      expect(query.mock.calls[0][0]).toContain('SELECT 1');
      expect(query.mock.calls[2][0]).toContain('CAST("balance" AS TEXT)');
    });
    /**
     * @target BalancePrecision1790812800000.up 'refuses unsafe cached rows before any schema write'
     * @dependencies Capturing query runner reporting one unsafe row.
     * @scenario Invoke up with a nonempty validation result.
     * @expected Refusal after one validation query; no schema mutation.
     */
    it('refuses unsafe cached rows before any schema write', async () => {
      const { query, runner } = mockQueryRunner(true);
      await expect(
        new BalancePrecision1790812800000().up(runner),
      ).rejects.toThrow('refuses unsafe cached balances');
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
  describe('down', () => {
    /**
     * @target BalancePrecision1790812800000.down 'refuses precision-losing rollback'
     * @dependencies Actual migration; no database connection.
     * @scenario Invoke down.
     * @expected Explicit unsupported rollback refusal.
     */
    it('refuses precision-losing rollback', async () => {
      await expect(new BalancePrecision1790812800000().down()).rejects.toThrow(
        'numeric storage can lose precision',
      );
    });
  });
});
