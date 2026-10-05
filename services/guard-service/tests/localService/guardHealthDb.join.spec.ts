import '@rosen-bridge/extended-typeorm/bootstrap';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ConsoleLogger, DefaultLogger } from '@rosen-bridge/abstract-logger';
import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { HealthStatusLevel } from '@rosen-bridge/health-check';

import {
  initialMilliseconds,
  savedBlock,
  scanner,
} from './guardHealthDbTestData';
import {
  createHealthApi,
  createScannerHealth,
  migrationRows,
  openProductionDatabase,
  reopenProductionDatabase,
  seedScannerBlocks,
} from './guardHealthDbTestUtils';

const state = vi.hoisted(() => ({
  health: undefined as unknown,
  database: '',
}));

// Input boundary only: synthetic file path, no deployment configuration or secrets.
vi.mock('../../src/configs/configs', () => ({
  default: {
    dbType: 'sqlite',
    dbPath: state.database,
    publicStatusBaseUrl: undefined,
  },
}));
// The route receives a real HealthCheck assembled in this bounded composition fixture.
// The factory seam avoids full chain initialization and TSS startup.
vi.mock('../../src/guard/healthCheck', () => ({
  getHealthCheck: async () => state.health,
}));

describe('Guard DB and health route composition', () => {
  let db: Awaited<ReturnType<typeof openProductionDatabase>>;
  let api: Awaited<ReturnType<typeof createHealthApi>>;
  let health: Awaited<ReturnType<typeof createScannerHealth>>;
  let initialMigrations: Array<{ name: string; timestamp: number }>;

  beforeAll(async () => {
    DefaultLogger.init(new ConsoleLogger('synthetic-guard-capsule'));
    state.database = join(
      mkdtempSync(join(tmpdir(), 'rosen-local-service-')),
      'health.sqlite',
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(initialMilliseconds);
    db = await openProductionDatabase();
    initialMigrations = await migrationRows(db.dataSource);
    health = await createScannerHealth();
    state.health = health.health;
    api = await createHealthApi();
  });

  beforeEach(async () => {
    vi.setSystemTime(initialMilliseconds);
    if (!db.dataSource.isInitialized)
      db.action = (await reopenProductionDatabase(db.dataSource)).action;
    await seedScannerBlocks(db.dataSource);
    health = await createScannerHealth();
    state.health = health.health;
    await health.health.update();
  });

  afterAll(async () => {
    if (api) await api.close();
    if (db?.dataSource.isInitialized) await db.dataSource.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('production DataSource and DatabaseAction', () => {
    /**
     * @target DatabaseAction.getLastSavedBlockForScanner
     * @dependencies production SQLite DataSource, migrations, BlockEntity and DatabaseAction
     * @scenario persist one selected block and two excluded controls, then close and reopen the file
     * @expected initialized migrations and exact reader output survive closing and reopening
     */
    it('retains the selected scanner block through a file database restart', async () => {
      expect(db.dataSource.isInitialized).toEqual(true);
      expect(initialMigrations.length).toBeGreaterThan(21);
      expect(await db.dataSource.showMigrations()).toEqual(false);
      expect(await db.action.getLastSavedBlockForScanner(scanner)).toEqual({
        height: savedBlock.height,
        timestamp: savedBlock.timestamp,
      });
      await db.dataSource.destroy();
      expect(db.dataSource.isInitialized).toEqual(false);
      const reopened = await reopenProductionDatabase(db.dataSource);
      db.action = reopened.action;
      expect(reopened.migrations).toEqual([]);
      expect(await migrationRows(db.dataSource)).toEqual(initialMigrations);
      expect(await db.dataSource.showMigrations()).toEqual(false);
      expect(await db.action.getLastSavedBlockForScanner(scanner)).toEqual({
        height: savedBlock.height,
        timestamp: savedBlock.timestamp,
      });
      const retained = await db.dataSource
        .getRepository(BlockEntity)
        .findOneByOrFail({ hash: savedBlock.hash });
      expect({
        hash: retained.hash,
        parentHash: retained.parentHash,
        status: retained.status,
        scanner: retained.scanner,
      }).toEqual({
        hash: savedBlock.hash,
        parentHash: savedBlock.parentHash,
        status: PROCEED,
        scanner,
      });
    });
  });

  describe('actual scanner health and healthRoutes', () => {
    /**
     * @target healthRoutes and ScannerSyncHealthCheckParam.updateStatus
     * @dependencies actual HealthCheck, persisted block, controlled Date and Fastify inject
     * @scenario let a fresh scanner block become stale, then persist a fresh timestamp
     * @expected named enums and service timestamp fields reflect the actual persisted block
     */
    it('exposes healthy stale and recovered scanner states through the real route', async () => {
      const paramId = health.parameter.getId();
      expect(paramId).toEqual('ethereum_scanner');
      const healthy = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });
      expect(healthy.statusCode).toEqual(200);
      expect(healthy.json().status).toEqual(HealthStatusLevel.HEALTHY);
      expect(healthy.json().lastCheck).toEqual(
        new Date(initialMilliseconds).toISOString(),
      );
      expect(healthy.json().lastTrialErrorMessage).toEqual(undefined);
      vi.setSystemTime(initialMilliseconds + 11000);
      const stale = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });
      expect(stale.statusCode).toEqual(200);
      expect(stale.json().status).toEqual(HealthStatusLevel.BROKEN);
      expect(stale.json().details).toContain('Service has stopped working.');
      await db.dataSource
        .getRepository(BlockEntity)
        .update(
          { hash: savedBlock.hash },
          { timestamp: (initialMilliseconds + 11000) / 1000 },
        );
      const recovered = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });
      expect(recovered.statusCode).toEqual(200);
      expect(recovered.json().status).toEqual(HealthStatusLevel.HEALTHY);
      const list = await api.inject({ method: 'GET', url: '/health/status' });
      expect(list.statusCode).toEqual(200);
      expect(list.json().map((entry: { id: string }) => entry.id)).toEqual([
        paramId,
      ]);
      expect(list.json()[0].lastCheck).toEqual(recovered.json().lastCheck);
    });

    /**
     * @target healthRoutes and HealthCheck.updateParam
     * @dependencies actual database read failure, HealthCheck error fields and Fastify inject
     * @scenario destroy the database connection after a good check, then reopen it
     * @expected the route retains the last good check and exposes actual read-error custody
     */
    it('preserves database read errors and clears their fields after recovery', async () => {
      const paramId = health.parameter.getId();
      const before = await api.inject({
        method: 'GET',
        url: `/health/parameter/${paramId}`,
      });
      await db.dataSource.destroy();
      let readError: unknown;
      try {
        await db.action.getLastSavedBlockForScanner(scanner);
      } catch (error) {
        readError = error;
      }
      expect(readError).toBeInstanceOf(Error);
      const failed = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });
      expect(failed.statusCode).toEqual(200);
      expect(failed.json().lastTrialErrorMessage).toEqual(
        (readError as Error).message,
      );
      expect(failed.json().lastTrialErrorTime).toEqual(
        new Date(initialMilliseconds).toISOString(),
      );
      expect(failed.json().lastCheck).toEqual(before.json().lastCheck);
      expect(failed.json().status).toEqual(HealthStatusLevel.HEALTHY);
      db.action = (await reopenProductionDatabase(db.dataSource)).action;
      const recovered = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });
      expect(recovered.statusCode).toEqual(200);
      expect(recovered.json().status).toEqual(HealthStatusLevel.HEALTHY);
      expect(recovered.json().lastTrialErrorMessage).toEqual(undefined);
      expect(recovered.json().lastTrialErrorTime).toEqual(undefined);
      expect(recovered.json().lastCheck).toEqual(
        new Date(initialMilliseconds).toISOString(),
      );
    });

    /**
     * @target healthRoutes
     * @dependencies actual Fastify route and real HealthCheck parameter registry
     * @scenario request a scanner health parameter absent from the registry
     * @expected the actual route returns its existing registration error
     */
    it('refuses a health parameter that the fixture did not register', async () => {
      const missing = await api.inject({
        method: 'GET',
        url: '/health/parameter/synthetic-missing',
      });
      expect(missing.statusCode).toEqual(500);
      expect(missing.json().message).toEqual(
        "Health parameter with id 'synthetic-missing' is not registered.",
      );
    });
  });
});
