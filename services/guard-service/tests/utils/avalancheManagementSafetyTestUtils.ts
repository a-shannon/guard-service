import '@rosen-bridge/extended-typeorm/bootstrap';

import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations,
} from '@rosen-bridge/abstract-scanner';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
  AvalancheSafetyState1790769600000,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TransactionType } from '@rosen-chains/abstract-chain';

import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import { mockManagementAuthority } from './mocked/avalancheManagementSafety.mock';

/** Makes a canonical synthetic block identity for the actual scanner database. */
const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');

/** Initializes the real SQLite scanner, with block acquisition confined to fixtures. */
export const createManagementSafetyFixture = async (
  type: TransactionType = TransactionType.coldStorage,
  chainId = 43113n,
) => {
  const database = await new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [BlockEntity, ExtractorStatusEntity, AvalancheSafetyState],
    migrations: [...migrations.sqlite, AvalancheSafetyState1790769600000],
    synchronize: false,
  }).initialize();
  await database.runMigrations();
  const network = new AvalancheRpcNetwork('http://127.0.0.1:1', chainId);
  vi.spyOn(network, 'getCurrentHeight').mockResolvedValue(2);
  vi.spyOn(network, 'getBlockAtHeight').mockImplementation(async (height) => ({
    hash: hash(height),
    height,
    parentHash: hash(height - 1),
    timestamp: 100 + height,
    txCount: 0,
  }));
  vi.spyOn(network, 'getBlockTxs').mockResolvedValue([]);
  const scanner = new AvalancheRpcScanner({
    network,
    dataSource: database,
    sourceId: 'synthetic-management-source',
    initialHeight: 0,
    blockCleanupConfig: {
      blockCleanupThresholdDuration: 86400,
      blockTrimCountInRound: 0,
    },
  });
  await scanner.update();
  const mocked = mockManagementAuthority();
  const getScanner = vi.fn(() => scanner as AvalancheRpcScanner | undefined);
  const getEvent = vi.fn(async () => undefined);
  const safety = new AvalancheTransactionSafety(
    getEvent,
    getScanner,
    mocked.bind,
  );
  const intent = {
    network: 'avalanche',
    eventId: type === TransactionType.arbitrary ? 'cd'.repeat(32) : '',
    txType: type,
    txId: '0x' + 'ef'.repeat(32),
    txBytes: 'abcd',
  };
  return {
    ...mocked,
    database,
    network,
    scanner,
    safety,
    intent,
    getScanner,
    getEvent,
    /** Closes providers and the isolated in-memory database without live traffic. */
    close: async () => {
      network['provider'].destroy();
      await database.destroy();
    },
  };
};
