import migrations from '../../../src/db/migrations';
import { BalancePrecision1790812800000 as PostgresPrecision } from '../../../src/db/migrations/postgres/1790812800000-migration';
import { BalancePrecision1790812800000 as SqlitePrecision } from '../../../src/db/migrations/sqlite/1790812800000-migration';

describe('migrations', () => {
  /**
   * @target migrations 'registers the %s precision migration once after its predecessors'
   * @dependencies Actual migration registry and both engine constructors.
   * @scenario Read each engine migration list and inspect the precision constructor position.
   * @expected Exactly one precision migration as the final migration.
   */
  it.each([
    ['sqlite', SqlitePrecision],
    ['postgres', PostgresPrecision],
  ] as const)(
    'registers the %s precision migration once after its predecessors',
    (engine, precision) => {
      const entries = migrations[engine];
      expect(entries.filter((entry) => entry === precision)).toHaveLength(1);
      expect(entries.at(-1)).toBe(precision);
      expect(entries.length).toBeGreaterThan(1);
    },
  );
});
