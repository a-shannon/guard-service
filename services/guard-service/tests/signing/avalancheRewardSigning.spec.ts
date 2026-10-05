import { blake2b } from 'blakejs';
import * as wasm from 'ergo-lib-wasm-nodejs';
import { SigningKey, Transaction } from 'ethers';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations,
} from '@rosen-bridge/abstract-scanner';
import type { SigningPhase } from '@rosen-bridge/ergo-multi-sig';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
  AvalancheSafetyState1790769600000,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  AbstractChain,
  ConfirmationStatus,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import {
  AbstractErgoNetwork,
  ErgoChain,
  ErgoTransaction,
} from '@rosen-chains/ergo';

import { AvalancheRewardAdmission } from '../../src/agreement/avalancheRewardAdmission';
import { DatabaseAction } from '../../src/db/databaseAction';
import EventOrder from '../../src/event/eventOrder';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import { createErgoSigningAuthorization } from '../../src/signing/ergoSigningAuthorization';
import { createGuardSigningRuntime } from '../../src/signing/signingRuntime';
import { TransactionSigningContext } from '../../src/signing/transactionSigningContext';
import { TssAuthorizationRegistry } from '../../src/signing/tssAuthorizationRegistry';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import TransactionVerifier from '../../src/verification/transactionVerifier';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';
import ergoFixture from '../synchronization/avalancheSynchronizationTestData';

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
describe('Avalanche reward signing authority', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let scannerDb: DataSource;
  let network: AvalancheRpcNetwork;
  let scanner: AvalancheRpcScanner;
  let payment: PaymentTransaction;
  let reward: ErgoTransaction;
  let eventId: string;
  let context: TransactionSigningContext;
  let authorization: RewardAuthorization;
  const confirmation = vi.fn();
  const wallet = vi.fn(() => 'signed');
  const hold = () =>
    scannerDb
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'test hold' });
  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    scannerDb = await new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [BlockEntity, ExtractorStatusEntity, AvalancheSafetyState],
      migrations: [...migrations.sqlite, AvalancheSafetyState1790769600000],
    }).initialize();
    await scannerDb.runMigrations();
    network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
    vi.spyOn(network, 'getCurrentHeight').mockResolvedValue(2);
    vi.spyOn(network, 'getBlockAtHeight').mockImplementation(
      async (height) => ({
        hash: hash(height),
        height,
        parentHash: hash(height - 1),
        timestamp: 100 + height,
        txCount: 0,
      }),
    );
    vi.spyOn(network, 'getBlockTxs').mockResolvedValue([]);
    scanner = new AvalancheRpcScanner({
      network,
      dataSource: scannerDb,
      sourceId: 'reward-source',
      initialHeight: 0,
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 0,
      },
    });
    await scanner.update();
    const event = mockEventTrigger().event;
    Object.assign(event, {
      fromChain: 'ergo',
      toChain: 'avalanche',
      sourceChainHeight: 1,
      sourceBlockId: hash(1),
      WIDsCount: 1,
      WIDsHash: Buffer.from(
        blake2b(Buffer.from('aa'.repeat(32), 'hex'), undefined, 32),
      ).toString('hex'),
    });
    eventId = EventSerializer.getId(event);
    await DatabaseActionMock.insertEventRecord(
      event,
      EventStatus.inReward,
      undefined,
      1,
      'first',
      event.height,
    );
    await db().EventRepository.update(
      { eventId },
      {
        spendBlock: null,
        spendHeight: null,
        spendTxId: null,
        result: null,
        paymentTxId: null,
      },
    );
    await DatabaseActionMock.insertCommitmentBoxRecord(
      event,
      eventId,
      'YQ==',
      'aa'.repeat(32),
      event.height - 1,
      '1',
      'event-creation-tx-id',
      0,
    );
    const signed = Transaction.from({
      type: 2,
      chainId: 43113,
      nonce: 0,
      to: '0x' + '11'.repeat(20),
      value: 1n,
      gasLimit: 21000n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
    });
    signed.signature = new SigningKey('0x' + '01'.repeat(32)).sign(
      signed.unsignedHash,
    );
    payment = new PaymentTransaction(
      'avalanche',
      signed.unsignedHash,
      eventId,
      Buffer.from(signed.serialized.slice(2), 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      payment,
      TransactionStatus.completed,
      123,
      'updated',
      false,
      0,
      3,
    );
    reward = new ErgoTransaction(
      'reward-id',
      eventId,
      Buffer.from('abcd', 'hex'),
      TransactionType.reward,
      [],
      [],
    );
    confirmation
      .mockReset()
      .mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    wallet.mockClear();
    const target = {
      getActualTxId: vi.fn().mockResolvedValue(signed.hash),
      getTxConfirmationStatus: confirmation,
      verifyPaymentTransaction: vi.fn().mockResolvedValue(true),
      verifyTransactionExtraConditions: vi.fn().mockReturnValue(true),
      getHeight: vi.fn().mockResolvedValue(100),
      extractTransactionOrder: vi.fn().mockReturnValue([]),
    } as unknown as AbstractChain<unknown>;
    context = new TransactionSigningContext({
      safety: new AvalancheTransactionSafety(
        (id) => db().getEventById(id),
        () => scanner,
      ),
      getTx: (id) => db().getTxById(id),
      decode: (json) => {
        const m = JSON.parse(json);
        if (m.network === 'ergo') return ErgoTransaction.fromJson(json);
        return new PaymentTransaction(
          m.network,
          m.txId,
          m.eventId,
          Buffer.from(m.txBytes, 'hex'),
          m.txType,
        );
      },
      registry: new TssAuthorizationRegistry(1000, 4),
      bindReward: (expected, statuses) =>
        authorization.bindExistingReward(expected, statuses),
    });
    authorization = new RewardAuthorization({
      context,
      getDatabase: db,
      getChain: () => target,
    });
    vi.spyOn(RewardAuthorization, 'getInstance').mockReturnValue(authorization);
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getErgoChain: () => target,
      getChain: () => target,
    } as never);
    vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue(
      {} as never,
    );
    vi.spyOn(EventOrder, 'createEventRewardOrder').mockResolvedValue([]);
    vi.spyOn(TransactionVerifier, 'verifyTxCommonConditions').mockResolvedValue(
      true,
    );
    await DatabaseActionMock.insertTxRecord(
      reward,
      TransactionStatus.inSign,
      123,
      'updated',
      false,
      0,
      3,
    );
  });
  afterEach(async () => {
    network['provider'].destroy();
    await scannerDb.destroy();
    vi.restoreAllMocks();
  });

  describe('qualified signing persistence', () => {
    const bindPersistence = async (status = TransactionStatus.inSign) => {
      await db().TransactionRepository.update(
        { txId: reward.txId },
        { status },
      );
      return context.bind((await db().getTxById(reward.txId))!, [
        TransactionStatus.approved,
        TransactionStatus.signFailed,
        TransactionStatus.inSign,
      ]);
    };
    const failure = async (
      bound: Awaited<ReturnType<typeof bindPersistence>>,
    ) =>
      bound.withPersistence('failure', (expected, permit) =>
        db().setTxStatusIfUnchanged(
          expected,
          TransactionStatus.signFailed,
          permit,
        ),
      );

    /**
     * @target TransactionProcessor.processInSignTx, TransactionProcessor.processApprovedTx 'actual processor %s respects reward persistence authority'
     * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
     * @scenario Run 'actual processor %s respects reward persistence authority' through TransactionProcessor.processInSignTx and TransactionProcessor.processApprovedTx.
     * @expected await expect(work).rejects.toThrow(); await expect(work).rejects.toThrow(); expect(sign).not.toHaveBeenCalled(); await vi.waitFor(() => expect(TransactionProcessor['attempts'].size).toBe(0), ); expect(binding).toHaveBeenCalledOnce(); expect((await db().getTxById(reward.txId))!.status).toBe( expectedStatus, );
     */
    it.each([
      'queue-loss',
      'owned-failure',
      'owned-loss',
      'orphan-failure',
      'orphan-loss',
    ])(
      'actual processor %s respects reward persistence authority',
      async (scenario) => {
        vi.spyOn(DatabaseAction, 'getInstance').mockReturnValue(db());
        TransactionProcessor.initSigning(context, {
          timeoutMs: 5000,
          maxPending: 4,
        });
        const binding = vi.spyOn(authorization, 'bindExistingReward');
        let rejectSign!: (reason: Error) => void;
        const pending = new Promise<PaymentTransaction>((_, reject) => {
          rejectSign = reject;
        });
        const sign = vi.fn().mockReturnValue(pending);
        Object.assign(authorization['dependencies'].getChain('ergo'), {
          signTransaction: sign,
          isTransactionInSign: vi.fn().mockResolvedValue(false),
        });
        if (scenario.startsWith('orphan')) {
          if (scenario === 'orphan-loss')
            confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
          const work = TransactionProcessor.processInSignTx(
            (await db().getTxById(reward.txId))!,
          );
          if (scenario === 'orphan-loss') await expect(work).rejects.toThrow();
          else await work;
        } else {
          await db().TransactionRepository.update(
            { txId: reward.txId },
            { status: TransactionStatus.approved },
          );
          if (scenario === 'queue-loss')
            confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
          const work = TransactionProcessor.processApprovedTx(
            (await db().getTxById(reward.txId))!,
          );
          if (scenario === 'queue-loss') {
            await expect(work).rejects.toThrow();
            expect(sign).not.toHaveBeenCalled();
          } else {
            await work;
            if (scenario === 'owned-loss')
              confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
            rejectSign(new Error('Synthetic signer failure'));
            await vi.waitFor(() =>
              expect(TransactionProcessor['attempts'].size).toBe(0),
            );
            expect(binding).toHaveBeenCalledOnce();
          }
        }
        const expectedStatus =
          scenario === 'queue-loss'
            ? TransactionStatus.approved
            : scenario.endsWith('loss')
              ? TransactionStatus.inSign
              : TransactionStatus.signFailed;
        expect((await db().getTxById(reward.txId))!.status).toBe(
          expectedStatus,
        );
      },
    );

    /**
     * @target TransactionSigningContext.bind 'pins %s admission through signing and failure'
     * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run 'pins %s admission through signing and failure' with the suite's captured inputs and invoke the bind path.
     * @expected await expect(failure(bound)).resolves.toBe(true); expect(binding).toHaveBeenCalledOnce(); expect(await db().getTxById(reward.txId)).toMatchObject({ status: TransactionStatus.signFailed, failedInSign: true, signFailedCount: 1, });
     */
    it.each([TransactionStatus.approved, TransactionStatus.signFailed])(
      'pins %s admission through signing and failure',
      async (status) => {
        const binding = vi.spyOn(authorization, 'bindExistingReward');
        const bound = await bindPersistence(status);
        await bound.withPersistence('queue', (expected, permit) =>
          db().setTxStatusIfUnchanged(
            expected,
            TransactionStatus.inSign,
            permit,
          ),
        );
        const attempt = context.beginAttempt(bound, 1000, () => true);
        const prepared = await attempt.prepareSigningAuthorization();
        await prepared.withAction('sign', wallet);
        attempt.revoke();
        await expect(failure(bound)).resolves.toBe(true);
        expect(binding).toHaveBeenCalledOnce();
        expect(await db().getTxById(reward.txId)).toMatchObject({
          status: TransactionStatus.signFailed,
          failedInSign: true,
          signFailedCount: 1,
        });
      },
    );
    /**
     * @target TransactionSigningContext.bind 'rejects %s drift after the authority was pinned at admission'
     * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run 'rejects %s drift after the authority was pinned at admission' with the suite's captured inputs and invoke the bind path.
     * @expected await expect(failure(bound)).rejects.toThrow(); expect((await db().getTxById(reward.txId))!.status).toBe( TransactionStatus.inSign, );
     */
    it.each(['payment', 'confirmation', 'fee', 'hold'])(
      'rejects %s drift after the authority was pinned at admission',
      async (fault) => {
        const bound = await bindPersistence(TransactionStatus.approved);
        await bound.withPersistence('queue', (expected, permit) =>
          db().setTxStatusIfUnchanged(
            expected,
            TransactionStatus.inSign,
            permit,
          ),
        );
        if (fault === 'payment')
          await db().TransactionRepository.update(
            { txId: payment.txId },
            { requiredSign: 4 },
          );
        if (fault === 'confirmation')
          confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
        if (fault === 'fee')
          vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
            changed: true,
          } as never);
        if (fault === 'hold') await hold();
        await expect(failure(bound)).rejects.toThrow();
        expect((await db().getTxById(reward.txId))!.status).toBe(
          TransactionStatus.inSign,
        );
      },
    );
    /**
     * @target TransactionSigningContext.bind 'rolls back a written failure when the attempt is %s before commit'
     * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run 'rolls back a written failure when the attempt is %s before commit' with the suite's captured inputs and invoke the bind path.
     * @expected await expect( attempt.withPersistence('failure', (expected, permit) => db().setTxStatusIfUnchanged( expected, TransactionStatus.signFailed, { ...permit, assertAfter: async (manager, row) => { await permit.assertAfter(manager, row); if (fault === 'revoked') attempt.revoke(); if (fault === 'replaced') current = false; if (fault === 'expired') vi.spyOn(performance, 'now').mockReturnValue( Number.MAX_SAFE_INTEGER, ); }, }, ), ), ).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toEqual(before);
     */
    it.each(['revoked', 'expired', 'replaced'])(
      'rolls back a written failure when the attempt is %s before commit',
      async (fault) => {
        const bound = await bindPersistence();
        let current = true;
        const attempt = context.beginAttempt(bound, 1000, () => current);
        const before = await db().getTxById(reward.txId);
        await expect(
          attempt.withPersistence('failure', (expected, permit) =>
            db().setTxStatusIfUnchanged(
              expected,
              TransactionStatus.signFailed,
              {
                ...permit,
                assertAfter: async (manager, row) => {
                  await permit.assertAfter(manager, row);
                  if (fault === 'revoked') attempt.revoke();
                  if (fault === 'replaced') current = false;
                  if (fault === 'expired')
                    vi.spyOn(performance, 'now').mockReturnValue(
                      Number.MAX_SAFE_INTEGER,
                    );
                },
              },
            ),
          ),
        ).rejects.toThrow();
        expect(await db().getTxById(reward.txId)).toEqual(before);
      },
    );
    /**
     * @target TransactionSigningContext.bind 'rolls back AFTER-trigger %s mutations'
     * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run 'rolls back AFTER-trigger %s mutations' with the suite's captured inputs and invoke the bind path.
     * @expected await expect(failure(bound)).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toEqual(before); expect((await db().getTxById(payment.txId))!.requiredSign).toBe(3);
     */
    it.each([
      'status',
      'txJson',
      'lastCheck',
      'signFailedCount',
      'failedInSign',
      'payment',
    ])('rolls back AFTER-trigger %s mutations', async (fault) => {
      const bound = await bindPersistence();
      await bound.prepareSigningAuthorization();
      const before = await db().getTxById(reward.txId);
      const assignments: Record<string, string> = {
        status: "status = 'completed'",
        txJson: "txJson = '{}'",
        lastCheck: 'lastCheck = 999',
        signFailedCount: 'signFailedCount = 99',
        failedInSign: 'failedInSign = 0',
      };
      const target = fault === 'payment' ? payment.txId : reward.txId;
      const assignment =
        fault === 'payment' ? 'requiredSign = 9' : assignments[fault];
      await db().dataSource.query(
        `CREATE TEMP TRIGGER r3b_mutation AFTER UPDATE ON transaction_entity WHEN NEW.txId = '${reward.txId}' BEGIN UPDATE transaction_entity SET ${assignment} WHERE txId = '${target}'; END`,
      );
      try {
        await expect(failure(bound)).rejects.toThrow();
        expect(await db().getTxById(reward.txId)).toEqual(before);
        expect((await db().getTxById(payment.txId))!.requiredSign).toBe(3);
      } finally {
        await db().dataSource.query('DROP TRIGGER r3b_mutation');
      }
    });
    /**
     * @target TransactionSigningContext.bind 'rolls back SQLite %s without partial counters'
     * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run 'rolls back SQLite %s without partial counters' with the suite's captured inputs and invoke the bind path.
     * @expected await expect(failure(bound)).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toEqual(before);
     */
    it.each(['ABORT', 'IGNORE'])(
      'rolls back SQLite %s without partial counters',
      async (mode) => {
        const bound = await bindPersistence();
        const before = await db().getTxById(reward.txId);
        const raise = mode === 'IGNORE' ? 'IGNORE' : "ABORT, 'blocked'";
        await db().dataSource.query(
          `CREATE TEMP TRIGGER r3b_failure BEFORE UPDATE ON transaction_entity BEGIN SELECT RAISE(${raise}); END`,
        );
        try {
          await expect(failure(bound)).rejects.toThrow();
          expect(await db().getTxById(reward.txId)).toEqual(before);
        } finally {
          await db().dataSource.query('DROP TRIGGER r3b_failure');
        }
      },
    );
    /**
     * @target TransactionSigningContext.bind 'rechecks payment authority after waiting for a foreign SQL owner'
     * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
     * @scenario Run 'rechecks payment authority after waiting for a foreign SQL owner' with the suite's captured inputs and invoke the bind path.
     * @expected await expect( bound.withPersistence('failure', async (expected, permit) => { const owner = db().dataSource.transaction(async (manager) => { await manager.query( 'UPDATE transaction_entity SET requiredSign = 4 WHERE txId = ?', [payment.txId], ); entered(); await wait; }); await ready; const write = db().setTxStatusIfUnchanged( expected, TransactionStatus.signFailed, permit, ); release(); await owner; return write; }), ).rejects.toThrow(); expect((await db().getTxById(reward.txId))!.status).toBe( TransactionStatus.inSign, ); expect((await db().getTxById(payment.txId))!.requiredSign).toBe(4);
     */
    it('rechecks payment authority after waiting for a foreign SQL owner', async () => {
      const bound = await bindPersistence();
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      await expect(
        bound.withPersistence('failure', async (expected, permit) => {
          const owner = db().dataSource.transaction(async (manager) => {
            await manager.query(
              'UPDATE transaction_entity SET requiredSign = 4 WHERE txId = ?',
              [payment.txId],
            );
            entered();
            await wait;
          });
          await ready;
          const write = db().setTxStatusIfUnchanged(
            expected,
            TransactionStatus.signFailed,
            permit,
          );
          release();
          await owner;
          return write;
        }),
      ).rejects.toThrow();
      expect((await db().getTxById(reward.txId))!.status).toBe(
        TransactionStatus.inSign,
      );
      expect((await db().getTxById(payment.txId))!.requiredSign).toBe(4);
    });
  });

  const prepare = async (timeout = 1000, isCurrent = () => true) => {
    const row = (await db().getTxById(reward.txId))!;
    const bound = await context.bind(row, [TransactionStatus.inSign]);
    const attempt = context.beginAttempt(bound, timeout, isCurrent);
    const policy = await context.run(attempt, () =>
      createErgoSigningAuthorization({
        context,
        ergo: { timeoutMs: timeout, maxPending: 4 },
      }).bind({
        txId: reward.txId,
        reducedTxBytes: Buffer.from(reward.txBytes).toString('hex'),
        inputBoxBytes: reward.inputBoxes.map((b) =>
          Buffer.from(b).toString('hex'),
        ),
        dataInputBoxBytes: reward.dataInputs.map((b) =>
          Buffer.from(b).toString('hex'),
        ),
        requiredSign: 3,
        publicKey: 'local',
        guardPublicKeys: ['local', 'peer'],
      }),
    );
    return { policy, attempt };
  };
  /**
   * @target TransactionSigningContext.bind 'gates the actual %s callback through SQLite and the dedicated scanner'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'gates the actual %s callback through SQLite and the dedicated scanner' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction(phase, wallet)).resolves.toBe('signed'); expect(wallet).toHaveBeenCalledOnce(); await expect(policy.withAction(phase, wallet)).rejects.toThrow(); expect(wallet).toHaveBeenCalledOnce();
   */
  it.each([
    'queue',
    'commitment',
    'sign',
    'outbound',
    'result',
  ] as SigningPhase[])(
    'gates the actual %s callback through SQLite and the dedicated scanner',
    async (phase) => {
      const { policy } = await prepare();
      await expect(policy.withAction(phase, wallet)).resolves.toBe('signed');
      expect(wallet).toHaveBeenCalledOnce();
      await hold();
      await expect(policy.withAction(phase, wallet)).rejects.toThrow();
      expect(wallet).toHaveBeenCalledOnce();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'does not sign when the completed payment loses confirmation after preparation'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not sign when the completed payment loses confirmation after preparation' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it('does not sign when the completed payment loses confirmation after preparation', async () => {
    const { policy } = await prepare();
    confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
    await expect(policy.withAction('sign', wallet)).rejects.toThrow();
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'requires exact source observation for Avalanche to %s reward signing'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'requires exact source observation for Avalanche to %s reward signing' with the suite's captured inputs and invoke the bind path.
   * @expected expect(observed).toHaveBeenCalled(); expect(wallet).toHaveBeenCalledOnce(); await expect(policy.withAction('outbound', wallet)).rejects.toThrow(); expect(wallet).toHaveBeenCalledOnce();
   */
  it.each(['ethereum', 'avalanche'])(
    'requires exact source observation for Avalanche to %s reward signing',
    async (destination) => {
      await db().EventRepository.update(
        { eventId },
        {
          fromChain: 'avalanche',
          toChain: destination,
          extractor: 'avalancheEventTrigger',
        },
      );
      if (destination === 'ethereum') {
        const signed = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        signed.chainId = 1n;
        signed.signature = new SigningKey('0x' + '01'.repeat(32)).sign(
          signed.unsignedHash,
        );
        const next = new PaymentTransaction(
          destination,
          signed.unsignedHash,
          eventId,
          Buffer.from(signed.serialized.slice(2), 'hex'),
          TransactionType.payment,
        );
        await db().TransactionRepository.update(
          { txId: payment.txId },
          {
            txId: next.txId,
            chain: destination,
            txJson: next.toJson(),
          },
        );
        payment = next;
        vi.mocked(
          authorization['dependencies'].getChain(destination).getActualTxId,
        ).mockResolvedValue(signed.hash!);
      }
      const observed = vi.spyOn(scanner, 'withObservation');
      const { policy } = await prepare();
      await policy.withAction('sign', wallet);
      expect(observed).toHaveBeenCalled();
      expect(wallet).toHaveBeenCalledOnce();
      await db().EventRepository.update(
        { eventId },
        { sourceBlockId: hash(999) },
      );
      await expect(policy.withAction('outbound', wallet)).rejects.toThrow();
      expect(wallet).toHaveBeenCalledOnce();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'production runtime injects the lazy reward binder before signer callbacks'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'production runtime injects the lazy reward binder before signer callbacks' with the suite's captured inputs and invoke the bind path.
   * @expected expect(binding).toHaveBeenCalledOnce(); expect(wallet).toHaveBeenCalledOnce();
   */
  it('production runtime injects the lazy reward binder before signer callbacks', async () => {
    const original = context;
    context = createGuardSigningRuntime({
      getEvent: (id) => db().getEventById(id),
      getTx: (id) => db().getTxById(id),
      decode: original['dependencies'].decode,
      getScanner: () => scanner,
      curveTimeoutSeconds: 1,
      edwardTimeoutSeconds: 1,
      ergoTimeoutSeconds: 1,
      maxPending: 4,
    }).context;
    const binding = vi.spyOn(authorization, 'bindExistingReward');
    const { policy } = await prepare();
    await policy.withAction('sign', wallet);
    expect(binding).toHaveBeenCalledOnce();
    expect(wallet).toHaveBeenCalledOnce();
  });
  /**
   * @target TransactionSigningContext.bind 'a preexisting hold denies preparation before a signer receives authority'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'a preexisting hold denies preparation before a signer receives authority' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(prepare()).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it('a preexisting hold denies preparation before a signer receives authority', async () => {
    await hold();
    await expect(prepare()).rejects.toThrow();
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects payment %s drift'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects payment %s drift' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it.each(['txJson', 'requiredSign', 'status', 'chain'])(
    'rejects payment %s drift',
    async (field) => {
      const { policy } = await prepare();
      const patch = {
        txJson: '{}',
        requiredSign: 4,
        status: TransactionStatus.sent,
        chain: 'ethereum',
      };
      await db().TransactionRepository.update(
        { txId: payment.txId },
        { [field]: patch[field as keyof typeof patch] },
      );
      await expect(policy.withAction('sign', wallet)).rejects.toThrow();
      expect(wallet).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects trigger %s drift'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects trigger %s drift' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it.each(['serialized', 'spendTxId', 'spendBlock', 'paymentTxId', 'result'])(
    'rejects trigger %s drift',
    async (field) => {
      const { policy } = await prepare();
      await db().EventRepository.update({ eventId }, { [field]: 'changed' });
      await expect(policy.withAction('sign', wallet)).rejects.toThrow();
      expect(wallet).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects reward status %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects reward status %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it.each(['approved', 'signed', 'sent', 'completed', 'invalid'])(
    'rejects reward status %s',
    async (status) => {
      const { policy } = await prepare();
      await db().TransactionRepository.update(
        { txId: reward.txId },
        { status },
      );
      await expect(policy.withAction('sign', wallet)).rejects.toThrow();
      expect(wallet).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects event phase %s'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects event phase %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('outbound', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it.each(['pending-reward', 'completed'])(
    'rejects event phase %s',
    async (status) => {
      const { policy } = await prepare();
      await db().ConfirmedEventRepository.update({ id: eventId }, { status });
      await expect(policy.withAction('outbound', wallet)).rejects.toThrow();
      expect(wallet).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects current fee-policy drift after awaited order work'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects current fee-policy drift after awaited order work' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it('rejects current fee-policy drift after awaited order work', async () => {
    const { policy } = await prepare();
    vi.mocked(EventOrder.createEventRewardOrder).mockImplementation(
      async () => {
        vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
          changed: true,
        } as never);
        return [];
      },
    );
    await expect(policy.withAction('sign', wallet)).rejects.toThrow();
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects WID drift after receipt lookup'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects WID drift after receipt lookup' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('result', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it('rejects WID drift after receipt lookup', async () => {
    const { policy } = await prepare();
    confirmation.mockImplementation(async () => {
      await db().CommitmentRepository.update(
        { eventId },
        { WID: 'bb'.repeat(32) },
      );
      return ConfirmationStatus.ConfirmedEnough;
    });
    await expect(policy.withAction('result', wallet)).rejects.toThrow();
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects order mismatch before returning signer authorization'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects order mismatch before returning signer authorization' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(prepare()).rejects.toThrow('order'); expect(wallet).not.toHaveBeenCalled();
   */
  it('rejects order mismatch before returning signer authorization', async () => {
    vi.mocked(EventOrder.createEventRewardOrder).mockResolvedValue([
      { address: 'other' },
    ] as never);
    await expect(prepare()).rejects.toThrow('order');
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects malformed current reward model before any wallet action'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects malformed current reward model before any wallet action' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(prepare()).rejects.toThrow('inconsistent'); expect(wallet).not.toHaveBeenCalled();
   */
  it('rejects malformed current reward model before any wallet action', async () => {
    vi.mocked(TransactionVerifier.verifyTxCommonConditions).mockResolvedValue(
      false,
    );
    await expect(prepare()).rejects.toThrow('inconsistent');
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'requires the injected binder for reward signing'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'requires the injected binder for reward signing' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(prepare()).rejects.toThrow('unavailable'); expect(wallet).not.toHaveBeenCalled();
   */
  it('requires the injected binder for reward signing', async () => {
    context['dependencies'].bindReward = undefined;
    await expect(prepare()).rejects.toThrow('unavailable');
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects revocation during fresh confirmation lookup'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects revocation during fresh confirmation lookup' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow('revoked'); expect(wallet).not.toHaveBeenCalled();
   */
  it('rejects revocation during fresh confirmation lookup', async () => {
    const { policy, attempt } = await prepare();
    confirmation.mockImplementation(async () => {
      attempt.revoke();
      return ConfirmationStatus.ConfirmedEnough;
    });
    await expect(policy.withAction('sign', wallet)).rejects.toThrow('revoked');
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects expiry during fresh confirmation lookup'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects expiry during fresh confirmation lookup' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow('expired'); expect(wallet).not.toHaveBeenCalled();
   */
  it('rejects expiry during fresh confirmation lookup', async () => {
    const { policy } = await prepare(100);
    confirmation.mockImplementation(async () => {
      await delay(120);
      return ConfirmationStatus.ConfirmedEnough;
    });
    await expect(policy.withAction('sign', wallet)).rejects.toThrow('expired');
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects a caller attempting an unknown signing phase'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects a caller attempting an unknown signing phase' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( policy.withAction('other' as SigningPhase, wallet), ).rejects.toThrow('phase'); expect(wallet).not.toHaveBeenCalled();
   */
  it('rejects a caller attempting an unknown signing phase', async () => {
    const { policy } = await prepare();
    await expect(
      policy.withAction('other' as SigningPhase, wallet),
    ).rejects.toThrow('phase');
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects a downgraded route using %s evidence'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects a downgraded route using %s evidence' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(prepare()).rejects.toThrow('route changed'); expect(wallet).not.toHaveBeenCalled();
   */
  it.each(['extractor', 'payment', 'known'])(
    'rejects a downgraded route using %s evidence',
    async (evidence) => {
      if (evidence === 'known') {
        const event = (await db().getEventById(eventId))!;
        await authorization.bindForAgreement(
          EventSerializer.fromConfirmedEntity(event),
          event.eventData.txId,
        );
      }
      if (evidence !== 'payment')
        await db().TransactionRepository.update(
          { txId: payment.txId },
          { chain: 'ethereum' },
        );
      await db().EventRepository.update(
        { eventId },
        {
          toChain: 'ethereum',
          ...(evidence === 'extractor'
            ? { extractor: 'avalancheEventTrigger' }
            : {}),
        },
      );
      await expect(prepare()).rejects.toThrow('route changed');
      expect(wallet).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'keeps a genuinely unrelated reward on its existing signing path'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps a genuinely unrelated reward on its existing signing path' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).resolves.toBe('signed'); expect(wallet).toHaveBeenCalledOnce();
   */
  it('keeps a genuinely unrelated reward on its existing signing path', async () => {
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { chain: 'ethereum' },
    );
    await db().EventRepository.update({ eventId }, { toChain: 'ethereum' });
    const { policy } = await prepare();
    await expect(policy.withAction('sign', wallet)).resolves.toBe('signed');
    expect(wallet).toHaveBeenCalledOnce();
  });
  /**
   * @target TransactionSigningContext.bind 'new durable evidence cannot reuse a previously legacy signing authorization'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'new durable evidence cannot reuse a previously legacy signing authorization' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow( 'route changed', ); expect(wallet).not.toHaveBeenCalled();
   */
  it('new durable evidence cannot reuse a previously legacy signing authorization', async () => {
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { chain: 'ethereum' },
    );
    await db().EventRepository.update({ eventId }, { toChain: 'ethereum' });
    const { policy } = await prepare();
    await db().EventRepository.update(
      { eventId },
      { extractor: 'avalancheEventTrigger' },
    );
    await expect(policy.withAction('sign', wallet)).rejects.toThrow(
      'route changed',
    );
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects exact reward row %s drift'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects exact reward row %s drift' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(policy.withAction('sign', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it.each(['requiredSign', 'txJson', 'chain', 'order'])(
    'rejects exact reward row %s drift',
    async (field) => {
      const { policy } = await prepare();
      const patch = {
        requiredSign: 9,
        txJson: '{}',
        chain: 'ethereum',
        order: { id: 'foreign' },
      };
      if (field === 'order') {
        await db().dataSource.query('PRAGMA foreign_keys = OFF');
        await db().dataSource.query(
          "UPDATE transaction_entity SET orderId='foreign' WHERE txId=?",
          [reward.txId],
        );
        await db().dataSource.query('PRAGMA foreign_keys = ON');
      } else
        await db().TransactionRepository.update({ txId: reward.txId }, {
          [field]: patch[field as keyof typeof patch],
        } as never);
      await expect(policy.withAction('sign', wallet)).rejects.toThrow();
      expect(wallet).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'does not adopt a fresh settlement authority when preparing the same attempt again'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not adopt a fresh settlement authority when preparing the same attempt again' with the suite's captured inputs and invoke the bind path.
   * @expected expect(second.bindingId).toBe(first.bindingId); await expect(second.withAction('sign', wallet)).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it('does not adopt a fresh settlement authority when preparing the same attempt again', async () => {
    const { attempt } = await prepare();
    const first = await attempt.prepareSigningAuthorization();
    await db().ConfirmedEventRepository.update(
      { id: eventId },
      { unexpectedFails: 1 },
    );
    const second = await attempt.prepareSigningAuthorization();
    expect(second.bindingId).toBe(first.bindingId);
    await expect(second.withAction('sign', wallet)).rejects.toThrow();
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'different attempts have distinct immutable signing identities'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'different attempts have distinct immutable signing identities' with the suite's captured inputs and invoke the bind path.
   * @expected expect( (await first.attempt.prepareSigningAuthorization()).bindingId, ).not.toBe((await second.attempt.prepareSigningAuthorization()).bindingId);
   */
  it('different attempts have distinct immutable signing identities', async () => {
    const first = await prepare();
    const second = await prepare();
    expect(
      (await first.attempt.prepareSigningAuthorization()).bindingId,
    ).not.toBe((await second.attempt.prepareSigningAuthorization()).bindingId);
  });
  /**
   * @target TransactionSigningContext.bind 'a captured old callback cannot authorize its replacement attempt'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'a captured old callback cannot authorize its replacement attempt' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(stale('sign', wallet)).rejects.toThrow('replaced'); expect(wallet).not.toHaveBeenCalled(); await expect(second.policy.withAction('sign', wallet)).resolves.toBe( 'signed', ); expect(wallet).toHaveBeenCalledOnce();
   */
  it('a captured old callback cannot authorize its replacement attempt', async () => {
    let owner = 1;
    const first = await prepare(1000, () => owner === 1);
    const stale = first.policy.withAction;
    owner = 2;
    const second = await prepare(1000, () => owner === 2);
    await expect(stale('sign', wallet)).rejects.toThrow('replaced');
    expect(wallet).not.toHaveBeenCalled();
    await expect(second.policy.withAction('sign', wallet)).resolves.toBe(
      'signed',
    );
    expect(wallet).toHaveBeenCalledOnce();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects an orphan SQL orderId on the %s authority row'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects an orphan SQL orderId on the %s authority row' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(dispatch()).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it.each(['completed payment', 'agreement reward'])(
    'rejects an orphan SQL orderId on the %s authority row',
    async (kind) => {
      let dispatch: () => Promise<unknown>;
      if (kind === 'agreement reward') {
        await db().TransactionRepository.update(
          { txId: reward.txId },
          { status: TransactionStatus.approved },
        );
        const admission = (await AvalancheRewardAdmission.bind(
          reward,
          3,
          () => undefined,
        ))!;
        dispatch = () => admission.withAction(wallet);
      } else {
        const { policy } = await prepare();
        dispatch = () => policy.withAction('sign', wallet);
      }
      await db().dataSource.query('PRAGMA foreign_keys = OFF');
      await db().dataSource.query(
        "UPDATE transaction_entity SET orderId='absent-order' WHERE txId=?",
        [kind === 'agreement reward' ? reward.txId : payment.txId],
      );
      await db().dataSource.query('PRAGMA foreign_keys = ON');
      await expect(dispatch()).rejects.toThrow();
      expect(wallet).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'sees authority changes committed by the preceding SQL owner'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'sees authority changes committed by the preceding SQL owner' with the suite's captured inputs and invoke the bind path.
   * @expected expect(wallet).not.toHaveBeenCalled(); await expect(action).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it('sees authority changes committed by the preceding SQL owner', async () => {
    const { policy } = await prepare(5000);
    const runner = db().dataSource.createQueryRunner();
    let notify!: () => void;
    const acquired = new Promise<void>((resolve) => {
      notify = resolve;
    });
    confirmation.mockImplementation(async () => {
      await runner.startTransaction();
      notify();
      return ConfirmationStatus.ConfirmedEnough;
    });
    const action = policy.withAction('sign', wallet);
    await acquired;
    await delay(15);
    expect(wallet).not.toHaveBeenCalled();
    await runner.manager
      .getRepository(db().ConfirmedEventRepository.target)
      .update({ id: eventId }, { unexpectedFails: 1 });
    await runner.commitTransaction();
    await runner.release();
    await expect(action).rejects.toThrow();
    expect(wallet).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects %s while queued behind an unchanged SQL owner'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s while queued behind an unchanged SQL owner' with the suite's captured inputs and invoke the bind path.
   * @expected await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce()); expect(wallet).not.toHaveBeenCalled(); expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch( /expired, revoked or replaced/, ); expect(wallet).not.toHaveBeenCalled(); await expect(next.policy.withAction('sign', wallet)).resolves.toBe( 'signed', ); expect(wallet).toHaveBeenCalledOnce();
   */
  it.each(['revocation', 'expiry'])(
    'rejects %s while queued behind an unchanged SQL owner',
    async (failure) => {
      let now = 100;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const { policy, attempt } = await prepare(5000);
      const runner = db().dataSource.createQueryRunner();
      let notify!: () => void;
      const acquired = new Promise<void>((resolve) => {
        notify = resolve;
      });
      confirmation.mockImplementation(async () => {
        await runner.startTransaction();
        notify();
        return ConfirmationStatus.ConfirmedEnough;
      });
      const entered = vi.spyOn(db().dataSource, 'transaction');
      const action = policy.withAction('sign', wallet);
      const outcome = action.catch((error: unknown) => error);
      try {
        await acquired;
        await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
        expect(wallet).not.toHaveBeenCalled();
        if (failure === 'revocation') attempt.revoke();
        else now += 5001;
        await runner.commitTransaction();
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /expired, revoked or replaced/,
        );
        expect(wallet).not.toHaveBeenCalled();
        // The database authority remains valid: a new attempt may still sign.
        confirmation.mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
        const next = await prepare();
        await expect(next.policy.withAction('sign', wallet)).resolves.toBe(
          'signed',
        );
        expect(wallet).toHaveBeenCalledOnce();
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    },
  );
  /**
   * @target TransactionSigningContext.bind 'holds scanner exclusion only through the qualified synchronous action'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'holds scanner exclusion only through the qualified synchronous action' with the suite's captured inputs and invoke the bind path.
   * @expected expect(await update).toEqual( new Error('Avalanche scanner operation already running'), ); await expect(scanner.update()).resolves.toBeUndefined(); expect(wallet).toHaveBeenCalledOnce();
   */
  it('holds scanner exclusion only through the qualified synchronous action', async () => {
    const { policy } = await prepare();
    let update: Promise<unknown> | undefined;
    await policy.withAction('sign', () => {
      update = scanner.update().catch((error: unknown) => error);
      wallet();
    });
    expect(await update).toEqual(
      new Error('Avalanche scanner operation already running'),
    );
    await expect(scanner.update()).resolves.toBeUndefined();
    expect(wallet).toHaveBeenCalledOnce();
  });
  /**
   * @target TransactionSigningContext.bind 'releases SQL and scanner ownership after a wallet failure'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'releases SQL and scanner ownership after a wallet failure' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( policy.withAction('sign', () => { throw new Error('wallet failed'); }), ).rejects.toThrow('wallet failed'); await expect(scanner.update()).resolves.toBeUndefined(); await expect(db().dataSource.query('SELECT 1')).resolves.toHaveLength(1);
   */
  it('releases SQL and scanner ownership after a wallet failure', async () => {
    const { policy } = await prepare();
    await expect(
      policy.withAction('sign', () => {
        throw new Error('wallet failed');
      }),
    ).rejects.toThrow('wallet failed');
    await expect(scanner.update()).resolves.toBeUndefined();
    await expect(db().dataSource.query('SELECT 1')).resolves.toHaveLength(1);
  });
  /**
   * @target TransactionSigningContext.bind 'uses the real Ergo codec for isolated %s model consistency'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'uses the real Ergo codec for isolated %s model consistency' with the suite's captured inputs and invoke the bind path.
   * @expected expect(permit).toBeDefined(); expect(result).toBe(true); expect(await db().getTxById(reward.txId)).toMatchObject({ status: TransactionStatus.signed, txJson: signed.toJson(), }); await expect(persist()).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toEqual(before); await expect(policy.withAction('sign', wallet)).resolves.toBe('signed'); expect(wallet).toHaveBeenCalledOnce(); await expect(prepare()).rejects.toThrow(); expect(wallet).not.toHaveBeenCalled();
   */
  it.each([
    'none',
    'txId',
    'txBytes',
    'inputBoxes',
    'dataInputs',
    'signed',
    'signedUnsigned',
    'signedBytes',
    'signedInput',
    'signedId',
    'signedLostPayment',
    'signedAfterWriteRevoked',
    'signedAfterWriteCorrupt',
  ])(
    'uses the real Ergo codec for isolated %s model consistency',
    async (mutation) => {
      const oldId = reward.txId;
      reward = ErgoTransaction.fromJson(JSON.stringify(ergoFixture.payment));
      reward.eventId = eventId;
      reward.txType = TransactionType.reward;
      const tokens = new TokenMap();
      await tokens.updateConfigByJson([]);
      const chain = new ErgoChain(
        {} as AbstractErgoNetwork,
        {
          fee: 1100000n,
          confirmations: {
            observation: 5,
            payment: 9,
            cold: 10,
            manual: 11,
            arbitrary: 12,
          },
          addresses: {
            lock: ergoFixture.lock,
            cold: 'unused',
            permit: 'unused',
            fraud: 'unused',
          },
          rwtId:
            '9410db5b39388c6b515160e7248346d7ec63d5457292326da12a26cc02efb526',
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        },
        tokens,
        {
          isInSign: vi.fn().mockResolvedValue(false),
          sign: vi
            .fn()
            .mockRejectedValue(new Error('No signing in codec fixture')),
        },
      );
      const target = authorization['dependencies'].getChain('avalanche');
      authorization['dependencies'].getChain = (network) =>
        network === 'ergo'
          ? (chain as unknown as AbstractChain<unknown>)
          : target;
      vi.mocked(
        TransactionVerifier.verifyTxCommonConditions,
      ).mockImplementation((tx) => chain.verifyPaymentTransaction(tx));
      vi.mocked(EventOrder.createEventRewardOrder).mockResolvedValue(
        chain.extractTransactionOrder(reward),
      );
      if (mutation === 'txId') reward.txId = '00'.repeat(32);
      if (mutation === 'txBytes') reward.txBytes = Buffer.from('abcd', 'hex');
      if (mutation === 'inputBoxes')
        reward.inputBoxes[0] = Buffer.from('abcd', 'hex');
      if (mutation === 'dataInputs')
        reward.dataInputs.push(reward.inputBoxes[0]);
      await db().TransactionRepository.delete({ txId: oldId });
      await DatabaseActionMock.insertTxRecord(
        reward,
        TransactionStatus.inSign,
        123,
        'updated',
        false,
        0,
        3,
      );
      if (mutation.startsWith('signed')) {
        const { attempt } = await prepare();
        const signed = ErgoTransaction.fromJson(reward.toJson());
        const unsigned = wasm.ReducedTransaction.sigma_parse_bytes(
          reward.txBytes,
        ).unsigned_tx();
        signed.txBytes = wasm.Transaction.from_unsigned_tx(
          unsigned,
          Array.from(
            { length: unsigned.inputs().len() },
            () => new Uint8Array(),
          ),
        ).sigma_serialize_bytes();
        if (mutation === 'signedUnsigned') signed.txBytes = reward.txBytes;
        if (mutation === 'signedBytes')
          signed.txBytes = Buffer.from('abcd', 'hex');
        if (mutation === 'signedInput')
          signed.inputBoxes[0] = Buffer.from('abcd', 'hex');
        if (mutation === 'signedId') signed.txId = '00'.repeat(32);
        if (mutation === 'signedLostPayment')
          confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
        const before = await db().getTxById(reward.txId);
        const persist = () =>
          context.persistResult(
            attempt,
            signed,
            async (json, expected, permit) => {
              expect(permit).toBeDefined();
              const result = await db().updateWithSignedTxIfUnchanged(
                expected,
                json,
                {
                  ...permit!,
                  assertAfter: async (manager, row) => {
                    await permit!.assertAfter(manager, row);
                    if (mutation === 'signedAfterWriteRevoked')
                      attempt.revoke();
                    if (mutation === 'signedAfterWriteCorrupt')
                      await manager.query(
                        'UPDATE transaction_entity SET txJson = ? WHERE txId = ?',
                        ['{}', reward.txId],
                      );
                  },
                },
              );
              expect(result).toBe(true);
            },
          );
        if (mutation === 'signed') {
          await persist();
          expect(await db().getTxById(reward.txId)).toMatchObject({
            status: TransactionStatus.signed,
            txJson: signed.toJson(),
          });
        } else {
          await expect(persist()).rejects.toThrow();
          expect(await db().getTxById(reward.txId)).toEqual(before);
        }
      } else if (mutation === 'none') {
        const { policy } = await prepare();
        await expect(policy.withAction('sign', wallet)).resolves.toBe('signed');
        expect(wallet).toHaveBeenCalledOnce();
      } else {
        await expect(prepare()).rejects.toThrow();
        expect(wallet).not.toHaveBeenCalled();
      }
    },
  );
});
