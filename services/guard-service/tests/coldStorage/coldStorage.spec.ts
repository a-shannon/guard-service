import { FeeData, Transaction } from 'ethers';

import { AssetBalance, TransactionType } from '@rosen-chains/abstract-chain';
import { AbstractChain } from '@rosen-chains/abstract-chain';
import { BITCOIN_CHAIN } from '@rosen-chains/bitcoin';
import { CARDANO_CHAIN } from '@rosen-chains/cardano';
import { ERGO_CHAIN } from '@rosen-chains/ergo';

import ColdStorage from '../../src/coldStorage/coldStorage';
import Configs from '../../src/configs/configs';
import ChainHandler from '../../src/handlers/chainHandler';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import { COLD_STORAGE_CHAINS } from '../../src/utils/constants';
import GuardTurn from '../../src/utils/guardTurn';
import { assertAvalancheColdReserve } from '../../src/verification/avalancheManagementAuthorization';
import { resolveAvalancheColdPolicy } from '../../src/verification/avalancheManagementDependencies';
import RequestVerifier from '../../src/verification/requestVerifier';
import TxAgreementMock from '../agreement/mocked/txAgreement.mock';
import {
  mockErgoPaymentTransaction,
  mockPaymentTransaction,
} from '../agreement/testData';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockTokenPaymentFromErgoEvent } from '../event/testData';
import ChainHandlerMock, {
  chainHandlerInstance,
} from '../handlers/chainHandler.mock';
import { createRegistryMockScope } from '../mocked/registryScope.mock';
import TestConfigs from '../testUtils/testConfigs';
import TestUtils from '../testUtils/testUtils';
import { mockGuardTurn } from '../utils/mocked/guardTurn.mock';
import { coldProducerFixture } from './avalancheColdProducerTestUtils';
import ColdStorageMock from './coldStorage.mock';

