import { Transaction } from 'ethers';
import fs from 'node:fs';

import { BlockEntity } from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { AvalancheSafetyState } from '@rosen-bridge/evm-scanner';
import {
  ConfirmationStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { DatabaseAction } from '../../src/db/databaseAction';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { createManagementProcessorFixture } from '../transaction/avalancheManagementProcessorTestUtils';

/** Captures persisted primitive rows in a deterministic order for connection/process replay. */
const snapshot = async () => {
  const db = DatabaseAction.getInstance();
  return {
    transaction: await db.TransactionRepository.find({
      relations: ['event', 'order'],
      order: { txId: 'ASC' },
    }),
    order: await db.ArbitraryRepository.find({ order: { id: 'ASC' } }),
    scanner: await db.dataSource
      .getRepository(AvalancheSafetyState)
      .find({ order: { scanner: 'ASC' } }),
    blocks: await db.dataSource
      .getRepository(BlockEntity)
      .find({ order: { id: 'ASC' } }),
    execution: await db.dataSource
      .getRepository(AddressTxsEntity)
      .find({ order: { id: 'ASC' } }),
  };
};

describe('DatabaseAction management PostgreSQL restart', () => {
  /**
   * @target DatabaseAction preserves recovered asset bytes and order after PostgreSQL restart
   * @dependencies
   * - Actual native/mainnet JOE processor, settled RPC decoder, scanner, PostgreSQL DAO and migrations.
   * - Synthetic own execution, confirmation acquisition and public test key.
   * @scenario
   * - Seed exact signed recovery and completion, persist its rows, stop/start the database and replay with a fresh test process.
   * @expected
   * - Signed bytes, quorum, counters, completed order, scanner and execution rows remain identical; migrations do not replay.
   */
  it('preserves recovered asset bytes and order after PostgreSQL restart', async () => {
    const phase = process.env.AVALANCHE_NATIVE_FIXTURE_RESTART_PHASE;
    const reference = process.env.AVALANCHE_NATIVE_FIXTURE_RESTART_SNAPSHOT;
    const token = process.env.AVALANCHE_FIXTURE_ASSET === 'JOE';
    if (!reference || !['seed', 'replay'].includes(phase ?? ''))
      throw new Error(
        'An explicit native PostgreSQL restart phase and snapshot path are required',
      );
    if (phase === 'seed') {
      const f = await createManagementProcessorFixture(
        TransactionType.arbitrary,
        true,
        token,
      );
      try {
        await f.observe();
        f.cold.locked.nativeToken = 1n;
        if (token) f.cold.locked.tokens[0].value = 0n;
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        await TransactionProcessor.processSignFailedTx(await f.current());
        await TransactionProcessor.processSentTx(await f.current());
        expect((await f.current()).status).toEqual('completed');
        expect(f.requests).toHaveLength(0);
        fs.writeFileSync(reference, JSON.stringify(await snapshot()) + '\n', {
          flag: 'wx',
        });
      } finally {
        await f.close();
        vi.restoreAllMocks();
      }
    } else {
      const current = await snapshot();
      expect(current).toEqual(JSON.parse(fs.readFileSync(reference, 'utf8')));
      expect(current.transaction).toHaveLength(1);
      const row = current.transaction[0];
      const tx = Transaction.from('0x' + JSON.parse(row.txJson).txBytes);
      expect(tx.isSigned()).toEqual(true);
      expect(tx.chainId).toEqual(token ? 43114n : 43113n);
      if (token) {
        expect(tx.to?.toLowerCase()).toEqual(
          '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd',
        );
        expect(tx.value).toEqual(0n);
      }
      expect(tx.unsignedHash).toEqual(row.txId);
      expect(tx.from?.toLowerCase()).toEqual(
        '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
      );
      expect(row.status).toEqual('completed');
      expect(row.requiredSign).toEqual(2);
      expect(row.signFailedCount).toEqual(2);
      expect(row.lastCheck).toEqual(12);
      expect(row.event).toBeNull();
      expect(row.order?.status).toEqual('completed');
      expect(
        await DatabaseAction.getInstance().dataSource.runMigrations(),
      ).toEqual([]);
    }
  });
});
