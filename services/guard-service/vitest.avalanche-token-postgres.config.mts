import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import base from './vitest.config';

/** Qualifies mapped execution, signing persistence and processor consumers on the dedicated loopback PostgreSQL fixture. */
const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: ['./tests/setup/setupNativeManagementPostgres.ts'],
      fileParallelism: false,
      maxWorkers: 1,
      include: [
        'tests/verification/avalancheManagementExecutionAuthorization.spec.ts',
        'tests/signing/avalancheManagementPostgresPersistence.spec.ts',
        'tests/transaction/avalancheManagementProcessor.spec.ts',
        'tests/db/avalancheNativeManagementPostgresRestart.spec.ts',
      ],
    },
  }),
);

export default defineConfig({
  ...merged,
  test: { ...merged.test, exclude: configDefaults.exclude },
});
