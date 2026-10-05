import type { DataSource } from '@rosen-bridge/extended-typeorm';
import type { FastifyWithZod } from '@rosen-bridge/fastify-enhanced';
import type { HealthCheck } from '@rosen-bridge/health-check';

import {
  agePolicy,
  processingStatus,
  savedBlock,
  scanner,
} from './guardHealthDbTestData';

/** Seed isolated actual scanner rows, including non-selected status and scanner controls. */
export const seedScannerBlocks = async (dataSource: DataSource) => {
  const { BlockEntity, PROCEED } = await import(
    '@rosen-bridge/abstract-scanner'
  );
  const repository = dataSource.getRepository(BlockEntity);
  await repository.clear();
  await repository.save([
    { ...savedBlock, status: PROCEED },
    {
      ...savedBlock,
      hash: 'synthetic-processing',
      parentHash: 'synthetic-processing-parent',
      height: 999,
      status: processingStatus,
    },
    {
      ...savedBlock,
      hash: 'synthetic-other-scanner',
      scanner: 'synthetic-other',
      height: 1000,
      status: PROCEED,
    },
  ]);
};

/** Load the unchanged production DataSource and initialize its complete migrations. */
export const openProductionDatabase = async () => {
  const { dataSource } = await import('../../src/db/dataSource');
  await dataSource.initialize();
  const migrations = await dataSource.runMigrations();
  const { DatabaseAction } = await import('../../src/db/databaseAction');
  const action = DatabaseAction.init(dataSource);
  return { dataSource, action, migrations };
};

/** Reopen the same file-backed production DataSource and rebind its real consumer. */
export const reopenProductionDatabase = async (dataSource: DataSource) => {
  await dataSource.initialize();
  const migrations = await dataSource.runMigrations();
  const { DatabaseAction } = await import('../../src/db/databaseAction');
  return { action: DatabaseAction.init(dataSource), migrations };
};

/** Register an actual scanner health parameter backed by the service DB singleton. */
export const createScannerHealth = async () => {
  const { HealthCheck } = await import('@rosen-bridge/health-check');
  const { ScannerSyncHealthCheckParam } = await import(
    '@rosen-bridge/scanner-sync-check'
  );
  const { DatabaseAction } = await import('../../src/db/databaseAction');
  const health = new HealthCheck();
  const parameter = new ScannerSyncHealthCheckParam(
    scanner,
    () => DatabaseAction.getInstance().getLastSavedBlockForScanner(scanner),
    agePolicy.warnDifference,
    agePolicy.criticalDifference,
    agePolicy.blockTime,
  );
  health.register(parameter);
  return { health, parameter };
};

/** Attach the unchanged service health routes without binding a listening socket. */
export const createHealthApi = async (): Promise<FastifyWithZod> => {
  const { makeFastify } = await import('@rosen-bridge/fastify-enhanced');
  const { healthRoutes } = await import('../../src/api/healthCheck');
  const api = await makeFastify();
  await api.register(healthRoutes);
  await api.ready();
  return api;
};

/** Extract stable migration rows through the actual TypeORM metadata repository. */
export const migrationRows = async (dataSource: DataSource) =>
  dataSource.query(
    'SELECT name, timestamp FROM migrations ORDER BY timestamp, name',
  );

/** Update one real parameter and return its current service-facing status object. */
export const updateScannerHealth = async (
  health: HealthCheck,
  paramId: string,
) => {
  await health.updateParam(paramId);
  return health.getHealthStatusWithParamId(paramId);
};
