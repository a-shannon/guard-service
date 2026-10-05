/* eslint vitest/expect-expect: ["error", {"assertFunctionNames": ["expect", "unchanged"]}] */
import * as wasm from 'ergo-lib-wasm-nodejs';
import { Transaction } from 'ethers';

import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  ConfirmationStatus,
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import {
  AbstractErgoNetwork,
  ErgoChain,
  ErgoTransaction,
} from '@rosen-chains/ergo';

import { DatabaseAction } from '../../src/db/databaseAction';
import { dataSource as configuredSource } from '../../src/db/dataSource';
import EventBoxes from '../../src/event/eventBoxes';
import EventOrder from '../../src/event/eventOrder';
import ChainHandler from '../../src/handlers/chainHandler';
import GuardPkHandler from '../../src/handlers/guardPkHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import ergoFixture, { eventId } from './avalancheSynchronizationTestData';
import {
  blockHash,
  TestDatabase as FixtureDatabase,
  TestSynchronization as FixtureSynchronization,
} from './avalancheSynchronizationTestUtils';

describe('EventSynchronization', () => {
  describe('synchronization scanner and atomic persistence join', () => {
    let source: DataSource;
    let db: FixtureDatabase;
    let network: AvalancheRpcNetwork;
    let scanner: AvalancheRpcScanner | undefined;
    let sync: FixtureSynchronization;
    let payment: PaymentTransaction;
    let actualId: string;
    let guards: ReturnType<typeof GuardPkHandler.getInstance>;
    const confirmation = vi.fn<() => Promise<ConfirmationStatus>>();
    const height = vi.fn<() => Promise<number>>();
    const event = async () => (await db.getEventById(eventId))!;
    const hold = () =>
      source
        .getRepository(AvalancheSafetyState)
        .update({ scanner: 'avalanche' }, { holdReason: 'fixture hold' });
    const unchanged = async () => {
      expect(await db.TransactionRepository.count()).toBe(0);
      expect((await event()).status).toBe(EventStatus.pendingPayment);
      expect(sync.active()).toBe(true);
    };
    const destination = async () => {
      await db.EventRepository.update(
        { eventId },
        { fromChain: 'ergo', toChain: 'avalanche' },
      );
      const signed = Transaction.from({
        type: 2,
        chainId: 43113n,
        nonce: 1,
        gasLimit: 25000n,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 1n,
        to: '0x' + '12'.repeat(20),
        value: 5n,
        data: '0x' + eventId,
        signature: {
          r: '0x' + '01'.repeat(32),
          s: '0x' + '02'.repeat(32),
          v: 27,
        },
      });
      payment = new PaymentTransaction(
        'avalanche',
        signed.unsignedHash,
        eventId,
        Buffer.from(signed.serialized.slice(2), 'hex'),
        TransactionType.payment,
      );
      actualId = signed.hash!;
    };
    const realErgo = async () => {
      const parsed = ErgoTransaction.fromJson(
        JSON.stringify(ergoFixture.payment),
      );
      const unsigned = wasm.ReducedTransaction.sigma_parse_bytes(
        parsed.txBytes,
      ).unsigned_tx();
      // Exercise the actual signed codec and boxes; RPC finality remains synthetic.
      parsed.txBytes = wasm.Transaction.from_unsigned_tx(
        unsigned,
        Array.from({ length: unsigned.inputs().len() }, () => new Uint8Array()),
      ).sigma_serialize_bytes();
      parsed.eventId = eventId;
      parsed.txType = TransactionType.payment;
      payment = parsed;
      actualId = parsed.txId;
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
            .mockRejectedValue(
              new Error('Signing is not part of this fixture'),
            ),
        },
      );
      vi.spyOn(chain, 'getTxConfirmationStatus').mockImplementation(
        confirmation,
      );
      vi.spyOn(chain, 'getHeight').mockImplementation(height);
      vi.mocked(ChainHandler.getInstance).mockReturnValue({
        getChain: () => chain,
      } as unknown as ChainHandler);
      vi.mocked(EventOrder.createEventPaymentOrder).mockResolvedValue(
        ergoFixture.order.map((entry) => ({
          ...entry,
          assets: {
            nativeToken: BigInt(entry.assets.nativeToken.integer),
            tokens: entry.assets.tokens.map((token) => ({
              id: token.id,
              value: BigInt(token.value.integer),
            })),
          },
        })),
      );
      return chain;
    };

    beforeEach(async () => {
      if (configuredSource.options.type !== 'sqlite')
        throw new Error('SQLite configuration required');
      source = await new DataSource({
        ...configuredSource.options,
        type: 'sqlite',
        database: ':memory:',
      }).initialize();
      await source.runMigrations();
      db = new FixtureDatabase(source);
      vi.spyOn(DatabaseAction, 'getInstance').mockReturnValue(db);
      vi.spyOn(
        PublicStatusHandler.getInstance(),
        'updatePublicTxStatus',
      ).mockResolvedValue(undefined);
      vi.spyOn(
        PublicStatusHandler.getInstance(),
        'updatePublicEventStatus',
      ).mockResolvedValue(undefined);
      network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
      vi.spyOn(network, 'getCurrentHeight').mockResolvedValue(2);
      vi.spyOn(network, 'getBlockAtHeight').mockImplementation(
        async (number) => ({
          hash: blockHash(number),
          height: number,
          parentHash: blockHash(number - 1),
          timestamp: 100 + number,
          txCount: 0,
        }),
      );
      vi.spyOn(network, 'getBlockTxs').mockResolvedValue([]);
      scanner = new AvalancheRpcScanner({
        network,
        dataSource: source,
        sourceId: 'synchronization-source',
        initialHeight: 0,
        blockCleanupConfig: {
          blockCleanupThresholdDuration: 86400,
          blockTrimCountInRound: 0,
        },
      });
      await scanner.update();
      await db.EventRepository.insert({
        height: 4,
        fromChain: 'avalanche',
        toChain: 'ergo',
        fromAddress: 'source',
        toAddress: 'target',
        amount: '10',
        bridgeFee: '1',
        networkFee: '1',
        sourceChainTokenId: 'avax',
        targetChainTokenId: 'wrapped',
        sourceTxId: 'synchronization-source',
        sourceChainHeight: 1,
        sourceBlockId: blockHash(1),
        WIDsHash: 'wids',
        WIDsCount: 1,
        extractor: 'fixture',
        identifier: 'fixture',
        serialized: 'fixture',
        block: 'fixture',
        txId: 'creation',
        eventId,
      });
      const eventData = await db.EventRepository.findOneByOrFail({ eventId });
      await db.ConfirmedEventRepository.insert({
        id: eventId,
        eventData,
        status: EventStatus.pendingPayment,
      });
      payment = new ErgoTransaction(
        'synchronization-payment',
        eventId,
        Buffer.from('cdef', 'hex'),
        TransactionType.payment,
        [Buffer.from('aa', 'hex')],
        [Buffer.from('bb', 'hex')],
      );
      actualId = payment.txId;
      confirmation
        .mockReset()
        .mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
      height.mockReset().mockResolvedValue(2);
      vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
        getChain: () => ({
          verifyPaymentTransaction: vi.fn().mockResolvedValue(true),
          extractTransactionOrder: () => [],
          verifyTransactionExtraConditions: () => true,
          getTxConfirmationStatus: confirmation,
          getHeight: height,
        }),
      } as unknown as ChainHandler);
      vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue(
        {} as never,
      );
      vi.spyOn(EventOrder, 'createEventPaymentOrder').mockResolvedValue([]);
      vi.spyOn(EventBoxes, 'getEventWIDs').mockResolvedValue(['fixture-wid']);
      guards = {
        ...GuardPkHandler.getInstance(),
        publicKeys: [...GuardPkHandler.getInstance().publicKeys],
      };
      vi.spyOn(GuardPkHandler, 'getInstance').mockReturnValue(guards);
      sync = new FixtureSynchronization(
        new AvalancheTransactionSafety(db.getEventById, () => scanner),
      );
      sync.activate();
    });
    afterEach(async () => {
      network['provider'].destroy();
      await source.destroy();
      vi.restoreAllMocks();
    });
    for (const direction of ['source', 'destination']) {
      describe(`direction ${direction}`, () => {
        describe('setTxAsApproved', () => {
          /**
           * @target EventSynchronization.setTxAsApproved `records qualified ${direction} payment and matching event in one action`
           * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
           * @scenario Exercise `records qualified ${direction} payment and matching event in one action` through setTxAsApproved with the current scanner and persistence state.
           * @expected expect(bound).toHaveBeenCalledOnce(); expect(tx?.txJson).toBe(payment.toJson()); expect(tx?.status).toBe(TransactionStatus.completed); expect(tx?.requiredSign).toBe(guards.requiredSign); expect((await event()).status).toBe( direction === 'source' ? EventStatus.completed : EventStatus.pendingReward, ); expect(sync.active()).toBe(false); expect(confirmation).toHaveBeenCalledWith( actualId, TransactionType.payment, );
           */
          it(`records qualified ${direction} payment and matching event in one action`, async () => {
            if (direction === 'destination') await destination();
            const bound = vi.spyOn(
              scanner!,
              direction === 'source' ? 'withObservation' : 'withSafety',
            );
            await sync.approve(payment, actualId);
            expect(bound).toHaveBeenCalledOnce();
            const tx = await db.getTxById(payment.txId);
            expect(tx?.txJson).toBe(payment.toJson());
            expect(tx?.status).toBe(TransactionStatus.completed);
            expect(tx?.requiredSign).toBe(guards.requiredSign);
            expect((await event()).status).toBe(
              direction === 'source'
                ? EventStatus.completed
                : EventStatus.pendingReward,
            );
            expect(sync.active()).toBe(false);
            expect(confirmation).toHaveBeenCalledWith(
              actualId,
              TransactionType.payment,
            );
          });
          /**
           * @target EventSynchronization.setTxAsApproved `rejects a held ${direction} scanner before querying settlement`
           * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
           * @scenario Exercise `rejects a held ${direction} scanner before querying settlement` through setTxAsApproved with the current scanner and persistence state.
           * @expected expect(confirmation).not.toHaveBeenCalled();
           */
          it(`rejects a held ${direction} scanner before querying settlement`, async () => {
            if (direction === 'destination') await destination();
            await hold();
            await sync.approve(payment, actualId);
            await unchanged();
            expect(confirmation).not.toHaveBeenCalled();
          });
          /**
           * @target EventSynchronization.setTxAsApproved `rejects a missing ${direction} scanner`
           * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
           * @scenario Exercise `rejects a missing ${direction} scanner` through setTxAsApproved with the current scanner and persistence state.
           * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
           */
          it(`rejects a missing ${direction} scanner`, async () => {
            if (direction === 'destination') await destination();
            scanner = undefined;
            await sync.approve(payment, actualId);
            await unchanged();
          });
          /**
           * @target EventSynchronization.setTxAsApproved `rechecks ${direction} safety after event lookup yields`
           * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
           * @scenario Exercise `rechecks ${direction} safety after event lookup yields` through setTxAsApproved with the current scanner and persistence state.
           * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
           */
          it(`rechecks ${direction} safety after event lookup yields`, async () => {
            if (direction === 'destination') await destination();
            const getEvent = db.getEventById;
            vi.spyOn(db, 'getEventById').mockImplementationOnce(async (id) => {
              const captured = await getEvent(id);
              await hold();
              return captured;
            });
            await sync.approve(payment, actualId);
            await unchanged();
          });
          /**
           * @target EventSynchronization.setTxAsApproved `excludes ${direction} scanner updates through the SQL commit`
           * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
           * @scenario Exercise `excludes ${direction} scanner updates through the SQL commit` through setTxAsApproved with the current scanner and persistence state.
           * @expected vi.spyOn(db, 'insertSynchronizedPaymentIfUnchanged').mockImplementation( async (...args) => { await expect(scanner!.update()).rejects.toThrow( 'operation already running', ); return persist(...args); }, ); await expect(scanner!.update()).rejects.toThrow( 'operation already running', ); expect((await db.getTxById(payment.txId))?.status).toBe( TransactionStatus.completed, ); await expect(scanner!.update()).resolves.toBeUndefined();
           */
          it(`excludes ${direction} scanner updates through the SQL commit`, async () => {
            if (direction === 'destination') await destination();
            const persist = db.insertSynchronizedPaymentIfUnchanged;
            vi.spyOn(
              db,
              'insertSynchronizedPaymentIfUnchanged',
            ).mockImplementation(async (...args) => {
              await expect(scanner!.update()).rejects.toThrow(
                'operation already running',
              );
              return persist(...args);
            });
            await sync.approve(payment, actualId);
            expect((await db.getTxById(payment.txId))?.status).toBe(
              TransactionStatus.completed,
            );
            await expect(scanner!.update()).resolves.toBeUndefined();
          });
        });
        describe('processSyncResponse', () => {
          /**
           * @target EventSynchronization.processSyncResponse `refuses ${direction} finality lost after the quorum votes`
           * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
           * @scenario Exercise `refuses ${direction} finality lost after the quorum votes` through processSyncResponse with the current scanner and persistence state.
           * @expected expect(confirmation).toHaveBeenCalledTimes(3);
           */
          it(`refuses ${direction} finality lost after the quorum votes`, async () => {
            if (direction === 'destination') await destination();
            confirmation
              .mockResolvedValueOnce(ConfirmationStatus.ConfirmedEnough)
              .mockResolvedValueOnce(ConfirmationStatus.ConfirmedEnough)
              .mockResolvedValue(ConfirmationStatus.NotFound);
            await sync.respond(payment, actualId, 0);
            await sync.respond(payment, actualId, 1);
            expect(confirmation).toHaveBeenCalledTimes(3);
            await unchanged();
          });
        });
      });
    }
    for (const fault of [
      'threshold increase',
      'threshold decrease',
      'public key rotation',
      'guard index',
    ]) {
      describe(`direction ${fault}`, () => {
        const mutate = (guard: typeof guards) => {
          if (fault === 'threshold increase') guard.requiredSign++;
          if (fault === 'threshold decrease') guard.requiredSign--;
          if (fault === 'public key rotation')
            guard.publicKeys[0] = 'replacement';
          if (fault === 'guard index') guard.guardId++;
        };
        describe('processSyncResponse', () => {
          /**
           * @target EventSynchronization.processSyncResponse `rejects ${fault} between votes`
           * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
           * @scenario Exercise `rejects ${fault} between votes` through processSyncResponse with the current scanner and persistence state.
           * @expected await expect(sync.respond(payment, actualId, 1)).rejects.toThrow( 'guard configuration changed', );
           */
          it(`rejects ${fault} between votes`, async () => {
            await sync.respond(payment, actualId, 0);
            mutate(guards);
            await expect(sync.respond(payment, actualId, 1)).rejects.toThrow(
              'guard configuration changed',
            );
            await unchanged();
          });
        });
        describe('setTxAsApproved', () => {
          /**
           * @target EventSynchronization.setTxAsApproved `rejects ${fault} during final height lookup`
           * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
           * @scenario Exercise `rejects ${fault} during final height lookup` through setTxAsApproved with the current scanner and persistence state.
           * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
           */
          it(`rejects ${fault} during final height lookup`, async () => {
            height.mockImplementationOnce(async () => {
              mutate(guards);
              return 2;
            });
            await sync.approve(payment, actualId);
            await unchanged();
          });
        });
      });
    }
    describe('setTxAsApproved', () => {
      /**
       * @target EventSynchronization.setTxAsApproved 'refuses a source observation whose block hash differs'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'refuses a source observation whose block hash differs' through setTxAsApproved with the current scanner and persistence state.
       * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
       */
      it('refuses a source observation whose block hash differs', async () => {
        await db.EventRepository.update(
          { eventId },
          { sourceBlockId: blockHash(77) },
        );
        await sync.approve(payment, actualId);
        await unchanged();
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'rejects the unsigned Avalanche alias even if the RPC claims it is confirmed'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'rejects the unsigned Avalanche alias even if the RPC claims it is confirmed' through setTxAsApproved with the current scanner and persistence state.
       * @expected expect(confirmation).not.toHaveBeenCalled();
       */
      it('rejects the unsigned Avalanche alias even if the RPC claims it is confirmed', async () => {
        await destination();
        await sync.approve(payment, payment.txId);
        await unchanged();
        expect(confirmation).not.toHaveBeenCalled();
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'rejects an unrelated Ergo settlement ID even if the RPC claims it is confirmed'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'rejects an unrelated Ergo settlement ID even if the RPC claims it is confirmed' through setTxAsApproved with the current scanner and persistence state.
       * @expected expect(confirmation).not.toHaveBeenCalled();
       */
      it('rejects an unrelated Ergo settlement ID even if the RPC claims it is confirmed', async () => {
        await sync.approve(payment, 'unrelated-confirmed-transaction');
        await unchanged();
        expect(confirmation).not.toHaveBeenCalled();
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'passes the verified watcher identities to the combined Ergo payment/reward order'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'passes the verified watcher identities to the combined Ergo payment/reward order' through setTxAsApproved with the current scanner and persistence state.
       * @expected expect(EventOrder.createEventPaymentOrder).toHaveBeenCalledWith( expect.anything(), 'creation', expect.anything(), ['fixture-wid'], );
       */
      it('passes the verified watcher identities to the combined Ergo payment/reward order', async () => {
        await sync.approve(payment, actualId);
        expect(EventOrder.createEventPaymentOrder).toHaveBeenCalledWith(
          expect.anything(),
          'creation',
          expect.anything(),
          ['fixture-wid'],
        );
      });
      for (const value of [-1, 1.5, NaN, Infinity]) {
        /**
         * @target EventSynchronization.setTxAsApproved `rejects invalid completion height ${value}`
         * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
         * @scenario Exercise `rejects invalid completion height ${value}` through setTxAsApproved with the current scanner and persistence state.
         * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
         */
        it(`rejects invalid completion height ${value}`, async () => {
          height.mockResolvedValue(value);
          await sync.approve(payment, actualId);
          await unchanged();
        });
      }
      /**
       * @target EventSynchronization.setTxAsApproved 'retains the full captured Ergo model when the caller mutates auxiliary boxes'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'retains the full captured Ergo model when the caller mutates auxiliary boxes' through setTxAsApproved with the current scanner and persistence state.
       * @expected expect((await db.getTxById(payment.txId))?.txJson).toBe(expectedJson);
       */
      it('retains the full captured Ergo model when the caller mutates auxiliary boxes', async () => {
        const expectedJson = payment.toJson();
        height.mockImplementationOnce(async () => {
          (payment as ErgoTransaction).inputBoxes[0][0] = 0;
          (payment as ErgoTransaction).dataInputs[0][0] = 0;
          payment.txBytes[0] = 0;
          return 2;
        });
        await sync.approve(payment, actualId);
        expect((await db.getTxById(payment.txId))?.txJson).toBe(expectedJson);
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'keeps a replacement active synchronization intact after an await'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'keeps a replacement active synchronization intact after an await' through setTxAsApproved with the current scanner and persistence state.
       * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
       */
      it('keeps a replacement active synchronization intact after an await', async () => {
        height.mockImplementationOnce(async () => {
          sync.activate();
          return 2;
        });
        await sync.approve(payment, actualId);
        await unchanged();
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'does not persist after event phase changes during settlement checks'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'does not persist after event phase changes during settlement checks' through setTxAsApproved with the current scanner and persistence state.
       * @expected expect(await db.TransactionRepository.count()).toBe(0); expect((await event()).status).toBe(EventStatus.inPayment); expect(sync.active()).toBe(true);
       */
      it('does not persist after event phase changes during settlement checks', async () => {
        height.mockImplementationOnce(async () => {
          await db.ConfirmedEventRepository.update(
            { id: eventId },
            { status: EventStatus.inPayment },
          );
          return 2;
        });
        await sync.approve(payment, actualId);
        expect(await db.TransactionRepository.count()).toBe(0);
        expect((await event()).status).toBe(EventStatus.inPayment);
        expect(sync.active()).toBe(true);
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'does not persist after event protocol data changes during settlement checks'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'does not persist after event protocol data changes during settlement checks' through setTxAsApproved with the current scanner and persistence state.
       * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
       */
      it('does not persist after event protocol data changes during settlement checks', async () => {
        height.mockImplementationOnce(async () => {
          await db.EventRepository.update({ eventId }, { amount: '11' });
          return 2;
        });
        await sync.approve(payment, actualId);
        await unchanged();
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'does not advance memory or the event when persistence reports a conflict'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'does not advance memory or the event when persistence reports a conflict' through setTxAsApproved with the current scanner and persistence state.
       * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
       */
      it('does not advance memory or the event when persistence reports a conflict', async () => {
        vi.spyOn(db, 'insertSynchronizedPaymentIfUnchanged').mockResolvedValue(
          false,
        );
        await sync.approve(payment, actualId);
        await unchanged();
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'preserves recovery state when the persistence transaction throws'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'preserves recovery state when the persistence transaction throws' through setTxAsApproved with the current scanner and persistence state.
       * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
       */
      it('preserves recovery state when the persistence transaction throws', async () => {
        vi.spyOn(db, 'insertSynchronizedPaymentIfUnchanged').mockRejectedValue(
          new Error('fixture SQL failure'),
        );
        await sync.approve(payment, actualId);
        await unchanged();
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'rejects guard authority drift while waiting for the SQLite transaction owner'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'rejects guard authority drift while waiting for the SQLite transaction owner' through setTxAsApproved with the current scanner and persistence state.
       * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
       */
      it('rejects guard authority drift while waiting for the SQLite transaction owner', async () => {
        const owner = source.createQueryRunner();
        const persist = db.insertSynchronizedPaymentIfUnchanged;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          release = resolve;
        });
        vi.spyOn(db, 'insertSynchronizedPaymentIfUnchanged').mockImplementation(
          async (...args) => {
            await owner.startTransaction();
            const waiting = persist(...args);
            release();
            return waiting;
          },
        );
        const approval = sync.approve(payment, actualId);
        await started;
        guards.requiredSign++;
        await owner.commitTransaction();
        await owner.release();
        await approval;
        await unchanged();
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'synchronizes through the installed Ergo signed codec, box binding and order extraction'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'synchronizes through the installed Ergo signed codec, box binding and order extraction' through setTxAsApproved with the current scanner and persistence state.
       * @expected expect(verify).toHaveBeenCalledWith( expect.any(ErgoTransaction), SigningStatus.Signed, ); expect(order).toHaveBeenCalledWith( expect.any(ErgoTransaction), SigningStatus.Signed, ); expect((await db.getTxById(payment.txId))?.txJson).toBe(payment.toJson()); expect((await event()).status).toBe(EventStatus.completed);
       */
      it('synchronizes through the installed Ergo signed codec, box binding and order extraction', async () => {
        const chain = await realErgo();
        const verify = vi.spyOn(chain, 'verifyPaymentTransaction');
        const order = vi.spyOn(chain, 'extractTransactionOrder');
        await sync.approve(payment, actualId);
        expect(verify).toHaveBeenCalledWith(
          expect.any(ErgoTransaction),
          SigningStatus.Signed,
        );
        expect(order).toHaveBeenCalledWith(
          expect.any(ErgoTransaction),
          SigningStatus.Signed,
        );
        expect((await db.getTxById(payment.txId))?.txJson).toBe(
          payment.toJson(),
        );
        expect((await event()).status).toBe(EventStatus.completed);
      });
      /**
       * @target EventSynchronization.setTxAsApproved 'rolls back the inserted payment when guard authority changes before the event update'
       * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
       * @scenario Exercise 'rolls back the inserted payment when guard authority changes before the event update' through setTxAsApproved with the current scanner and persistence state.
       * @expected expect(checks).toBe(2); expect( PublicStatusHandler.getInstance().updatePublicTxStatus, ).not.toHaveBeenCalled(); expect( PublicStatusHandler.getInstance().updatePublicEventStatus, ).not.toHaveBeenCalled();
       */
      it('rolls back the inserted payment when guard authority changes before the event update', async () => {
        const persist = db.insertSynchronizedPaymentIfUnchanged;
        let checks = 0;
        vi.spyOn(db, 'insertSynchronizedPaymentIfUnchanged').mockImplementation(
          (tx, expected, required, currentHeight, assertAuthority) =>
            persist(tx, expected, required, currentHeight, () => {
              if (++checks === 2) guards.requiredSign++;
              assertAuthority!();
            }),
        );
        await sync.approve(payment, actualId);
        expect(checks).toBe(2);
        await unchanged();
        expect(
          PublicStatusHandler.getInstance().updatePublicTxStatus,
        ).not.toHaveBeenCalled();
        expect(
          PublicStatusHandler.getInstance().updatePublicEventStatus,
        ).not.toHaveBeenCalled();
      });
      for (const fault of [
        'wrong model ID',
        'wrong input box',
        'unsigned encoding',
        'wrong order',
        'wrong settlement ID',
        'missing watcher identities',
      ]) {
        /**
         * @target EventSynchronization.setTxAsApproved `rejects real Ergo ${fault} without changing persistence`
         * @dependencies Actual synchronization, Avalanche scanner observation leases, DatabaseAction, SQLite and signed payment fixtures.
         * @scenario Exercise `rejects real Ergo ${fault} without changing persistence` through setTxAsApproved with the current scanner and persistence state.
         * @expected The unchanged helper verifies that payment rows, event state and the active synchronization remain unchanged.
         */
        it(`rejects real Ergo ${fault} without changing persistence`, async () => {
          await realErgo();
          if (fault === 'wrong model ID') payment.txId = '00'.repeat(32);
          if (fault === 'wrong input box')
            (payment as ErgoTransaction).inputBoxes[0] = Buffer.from(
              'aa',
              'hex',
            );
          if (fault === 'unsigned encoding')
            payment.txBytes = ErgoTransaction.fromJson(
              JSON.stringify(ergoFixture.payment),
            ).txBytes;
          if (fault === 'wrong order')
            vi.mocked(EventOrder.createEventPaymentOrder).mockResolvedValue([]);
          if (fault === 'wrong settlement ID') actualId = '00'.repeat(32);
          if (fault === 'missing watcher identities')
            vi.mocked(EventBoxes.getEventWIDs).mockRejectedValue(
              new Error('Missing watcher identities'),
            );
          await sync.approve(payment, actualId);
          await unchanged();
        });
      }
    });
  });
});
