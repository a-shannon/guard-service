import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import base from './vitest.config';

/** Replays native execution consumers against one dedicated local PostgreSQL fixture. */
const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: ['./tests/setup/setupNativeManagementPostgres.ts'],
      fileParallelism: false,
      maxWorkers: 1,
      include: [
        'tests/verification/avalancheManagementExecutionAuthorization.spec.ts',
        'tests/transaction/avalancheManagementProcessor.spec.ts',
        'tests/signing/avalancheManagementPostgresPersistence.spec.ts',
        'tests/db/avalancheNativeManagementPostgresRestart.spec.ts',
      ],
    },
  }),
);

export default defineConfig({
  ...merged,
  test: {
    ...merged.test,
    exclude: configDefaults.exclude,
  },
});
