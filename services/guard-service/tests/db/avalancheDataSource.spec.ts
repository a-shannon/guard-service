import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DummyLogger } from '@rosen-bridge/abstract-logger';
import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
  AvalancheSafetyState1790769600000,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import { dataSource as configuredSource } from '../../src/db/dataSource';

describe('Avalanche production database registration', () => {
  let database: string;
  let source: DataSource;
  const networks: AvalancheRpcNetwork[] = [];
  const safetyMigration = AvalancheSafetyState1790769600000.name;
  const state = {
    scanner: 'avalanche',
    chainId: '43113',
    sourceId: 'fixture-rpc',
    policy: 'helicon-settled-v1',
    initialHeight: 0,
    finalizedHeight: 1,
    finalizedHash: `0x${'1'.repeat(64)}`,
    holdReason: 'settled-frontier-conflict',
  };

  const open = async (legacy = false) => {
    const options = configuredSource.options;
    if (options.type !== 'sqlite')
      throw new Error('Expected SQLite test configuration');
    const configuredMigrations = options.migrations;
    if (!Array.isArray(configuredMigrations))
      throw new Error('Expected explicit production migrations');
    source = new DataSource({
      ...options,
      type: 'sqlite',
      database,
      migrations: legacy
        ? configuredMigrations.filter(
            (migration) => migration !== AvalancheSafetyState1790769600000,
          )
        : configuredMigrations,
    });
    await source.initialize();
    return source.runMigrations();
  };

  const scanner = (sourceId = state.sourceId) => {
    const network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n, 50);
    networks.push(network);
    return new AvalancheRpcScanner({
      dataSource: source,
      network,
      sourceId,
      initialHeight: 0,
      logger: new DummyLogger(),
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 0,
      },
    });
  };

  beforeEach(() => {
    database = join(tmpdir(), `rosen-avalanche-${randomUUID()}.sqlite`);
  });

  afterEach(async () => {
    networks.splice(0).forEach((network) => network['provider'].destroy());
    if (source?.isInitialized) await source.destroy();
    await unlink(database).catch((error: { code?: string }) => {
      if (error.code !== 'ENOENT') throw error;
    });
  });

  /**
   * @target dataSource 'creates the safety table through production migrations without qualifying an empty scanner'
   * @dependencies Actual dataSource sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'creates the safety table through production migrations without qualifying an empty scanner' through dataSource.
   * @expected expect( applied.filter((migration) => migration.name === safetyMigration), ).toHaveLength(1); expect(source.hasMetadata(AvalancheSafetyState)).toBe(true); expect(await source.getRepository(AvalancheSafetyState).count()).toBe(0); await expect(scanner().assertUsable()).rejects.toThrow('not qualified'); expect(await source.runMigrations()).toEqual([]);
   */
  it('creates the safety table through production migrations without qualifying an empty scanner', async () => {
    const applied = await open();
    expect(
      applied.filter((migration) => migration.name === safetyMigration),
    ).toHaveLength(1);
    expect(source.hasMetadata(AvalancheSafetyState)).toBe(true);
    expect(await source.getRepository(AvalancheSafetyState).count()).toBe(0);
    await expect(scanner().assertUsable()).rejects.toThrow('not qualified');
    expect(await source.runMigrations()).toEqual([]);
  });

  /**
   * @target dataSource 'upgrades an existing database while preserving other scanners and keeping legacy Avalanche history unqualified'
   * @dependencies Actual dataSource sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'upgrades an existing database while preserving other scanners and keeping legacy Avalanche history unqualified' through dataSource.
   * @expected expect(applied.map((migration) => migration.name)).toEqual([ safetyMigration, ]); expect( await source.getRepository(BlockEntity).findOneByOrFail({ id: saved.id }), ).toEqual(saved); expect(await source.getRepository(AvalancheSafetyState).count()).toBe(0); await expect(scanner().assertUsable()).rejects.toThrow('not qualified'); await expect(scanner().update()).rejects.toThrow( 'unqualified-existing-history', ); expect( await source .getRepository(AvalancheSafetyState) .findOneByOrFail({ scanner: state.scanner }), ).toMatchObject({ holdReason: 'unqualified-existing-history', finalizedHeight: null, });
   */
  it('upgrades an existing database while preserving other scanners and keeping legacy Avalanche history unqualified', async () => {
    await open(true);
    const saved = await source.getRepository(BlockEntity).save({
      scanner: 'ethereum',
      height: 1,
      hash: `0x${'2'.repeat(64)}`,
      parentHash: `0x${'0'.repeat(64)}`,
      status: PROCEED,
      timestamp: 1,
    });
    await source.getRepository(BlockEntity).save({
      ...saved,
      id: undefined,
      scanner: 'avalanche',
      hash: state.finalizedHash,
    });
    await source.destroy();
    const applied = await open();
    expect(applied.map((migration) => migration.name)).toEqual([
      safetyMigration,
    ]);
    expect(
      await source.getRepository(BlockEntity).findOneByOrFail({ id: saved.id }),
    ).toEqual(saved);
    expect(await source.getRepository(AvalancheSafetyState).count()).toBe(0);
    await expect(scanner().assertUsable()).rejects.toThrow('not qualified');
    await expect(scanner().update()).rejects.toThrow(
      'unqualified-existing-history',
    );
    expect(
      await source
        .getRepository(AvalancheSafetyState)
        .findOneByOrFail({ scanner: state.scanner }),
    ).toMatchObject({
      holdReason: 'unqualified-existing-history',
      finalizedHeight: null,
    });
  });

  /**
   * @target dataSource 'preserves a hold after reopening the migrated database'
   * @dependencies Actual dataSource sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'preserves a hold after reopening the migrated database' through dataSource.
   * @expected expect(await open()).toEqual([]); expect( await source .getRepository(AvalancheSafetyState) .findOneByOrFail({ scanner: state.scanner }), ).toEqual(state); await expect(scanner().assertUsable()).rejects.toThrow('not qualified');
   */
  it('preserves a hold after reopening the migrated database', async () => {
    await open();
    await source.getRepository(AvalancheSafetyState).save(state);
    await source.destroy();
    expect(await open()).toEqual([]);
    expect(
      await source
        .getRepository(AvalancheSafetyState)
        .findOneByOrFail({ scanner: state.scanner }),
    ).toEqual(state);
    await expect(scanner().assertUsable()).rejects.toThrow('not qualified');
  });

  /**
   * @target dataSource 'rejects a changed source identity after reopening without a hold'
   * @dependencies Actual dataSource sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'rejects a changed source identity after reopening without a hold' through dataSource.
   * @expected await expect(scanner().assertUsable()).resolves.toBeUndefined(); await expect(scanner('replacement-rpc').assertUsable()).rejects.toThrow( 'not qualified', );
   */
  it('rejects a changed source identity after reopening without a hold', async () => {
    await open();
    await source
      .getRepository(AvalancheSafetyState)
      .save({ ...state, holdReason: null });
    await source.destroy();
    await open();
    await expect(scanner().assertUsable()).resolves.toBeUndefined();
    await expect(scanner('replacement-rpc').assertUsable()).rejects.toThrow(
      'not qualified',
    );
  });

  /**
   * @target dataSource 'refuses rollback when it would erase persisted safety state'
   * @dependencies Actual dataSource sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'refuses rollback when it would erase persisted safety state' through dataSource.
   * @expected await expect( new AvalancheSafetyState1790769600000().down(runner), ).rejects.toThrow('Cannot remove a populated Avalanche safety state'); expect( await source .getRepository(AvalancheSafetyState) .findOneByOrFail({ scanner: state.scanner }), ).toEqual(state); expect(await source.showMigrations()).toBe(false);
   */
  it('refuses rollback when it would erase persisted safety state', async () => {
    await open();
    await source.getRepository(AvalancheSafetyState).save(state);
    const runner = source.createQueryRunner();
    try {
      await runner.startTransaction();
      await expect(
        new AvalancheSafetyState1790769600000().down(runner),
      ).rejects.toThrow('Cannot remove a populated Avalanche safety state');
    } finally {
      try {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
      } finally {
        await runner.release();
      }
    }
    expect(
      await source
        .getRepository(AvalancheSafetyState)
        .findOneByOrFail({ scanner: state.scanner }),
    ).toEqual(state);
    expect(await source.showMigrations()).toBe(false);
  });
});
