import { BlockEntity } from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { TransactionType } from '@rosen-chains/abstract-chain';
import { EvmTxStatus } from '@rosen-chains/evm';

import { ArbitraryEntity } from '../../src/db/entities/arbitraryEntity';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import {
  createManagementExecutionFixture,
  corruptManagementTransfer,
  managementTransferFaults,
} from './avalancheManagementExecutionAuthorizationTestUtils';

type Fixture = Awaited<ReturnType<typeof createManagementExecutionFixture>>;
let f: Fixture;
afterEach(() => {
  f?.close();
  vi.restoreAllMocks();
});

describe('AvalancheManagementExecutionAuthorization', () => {
  describe('bind', () => {
    /**
     * @target AvalancheManagementExecutionAuthorization.bind starts mapped JOE %s once under owned SQL
     * @dependencies Real mainnet chain, SQLite transaction/order schema and business authorization; mocked fee and lease ports
     * @scenario Prepare and authorize a signed token route, then persist its sent afterimage
     * @expected One transport start, sent row and refused authority reuse
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('starts mapped JOE %s once under owned SQL', async (type) => {
      f = await createManagementExecutionFixture(type, false, true);
      const prepared = await (
        await f.authorization.bind(f.preimage(), 'submission')
      ).prepareUnderScannerLease(() => {});
      const start = vi.fn();
      await prepared.authorize(start);
      expect(start).toHaveBeenCalledOnce();
      await expect(prepared.authorize(start)).rejects.toThrow('not authorized');
      await f.database.dataSource.transaction(async (manager) => {
        await prepared.assertBefore(manager, f.preimage());
        await manager
          .getRepository(TransactionEntity)
          .update(
            { txId: f.expected.txId },
            { status: 'sent', lastStatusUpdate: '101' },
          );
        await prepared.assertAfter(manager, {
          ...f.preimage(),
          status: 'sent',
        });
      });
      expect((await f.current()).status).toEqual('sent');
      if (type !== TransactionType.coldStorage)
        expect(f.getColdState).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheManagementExecutionAuthorization.bind completes proven mainnet JOE %s without another dispatch
     * @dependencies Actual immutable RPC receipt, mapped proof predicate and SQLite DAO
     * @scenario Observe one exact successful Transfer for an admitted sent token route
     * @expected Exact bytes complete, the arbitrary order completes and transport remains unavailable
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])(
      'completes proven mainnet JOE %s without another dispatch',
      async (type) => {
        f = await createManagementExecutionFixture(type, false, true);
        await f.updateStatus('sent');
        await f.observe();
        const prepared = await (
          await f.authorization.bind(f.preimage(), 'completion')
        ).prepareUnderScannerLease(() => {});
        const start = vi.fn();
        await expect(prepared.authorize(start)).rejects.toThrow(
          'not authorized',
        );
        expect(
          await f.database.finalizeTxIfUnchanged(f.preimage(), {
            assertActive: () => {},
            ...prepared,
          }),
        ).toEqual(true);
        const row = await f.current();
        expect(row.status).toEqual('completed');
        expect(row.txJson).toEqual(f.expected.txJson);
        if (type === TransactionType.arbitrary)
          expect(row.order?.status).toEqual('completed');
        expect(start).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheManagementExecutionAuthorization.bind refuses mapped completion with Transfer %s
     * @dependencies Actual receipt snapshots, mapped proof checker and SQLite admitted order
     * @scenario Corrupt one log predicate while preserving the signed body and successful receipt
     * @expected No completion authority and unchanged transaction/order rows
     */
    it.each(managementTransferFaults)(
      'refuses mapped completion with Transfer %s',
      async (fault) => {
        f = await createManagementExecutionFixture(
          TransactionType.arbitrary,
          false,
          true,
        );
        await f.updateStatus('sent');
        const seen = await f.observe();
        const row = await f.current();
        const order = await f.database.getOrderById(f.expected.orderId!);
        corruptManagementTransfer(seen, fault);
        await expect(
          (
            await f.authorization.bind(f.preimage(), 'completion')
          ).prepareUnderScannerLease(() => {}),
        ).rejects.toThrow();
        expect(await f.current()).toEqual(row);
        expect(await f.database.getOrderById(f.expected.orderId!)).toEqual(
          order,
        );
      },
    );

    /**
     * @target AvalancheManagementExecutionAuthorization.bind refuses late mapped %s drift
     * @dependencies Two immutable receipt reads and retained chain/RPC/map/scanner identities
     * @scenario Change one authority input after the first qualified receipt read
     * @expected Preparation refuses and the row remains sent
     */
    it.each(['Transfer', 'verifier', 'reader', 'map', 'scanner record'])(
      'refuses late mapped %s drift',
      async (fault) => {
        f = await createManagementExecutionFixture(
          TransactionType.manual,
          false,
          true,
        );
        await f.updateStatus('sent');
        const seen = await f.observe();
        const read = f.network.getSettledTransactionReceiptEvidence.bind(
          f.network,
        );
        let first = true;
        vi.spyOn(
          f.network,
          'getSettledTransactionReceiptEvidence',
        ).mockImplementation(async (...args) => {
          const evidence = await read(...args);
          if (first) {
            first = false;
            if (fault === 'Transfer') corruptManagementTransfer(seen, 'amount');
            if (fault === 'verifier')
              f.chain.verifySettledTokenEvidence = vi.fn(() => true);
            if (fault === 'reader')
              f.network.getSettledTransactionReceiptEvidence = vi.fn(
                async () => evidence,
              );
            if (fault === 'map') {
              const raw = f.tokens.getRawConfig();
              raw[1].avalanche.decimals = 17;
              await f.tokens.updateConfigByJson(raw);
            }
            if (fault === 'scanner record')
              await f.database.dataSource
                .getRepository(AddressTxsEntity)
                .update({ id: seen.record.id }, { nonce: 4 });
          }
          return evidence;
        });
        await expect(
          (
            await f.authorization.bind(f.preimage(), 'completion')
          ).prepareUnderScannerLease(() => {}),
        ).rejects.toThrow();
        expect((await f.current()).status).toEqual('sent');
      },
    );

    /**
     * @target starts %s once under exact SQLite ownership
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Create each signed native management row; bind submission; prepare and authorize once; update its SQL afterimage.
     * @expected
     * - One transport start, rejected reuse and a sent row under the active lease.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('starts %s once under exact SQLite ownership', async (type) => {
      f = await createManagementExecutionFixture(type);
      const bound = await f.authorization.bind(f.preimage(), 'submission');
      expect(bound.kind).toEqual('ready');
      const active = vi.fn();
      const prepared = await bound.prepareUnderScannerLease(active);
      const start = vi.fn();
      await prepared.authorize(start);
      expect(start).toHaveBeenCalledTimes(1);
      await expect(prepared.authorize(start)).rejects.toThrow('not authorized');
      await f.database.dataSource.transaction(async (manager) => {
        await prepared.assertBefore(manager, f.preimage());
        await manager
          .getRepository(TransactionEntity)
          .update(
            { txId: f.expected.txId },
            { status: 'sent', lastStatusUpdate: '101' },
          );
        await prepared.assertAfter(manager, {
          ...f.preimage(),
          status: 'sent',
        });
      });
      expect((await f.current()).status).toEqual('sent');
      expect(active).toHaveBeenCalled();
    });

    /**
     * @target refuses a new cold POST after its reserve has changed
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Prepare a cold submission; change its native reserve; attempt authorization.
     * @expected
     * - Reserve rejection and no transport call.
     */
    it('refuses a new cold POST after its reserve has changed', async () => {
      f = await createManagementExecutionFixture();
      const prepared = await (
        await f.authorization.bind(f.preimage(), 'submission')
      ).prepareUnderScannerLease(() => {});
      f.cold.locked.nativeToken = 100000n;
      const start = vi.fn();
      await expect(prepared.authorize(start)).rejects.toThrow('reserve');
      expect(start).not.toHaveBeenCalled();
    });

    /**
     * @target refuses SQL %s drift before transport
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Prepare submission; mutate only the selected SQL field; attempt authorization.
     * @expected
     * - SQL drift rejection and no transport call for every field.
     */
    it.each([
      'requiredSign',
      'lastCheck',
      'failedInSign',
      'signFailedCount',
      'lastStatusUpdate',
    ] as const)('refuses SQL %s drift before transport', async (field) => {
      f = await createManagementExecutionFixture();
      const prepared = await (
        await f.authorization.bind(f.preimage(), 'submission')
      ).prepareUnderScannerLease(() => {});
      const changed = {
        requiredSign: 1,
        lastCheck: 13,
        failedInSign: true,
        signFailedCount: 3,
        lastStatusUpdate: '101',
      }[field];
      await f.database.TransactionRepository.update(
        { txId: f.expected.txId },
        { [field]: changed },
      );
      const start = vi.fn();
      await expect(prepared.authorize(start)).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
    });

    /**
     * @target refuses a newly observed same-nonce record before transport
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Create a foreign same-nonce record; remove it before preparation; restore it before authorization.
     * @expected
     * - Scanner execution rejection and no transport call.
     */
    it('refuses a newly observed same-nonce record before transport', async () => {
      f = await createManagementExecutionFixture(TransactionType.manual);
      const seen = await f.observe('foreign');
      await f.database.dataSource
        .getRepository(AddressTxsEntity)
        .delete({ id: seen.record.id });
      const prepared = await (
        await f.authorization.bind(f.preimage(), 'submission')
      ).prepareUnderScannerLease(() => {});
      await f.database.dataSource
        .getRepository(AddressTxsEntity)
        .save(seen.record);
      const start = vi.fn();
      await expect(prepared.authorize(start)).rejects.toThrow(
        'scanner execution',
      );
      expect(start).not.toHaveBeenCalled();
    });

    /**
     * @target completes observed %s after the cold trigger is consumed, without POST
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Mark each management row sent; observe successful own execution; consume the cold trigger; finalize through SQL.
     * @expected
     * - Completed row and arbitrary order, no transport and no cold-state query.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])(
      'completes observed %s after the cold trigger is consumed, without POST',
      async (type) => {
        f = await createManagementExecutionFixture(type);
        await f.updateStatus('sent');
        await f.observe();
        f.cold.locked.nativeToken = 100000n;
        const bound = await f.authorization.bind(f.preimage(), 'completion');
        expect(bound.kind).toEqual('observed');
        const prepared = await bound.prepareUnderScannerLease(() => {});
        const start = vi.fn();
        await expect(prepared.authorize(start)).rejects.toThrow(
          'not authorized',
        );
        expect(
          await f.database.finalizeTxIfUnchanged(f.preimage(), {
            assertActive: () => {},
            ...prepared,
          }),
        ).toEqual(true);
        expect((await f.current()).status).toEqual('completed');
        if (type === TransactionType.arbitrary)
          expect(
            (await f.database.getOrderById(f.expected.orderId!))?.status,
          ).toEqual('completed');
        expect(start).not.toHaveBeenCalled();
        expect(f.getColdState).not.toHaveBeenCalled();
      },
    );

    /**
     * @target recognizes observed initial submission without reopening transport
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Observe own execution before submission; consume the reserve; bind and prepare; attempt transport.
     * @expected
     * - Observed authority and rejected transport.
     */
    it('recognizes observed initial submission without reopening transport', async () => {
      f = await createManagementExecutionFixture();
      await f.observe();
      f.cold.locked.nativeToken = 1n;
      const bound = await f.authorization.bind(f.preimage(), 'submission');
      expect(bound.kind).toEqual('observed');
      const prepared = await bound.prepareUnderScannerLease(() => {});
      const start = vi.fn();
      await expect(prepared.authorize(start)).rejects.toThrow('not authorized');
      expect(start).not.toHaveBeenCalled();
    });

    /**
     * @target refuses unowned SQL managers and preparation reuse
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Prepare and authorize submission; pass an unowned manager to its SQL check; attempt preparation again.
     * @expected
     * - Active-transaction rejection and single-use rejection.
     */
    it('refuses unowned SQL managers and preparation reuse', async () => {
      f = await createManagementExecutionFixture();
      const bound = await f.authorization.bind(f.preimage(), 'submission');
      const prepared = await bound.prepareUnderScannerLease(() => {});
      await prepared.authorize(() => {});
      await expect(
        prepared.assertBefore(f.database.dataSource.manager, f.preimage()),
      ).rejects.toThrow('active transaction');
      await expect(bound.prepareUnderScannerLease(() => {})).rejects.toThrow(
        'single use',
      );
    });

    /**
     * @target refuses %s identity drift before transport
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Prepare manual submission; change only the selected policy, adapter, decoder or database identity; authorize.
     * @expected
     * - Authority-change rejection and no transport call.
     */
    it.each([
      'policy',
      'chain-method',
      'rpc-method',
      'decode-method',
      'database',
    ] as const)('refuses %s identity drift before transport', async (field) => {
      f = await createManagementExecutionFixture(TransactionType.manual);
      const bound = await f.authorization.bind(f.preimage(), 'submission');
      const prepared = await bound.prepareUnderScannerLease(() => {});
      if (field === 'policy')
        f.getPolicy.mockReturnValue({
          ...f.getPolicy(),
          manualRequests: false,
        });
      if (field === 'chain-method') f.chain.getTxRequiredConfirmation = () => 1;
      if (field === 'rpc-method')
        f.network.getBlockInfo = async () => ({
          hash: '',
          height: 0,
          parentHash: '',
        });
      if (field === 'decode-method')
        f.policy.decode = (json) => f.chain.PaymentTransactionFromJson(json);
      if (field === 'database')
        vi.spyOn(f.database.dataSource, 'transaction').mockRejectedValue(
          new Error('foreign SQL'),
        );
      const start = vi.fn();
      await expect(prepared.authorize(start)).rejects.toThrow(
        'authority changed',
      );
      expect(start).not.toHaveBeenCalled();
    });

    /**
     * @target refuses scanner record drift after successful observed preparation
     * Class/function: AvalancheManagementExecutionAuthorization.bind
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Prepare observed completion; change the scanner block identity; attempt finalization.
     * @expected
     * - Scanner-execution rejection with the row still sent.
     */
    it('refuses scanner record drift after successful observed preparation', async () => {
      f = await createManagementExecutionFixture();
      await f.updateStatus('sent');
      const seen = await f.observe();
      const prepared = await (
        await f.authorization.bind(f.preimage(), 'completion')
      ).prepareUnderScannerLease(() => {});
      await f.database.dataSource
        .getRepository(AddressTxsEntity)
        .update({ id: seen.record.id }, { blockId: '0x' + '97'.repeat(32) });
      await expect(
        f.database.finalizeTxIfUnchanged(f.preimage(), {
          assertActive: () => {},
          ...prepared,
        }),
      ).rejects.toThrow('scanner execution');
      expect((await f.current()).status).toEqual('sent');
    });
  });

  describe('bindRecovery', () => {
    /**
     * @target AvalancheManagementExecutionAuthorization.bindRecovery restores proven mainnet JOE %s bytes
     * @dependencies Actual mapped chain/RPC receipt and twelve-field SQLite recovery transition
     * @scenario An unsigned sign-failed token route has an exact successful signed Transfer observation
     * @expected Recovery stores those signed bytes as sent and preserves the order/check metadata
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('restores proven mainnet JOE %s bytes', async (type) => {
      f = await createManagementExecutionFixture(type, true, true);
      const seen = await f.observe();
      const prepared = await (
        await f.authorization.bindRecovery(f.expected)
      ).prepareUnderScannerLease(() => {});
      expect(
        await f.database.recoverSignedManagementIfUnchanged(
          f.expected,
          prepared.signedJson,
          {
            assertActive: () => {},
            ...prepared,
          },
        ),
      ).toEqual(true);
      const row = await f.current();
      expect(row.status).toEqual('sent');
      expect(JSON.parse(row.txJson).txBytes).toEqual(
        seen.signed.serialized.slice(2),
      );
      expect(row.lastCheck).toEqual(12);
      expect(row.signFailedCount).toEqual(2);
      if (type === TransactionType.arbitrary)
        expect(row.order?.status).toEqual('in-process');
    });

    /**
     * @target AvalancheManagementExecutionAuthorization.bindRecovery refuses mapped recovery with Transfer %s
     * @dependencies Real signed receipt/body qualification and SQLite recovery owner
     * @scenario Alter one Transfer predicate in a successful observed unsigned token route
     * @expected No signed recovery authority and unchanged sign-failed row
     */
    it.each(managementTransferFaults)(
      'refuses mapped recovery with Transfer %s',
      async (fault) => {
        f = await createManagementExecutionFixture(
          TransactionType.manual,
          true,
          true,
        );
        const seen = await f.observe();
        const before = await f.current();
        corruptManagementTransfer(seen, fault);
        await expect(
          (
            await f.authorization.bindRecovery(f.expected)
          ).prepareUnderScannerLease(() => {}),
        ).rejects.toThrow();
        expect(await f.current()).toEqual(before);
      },
    );

    /**
     * @target restores exact observed signed %s bytes with the 12-field afterimage
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Create each unsigned sign-failed row; observe own signed bytes; consume the trigger; recover through SQL.
     * @expected
     * - Exact signed bytes, sent row, preserved check/counter fields and active arbitrary order.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])(
      'restores exact observed signed %s bytes with the 12-field afterimage',
      async (type) => {
        f = await createManagementExecutionFixture(type, true);
        const seen = await f.observe();
        f.cold.locked.nativeToken = 1n;
        const prepared = await (
          await f.authorization.bindRecovery(f.expected)
        ).prepareUnderScannerLease(() => {});
        expect(JSON.parse(prepared.signedJson).txBytes).toEqual(
          seen.signed.serialized.slice(2),
        );
        expect(
          await f.database.recoverSignedManagementIfUnchanged(
            f.expected,
            prepared.signedJson,
            { assertActive: () => {}, ...prepared },
          ),
        ).toEqual(true);
        const row = await f.current();
        expect(row.status).toEqual('sent');
        expect(row.lastCheck).toEqual(12);
        expect(row.signFailedCount).toEqual(2);
        if (type === TransactionType.arbitrary)
          expect(row.order?.status).toEqual('in-process');
        expect(f.getColdState).not.toHaveBeenCalled();
      },
    );

    /**
     * @target refuses %s execution for recovery
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Observe foreign, reverted or wrong-key execution for an unsigned row; attempt recovery.
     * @expected
     * - Rejected recovery with the row still sign-failed.
     */
    it.each(['foreign', 'reverted', 'wrong-key'] as const)(
      'refuses %s execution for recovery',
      async (fault) => {
        f = await createManagementExecutionFixture(
          TransactionType.manual,
          true,
        );
        await f.observe(
          fault === 'foreign' ? 'foreign' : 'own',
          fault === 'reverted' ? EvmTxStatus.failed : EvmTxStatus.succeed,
          fault === 'wrong-key',
        );
        await expect(
          (async () =>
            (
              await f.authorization.bindRecovery(f.expected)
            ).prepareUnderScannerLease(() => {}))(),
        ).rejects.toThrow();
        expect((await f.current()).status).toEqual('sign-failed');
      },
    );

    /**
     * @target refuses isolated scanner record %s corruption
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Observe own execution; corrupt only the selected scanner-record field; attempt recovery.
     * @expected
     * - Rejected recovery for each isolated record corruption.
     */
    it.each(['extractor', 'address', 'block', 'signedHash', 'nonce'] as const)(
      'refuses isolated scanner record %s corruption',
      async (field) => {
        f = await createManagementExecutionFixture(
          TransactionType.manual,
          true,
        );
        const seen = await f.observe();
        const changes = {
          extractor: 'foreign',
          address: '0x' + '42'.repeat(20),
          block: '0x' + '99'.repeat(32),
          signedHash: 'bad',
          nonce: 9,
        };
        await f.database.dataSource
          .getRepository(AddressTxsEntity)
          .update(
            { id: seen.record.id },
            { [field === 'block' ? 'blockId' : field]: changes[field] },
          );
        await expect(
          (async () =>
            (
              await f.authorization.bindRecovery(f.expected)
            ).prepareUnderScannerLease(() => {}))(),
        ).rejects.toThrow();
      },
    );

    /**
     * @target refuses isolated scanner block %s corruption
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Observe own execution; corrupt only the selected scanner-block field; attempt recovery.
     * @expected
     * - Rejected recovery for each isolated block corruption.
     */
    it.each(['status', 'parentHash', 'height'] as const)(
      'refuses isolated scanner block %s corruption',
      async (field) => {
        f = await createManagementExecutionFixture(
          TransactionType.manual,
          true,
        );
        const seen = await f.observe();
        const values = {
          status: 'PROCESSING',
          parentHash: '0x' + '99'.repeat(32),
          height: 11,
        };
        await f.database.dataSource
          .getRepository(BlockEntity)
          .update({ hash: seen.block.hash }, { [field]: values[field] });
        await expect(
          (async () =>
            (
              await f.authorization.bindRecovery(f.expected)
            ).prepareUnderScannerLease(() => {}))(),
        ).rejects.toThrow();
      },
    );

    /**
     * @target refuses isolated settled evidence %s corruption
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Observe own execution; replace only the selected settled-evidence field; attempt recovery.
     * @expected
     * - Rejected preparation and an unchanged sign-failed row.
     */
    it.each([
      'signedBytes',
      'hash',
      'unsignedHash',
      'from',
      'chainId',
      'nonce',
      'blockHash',
      'blockNumber',
      'index',
      'finalizedBlockHash',
      'finalizedBlockNumber',
      'confirmations',
      'status',
    ] as const)(
      'refuses isolated settled evidence %s corruption',
      async (field) => {
        f = await createManagementExecutionFixture(
          TransactionType.manual,
          true,
        );
        const seen = await f.observe();
        const evidence = await f.network.getSettledTransactionEvidence(
          seen.record.signedHash,
          seen.record.blockId,
        );
        const replacements = {
          signedBytes: '0x00',
          hash: '0x' + '91'.repeat(32),
          unsignedHash: '0x' + '92'.repeat(32),
          from: '0x' + '93'.repeat(20),
          chainId: 43114n,
          nonce: 4,
          blockHash: '0x' + '94'.repeat(32),
          blockNumber: 11,
          index: -1,
          finalizedBlockHash: 'bad',
          finalizedBlockNumber: 9,
          confirmations: 90,
          status: EvmTxStatus.failed,
        };
        vi.spyOn(f.network, 'getSettledTransactionEvidence').mockResolvedValue({
          ...evidence,
          [field]: replacements[field],
        });
        await expect(
          (async () =>
            (
              await f.authorization.bindRecovery(f.expected)
            ).prepareUnderScannerLease(() => {}))(),
        ).rejects.toThrow();
        expect((await f.current()).status).toEqual('sign-failed');
      },
    );

    /**
     * @target requires the route confirmation count at the settled frontier
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Observe own execution; lower the finalized frontier below the route confirmation count; attempt recovery.
     * @expected
     * - Settled-execution rejection.
     */
    it('requires the route confirmation count at the settled frontier', async () => {
      f = await createManagementExecutionFixture(TransactionType.manual, true);
      const seen = await f.observe();
      seen.frontier.number =
        seen.block.number +
        f.chain.getTxRequiredConfirmation(TransactionType.manual) -
        2;
      await expect(
        (
          await f.authorization.bindRecovery(f.expected)
        ).prepareUnderScannerLease(() => {}),
      ).rejects.toThrow('settled execution');
    });

    /**
     * @target refuses RPC evidence alias mutation during a header await
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Return aliased settled evidence; mutate its confirmations during the block-header await; attempt recovery.
     * @expected
     * - Evidence-mutation rejection.
     */
    it('refuses RPC evidence alias mutation during a header await', async () => {
      f = await createManagementExecutionFixture(TransactionType.manual, true);
      const seen = await f.observe();
      const evidence = {
        ...(await f.network.getSettledTransactionEvidence(
          seen.record.signedHash,
          seen.record.blockId,
        )),
      };
      vi.spyOn(f.network, 'getSettledTransactionEvidence').mockResolvedValue(
        evidence,
      );
      vi.spyOn(f.network, 'getBlockInfo').mockImplementation(async () => {
        evidence.confirmations -= 1;
        return {
          hash: seen.block.hash,
          height: seen.block.number,
          parentHash: seen.block.parentHash,
        };
      });
      await expect(
        (
          await f.authorization.bindRecovery(f.expected)
        ).prepareUnderScannerLease(() => {}),
      ).rejects.toThrow('evidence mutated');
    });

    /**
     * @target rolls back recovery when its signed afterimage differs
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Prepare arbitrary recovery; corrupt the supplied signed afterimage during the SQL after-check.
     * @expected
     * - Preimage rejection, rolled-back sign-failed row and in-process order.
     */
    it('rolls back recovery when its signed afterimage differs', async () => {
      f = await createManagementExecutionFixture(
        TransactionType.arbitrary,
        true,
      );
      await f.observe();
      const prepared = await (
        await f.authorization.bindRecovery(f.expected)
      ).prepareUnderScannerLease(() => {});
      await expect(
        f.database.recoverSignedManagementIfUnchanged(
          f.expected,
          prepared.signedJson,
          {
            assertActive: () => {},
            assertBefore: prepared.assertBefore,
            assertAfter: async (manager, row) =>
              prepared.assertAfter(manager, {
                ...(row as typeof f.expected),
                signFailedCount: 99,
              }),
          },
        ),
      ).rejects.toThrow('preimage changed');
      expect((await f.current()).status).toEqual('sign-failed');
      expect(
        (await f.database.getOrderById(f.expected.orderId!))?.status,
      ).toEqual('in-process');
    });

    /**
     * @target rolls back recovery when its row changes inside the owned SQL transaction
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Prepare arbitrary recovery; change required signatures inside its active SQL before-check.
     * @expected
     * - False recovery result and rolled-back required-signature/status fields.
     */
    it('rolls back recovery when its row changes inside the owned SQL transaction', async () => {
      f = await createManagementExecutionFixture(
        TransactionType.arbitrary,
        true,
      );
      await f.observe();
      const prepared = await (
        await f.authorization.bindRecovery(f.expected)
      ).prepareUnderScannerLease(() => {});
      await expect(
        f.database.recoverSignedManagementIfUnchanged(
          f.expected,
          prepared.signedJson,
          {
            assertActive: () => {},
            assertAfter: prepared.assertAfter,
            assertBefore: async (manager, row) => {
              await prepared.assertBefore(manager, row as typeof f.expected);
              await manager
                .getRepository(TransactionEntity)
                .update({ txId: f.expected.txId }, { requiredSign: 1 });
            },
          },
        ),
      ).resolves.toEqual(false);
      expect((await f.current()).requiredSign).toEqual(2);
      expect((await f.current()).status).toEqual('sign-failed');
    });

    /**
     * @target rolls back recovery when its order changes inside the owned SQL transaction
     * Class/function: AvalancheManagementExecutionAuthorization.bindRecovery
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Prepare arbitrary recovery; change the order JSON inside its active SQL before-check.
     * @expected
     * - Rejected recovery and rolled-back row/order state.
     */
    it('rolls back recovery when its order changes inside the owned SQL transaction', async () => {
      f = await createManagementExecutionFixture(
        TransactionType.arbitrary,
        true,
      );
      await f.observe();
      const prepared = await (
        await f.authorization.bindRecovery(f.expected)
      ).prepareUnderScannerLease(() => {});
      await expect(
        f.database.recoverSignedManagementIfUnchanged(
          f.expected,
          prepared.signedJson,
          {
            assertActive: () => {},
            assertAfter: prepared.assertAfter,
            assertBefore: async (manager, row) => {
              await prepared.assertBefore(manager, row as typeof f.expected);
              await manager
                .getRepository(ArbitraryEntity)
                .update({ id: f.expected.orderId! }, { orderJson: '[]' });
            },
          },
        ),
      ).rejects.toThrow();
      expect((await f.current()).status).toEqual('sign-failed');
      expect(
        (await f.database.getOrderById(f.expected.orderId!))?.orderJson,
      ).toEqual(f.order.orderJson);
    });
  });

  describe('bindInvalidation', () => {
    /**
     * @target AvalancheManagementExecutionAuthorization.bindInvalidation classifies mapped %s without Transfer proof
     * @dependencies Actual settled core execution and scanner/SQLite order state
     * @scenario Observe own reverted or foreign successful nonce use with no token logs
     * @expected Invalidation preserves its cause, reopens the arbitrary order and does not require a Transfer
     */
    it.each(['own-failed', 'foreign-succeeded'] as const)(
      'classifies mapped %s without Transfer proof',
      async (mode) => {
        f = await createManagementExecutionFixture(
          TransactionType.arbitrary,
          mode === 'foreign-succeeded',
          true,
        );
        if (mode === 'own-failed') await f.updateStatus('sent');
        const seen = await f.observe(
          mode === 'own-failed' ? 'own' : 'foreign',
          mode === 'own-failed' ? EvmTxStatus.failed : EvmTxStatus.succeed,
        );
        seen.receipt.logs = [];
        const receipts = vi.spyOn(
          f.network,
          'getSettledTransactionReceiptEvidence',
        );
        const prepared = await (
          await f.authorization.bindInvalidation(f.expected)
        ).prepareUnderScannerLease(() => {});
        expect(prepared.unexpected).toEqual(mode === 'own-failed');
        expect(
          await f.database.invalidateTxIfUnchanged(
            f.expected,
            f.expected.lastCheck,
            prepared.unexpected,
            {
              assertActive: () => {},
              ...prepared,
            },
          ),
        ).toEqual(true);
        const row = await f.current();
        expect(row.status).toEqual('invalid');
        expect(row.order?.status).toEqual('pending');
        expect(row.order?.unexpectedFails).toEqual(
          mode === 'own-failed' ? 1 : 0,
        );
        expect(receipts).not.toHaveBeenCalled();
      },
    );

    /**
     * @target invalidates %s from settled proof and preserves the order transition
     * Class/function: AvalancheManagementExecutionAuthorization.bindInvalidation
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Create an arbitrary row; observe own failure or foreign success; prepare invalidation and apply its SQL transition.
     * @expected
     * - Invalid row, pending order and the matching unexpected-failure counter.
     */
    it.each(['own-failed', 'foreign-succeeded'] as const)(
      'invalidates %s from settled proof and preserves the order transition',
      async (mode) => {
        f = await createManagementExecutionFixture(
          TransactionType.arbitrary,
          mode === 'foreign-succeeded',
        );
        if (mode === 'own-failed') await f.updateStatus('sent');
        await f.observe(
          mode === 'own-failed' ? 'own' : 'foreign',
          mode === 'own-failed' ? EvmTxStatus.failed : EvmTxStatus.succeed,
        );
        const prepared = await (
          await f.authorization.bindInvalidation(f.expected)
        ).prepareUnderScannerLease(() => {});
        expect(prepared.unexpected).toEqual(mode === 'own-failed');
        expect(
          await f.database.invalidateTxIfUnchanged(
            f.expected,
            f.expected.lastCheck,
            prepared.unexpected,
            { assertActive: () => {}, ...prepared },
          ),
        ).toEqual(true);
        expect((await f.current()).status).toEqual('invalid');
        const order = await f.database.getOrderById(f.expected.orderId!);
        expect(order?.status).toEqual('pending');
        expect(order?.unexpectedFails).toEqual(mode === 'own-failed' ? 1 : 0);
      },
    );

    /**
     * @target refuses invalidation of successful own bytes
     * Class/function: AvalancheManagementExecutionAuthorization.bindInvalidation
     * @dependencies
     * - createManagementExecutionFixture: real SQLite transaction, scanner and order records.
     * - Actual Avalanche chain/RPC adapters with synthetic provider spies; policy and lease callbacks.
     * @scenario
     * - Mark a manual row sent; observe successful own execution; attempt invalidation.
     * @expected
     * - Reconciliation rejection.
     */
    it('refuses invalidation of successful own bytes', async () => {
      f = await createManagementExecutionFixture(TransactionType.manual);
      await f.updateStatus('sent');
      await f.observe();
      await expect(
        (
          await f.authorization.bindInvalidation(f.expected)
        ).prepareUnderScannerLease(() => {}),
      ).rejects.toThrow('reconciliation');
    });
  });
});