describe('ColdStorage', () => {
  describe('chainColdStorageProcess', () => {
    describe('legacy behavior', () => {
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        ChainHandlerMock.resetMock();
        ColdStorageMock.restoreMocks();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess should do nothing
       * when there is already an active cold storage tx for the chain
       * @dependencies
       * - database
       * - ChainHandler
       * - GuardTurn
       * @scenario
       * - mock a transaction and insert into db
       * - mock ChainHandler `getChain`
       *   - mock `getLockAddressAssets`
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `getLockAddressAssets` should NOT got called
       */
      it(`should do nothing when there is already an active cold storage tx for the chain`, async () => {
        // mock transaction and insert into db as 'approved'
        const tx = mockPaymentTransaction(TransactionType.coldStorage);
        await DatabaseActionMock.insertTxRecord(tx, TransactionStatus.approved);

        // mock ChainHandler `getChain`
        const chain = tx.network;
        ChainHandlerMock.mockChainName(chain);
        // mock `getLockAddressAssets`
        ChainHandlerMock.mockChainFunction(
          chain,
          'getLockAddressAssets',
          null,
          true,
        );

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        await ColdStorage.chainColdStorageProcess(tx.network);

        // `getLockAddressAssets` should NOT got called
        expect(
          ChainHandlerMock.getChainMockedFunction(
            chain,
            'getLockAddressAssets',
          ),
        ).not.toHaveBeenCalled();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess should do nothing
       * when no thresholds is set for the chain
       * @dependencies
       * - ChainHandler
       * - GuardTurn
       * @scenario
       * - mock ChainHandler `getChain`
       *   - mock `getLockAddressAssets`
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `getLockAddressAssets` should NOT got called
       */
      it(`should do nothing when no thresholds is set for the chain`, async () => {
        // mock ChainHandler `getChain`
        const chain = BITCOIN_CHAIN;
        ChainHandlerMock.mockChainName(chain);
        // mock `getLockAddressAssets`
        ChainHandlerMock.mockChainFunction(
          chain,
          'getLockAddressAssets',
          null,
          true,
        );

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        await ColdStorage.chainColdStorageProcess(chain);

        // `getLockAddressAssets` should NOT got called
        expect(
          ChainHandlerMock.getChainMockedFunction(
            chain,
            'getLockAddressAssets',
          ),
        ).not.toHaveBeenCalled();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess should do nothing
       * when there is already an active cold storage tx for the chain
       * @dependencies
       * - database
       * - ChainHandler
       * - GuardTurn
       * @scenario
       * - mock ChainHandler `getChain`
       *   - mock `getLockAddressAssets`
       * - mock ColdStorage.generateColdStorageTransaction
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `generateColdStorageTransaction` should NOT got called
       */
      it(`should not generate transaction when no asset is more than it's high threshold`, async () => {
        const chain = CARDANO_CHAIN;
        // mock ChainHandler `getChain`
        ChainHandlerMock.mockChainName(chain);
        // mock `getLockAddressAssets`
        const lockedAssets: AssetBalance = {
          nativeToken: 200000000n,
          tokens: [
            {
              id: 'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
              value: 225000000000n,
            },
            {
              id: 'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
              value: 4000000000n,
            },
          ],
        };
        ChainHandlerMock.mockChainFunction(
          chain,
          'getLockAddressAssets',
          lockedAssets,
          true,
        );

        // mock ColdStorage.generateColdStorageTransaction
        ColdStorageMock.mockFunction('generateColdStorageTransaction');

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        await ColdStorage.chainColdStorageProcess(chain);

        // `generateColdStorageTransaction` should NOT got called
        expect(
          ColdStorageMock.getMockedSpy('generateColdStorageTransaction'),
        ).not.toHaveBeenCalled();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess should generate transaction
       * when native token is more than it's high threshold
       * @dependencies
       * - database
       * - ChainHandler
       * - GuardTurn
       * @scenario
       * - mock ChainHandler `getChain`
       *   - mock `getLockAddressAssets`
       *   - mock `getMinimumNativeToken`
       * - mock ColdStorage.generateColdStorageTransaction
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `generateColdStorageTransaction` should got called with correct arguments
       */
      it(`should generate transaction when native token is more than it's high threshold`, async () => {
        const chain = CARDANO_CHAIN;
        // mock ChainHandler `getChain`
        ChainHandlerMock.mockChainName(chain);
        // mock `getLockAddressAssets`
        const lockedAssets: AssetBalance = {
          nativeToken: 400000000n,
          tokens: [
            {
              id: 'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
              value: 225000000000n,
            },
            {
              id: 'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
              value: 4000000000n,
            },
          ],
        };
        ChainHandlerMock.mockChainFunction(
          chain,
          'getLockAddressAssets',
          lockedAssets,
          true,
        );
        // mock `getMinimumNativeToken`
        ChainHandlerMock.mockChainFunction(
          chain,
          'getMinimumNativeToken',
          100n,
        );

        // mock ColdStorage.generateColdStorageTransaction
        ColdStorageMock.mockFunction('generateColdStorageTransaction');

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        await ColdStorage.chainColdStorageProcess(chain);

        // `generateColdStorageTransaction` should got called with correct arguments
        expect(
          ColdStorageMock.getMockedSpy('generateColdStorageTransaction'),
        ).toHaveBeenCalledWith(
          { nativeToken: 300000000n, tokens: [] },
          chainHandlerInstance.getChain(chain),
          chain,
        );
      });

      /**
       * @target ColdStorage.chainColdStorageProcess should generate transaction
       * when at least one token is more than it's high threshold
       * @dependencies
       * - database
       * - ChainHandler
       * - GuardTurn
       * @scenario
       * - mock ChainHandler `getChain`
       *   - mock `getLockAddressAssets`
       *   - mock `getMinimumNativeToken`
       * - mock ColdStorage.generateColdStorageTransaction
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `generateColdStorageTransaction` should got called with correct arguments
       */
      it(`should generate transaction when at least one token is more than it's high threshold`, async () => {
        const chain = CARDANO_CHAIN;
        // mock ChainHandler `getChain`
        ChainHandlerMock.mockChainName(chain);
        // mock `getLockAddressAssets`
        const lockedAssets: AssetBalance = {
          nativeToken: 200000000n,
          tokens: [
            {
              id: 'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
              value: 225000000000n,
            },
            {
              id: 'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
              value: 544000000000n,
            },
          ],
        };
        ChainHandlerMock.mockChainFunction(
          chain,
          'getLockAddressAssets',
          lockedAssets,
          true,
        );
        // mock `getMinimumNativeToken`
        const minimumNativeToken = 10000000n;
        ChainHandlerMock.mockChainFunction(
          chain,
          'getMinimumNativeToken',
          minimumNativeToken,
        );

        // mock ColdStorage.generateColdStorageTransaction
        ColdStorageMock.mockFunction('generateColdStorageTransaction');

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        await ColdStorage.chainColdStorageProcess(chain);

        // `generateColdStorageTransaction` should got called with correct arguments
        expect(
          ColdStorageMock.getMockedSpy('generateColdStorageTransaction'),
        ).toHaveBeenCalledWith(
          {
            nativeToken: minimumNativeToken,
            tokens: [
              {
                id: 'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
                value: 541000000000n,
              },
            ],
          },
          chainHandlerInstance.getChain(chain),
          chain,
        );
      });

      /**
       * @target ColdStorage.chainColdStorageProcess should do nothing
       * when turn is over
       * @dependencies
       * - database
       * - ChainHandler
       * - GuardTurn
       * @scenario
       * - mock a transaction and insert into db
       * - mock ChainHandler `getChain`
       *   - mock `getLockAddressAssets`
       * - mock GuardTurn to return guard index + 1
       * - run test
       * - check if function got called
       * @expected
       * - `getLockAddressAssets` should NOT got called
       */
      it(`should do nothing when turn is over`, async () => {
        // mock transaction and insert into db as 'approved'
        const tx = mockPaymentTransaction(TransactionType.coldStorage);
        await DatabaseActionMock.insertTxRecord(tx, TransactionStatus.approved);

        // mock ChainHandler `getChain`
        const chain = tx.network;
        ChainHandlerMock.mockChainName(chain);
        // mock `getLockAddressAssets`
        ChainHandlerMock.mockChainFunction(
          chain,
          'getLockAddressAssets',
          null,
          true,
        );

        // mock GuardTurn to return guard index + 1
        mockGuardTurn(TestConfigs.guardIndex + 1);

        // run test
        await ColdStorage.chainColdStorageProcess(tx.network);

        // `getLockAddressAssets` should NOT got called
        expect(
          ChainHandlerMock.getChainMockedFunction(
            chain,
            'getLockAddressAssets',
          ),
        ).not.toHaveBeenCalled();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess should not generate transaction
       * when token is required in some waiting events
       * @dependencies
       * - database
       * - ChainHandler
       * - GuardTurn
       * @scenario
       * - mock an event and insert mocked event into db as paymentWaiting
       * - mock ChainHandler `getChain`
       *   - mock `getLockAddressAssets`
       *   - mock `getMinimumNativeToken` (event targetChainTokenId amount
       *     should be more than it's high threshold)
       * - mock ColdStorage.generateColdStorageTransaction
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `generateColdStorageTransaction` should NOT got called
       */
      it(`should not generate transaction when token is required in some waiting events`, async () => {
        // mock an event and insert mocked event into db as paymentWaiting
        const event = mockTokenPaymentFromErgoEvent().event;
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.paymentWaiting,
        );

        const chain = CARDANO_CHAIN;
        // mock ChainHandler `getChain`
        ChainHandlerMock.mockChainName(chain);
        // mock `getLockAddressAssets`
        const lockedAssets: AssetBalance = {
          nativeToken: 200000000n,
          tokens: [
            {
              id: 'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
              value: 225000000000n,
            },
            {
              id: 'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
              value: 544000000000n,
            },
          ],
        };
        ChainHandlerMock.mockChainFunction(
          chain,
          'getLockAddressAssets',
          lockedAssets,
          true,
        );
        // mock `getMinimumNativeToken`
        const minimumNativeToken = 10000000n;
        ChainHandlerMock.mockChainFunction(
          chain,
          'getMinimumNativeToken',
          minimumNativeToken,
        );

        // mock ColdStorage.generateColdStorageTransaction
        ColdStorageMock.mockFunction('generateColdStorageTransaction');

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        await ColdStorage.chainColdStorageProcess(chain);

        // `generateColdStorageTransaction` should NOT got called
        expect(
          ColdStorageMock.getMockedSpy('generateColdStorageTransaction'),
        ).not.toHaveBeenCalled();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess should ignore waiting events
       * required tokens when processing tokens
       * @dependencies
       * - database
       * - ChainHandler
       * - GuardTurn
       * @scenario
       * - mock an event and insert mocked event into db as paymentWaiting
       * - mock ChainHandler `getChain`
       *   - mock `getLockAddressAssets`
       *   - mock `getMinimumNativeToken` (event targetChainTokenId amount
       *     should be more than it's high threshold)
       * - mock ColdStorage.generateColdStorageTransaction
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `generateColdStorageTransaction` should got called with correct arguments
       */
      it(`should ignore waiting events required tokens when processing tokens`, async () => {
        // mock an event and insert mocked event into db as paymentWaiting
        const event = mockTokenPaymentFromErgoEvent().event;
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.paymentWaiting,
        );

        const chain = CARDANO_CHAIN;
        // mock ChainHandler `getChain`
        ChainHandlerMock.mockChainName(chain);
        // mock `getLockAddressAssets`
        const lockedAssets: AssetBalance = {
          nativeToken: 200000000n,
          tokens: [
            {
              id: 'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
              value: 726000000000n,
            },
            {
              id: 'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
              value: 544000000000n,
            },
          ],
        };
        ChainHandlerMock.mockChainFunction(
          chain,
          'getLockAddressAssets',
          lockedAssets,
          true,
        );
        // mock `getMinimumNativeToken`
        const minimumNativeToken = 10000000n;
        ChainHandlerMock.mockChainFunction(
          chain,
          'getMinimumNativeToken',
          minimumNativeToken,
        );

        // mock ColdStorage.generateColdStorageTransaction
        ColdStorageMock.mockFunction('generateColdStorageTransaction');

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        await ColdStorage.chainColdStorageProcess(chain);

        // `generateColdStorageTransaction` should got called with correct arguments
        expect(
          ColdStorageMock.getMockedSpy('generateColdStorageTransaction'),
        ).toHaveBeenCalledWith(
          {
            nativeToken: minimumNativeToken,
            tokens: [
              {
                id: 'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
                value: 601000000000n,
              },
            ],
          },
          chainHandlerInstance.getChain(chain),
          chain,
        );
      });
    });
    describe('Avalanche automatic generation', () => {
      let f: Awaited<ReturnType<typeof coldProducerFixture>>;
      const scope = createRegistryMockScope();
      beforeEach(async () => {
        ColdStorageMock.restoreMocks();
        scope.capture(ChainHandler, 'getInstance');
        f = await coldProducerFixture();
      });
      afterEach(() => {
        f.close();
        vi.restoreAllMocks();
        scope.restore();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess preserves the native cold reserve including gas
       * @dependencies Actual mainnet map, cold job, chain generation and reserve verifier; inert RPC balances/fees, agreement queue and turn
       * @scenario Keep JOE below its high threshold and run the enabled job with excess AVAX
       * @expected One generated native order satisfies the same cold reserve used by real admission
       */
      it('preserves the native cold reserve including gas', async () => {
        f.tokenBalance.mockResolvedValue(1000000n * 1000000000n);
        await ColdStorage.chainColdStorageProcess('avalanche');
        expect(f.queued).toHaveLength(1);
        const payment = f.queued[0];
        const locked = await f.chain.getLockAddressAssets();
        const required = (await f.chain.getTransactionAssets(payment))
          .inputAssets;
        const policy = resolveAvalancheColdPolicy(
          f.chain,
          payment,
          Configs.thresholds().avalanche,
        );
        expect(() =>
          assertAvalancheColdReserve(
            { locked, required, forbiddenTokens: [], activeTxIds: [] },
            policy,
            payment.txId,
          ),
        ).not.toThrow();
        expect(f.rpc).not.toHaveBeenCalled();
        expect(f.signer).not.toHaveBeenCalled();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess sweeps feasible AVAX when the cap gas budget exceeds the threshold gap
       * @dependencies Actual mainnet job, gas estimation, chain and request admission
       * @scenario Use 200 gwei, estimated 21000 gas, cap 50000 and low/high 100000/900000 significant units
       * @expected Queue the feasible 95700000-unit transfer and leave exactly the low reserve after maximum fees
       */
      it('sweeps feasible AVAX when the cap gas budget exceeds the threshold gap', async () => {
        f.tokenBalance.mockResolvedValue(1000000n * 1000000000n);
        f.balance.mockResolvedValue(100000000n * 1000000000n);
        vi.mocked(f.network.getFeeData).mockResolvedValue(
          new FeeData(null, 200000000000n, 2000000000n),
        );
        await ColdStorage.chainColdStorageProcess('avalanche');
        expect(f.queued).toHaveLength(1);
        expect(
          f.chain.extractTransactionOrder(f.queued[0])[0].assets.nativeToken,
        ).toEqual(95700000n);
        const required = (await f.chain.getTransactionAssets(f.queued[0]))
          .inputAssets.nativeToken;
        expect(100000000n - required).toEqual(100000n);
        expect(
          await RequestVerifier.verifyColdStorageTransactionRequest(
            f.queued[0],
          ),
        ).toEqual(true);
        expect(f.rpc).not.toHaveBeenCalled();
        expect(f.signer).not.toHaveBeenCalled();
      });
      /**
       * @target ColdStorage.chainColdStorageProcess retains the exact raw AVAX reserve with residual wei %s
       * @dependencies Actual mainnet native balance conversion, cold job, gas budget and request admission
       * @scenario Add a fractional significant unit to the same feasible AVAX sweep balance
       * @expected Queue 95700000 significant units and leave the low raw reserve plus the residual wei
       */
      it.each([1n, 999999999n])(
        'retains the exact raw AVAX reserve with residual wei %s',
        async (residual) => {
          const balance = 100000000n * 1000000000n + residual;
          f.tokenBalance.mockResolvedValue(1000000n * 1000000000n);
          f.balance.mockResolvedValue(balance);
          vi.mocked(f.network.getFeeData).mockResolvedValue(
            new FeeData(null, 200000000000n, 2000000000n),
          );
          await ColdStorage.chainColdStorageProcess('avalanche');
          expect(f.queued).toHaveLength(1);
          const tx = Transaction.from(
            '0x' + Buffer.from(f.queued[0].txBytes).toString('hex'),
          );
          expect(tx.value).toEqual(95700000n * 1000000000n);
          expect(balance - tx.value - tx.gasLimit * tx.maxFeePerGas!).toEqual(
            100000n * 1000000000n + residual,
          );
          expect(f.rpc).not.toHaveBeenCalled();
          expect(f.signer).not.toHaveBeenCalled();
        },
      );
      /**
       * @target ColdStorage.chainColdStorageProcess refuses gas planning %s
       * @dependencies Actual cold planning with an isolated gas-reader or cap fault
       * @scenario Return invalid/over-cap gas or replace the estimator during its await
       * @expected Queue nothing and never invoke a live endpoint or signer
       */
      it.each(['zero estimate', 'over cap', 'late estimator'])(
        'refuses gas planning %s',
        async (fault) => {
          f.tokenBalance.mockResolvedValue(1000000n * 1000000000n);
          const gas = vi.mocked(f.network.getGasRequired);
          if (fault === 'zero estimate') gas.mockResolvedValue(0n);
          if (fault === 'over cap') gas.mockResolvedValue(50001n);
          if (fault === 'late estimator')
            gas.mockImplementationOnce(async () => {
              f.network.getGasRequired = vi.fn().mockResolvedValue(21000n);
              return 21000n;
            });
          await ColdStorage.chainColdStorageProcess('avalanche');
          expect(f.queued).toEqual([]);
          expect(f.rpc).not.toHaveBeenCalled();
          expect(f.signer).not.toHaveBeenCalled();
        },
      );

      /**
       * @target ColdStorage.chainColdStorageProcess queues one eligible JOE order before excess AVAX
       * @dependencies Real cold job, selected mainnet map, chain and request admission; inert balances and agreement port
       * @scenario Put both AVAX and JOE above their high thresholds
       * @expected One token-only order reaches the queue and retains the configured JOE low balance
       */
      it('queues one eligible JOE order before excess AVAX', async () => {
        await ColdStorage.chainColdStorageProcess('avalanche');
        expect(f.queued).toHaveLength(1);
        expect(f.chain.extractTransactionOrder(f.queued[0])[0].assets).toEqual({
          nativeToken: 0n,
          tokens: [{ id: f.joe, value: 750000n }],
        });
        expect(
          await RequestVerifier.verifyColdStorageTransactionRequest(
            f.queued[0],
          ),
        ).toEqual(true);
        expect(f.rpc).not.toHaveBeenCalled();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess skips %s before queueing
       * @dependencies Actual producer/admission joined to mutable balance, threshold, waiting-asset and turn ports
       * @scenario Isolate one refusal condition on otherwise valid excess mainnet assets
       * @expected No payment reaches agreement and no live endpoint or signer is invoked
       */
      it.each([
        'native floor',
        'waiting gas',
        'below trigger',
        'unknown threshold',
        'missing native threshold',
        'invalid threshold',
        'late threshold',
        'late waiting token',
        'late turn',
        'fee failure',
        'late fee reader',
      ])('skips %s before queueing', async (fault) => {
        if (fault === 'native floor')
          f.balance.mockResolvedValue(100000n * 1000000000n);
        if (fault === 'waiting gas') f.forbidden.mockResolvedValue(['avax']);
        if (fault === 'below trigger') {
          f.balance.mockResolvedValue(800000n * 1000000000n);
          f.tokenBalance.mockResolvedValue(1000000n * 1000000000n);
        }
        if (fault === 'unknown threshold')
          f.thresholds.mockReturnValue({
            avalanche: {
              tokens: {
                avax: { low: 100000n, high: 900000n },
                ['0x' + '99'.repeat(20)]: { low: 1n, high: 2n },
              },
              maxNativeTransfer: 0n,
            },
          });
        if (fault === 'missing native threshold')
          f.thresholds.mockReturnValue({
            avalanche: {
              tokens: { [f.joe]: { low: 1250000n, high: 1500000n } },
              maxNativeTransfer: 0n,
            },
          });
        if (fault === 'invalid threshold')
          f.thresholds.mockReturnValue({
            avalanche: {
              tokens: { avax: { low: 900000n, high: 100000n } },
              maxNativeTransfer: 0n,
            },
          });
        if (fault === 'late threshold')
          f.tokenBalance.mockImplementationOnce(async () => {
            f.thresholds.mockReturnValue({
              avalanche: {
                tokens: {
                  avax: { low: 100000n, high: 900000n },
                  [f.joe]: { low: 1500000n, high: 1600000n },
                },
                maxNativeTransfer: 0n,
              },
            });
            return 2000000n * 1000000000n;
          });
        if (fault === 'late waiting token')
          f.forbidden.mockResolvedValueOnce([]).mockResolvedValue([f.joe]);
        if (fault === 'late turn') {
          const original = RequestVerifier.verifyColdStorageTransactionRequest;
          vi.spyOn(
            RequestVerifier,
            'verifyColdStorageTransactionRequest',
          ).mockImplementation(async (tx) => {
            const valid = await original(tx);
            vi.mocked(GuardTurn.guardTurn).mockReturnValue(9999);
            return valid;
          });
        }
        if (fault === 'fee failure' || fault === 'late fee reader') {
          f.tokenBalance.mockResolvedValue(1000000n * 1000000000n);
          if (fault === 'fee failure')
            vi.mocked(f.network.getFeeData).mockRejectedValue(
              new Error('Synthetic unavailable fee'),
            );
          else
            vi.mocked(f.network.getFeeData).mockImplementationOnce(async () => {
              f.network.getFeeData = vi
                .fn()
                .mockRejectedValue(new Error('Synthetic replaced reader'));
              return {
                maxFeePerGas: 20n,
                maxPriorityFeePerGas: 2n,
                gasPrice: null,
              } as Awaited<ReturnType<typeof f.network.getFeeData>>;
            });
        }
        await ColdStorage.chainColdStorageProcess('avalanche');
        expect(f.queued).toEqual([]);
        expect(f.rpc).not.toHaveBeenCalled();
        expect(f.signer).not.toHaveBeenCalled();
      });

      /**
       * @target ColdStorage.chainColdStorageProcess sweeps AVAX while waiting JOE is excluded
       * @dependencies Actual native budgeting and request admission with a selected waiting-token port
       * @scenario Keep JOE above high but reserve it for an event
       * @expected One gas-budgeted native payment is queued without token movement
       */
      it('sweeps AVAX while waiting JOE is excluded', async () => {
        f.forbidden.mockResolvedValue([f.joe]);
        await ColdStorage.chainColdStorageProcess('avalanche');
        expect(f.queued).toHaveLength(1);
        expect(
          f.chain.extractTransactionOrder(f.queued[0])[0].assets.tokens,
        ).toEqual([]);
        expect(
          await RequestVerifier.verifyColdStorageTransactionRequest(
            f.queued[0],
          ),
        ).toEqual(true);
      });
    });
    describe('Avalanche registry boundaries', () => {
      const scope = createRegistryMockScope();
      beforeEach(() => {
        scope.capture(ColdStorage, 'chainColdStorageProcess');
        scope.capture(GuardTurn, 'guardTurn');
      });
      afterEach(() => scope.restore());

      /**
       * @target ColdStorage.chainColdStorageProcess rejects Avalanche before reading guard state
       * @dependencies Throwing guard-turn spy; real processor method.
       * @scenario Directly request Avalanche cold processing outside the scheduler.
       * @expected Return before reading guard state or downstream dependencies.
       */
      it('rejects Avalanche before reading guard state', async () => {
        const turn = vi.spyOn(GuardTurn, 'guardTurn').mockImplementation(() => {
          throw new Error('unexpected guard-state read');
        });
        await ColdStorage.chainColdStorageProcess('avalanche');
        expect(turn).not.toHaveBeenCalled();
      });
    });
  });
  describe('generateColdStorageTransaction', () => {
    describe('legacy behavior', () => {
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        ChainHandlerMock.resetMock();
        ColdStorageMock.restoreMocks();
        TxAgreementMock.resetMock();
        TxAgreementMock.mock();
      });

      /**
       * @target ColdStorage.generateColdStorageTransaction should generate
       * cold storage transaction for non-Ergo chain successfully
       * @dependencies
       * - database
       * - ChainHandler
       * - TxAgreement
       * - GuardTurn
       * @scenario
       * - mock ChainHandler `getChain`
       *   - mock `generateMultipleTransactions`
       *   - mock `getChainConfigs`
       * - mock TxAgreement `getChainPendingTransactions` and `addTransactionToQueue`
       * - mock a transaction and insert into db as signed
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `generateMultipleTransactions` should got called with correct arguments
       * - `addTransactionToQueue` should got called
       */
      it(`should generate cold storage transaction for non-Ergo chain successfully`, async () => {
        const chain = CARDANO_CHAIN;
        // mock ChainHandler `getChain`
        ChainHandlerMock.mockChainName(chain);
        // mock `generateMultipleTransactions`
        ChainHandlerMock.mockChainFunction(
          chain,
          'generateMultipleTransactions',
          [{ txId: TestUtils.generateRandomId() }],
          true,
        );
        // mock `getChainConfigs`
        const coldAddress = `coldAddress`;
        ChainHandlerMock.mockChainFunction(chain, 'getChainConfigs', {
          addresses: { cold: coldAddress },
        });

        // mock TxAgreement `getChainPendingTransactions` and `addTransactionToQueue`
        TxAgreementMock.mockGetChainPendingTransactions([]);
        TxAgreementMock.mockAddTransactionToQueue();

        // mock a transaction and insert into db as signed
        const signedTx = mockPaymentTransaction(TransactionType.payment, chain);
        await DatabaseActionMock.insertTxRecord(
          signedTx,
          TransactionStatus.signed,
        );

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        const transferringAssets = { nativeToken: 0n, tokens: [] };
        await ColdStorage.generateColdStorageTransaction(
          transferringAssets,
          chainHandlerInstance.getChain(chain),
          chain,
        );

        // `generateMultipleTransactions` should got called with correct arguments
        const expectedOrder = [
          {
            address: coldAddress,
            assets: transferringAssets,
          },
        ];
        expect(
          ChainHandlerMock.getChainMockedFunction(
            chain,
            'generateMultipleTransactions',
          ),
        ).toHaveBeenCalledWith(
          '',
          TransactionType.coldStorage,
          expectedOrder,
          [],
          [Buffer.from(signedTx.txBytes).toString('hex')],
          ...[],
        );

        // `addTransactionToQueue` should got called
        expect(
          TxAgreementMock.getMockedFunction('addTransactionToQueue'),
        ).toHaveBeenCalledOnce();
      });

      /**
       * @target ColdStorage.generateColdStorageTransaction should generate
       * cold storage transaction for Ergo chain successfully
       * @dependencies
       * - database
       * - ChainHandler
       * - TxAgreement
       * - GuardTurn
       * @scenario
       * - mock ChainHandler `getChain`
       *   - mock `generateMultipleTransactions`
       *   - mock `getGuardsConfigBox`
       *   - mock `getChainConfigs`
       * - mock TxAgreement `getChainPendingTransactions` and `addTransactionToQueue`
       * - mock a transaction and insert into db as signed
       * - mock GuardTurn to return guard index
       * - run test
       * - check if function got called
       * @expected
       * - `generateMultipleTransactions` should got called with correct arguments
       * - `addTransactionToQueue` should got called
       */
      it(`should generate cold storage transaction for Ergo chain successfully`, async () => {
        const chain = ERGO_CHAIN;
        // mock ChainHandler `getChain`
        ChainHandlerMock.mockChainName(chain);
        // mock `generateMultipleTransactions`
        ChainHandlerMock.mockErgoFunctionReturnValue(
          'generateMultipleTransactions',
          [{ txId: TestUtils.generateRandomId() }],
          true,
        );
        // mock `getGuardsConfigBox`
        const guardConfigBox = 'serialized-box';
        ChainHandlerMock.mockErgoFunctionReturnValue(
          'getGuardsConfigBox',
          guardConfigBox,
          true,
        );
        // mock `getChainConfigs`
        const coldAddress = `coldAddress`;
        ChainHandlerMock.mockErgoFunctionReturnValue('getChainConfigs', {
          addresses: { cold: coldAddress },
        });

        // mock TxAgreement `getChainPendingTransactions` and `addTransactionToQueue`
        TxAgreementMock.mockGetChainPendingTransactions([]);
        TxAgreementMock.mockAddTransactionToQueue();

        // mock a transaction and insert into db as signed
        const signedTx = mockErgoPaymentTransaction(TransactionType.payment);
        await DatabaseActionMock.insertTxRecord(
          signedTx,
          TransactionStatus.signed,
        );

        // mock GuardTurn to return guard index
        mockGuardTurn(TestConfigs.guardIndex);

        // run test
        const transferringAssets = { nativeToken: 0n, tokens: [] };
        await ColdStorage.generateColdStorageTransaction(
          transferringAssets,
          chainHandlerInstance.getChain(chain),
          chain,
        );

        // `generateMultipleTransactions` should got called with correct arguments
        const expectedOrder = [
          {
            address: coldAddress,
            assets: transferringAssets,
          },
        ];
        expect(
          ChainHandlerMock.getErgoMockedFunction(
            'generateMultipleTransactions',
          ),
        ).toHaveBeenCalledWith(
          '',
          TransactionType.coldStorage,
          expectedOrder,
          [],
          [Buffer.from(signedTx.txBytes).toString('hex')],
          ...[[], [guardConfigBox]],
        );

        // `addTransactionToQueue` should got called
        expect(
          TxAgreementMock.getMockedFunction('addTransactionToQueue'),
        ).toHaveBeenCalledOnce();
      });

      /**
       * @target ColdStorage.generateColdStorageTransaction should generate
       * cold storage transaction but does not send it to agreement process when turn is over
       * @dependencies
       * - database
       * - ChainHandler
       * - TxAgreement
       * - GuardTurn
       * @scenario
       * - mock ChainHandler `getChain`
       *   - mock `generateMultipleTransactions`
       *   - mock `getChainConfigs`
       * - mock TxAgreement `getChainPendingTransactions` and `addTransactionToQueue`
       * - mock a transaction and insert into db as signed
       * - mock GuardTurn to return guard index + 1
       * - run test
       * - check if function got called
       * @expected
       * - `generateMultipleTransactions` should got called with correct arguments
       * - `addTransactionToQueue` should not got called
       */
      it(`should generate cold storage transaction but does not send it to agreement process when turn is over`, async () => {
        const chain = CARDANO_CHAIN;
        // mock ChainHandler `getChain`
        ChainHandlerMock.mockChainName(chain);
        // mock `generateMultipleTransactions`
        ChainHandlerMock.mockChainFunction(
          chain,
          'generateMultipleTransactions',
          [{ txId: TestUtils.generateRandomId() }],
          true,
        );
        // mock `getChainConfigs`
        const coldAddress = `coldAddress`;
        ChainHandlerMock.mockChainFunction(chain, 'getChainConfigs', {
          addresses: { cold: coldAddress },
        });

        // mock TxAgreement `getChainPendingTransactions` and `addTransactionToQueue`
        TxAgreementMock.mockGetChainPendingTransactions([]);
        TxAgreementMock.mockAddTransactionToQueue();

        // mock a transaction and insert into db as signed
        const signedTx = mockPaymentTransaction(TransactionType.payment, chain);
        await DatabaseActionMock.insertTxRecord(
          signedTx,
          TransactionStatus.signed,
        );

        // mock GuardTurn to return guard index + 1
        mockGuardTurn(TestConfigs.guardIndex + 1);

        // run test
        const transferringAssets = { nativeToken: 0n, tokens: [] };
        await ColdStorage.generateColdStorageTransaction(
          transferringAssets,
          chainHandlerInstance.getChain(chain),
          chain,
        );

        // `generateMultipleTransactions` should got called with correct arguments
        const expectedOrder = [
          {
            address: coldAddress,
            assets: transferringAssets,
          },
        ];
        expect(
          ChainHandlerMock.getChainMockedFunction(
            chain,
            'generateMultipleTransactions',
          ),
        ).toHaveBeenCalledWith(
          '',
          TransactionType.coldStorage,
          expectedOrder,
          [],
          [Buffer.from(signedTx.txBytes).toString('hex')],
          ...[],
        );

        // `addTransactionToQueue` should not got called
        expect(
          TxAgreementMock.getMockedFunction('addTransactionToQueue'),
        ).not.toHaveBeenCalled();
      });
    });
    describe('Avalanche registry boundaries', () => {
      const scope = createRegistryMockScope();
      beforeEach(() => {
        scope.capture(ColdStorage, 'chainColdStorageProcess');
        scope.capture(GuardTurn, 'guardTurn');
      });
      afterEach(() => scope.restore());

      /**
       * @target ColdStorage.generateColdStorageTransaction rejects Avalanche before constructing an order
       * @dependencies Throwing chain-config API mock; real generation entry point.
       * @scenario Directly request a synthetic Avalanche cold transaction.
       * @expected Reject before reading addresses, agreement state or signing inputs.
       */
      it('rejects Avalanche before constructing an order', async () => {
        const getChainConfigs = vi.fn(() => {
          throw new Error('unexpected address read');
        });
        const chain = { getChainConfigs } as unknown as AbstractChain<unknown>;
        await expect(async () => {
          await ColdStorage.generateColdStorageTransaction(
            { nativeToken: 1n, tokens: [] },
            chain,
            'avalanche',
          );
        }).rejects.toThrow('not supported');
        expect(getChainConfigs).not.toHaveBeenCalled();
      });
    });
  });
  describe('processLockAddressAssets', () => {
    describe('Avalanche registry boundaries', () => {
      const scope = createRegistryMockScope();
      beforeEach(() => {
        scope.capture(ColdStorage, 'chainColdStorageProcess');
        scope.capture(GuardTurn, 'guardTurn');
      });
      afterEach(() => scope.restore());

      /**
       * @target ColdStorage.processLockAddressAssets schedules only chains with cold-storage capability
       * @dependencies Mocked per-chain cold processor; real scheduler method.
       * @scenario Run the scheduler after registering Avalanche as a known identity.
       * @expected Process each original chain once and skip Avalanche without an opt-in.
       */
      it('schedules only chains with cold-storage capability', async () => {
        const process = vi
          .spyOn(ColdStorage, 'chainColdStorageProcess')
          .mockResolvedValue(undefined);
        await ColdStorage.processLockAddressAssets();
        expect(process).toHaveBeenCalledTimes(COLD_STORAGE_CHAINS.length - 1);
        expect(process.mock.calls.map(([chain]) => chain)).toEqual([
          ...COLD_STORAGE_CHAINS.filter((chain) => chain !== 'avalanche'),
        ]);
        expect(process).not.toHaveBeenCalledWith('avalanche');
      });
    });
  });
});
