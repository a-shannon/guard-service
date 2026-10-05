import { Transaction } from 'ethers';

import { AvalancheSafetyState } from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import {
  ConfirmationStatus,
  ChainUtils,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { EvmTxStatus } from '@rosen-chains/evm';

import { recoverAvalancheApprovedOrder } from '../../src/agreement/avalancheOrderRecovery';
import Configs from '../../src/configs/configs';
import { ArbitraryEntity } from '../../src/db/entities/arbitraryEntity';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import ChainHandler from '../../src/handlers/chainHandler';
import GuardPkHandler from '../../src/handlers/guardPkHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import { createGuardSigningRuntime } from '../../src/signing/signingRuntime';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { createManagementProcessorFixture } from './avalancheManagementProcessorTestUtils';

type Fixture = Awaited<ReturnType<typeof createManagementProcessorFixture>>;
let f: Fixture | undefined;
let previousArbitraryRequests: boolean | undefined;
const routes = [
  TransactionType.coldStorage,
  TransactionType.manual,
  TransactionType.arbitrary,
];

describe('TransactionProcessor', () => {
  afterEach(async () => {
    await f?.close();
    f = undefined;
    if (previousArbitraryRequests !== undefined) {
      Configs.isArbitraryOrderRequestActive = previousArbitraryRequests;
      previousArbitraryRequests = undefined;
    }
    vi.restoreAllMocks();
  });
  describe('processTransactions', () => {
    /** Creates persisted interrupted approval state, then replaces all in-memory signing context. */
    const interrupted = async (token: boolean, unsigned = false) => {
      previousArbitraryRequests = Configs.isArbitraryOrderRequestActive;
      Configs.isArbitraryOrderRequestActive = true;
      const current = (f = await createManagementProcessorFixture(
        TransactionType.arbitrary,
        unsigned,
        true,
      ));
      vi.spyOn(TokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
        current.tokens,
      );
      if (!token) {
        const before = await current.current();
        current.tx.signature = null;
        current.tx.to = '0x' + '56'.repeat(20);
        current.tx.value = 750000n * 1000000000n;
        current.tx.data = '0x' + current.order.id;
        if (!unsigned) current.sign();
        const payment = current.payment();
        await current.database.TransactionRepository.delete({
          txId: before.txId,
        });
        await current.database.TransactionRepository.insert({
          ...before,
          txId: payment.txId,
          txJson: payment.toJson(),
        });
        current.expected.txId = payment.txId;
        current.expected.txJson = payment.toJson();
        await current.database.ArbitraryRepository.update(
          { id: current.order.id },
          {
            orderJson: ChainUtils.encodeOrder(
              current.chain.extractTransactionOrder(payment),
            ),
          },
        );
      }
      const guards = GuardPkHandler.getInstance();
      vi.spyOn(GuardPkHandler, 'getInstance').mockReturnValue({
        ...guards,
        requiredSign: 2,
      } as GuardPkHandler);
      await current.database.ArbitraryRepository.update(
        { id: current.order.id },
        { status: 'pending' },
      );
      if (unsigned) await current.updateStatus('approved');
      const restarted = createGuardSigningRuntime({
        getEvent: async () => null,
        getTx: (id) => current.database.getTxById(id),
        decode: (json) => current.chain.PaymentTransactionFromJson(json),
        getScanner: () => current.scanner,
        management: current.policy,
        curveTimeoutSeconds: 1,
        edwardTimeoutSeconds: 1,
        ergoTimeoutSeconds: 1,
        maxPending: 2,
      });
      TransactionProcessor.initSigning(restarted.context, restarted.processor);
      return { ...current, restarted };
    };

    /**
     * @target recoverAvalancheApprovedOrder recovers the exact interrupted owner without changing transaction fields
     * @dependencies Actual SQLite manager, scanner and replacement signing runtime
     * @scenario Recover a persisted signed/pending mainnet JOE row through the bounded helper
     * @expected Only order.status changes and no submission begins
     */
    it('recovers the exact interrupted owner without changing transaction fields', async () => {
      const current = await interrupted(true);
      const before = await current.current();
      const recovered = await recoverAvalancheApprovedOrder(
        before,
        () => current.restarted.context,
      );
      expect(recovered.order?.status).toEqual('in-process');
      expect({ ...recovered, order: null }).toEqual({ ...before, order: null });
      expect(current.requests).toEqual([]);
    });

    /**
     * @target TransactionProcessor.processTransactions recovers persisted $name signed approval after context restart
     * @dependencies Actual SQLite DAO, scanner, replacement runtime, native/JOE adapter and loopback transport
     * @scenario Persist signed/pending state, discard signing context, then run the periodic database consumer without any agreement message
     * @expected Exactly that order becomes in-process and the existing signed row is submitted once as sent
     */
    it.each([
      { name: 'AVAX', token: false },
      { name: 'JOE', token: true },
    ])(
      'recovers persisted $name signed approval after context restart',
      async ({ token }) => {
        const current = await interrupted(token);
        expect(current.chain.CHAIN_ID).toEqual(43114n);
        const before = await current.current();
        await TransactionProcessor.processTransactions();
        const after = await current.current();
        expect(after.order?.status).toEqual('in-process');
        expect(after.status).toEqual('sent');
        expect(after.txJson).toEqual(before.txJson);
        expect(after.requiredSign).toEqual(before.requiredSign);
        expect(after.lastCheck).toEqual(before.lastCheck);
        expect(after.signFailedCount).toEqual(before.signFailedCount);
        expect(current.requests).toHaveLength(1);
        expect(current.legacy).not.toHaveBeenCalled();
      },
    );

    /**
     * @target TransactionProcessor.processTransactions recovers persisted $name unsigned approval before actual queueing
     * @dependencies Actual DAO, scanner, replacement signing context and processor-owned result persistence; synthetic signed result
     * @scenario Restart with approved/pending state and run the periodic consumer, then return exact signed bytes from the signer
     * @expected The order is recovered before the real queue/result route, with no approval-message replay or HTTP submission
     */
    it.each([
      { name: 'AVAX', token: false },
      { name: 'JOE', token: true },
    ])(
      'recovers persisted $name unsigned approval before actual queueing',
      async ({ token }) => {
        const current = await interrupted(token, true);
        expect(current.chain.CHAIN_ID).toEqual(43114n);
        const sign = vi
          .spyOn(current.chain, 'signTransaction')
          .mockImplementation(async (payment) => {
            expect((await current.current()).order?.status).toEqual(
              'in-process',
            );
            const signed = Transaction.from(
              '0x' + Buffer.from(payment.txBytes).toString('hex'),
            );
            signed.signature = current.key.sign(signed.unsignedHash);
            return new PaymentTransaction(
              'avalanche',
              signed.unsignedHash,
              payment.eventId,
              Buffer.from(signed.serialized.slice(2), 'hex'),
              TransactionType.arbitrary,
            );
          });
        await TransactionProcessor.processTransactions();
        await vi.waitFor(async () =>
          expect((await current.current()).status).toEqual('signed'),
        );
        await vi.waitFor(() =>
          expect(TransactionProcessor['attempts'].size).toEqual(0),
        );
        expect(sign).toHaveBeenCalledTimes(1);
        expect((await current.current()).order?.status).toEqual('in-process');
        expect(current.requests).toEqual([]);
      },
    );

    /**
     * @target TransactionProcessor.processTransactions refuses interrupted recovery with %s
     * @dependencies Actual SQL rows, scanner authority, management envelope and periodic selection
     * @scenario Independently corrupt one persisted owner, terminal phase, bytes, chain, order, quorum or scanner hold
     * @expected No order is reopened, no signed POST starts and the selected row status is unchanged
     */
    it.each([
      'completed row',
      'invalid row',
      'completed order',
      'conflicting owner',
      'wrong bytes',
      'wrong chain',
      'order drift',
      'quorum drift',
      'scanner hold',
    ])('refuses interrupted recovery with %s', async (fault) => {
      const current = await interrupted(true);
      const rows = current.database.TransactionRepository;
      const orders = current.database.ArbitraryRepository;
      if (fault === 'completed row') await current.updateStatus('completed');
      if (fault === 'invalid row') await current.updateStatus('invalid');
      if (fault === 'completed order')
        await orders.update({ id: current.order.id }, { status: 'completed' });
      if (fault === 'conflicting owner') {
        const own = await current.current();
        await rows.insert({
          ...own,
          txId: '0x' + '77'.repeat(32),
          order: { id: current.order.id },
        });
      }
      if (fault === 'wrong bytes') {
        const json = JSON.parse((await current.current()).txJson);
        json.txBytes = '00';
        await rows.update(
          { txId: current.expected.txId },
          { txJson: JSON.stringify(json) },
        );
      }
      if (fault === 'wrong chain')
        await rows.update(
          { txId: current.expected.txId },
          { chain: 'ethereum' },
        );
      if (fault === 'order drift')
        await orders.update({ id: current.order.id }, { orderJson: '[]' });
      if (fault === 'quorum drift')
        await rows.update({ txId: current.expected.txId }, { requiredSign: 1 });
      if (fault === 'scanner hold')
        await current.database.dataSource
          .getRepository(AvalancheSafetyState)
          .update(
            { scanner: 'avalanche' },
            { holdReason: 'synthetic-recovery-hold' },
          );
      const before = await current.current();
      await TransactionProcessor.processTransactions();
      const after = await current.current();
      expect(after.order?.status).toEqual(before.order?.status);
      expect(after.status).toEqual(before.status);
      expect(current.requests).toEqual([]);
    });

    /**
     * @target recoverAvalancheApprovedOrder rolls back recovery when exact %s changes
     * @dependencies Actual manager-owned SQLite row/order CAS and replacement context
     * @scenario Change one check or order metadata field after capturing the selected row but before recovery
     * @expected The pending order remains pending and the changed metadata is never overwritten
     */
    it.each([
      'lastCheck',
      'lastStatusUpdate',
      'failedInSign',
      'signFailedCount',
      'firstTry',
      'unexpectedFails',
    ])('rolls back recovery when exact %s changes', async (field) => {
      const current = await interrupted(true);
      const selected = await current.current();
      if (field === 'firstTry' || field === 'unexpectedFails')
        await current.database.ArbitraryRepository.update(
          { id: current.order.id },
          field === 'firstTry' ? { firstTry: '999' } : { unexpectedFails: 1 },
        );
      else
        await current.database.dataSource
          .getRepository(TransactionEntity)
          .update(
            { txId: selected.txId },
            field === 'lastCheck'
              ? { lastCheck: selected.lastCheck + 1 }
              : field === 'lastStatusUpdate'
                ? { lastStatusUpdate: '999' }
                : field === 'failedInSign'
                  ? { failedInSign: true }
                  : { signFailedCount: selected.signFailedCount + 1 },
          );
      await expect(
        recoverAvalancheApprovedOrder(
          selected,
          () => current.restarted.context,
        ),
      ).rejects.toThrow();
      expect((await current.current()).order?.status).toEqual('pending');
      if (field === 'lastCheck')
        expect((await current.current()).lastCheck).toEqual(
          selected.lastCheck + 1,
        );
      expect(current.requests).toEqual([]);
    });

    /**
     * @target recoverAvalancheApprovedOrder rolls back recovery when %s changes during owned SQL
     * @dependencies Actual manager transaction and synchronous startup policy/guard readers
     * @scenario Revoke one policy or quorum after SQL ownership begins, before phase persistence
     * @expected The order stays pending and no transaction field or transport is advanced
     */
    it.each(['request policy', 'quorum', 'chain config', 'token map'])(
      'rolls back recovery when %s changes during owned SQL',
      async (fault) => {
        const current = await interrupted(true);
        const before = await current.current();
        const source = current.database.dataSource;
        const transaction = source.transaction.bind(source);
        vi.spyOn(source, 'transaction').mockImplementation(
          async (...args: Parameters<typeof transaction>) => {
            const action = args[1] ?? args[0];
            if (typeof action !== 'function')
              throw new Error('Missing owned transaction action');
            return transaction(async (manager) => {
              const orders = manager.getRepository(ArbitraryEntity);
              const update = orders.update.bind(orders);
              vi.spyOn(orders, 'update').mockImplementation(
                async (...args: Parameters<typeof update>) => {
                  const written = await update(...args);
                  if (fault === 'request policy')
                    Configs.isArbitraryOrderRequestActive = false;
                  if (fault === 'quorum')
                    GuardPkHandler.getInstance().requiredSign = 1;
                  if (fault === 'chain config')
                    current.getPolicy().config.routes.arbitrary = false;
                  if (fault === 'token map')
                    vi.spyOn(
                      TokenHandler.getInstance().getTokenMap(),
                      'getRawConfig',
                    ).mockReturnValue([]);
                  return written;
                },
              );
              return action(manager);
            });
          },
        );
        await expect(
          recoverAvalancheApprovedOrder(
            before,
            () => current.restarted.context,
          ),
        ).rejects.toThrow();
        expect((await current.current()).order?.status).toEqual('pending');
        expect((await current.current()).status).toEqual(before.status);
        expect(current.requests).toEqual([]);
      },
    );
  });
  describe('PostgreSQL order ownership', () => {
    /**
     * @target recoverAvalancheApprovedOrder excludes a concurrent foreign-key owner until recovery commits
     * @dependencies Actual PostgreSQL datasource, order and transaction entities, signing context and two connections
     * @scenario Attempt a competing owner insert after the final recovery checks while its SQL transaction remains open
     * @expected The insert times out on the parent lock, recovery commits one owner, and no transport starts
     */
    it.skipIf(!process.env.AVALANCHE_NATIVE_FIXTURE_DATABASE_URL)(
      'excludes a concurrent foreign-key owner until recovery commits',
      async () => {
        previousArbitraryRequests = Configs.isArbitraryOrderRequestActive;
        Configs.isArbitraryOrderRequestActive = true;
        f = await createManagementProcessorFixture(
          TransactionType.arbitrary,
          false,
          true,
        );
        vi.spyOn(TokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
          f.tokens,
        );
        const guards = GuardPkHandler.getInstance();
        vi.spyOn(GuardPkHandler, 'getInstance').mockReturnValue({
          ...guards,
          requiredSign: 2,
        } as GuardPkHandler);
        await f.database.ArbitraryRepository.update(
          { id: f.order.id },
          { status: 'pending' },
        );
        const before = await f.current();
        const source = f.database.dataSource;
        expect(source.options.type).toEqual('postgres');
        const foreign = await new DataSource({
          ...source.options,
          synchronize: false,
        }).initialize();
        try {
          await foreign.query("SET lock_timeout = '100ms'");
          const transaction = source.transaction.bind(source);
          vi.spyOn(source, 'transaction').mockImplementation(
            async (...args: Parameters<typeof transaction>) => {
              const action = args[1] ?? args[0];
              if (typeof action !== 'function')
                throw new Error('Missing owned transaction action');
              return transaction(async (manager) => {
                const result = await action(manager);
                expect(manager.queryRunner?.isTransactionActive).toEqual(true);
                await expect(
                  foreign.getRepository(TransactionEntity).insert({
                    ...before,
                    txId: '0x' + '77'.repeat(32),
                    order: { id: before.order!.id },
                  }),
                ).rejects.toMatchObject({ code: '55P03' });
                return result;
              });
            },
          );
          const recovered = await recoverAvalancheApprovedOrder(
            before,
            () => f!.runtime.context,
          );
          expect(recovered.order?.status).toEqual('in-process');
          expect(
            await source.getRepository(TransactionEntity).count({
              where: { order: { id: before.order!.id } },
            }),
          ).toEqual(1);
          expect(f.requests).toEqual([]);
        } finally {
          await foreign.destroy();
        }
      },
    );
  });
  describe('processSignedTx', () => {
    /**
     * @target TransactionProcessor.processSignedTx submits mapped JOE %s with retained scanner and SQL authority
     * @dependencies Actual mainnet chain/RPC, runtime, DAO, scanner and loopback HTTP transport; synthetic token/gas responses
     * @scenario Process a signed mapped cold, manual or arbitrary row
     * @expected One exact signed POST starts under scanner exclusion and persists sent without legacy submission
     */
    it.each(routes)(
      'submits mapped JOE %s with retained scanner and SQL authority',
      async (type) => {
        f = await createManagementProcessorFixture(type, false, true);
        await TransactionProcessor.processSignedTx(await f.current());
        expect((await f.current()).status).toEqual('sent');
        expect(f.chain.CHAIN_ID).toEqual(43114n);
        expect(f.requests).toEqual([
          {
            method: 'eth_sendRawTransaction',
            params: ['0x' + Buffer.from(f.payment().txBytes).toString('hex')],
            id: expect.any(Number),
            jsonrpc: '2.0',
          },
        ]);
        expect(f.legacy).not.toHaveBeenCalled();
      },
    );

    /**
     * @target TransactionProcessor.processSignedTx refuses mapped JOE %s without AVAX gas
     * @dependencies Actual chain funding, signing runtime, scanner and DAO; consumed native balance port
     * @scenario Retain ample JOE but consume the AVAX balance before processor submission
     * @expected No POST and no sent state transition
     */
    it.each(routes)('refuses mapped JOE %s without AVAX gas', async (type) => {
      f = await createManagementProcessorFixture(type, false, true);
      f.cold.locked.nativeToken = 1n;
      await expect(
        TransactionProcessor.processSignedTx(await f.current()),
      ).rejects.toThrow();
      expect((await f.current()).status).toEqual('signed');
      expect(f.requests).toEqual([]);
    });
    /**
     * @target TransactionProcessor.processSignedTx submits signed %s through the qualified loopback transport
     * @dependencies
     * - Actual runtime, SQLite scanner/DAO, public native chain and RPC transport.
     * - Synthetic balance/fees and a loopback JSON-RPC peer.
     * @scenario
     * - Submit a signed native management row through the public processor method.
     * @expected
     * - Exactly one signed POST starts with the scanner excluded, followed by owned sent persistence.
     */
    it.each(routes)(
      'submits signed %s through the qualified loopback transport',
      async (type) => {
        f = await createManagementProcessorFixture(type);
        await TransactionProcessor.processSignedTx(await f.current());
        expect((await f.current()).status).toEqual('sent');
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0].method).toEqual('eth_sendRawTransaction');
        expect(f.requests[0].params).toEqual([
          '0x' + Buffer.from(f.payment().txBytes).toString('hex'),
        ]);
        expect(f.legacy).not.toHaveBeenCalled();
      },
    );

    /**
     * @target TransactionProcessor.processSignedTx reconciles observed signed %s without another POST
     * @dependencies
     * - Actual scanner records and public RPC settled-evidence decoder.
     * @scenario
     * - Signed own bytes already succeeded, and the live cold balance is consumed.
     * @expected
     * - The row becomes sent without reopening HTTP or requiring the old balance trigger.
     */
    it.each(routes)(
      'reconciles observed signed %s without another POST',
      async (type) => {
        f = await createManagementProcessorFixture(type);
        await f.observe();
        f.cold.locked.nativeToken = 1n;
        await TransactionProcessor.processSignedTx(await f.current());
        expect((await f.current()).status).toEqual('sent');
        expect(f.requests).toHaveLength(0);
        expect(f.legacy).not.toHaveBeenCalled();
        expect(f.getColdState).not.toHaveBeenCalled();
      },
    );

    /**
     * @target TransactionProcessor.processSignedTx refuses a persisted scanner hold before initial POST
     * @dependencies
     * - Actual scanner safety table, runtime and qualified dispatcher.
     * @scenario
     * - A hold is persisted after the row is admitted but before initial submission.
     * @expected
     * - No POST or sent transition occurs.
     */
    it('refuses a persisted scanner hold before initial POST', async () => {
      f = await createManagementProcessorFixture(TransactionType.manual);
      await f.database.dataSource
        .getRepository(AvalancheSafetyState)
        .update(
          { scanner: 'avalanche' },
          { holdReason: 'synthetic-processor-hold' },
        );
      await expect(
        TransactionProcessor.processSignedTx(await f.current()),
      ).rejects.toThrow('denied');
      expect((await f.current()).status).toEqual('signed');
      expect(f.requests).toHaveLength(0);
    });
  });
  describe('processSentTx', () => {
    /**
     * @target TransactionProcessor.processSentTx completes mapped JOE %s from exact settled Transfer
     * @dependencies Actual qualified receipt decoder, runtime, scanner and DAO with synthetic canonical mainnet evidence
     * @scenario Observe the signed token movement, consume current balances and process the sent row
     * @expected Completion and applicable order persist without a second POST
     */
    it.each(routes)(
      'completes mapped JOE %s from exact settled Transfer',
      async (type) => {
        f = await createManagementProcessorFixture(type, false, true);
        await f.updateStatus('sent');
        await f.observe();
        f.cold.locked.nativeToken = 1n;
        f.cold.locked.tokens[0].value = 0n;
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        await TransactionProcessor.processSentTx(await f.current());
        const row = await f.current();
        expect(row.status).toEqual('completed');
        if (type === TransactionType.arbitrary)
          expect(row.order?.status).toEqual('completed');
        expect(f.requests).toEqual([]);
        expect(f.getColdState).not.toHaveBeenCalled();
      },
    );

    /**
     * @target TransactionProcessor.processSentTx refuses mapped JOE %s with missing Transfer
     * @dependencies Actual receipt/accounting/runtime and owned SQL completion path
     * @scenario Keep successful canonical receipt and confirmation but remove its sole transfer log
     * @expected Sent row and order remain unchanged, with no POST
     */
    it.each(routes)(
      'refuses mapped JOE %s with missing Transfer',
      async (type) => {
        f = await createManagementProcessorFixture(type, false, true);
        await f.updateStatus('sent');
        const observation = await f.observe();
        observation.receipt.logs = [];
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        const before = await f.current();
        await expect(
          TransactionProcessor.processSentTx(before),
        ).rejects.toThrow();
        expect((await f.current()).status).toEqual(before.status);
        expect((await f.current()).order?.status ?? null).toEqual(
          before.order?.status ?? null,
        );
        expect(f.requests).toEqual([]);
      },
    );
    /**
     * @target TransactionProcessor.processSentTx resends an eligible native transaction through fresh authority
     * @dependencies
     * - Real qualified transport and native fee/reserve checks; synthetic confirmation acquisition.
     * @scenario
     * - A previously sent transaction is absent and still eligible.
     * @expected
     * - A fresh authorized POST occurs while identity and sent state remain unchanged.
     */
    it('resends an eligible native transaction through fresh authority', async () => {
      f = await createManagementProcessorFixture(TransactionType.manual);
      await f.updateStatus('sent');
      vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
        ConfirmationStatus.NotFound,
      );
      vi.spyOn(f.chain, 'isTxInMempool').mockResolvedValue(false);
      vi.spyOn(f.chain, 'isTxValid').mockResolvedValue({
        isValid: true,
        details: undefined,
      });
      await TransactionProcessor.processSentTx(await f.current());
      expect((await f.current()).status).toEqual('sent');
      expect(f.requests).toHaveLength(1);
      expect(f.legacy).not.toHaveBeenCalled();
    });

    /**
     * @target TransactionProcessor.processSentTx completes settled %s with consumed balance
     * @dependencies
     * - Actual qualified settled proof, SQL completion and arbitrary order relation.
     * @scenario
     * - Confirmation acquisition selects completion after a successful own execution.
     * @expected
     * - The transaction and its applicable order complete without an extra POST.
     */
    it.each(routes)(
      'completes settled %s with consumed balance',
      async (type) => {
        f = await createManagementProcessorFixture(type);
        await f.updateStatus('sent');
        await f.observe();
        f.cold.locked.nativeToken = 1n;
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        await TransactionProcessor.processSentTx(await f.current());
        const row = await f.current();
        expect(row.status).toEqual('completed');
        if (type === TransactionType.arbitrary)
          expect(row.order?.status).toEqual('completed');
        expect(f.requests).toHaveLength(0);
      },
    );

    /**
     * @target TransactionProcessor.processSentTx refuses %s without settled evidence
     * @dependencies
     * - Actual execution binder and SQL invalidation path.
     * @scenario
     * - Generic confirmation/validity hints propose completion, recovery or invalidation without settled evidence.
     * @expected
     * - No irreversible state transition or HTTP submission occurs.
     */
    it.each(['completion'] as ('completion' | 'recovery' | 'invalidation')[])(
      'refuses %s without settled evidence',
      async (purpose) => {
        f = await createManagementProcessorFixture(
          TransactionType.manual,
          purpose === 'recovery',
        );
        if (purpose !== 'recovery') await f.updateStatus('sent');
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        vi.spyOn(f.chain, 'getHeight').mockResolvedValue(100);
        const before = await f.current();
        const action =
          purpose === 'completion'
            ? TransactionProcessor.processSentTx(before)
            : purpose === 'recovery'
              ? TransactionProcessor.processSignFailedTx(before)
              : TransactionProcessor.setTransactionAsInvalid(
                  before,
                  ChainHandler.getInstance().getChain('avalanche'),
                  { reason: 'synthetic hint', unexpected: false },
                );
        await expect(action).rejects.toThrow();
        expect((await f.current()).status).toEqual(before.status);
        expect(f.requests).toHaveLength(0);
      },
    );
  });
  describe('processSignFailedTx', () => {
    /**
     * @target TransactionProcessor.processSignFailedTx recovers mapped JOE %s exact signed bytes
     * @dependencies Actual canonical receipt/Transfer decoder, runtime and persisted unsigned row/order
     * @scenario The public key signed an unsigned sign-failed candidate already observed on mainnet simulation
     * @expected The same signed body is recovered without another POST or balance preflight
     */
    it.each(routes)(
      'recovers mapped JOE %s exact signed bytes',
      async (type) => {
        f = await createManagementProcessorFixture(type, true, true);
        const observed = await f.observe();
        f.cold.locked.nativeToken = 1n;
        f.cold.locked.tokens[0].value = 0n;
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        await TransactionProcessor.processSignFailedTx(await f.current());
        const row = await f.current();
        expect(row.status).toEqual('sent');
        expect(JSON.parse(row.txJson).txBytes).toEqual(
          observed.signed.serialized.slice(2),
        );
        expect(f.requests).toEqual([]);
        expect(f.getColdState).not.toHaveBeenCalled();
      },
    );
    /**
     * @target TransactionProcessor.processSignFailedTx recovers exact settled %s bytes before marking sent
     * @dependencies
     * - Actual 12-field recovery DAO and public settled RPC evidence.
     * @scenario
     * - A local unsigned sign-failed row is selected as already observed.
     * @expected
     * - Exact settled signed bytes become sent while counters and order ownership survive.
     */
    it.each(routes)(
      'recovers exact settled %s bytes before marking sent',
      async (type) => {
        f = await createManagementProcessorFixture(type, true);
        const seen = await f.observe();
        f.cold.locked.nativeToken = 1n;
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        await TransactionProcessor.processSignFailedTx(await f.current());
        const row = await f.current();
        expect(row.status).toEqual('sent');
        expect(JSON.parse(row.txJson).txBytes).toEqual(
          seen.signed.serialized.slice(2),
        );
        expect(row.signFailedCount).toEqual(2);
        expect(row.lastCheck).toEqual(12);
        expect(f.requests).toHaveLength(0);
      },
    );

    /**
     * @target TransactionProcessor.processSignFailedTx refuses %s without settled evidence
     * @dependencies
     * - Actual execution binder and SQL invalidation path.
     * @scenario
     * - Generic confirmation/validity hints propose completion, recovery or invalidation without settled evidence.
     * @expected
     * - No irreversible state transition or HTTP submission occurs.
     */
    it.each(['recovery'] as ('completion' | 'recovery' | 'invalidation')[])(
      'refuses %s without settled evidence',
      async (purpose) => {
        f = await createManagementProcessorFixture(
          TransactionType.manual,
          purpose === 'recovery',
        );
        if (purpose !== 'recovery') await f.updateStatus('sent');
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        vi.spyOn(f.chain, 'getHeight').mockResolvedValue(100);
        const before = await f.current();
        const action =
          purpose === 'completion'
            ? TransactionProcessor.processSentTx(before)
            : purpose === 'recovery'
              ? TransactionProcessor.processSignFailedTx(before)
              : TransactionProcessor.setTransactionAsInvalid(
                  before,
                  ChainHandler.getInstance().getChain('avalanche'),
                  { reason: 'synthetic hint', unexpected: false },
                );
        await expect(action).rejects.toThrow();
        expect((await f.current()).status).toEqual(before.status);
        expect(f.requests).toHaveLength(0);
      },
    );
  });
  describe('setTransactionAsInvalid', () => {
    /**
     * @target TransactionProcessor.setTransactionAsInvalid invalidates %s settled native execution
     * @dependencies
     * - Actual observed proof and owned invalidation/order bookkeeping.
     * @scenario
     * - The settled nonce belongs to a failed own execution or different transaction.
     * @expected
     * - Invalidation derives its reason and counter policy without trusting a generic reason.
     */
    it.each(['own', 'foreign'] as const)(
      'invalidates %s settled native execution',
      async (mode) => {
        f = await createManagementProcessorFixture(TransactionType.arbitrary);
        await f.updateStatus('sent');
        await f.observe(
          mode,
          mode === 'own' ? EvmTxStatus.failed : EvmTxStatus.succeed,
        );
        vi.spyOn(f.chain, 'getHeight').mockResolvedValue(100);
        await TransactionProcessor.setTransactionAsInvalid(
          await f.current(),
          ChainHandler.getInstance().getChain('avalanche'),
          undefined,
        );
        const row = await f.current();
        expect(row.status).toEqual('invalid');
        expect(row.order?.status).toEqual('pending');
        expect(row.order?.unexpectedFails).toEqual(mode === 'own' ? 1 : 0);
        expect(f.requests).toHaveLength(0);
        expect(f.notify).toHaveBeenCalledTimes(mode === 'own' ? 1 : 0);
      },
    );

    /**
     * @target TransactionProcessor.setTransactionAsInvalid refuses %s without settled evidence
     * @dependencies
     * - Actual execution binder and SQL invalidation path.
     * @scenario
     * - Generic confirmation/validity hints propose completion, recovery or invalidation without settled evidence.
     * @expected
     * - No irreversible state transition or HTTP submission occurs.
     */
    it.each(['invalidation'] as ('completion' | 'recovery' | 'invalidation')[])(
      'refuses %s without settled evidence',
      async (purpose) => {
        f = await createManagementProcessorFixture(
          TransactionType.manual,
          purpose === 'recovery',
        );
        if (purpose !== 'recovery') await f.updateStatus('sent');
        vi.spyOn(f.chain, 'getTxConfirmationStatus').mockResolvedValue(
          ConfirmationStatus.ConfirmedEnough,
        );
        vi.spyOn(f.chain, 'getHeight').mockResolvedValue(100);
        const before = await f.current();
        const action =
          purpose === 'completion'
            ? TransactionProcessor.processSentTx(before)
            : purpose === 'recovery'
              ? TransactionProcessor.processSignFailedTx(before)
              : TransactionProcessor.setTransactionAsInvalid(
                  before,
                  ChainHandler.getInstance().getChain('avalanche'),
                  { reason: 'synthetic hint', unexpected: false },
                );
        await expect(action).rejects.toThrow();
        expect((await f.current()).status).toEqual(before.status);
        expect(f.requests).toHaveLength(0);
      },
    );
  });
});
