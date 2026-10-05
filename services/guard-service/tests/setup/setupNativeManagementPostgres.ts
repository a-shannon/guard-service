import { migrations as scannerMigrations } from '@rosen-bridge/abstract-scanner';
import { migrations as addressMigrations } from '@rosen-bridge/evm-address-tx-extractor';
import { AvalancheSafetyState1790769600000 } from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { migrations as watcherMigrations } from '@rosen-bridge/watcher-data-extractor';

import { DatabaseAction } from '../../src/db/databaseAction';
import guardMigrations from '../../src/db/migrations';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';

const connection = process.env.AVALANCHE_NATIVE_FIXTURE_DATABASE_URL;
if (!connection)
  throw new Error(
    'A dedicated local native-management fixture database is required',
  );
const address = new URL(connection);
if (
  address.protocol !== 'postgresql:' ||
  !['127.0.0.1', 'localhost'].includes(address.hostname) ||
  address.pathname !== '/avalanche_native_fixture' ||
  !address.port
)
  throw new Error(
    'Native-management tests require the dedicated loopback PostgreSQL fixture',
  );
const previous = DatabaseActionMock.testDataSource;
await previous.destroy();
const source = await new DataSource({
  type: 'postgres',
  url: connection,
  entities: previous.options.entities,
  migrations: [
    ...scannerMigrations.postgres,
    ...watcherMigrations.postgres,
    ...addressMigrations.postgres,
    ...guardMigrations.postgres,
    AvalancheSafetyState1790769600000,
  ],
  synchronize: false,
  logging: false,
}).initialize();
await source.runMigrations();
DatabaseAction.init(source);
DatabaseActionMock.testDataSource = source;
DatabaseActionMock.testDatabase = DatabaseAction.getInstance();
await PublicStatusHandler.init(source);
/** Clears only the dedicated fixture's registered tables between native cases. */
const clearFixtureTables = async () => {
  const tables = source.entityMetadatas
    .filter((entity) => entity.tableType !== 'view')
    .map((entity) => '"' + entity.tableName.replaceAll('"', '""') + '"');
  await source.query(
    'TRUNCATE TABLE ' + tables.join(', ') + ' RESTART IDENTITY CASCADE',
  );
};
beforeEach(() => {
  vi.spyOn(DatabaseActionMock, 'clearTables').mockImplementation(
    clearFixtureTables,
  );
});
afterAll(async () => {
  await source.destroy();
});
