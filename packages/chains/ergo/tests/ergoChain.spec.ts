import * as wasm from 'ergo-lib-wasm-nodejs';
import { createServer } from 'node:http';

import { TokenMap } from '@rosen-bridge/tokens';
import { BlockInfo } from '@rosen-chains/abstract-chain';
import { BoxInfo } from '@rosen-chains/abstract-chain';
import { NotEnoughAssetsError } from '@rosen-chains/abstract-chain';
import { NotEnoughValidBoxesError } from '@rosen-chains/abstract-chain';
import { SigningStatus } from '@rosen-chains/abstract-chain';
import { TransactionType } from '@rosen-chains/abstract-chain';
import ErgoNodeNetwork from '@rosen-chains/ergo-node-network';

import { ErgoChain } from '../lib';
import { ErgoConfigs } from '../lib';
import ErgoTransaction from '../lib/ergoTransaction';
import AbstractErgoNetwork from '../lib/network/abstractErgoNetwork';
import { AuthorizedSubmissionError } from '../lib/network/authorizedSubmission';
import Serializer from '../lib/serializer';
import * as boxTestData from './boxTestData';
import * as ergoTestUtils from './ergoTestUtils';
import { generateChainObject } from './ergoTestUtils';
import { createTransactionLifetimeFixture } from './mocked/transactionLifetime.mock';
import TestErgoNetwork from './network/testErgoNetwork';
import { generateAuthorizedPayment } from './testUtils/authorizedSubmission';
import { generateSubmissionOptions } from './testUtils/authorizedSubmission';
import { createSignedAccountingFixtures } from './testUtils/signedAccounting';
import { createSignedPaymentFixtures } from './testUtils/signedPaymentConsistency';
import * as transactionTestData from './transactionTestData';
import { transaction2SignedSerialized } from './transactionTestData';
import { transaction2PartialUnsignedPaymentTransaction } from './transactionTestData';
import { transaction5PaymentTransaction } from './transactionTestData';

describe('ErgoChain', () => {
  describe('baseline scenarios', () => {
    describe('generateTransaction', () => {
      /**
       * @target ErgoChain.generateTransaction should throw error when
       * last item on order is to lock address
       * @dependencies
       * @scenario
       * - run test and expect exception thrown
       * @expected
       * - it should throw Error
       */
      it('should throw error when last item on order is to lock address', async () => {
        const ergoChain = ergoTestUtils.generateChainObject(
          new TestErgoNetwork(),
        );
        await expect(async () => {
          await ergoChain.generateTransaction(
            '',
            TransactionType.manual,
            transactionTestData.invalidOrder,
            [],
            [],
            [],
            [],
          );
        }).rejects.toThrow(Error);
      });

      /**
       * @target ErgoChain.generateTransaction should generate payment
       * transaction successfully
       * @dependencies
       * @scenario
       * - mock transaction order, input and data input boxes
       * - mock an AssetBalance as lock address assets with enough assets
       * - mock a network object
       *   - mock 'getHeight'
       *   - mock 'getStateContext'
       *   - mock 'getAddressAssets' to return mocked assets
       *   - mock 'getMempoolTransactions' to return empty list
       * - mock chain config
       * - mock getCoveringBoxes
       * - mock getMempoolBoxMapping
       * - run test
       * - check attributes of returned value
       * @expected
       * - PaymentTransaction inputs, dataInputs, eventId and txType should be as
       *   expected
       * - extracted order of generated transaction should be the same as input
       *   order
       * - transaction fee should be the same as config fee
       * - two change boxes should be as expected
       */
      it('should generate payment transaction successfully', async () => {
        // mock transaction order, input and data input boxes
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );
        const order = transactionTestData.transaction3Order;
        const inputs = [Buffer.from(paymentTx.inputBoxes[0]).toString('hex')];
        const dataInputs = paymentTx.dataInputs.map((serializedBox) =>
          Buffer.from(serializedBox).toString('hex'),
        );

        // mock an AssetBalance as lock address assets with enough assets
        const mockedLockAssets = {
          nativeToken: 50000000n,
          tokens: [
            {
              id: '10278c102bf890fdab8ef5111e94053c90b3541bc25b0de2ee8aa6305ccec3de',
              value: 5000n,
            },
            {
              id: ergoTestUtils.generateRandomId(),
              value: 100000n,
            },
          ],
        };

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getHeight'
        const getHeightSpy = vi.spyOn(network, 'getHeight');
        getHeightSpy.mockResolvedValue(966000);
        // mock 'getStateContext'
        const getStateContextSpy = vi.spyOn(network, 'getStateContext');
        getStateContextSpy.mockResolvedValue(
          transactionTestData.mockedStateContext,
        );
        // mock 'getAddressAssets' to return mocked assets
        const getAddressAssetsSpy = vi.spyOn(network, 'getAddressAssets');
        getAddressAssetsSpy.mockResolvedValue(mockedLockAssets);
        // mock 'getMempoolTransactions'
        const getMempoolTransactionsSpy = vi.spyOn(
          network,
          'getMempoolTransactions',
        );
        getMempoolTransactionsSpy.mockResolvedValue([]);

        // mock chain config
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 300000n,
          eventTxConfirmation: 18,
        };

        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);
        // mock getCoveringBoxes
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const getCoveringBoxesSpy = vi.spyOn(
          (ergoChain as any).boxSelection, // eslint-disable-line @typescript-eslint/no-explicit-any
          'getCoveringBoxes',
        );
        getCoveringBoxesSpy.mockResolvedValue({
          covered: true,
          boxes: paymentTx.inputBoxes
            .slice(1)
            .map((serializedBox) =>
              wasm.ErgoBox.sigma_parse_bytes(serializedBox),
            ),
        });

        // mock getMempoolBoxMapping (the box itself doesn't matter)
        const mempoolTrackMap = new Map<string, wasm.ErgoBox | undefined>();
        mempoolTrackMap.set(
          'boxId',
          ergoTestUtils.toErgoBox(boxTestData.ergoBox2),
        );
        const getMempoolBoxMappingSpy = vi.spyOn(
          ergoChain,
          'getMempoolBoxMapping',
        );
        getMempoolBoxMappingSpy.mockResolvedValue(mempoolTrackMap);

        // run test
        const result = await ergoChain.generateTransaction(
          paymentTx.eventId,
          paymentTx.txType,
          order,
          [],
          [],
          inputs,
          dataInputs,
        );

        // check returned value
        //  PaymentTransaction inputs, dataInputs, eventId and txType should be as expected
        const ergoTx = result as ErgoTransaction;
        expect(ergoTx.inputBoxes).toEqual(paymentTx.inputBoxes);
        expect(ergoTx.dataInputs).toEqual(paymentTx.dataInputs);
        expect(ergoTx.eventId).toEqual(paymentTx.eventId);
        expect(ergoTx.txType).toEqual(paymentTx.txType);
        //  extracted order of generated transaction should be the same as input order
        const extractedOrder = ergoChain.extractTransactionOrder(result);
        expect(extractedOrder).toEqual(order);
        //  transaction fee should be the same as config fee
        const tx = wasm.ReducedTransaction.sigma_parse_bytes(
          result.txBytes,
        ).unsigned_tx();
        let boxChecked = false;
        for (let i = 0; i < tx.output_candidates().len(); i++) {
          if (
            tx.output_candidates().get(i).ergo_tree().to_base16_bytes() ===
            ErgoChain.feeBoxErgoTree
          ) {
            expect(
              BigInt(tx.output_candidates().get(i).value().as_i64().to_str()),
            ).toEqual(config.fee);
            boxChecked = true;
          }
        }
        expect(boxChecked).toEqual(true);
        // two change boxes should be as expected
        const outputsLength = tx.output_candidates().len();
        const changeBox1 = tx.output_candidates().get(outputsLength - 3);
        expect(changeBox1.value().as_i64().to_str()).toEqual(
          transactionTestData.transaction3ChangeBox1Assets.nativeToken.toString(),
        );
        const changeBox1Tokens = changeBox1.tokens();
        expect(changeBox1Tokens.len()).toEqual(
          transactionTestData.transaction3ChangeBox1Assets.tokens.length,
        );
        for (let i = 0; i < changeBox1Tokens.len(); i++) {
          const token = changeBox1Tokens.get(i);
          expect(token.id().to_str()).toEqual(
            transactionTestData.transaction3ChangeBox1Assets.tokens[i].id,
          );
          expect(token.amount().as_i64().to_str()).toEqual(
            transactionTestData.transaction3ChangeBox1Assets.tokens[
              i
            ].value.toString(),
          );
        }
        const changeBox2 = tx.output_candidates().get(outputsLength - 2);
        expect(changeBox2.value().as_i64().to_str()).toEqual(
          transactionTestData.transaction3ChangeBox2Assets.nativeToken.toString(),
        );
        const changeBox2Tokens = changeBox2.tokens();
        expect(changeBox2Tokens.len()).toEqual(
          transactionTestData.transaction3ChangeBox2Assets.tokens.length,
        );
        for (let i = 0; i < changeBox2Tokens.len(); i++) {
          const token = changeBox2Tokens.get(i);
          expect(token.id().to_str()).toEqual(
            transactionTestData.transaction3ChangeBox2Assets.tokens[i].id,
          );
          expect(token.amount().as_i64().to_str()).toEqual(
            transactionTestData.transaction3ChangeBox2Assets.tokens[
              i
            ].value.toString(),
          );
        }
      });

      /**
       * @target ErgoChain.generateTransaction should throw appropriate
       * error when locked assets are not enough to generate transaction
       * @dependencies
       * @scenario
       * - mock transaction order, input and data input boxes
       * - mock an AssetBalance as lock address assets lacking enough assets
       * - mock a network object
       *   - mock 'getHeight'
       *   - mock 'getStateContext'
       *   - mock 'getAddressAssets' to return mocked assets
       * - mock chain config
       * - run test and expect exception thrown
       * @expected
       * - it should thrown NotEnoughAssetsError
       */
      it('should throw appropriate error when locked assets are not enough to generate transaction', async () => {
        // mock transaction order, input and data input boxes
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );
        const order = transactionTestData.transaction3Order;
        const inputs = [Buffer.from(paymentTx.inputBoxes[0]).toString('hex')];
        const dataInputs = paymentTx.dataInputs.map((serializedBox) =>
          Buffer.from(serializedBox).toString('hex'),
        );

        // mock an AssetBalance as lock address assets lacking enough assets
        const mockedLockAssets = {
          nativeToken: 1000000n,
          tokens: [],
        };

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getHeight'
        const getHeightSpy = vi.spyOn(network, 'getHeight');
        getHeightSpy.mockResolvedValue(966000);
        // mock 'getStateContext'
        const getStateContextSpy = vi.spyOn(network, 'getStateContext');
        getStateContextSpy.mockResolvedValue(
          transactionTestData.mockedStateContext,
        );
        // mock 'getAddressAssets' to return mocked assets
        const getAddressAssetsSpy = vi.spyOn(network, 'getAddressAssets');
        getAddressAssetsSpy.mockResolvedValue(mockedLockAssets);

        // mock chain config
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 300000n,
          eventTxConfirmation: 18,
        };

        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);
        // run test and expect exception thrown
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        await expect(async () => {
          await ergoChain.generateTransaction(
            paymentTx.eventId,
            paymentTx.txType,
            order,
            [],
            [],
            inputs,
            dataInputs,
          );
        }).rejects.toThrow(NotEnoughAssetsError);
      });

      /**
       * @target ErgoChain.generateTransaction should throw appropriate
       * error when available boxes cannot cover required assets to generate
       * transaction
       * @dependencies
       * @scenario
       * - mock transaction order, input and data input boxes
       * - mock an AssetBalance as lock address assets with enough assets
       * - mock a network object
       *   - mock 'getHeight'
       *   - mock 'getStateContext'
       *   - mock 'getAddressAssets' to return mocked assets
       *   - mock 'getMempoolTransactions' to return empty list
       * - mock chain config
       * - mock getCoveringBoxes to return NOT covered
       * - run test and expect exception thrown
       * @expected
       * - it should thrown NotEnoughValidBoxesError
       */
      it('should throw appropriate error when available boxes cannot cover required assets to generate transaction', async () => {
        // mock transaction order, input and data input boxes
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );
        const order = transactionTestData.transaction3Order;
        const inputs = [Buffer.from(paymentTx.inputBoxes[0]).toString('hex')];
        const dataInputs = paymentTx.dataInputs.map((serializedBox) =>
          Buffer.from(serializedBox).toString('hex'),
        );

        // mock an AssetBalance as lock address assets with enough assets
        const mockedLockAssets = {
          nativeToken: 50000000n,
          tokens: [
            {
              id: '10278c102bf890fdab8ef5111e94053c90b3541bc25b0de2ee8aa6305ccec3de',
              value: 5000n,
            },
            {
              id: ergoTestUtils.generateRandomId(),
              value: 100000n,
            },
          ],
        };

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getHeight'
        const getHeightSpy = vi.spyOn(network, 'getHeight');
        getHeightSpy.mockResolvedValue(966000);
        // mock 'getStateContext'
        const getStateContextSpy = vi.spyOn(network, 'getStateContext');
        getStateContextSpy.mockResolvedValue(
          transactionTestData.mockedStateContext,
        );
        // mock 'getAddressAssets' to return mocked assets
        const getAddressAssetsSpy = vi.spyOn(network, 'getAddressAssets');
        getAddressAssetsSpy.mockResolvedValue(mockedLockAssets);
        // mock 'getMempoolTransactions'
        const getMempoolTransactionsSpy = vi.spyOn(
          network,
          'getMempoolTransactions',
        );
        getMempoolTransactionsSpy.mockResolvedValue([]);

        // mock chain config
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 300000n,
          eventTxConfirmation: 18,
        };

        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);
        // mock getCoveringBoxes
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const getCoveringBoxesSpy = vi.spyOn(
          (ergoChain as any).boxSelection, // eslint-disable-line @typescript-eslint/no-explicit-any
          'getCoveringBoxes',
        );
        getCoveringBoxesSpy.mockResolvedValue({
          covered: false,
          boxes: paymentTx.inputBoxes
            .slice(1, 2)
            .map((serializedBox) =>
              wasm.ErgoBox.sigma_parse_bytes(serializedBox),
            ),
        });

        // run test and expect exception thrown
        await expect(async () => {
          await ergoChain.generateTransaction(
            paymentTx.eventId,
            paymentTx.txType,
            order,
            [],
            [],
            inputs,
            dataInputs,
          );
        }).rejects.toThrow(NotEnoughValidBoxesError);
      });

      /**
       * @target ErgoChain.generateTransaction should filter boxes that
       * are used in unsigned transactions successfully
       * @dependencies
       * @scenario
       * - mock transaction order, input and data input boxes
       * - mock an unsigned transaction with it's input boxes
       * - mock an AssetBalance as lock address assets with enough assets
       * - mock a network object
       *   - mock 'getHeight'
       *   - mock 'getStateContext'
       *   - mock 'getAddressAssets' to return mocked assets
       *   - mock 'getMempoolTransactions' to return empty list
       * - mock chain config
       * - mock getCoveringBoxes
       *   - returns NOT covered when forbiddenBoxIds argument contains
       *     right ids
       *   - otherwise returns covered
       * - run test and expect exception thrown
       * @expected
       * - it should thrown NotEnoughValidBoxesError
       */
      it('should filter boxes that are used in unsigned transactions successfully', async () => {
        // mock transaction order, input and data input boxes
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );
        const order = transactionTestData.transaction3Order;
        const inputs = [Buffer.from(paymentTx.inputBoxes[0]).toString('hex')];
        const dataInputs = paymentTx.dataInputs.map((serializedBox) =>
          Buffer.from(serializedBox).toString('hex'),
        );

        // mock an unsigned transaction with it's input boxess
        const unsignedTransaction = ErgoTransaction.fromJson(
          transactionTestData.transaction2PartialUnsignedPaymentTransaction,
        );
        const unsignedTxInputBoxIds =
          transactionTestData.transaction2InputBoxIds;

        // mock an AssetBalance as lock address assets with enough assets
        const mockedLockAssets = {
          nativeToken: 50000000n,
          tokens: [
            {
              id: '10278c102bf890fdab8ef5111e94053c90b3541bc25b0de2ee8aa6305ccec3de',
              value: 5000n,
            },
            {
              id: ergoTestUtils.generateRandomId(),
              value: 100000n,
            },
          ],
        };

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getHeight'
        const getHeightSpy = vi.spyOn(network, 'getHeight');
        getHeightSpy.mockResolvedValue(966000);
        // mock 'getStateContext'
        const getStateContextSpy = vi.spyOn(network, 'getStateContext');
        getStateContextSpy.mockResolvedValue(
          transactionTestData.mockedStateContext,
        );
        // mock 'getAddressAssets' to return mocked assets
        const getAddressAssetsSpy = vi.spyOn(network, 'getAddressAssets');
        getAddressAssetsSpy.mockResolvedValue(mockedLockAssets);
        // mock 'getMempoolTransactions'
        const getMempoolTransactionsSpy = vi.spyOn(
          network,
          'getMempoolTransactions',
        );
        getMempoolTransactionsSpy.mockResolvedValue([]);

        // mock chain config
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 300000n,
          eventTxConfirmation: 18,
        };

        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);

        // mock getCoveringBoxes
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const getCoveringBoxesSpy = vi.spyOn(
          (ergoChain as any).boxSelection, // eslint-disable-line @typescript-eslint/no-explicit-any
          'getCoveringBoxes',
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getCoveringBoxesSpy.mockImplementation(async (...args: any[]) => {
          const forbiddenBoxIds = args[1] as Array<string>;
          // returns NOT covered when forbiddenBoxIds argument equals to expected value
          if (
            forbiddenBoxIds.length === 1 &&
            forbiddenBoxIds[0] === unsignedTxInputBoxIds[0]
          )
            return {
              covered: false,
              boxes: [],
            };
          // otherwise returns covered
          else
            return {
              covered: true,
              boxes: paymentTx.inputBoxes
                .slice(1)
                .map((serializedBox) =>
                  wasm.ErgoBox.sigma_parse_bytes(serializedBox),
                ),
            };
        });

        // run test and expect exception thrown
        await expect(async () => {
          await ergoChain.generateTransaction(
            paymentTx.eventId,
            paymentTx.txType,
            order,
            [unsignedTransaction],
            [],
            inputs,
            dataInputs,
          );
        }).rejects.toThrow(NotEnoughValidBoxesError);
      });

      /**
       * @target ErgoChain.generateTransaction should generate payment
       * transaction with wrapped order successfully
       * @dependencies
       * @scenario
       * - mock transaction order, input and data input boxes
       * - mock an AssetBalance as lock address assets with enough assets
       * - mock a network object
       *   - mock 'getHeight'
       *   - mock 'getStateContext'
       *   - mock 'getAddressAssets' to return mocked assets
       *   - mock 'getMempoolTransactions' to return empty list
       * - mock chain config
       * - mock getCoveringBoxes
       * - mock getMempoolBoxMapping
       * - run test
       * - check attributes of returned value
       * @expected
       * - PaymentTransaction inputs, dataInputs, eventId and txType should be as
       *   expected
       * - extracted order of generated transaction should be the same as input
       *   order
       * - transaction fee should be the same as config fee
       * - two change boxes should be as expected
       */
      it('should generate payment transaction with wrapped order successfully', async () => {
        // mock transaction order, input and data input boxes
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );
        const order = transactionTestData.transaction3WrappedOrder;
        const inputs = [Buffer.from(paymentTx.inputBoxes[0]).toString('hex')];
        const dataInputs = paymentTx.dataInputs.map((serializedBox) =>
          Buffer.from(serializedBox).toString('hex'),
        );

        // mock an AssetBalance as lock address assets with enough assets
        const mockedLockAssets = {
          nativeToken: 50000000n,
          tokens: [
            {
              id: '10278c102bf890fdab8ef5111e94053c90b3541bc25b0de2ee8aa6305ccec3de',
              value: 5000n,
            },
            {
              id: ergoTestUtils.generateRandomId(),
              value: 100000n,
            },
          ],
        };

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getHeight'
        const getHeightSpy = vi.spyOn(network, 'getHeight');
        getHeightSpy.mockResolvedValue(966000);
        // mock 'getStateContext'
        const getStateContextSpy = vi.spyOn(network, 'getStateContext');
        getStateContextSpy.mockResolvedValue(
          transactionTestData.mockedStateContext,
        );
        // mock 'getAddressAssets' to return mocked assets
        const getAddressAssetsSpy = vi.spyOn(network, 'getAddressAssets');
        getAddressAssetsSpy.mockResolvedValue(mockedLockAssets);
        // mock 'getMempoolTransactions'
        const getMempoolTransactionsSpy = vi.spyOn(
          network,
          'getMempoolTransactions',
        );
        getMempoolTransactionsSpy.mockResolvedValue([]);

        // mock chain config
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 300000n,
          eventTxConfirmation: 18,
        };
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.multiDecimalTokenMap);

        // mock getCoveringBoxes
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const getCoveringBoxesSpy = vi.spyOn(
          (ergoChain as any).boxSelection, // eslint-disable-line @typescript-eslint/no-explicit-any
          'getCoveringBoxes',
        );
        getCoveringBoxesSpy.mockResolvedValue({
          covered: true,
          boxes: paymentTx.inputBoxes
            .slice(1)
            .map((serializedBox) =>
              wasm.ErgoBox.sigma_parse_bytes(serializedBox),
            ),
        });

        // mock getMempoolBoxMapping (the box itself doesn't matter)
        const mempoolTrackMap = new Map<string, wasm.ErgoBox | undefined>();
        mempoolTrackMap.set(
          'boxId',
          ergoTestUtils.toErgoBox(boxTestData.ergoBox2),
        );
        const getMempoolBoxMappingSpy = vi.spyOn(
          ergoChain,
          'getMempoolBoxMapping',
        );
        getMempoolBoxMappingSpy.mockResolvedValue(mempoolTrackMap);

        // run test
        const result = await ergoChain.generateTransaction(
          paymentTx.eventId,
          paymentTx.txType,
          order,
          [],
          [],
          inputs,
          dataInputs,
        );

        // check returned value
        //  PaymentTransaction inputs, dataInputs, eventId and txType should be as expected
        const ergoTx = result as ErgoTransaction;
        expect(ergoTx.inputBoxes).toEqual(paymentTx.inputBoxes);
        expect(ergoTx.dataInputs).toEqual(paymentTx.dataInputs);
        expect(ergoTx.eventId).toEqual(paymentTx.eventId);
        expect(ergoTx.txType).toEqual(paymentTx.txType);
        //  extracted order of generated transaction should be the same as input order
        const extractedOrder = ergoChain.extractTransactionOrder(result);
        expect(extractedOrder).toEqual(order);
        //  transaction fee should be the same as config fee
        const tx = wasm.ReducedTransaction.sigma_parse_bytes(
          result.txBytes,
        ).unsigned_tx();
        let boxChecked = false;
        for (let i = 0; i < tx.output_candidates().len(); i++) {
          if (
            tx.output_candidates().get(i).ergo_tree().to_base16_bytes() ===
            ErgoChain.feeBoxErgoTree
          ) {
            expect(
              BigInt(tx.output_candidates().get(i).value().as_i64().to_str()),
            ).toEqual(config.fee);
            boxChecked = true;
          }
        }
        expect(boxChecked).toEqual(true);
        // two change boxes should be as expected
        const outputsLength = tx.output_candidates().len();
        const changeBox1 = tx.output_candidates().get(outputsLength - 3);
        expect(changeBox1.value().as_i64().to_str()).toEqual(
          transactionTestData.transaction3ChangeBox1Assets.nativeToken.toString(),
        );
        const changeBox1Tokens = changeBox1.tokens();
        expect(changeBox1Tokens.len()).toEqual(
          transactionTestData.transaction3ChangeBox1Assets.tokens.length,
        );
        for (let i = 0; i < changeBox1Tokens.len(); i++) {
          const token = changeBox1Tokens.get(i);
          expect(token.id().to_str()).toEqual(
            transactionTestData.transaction3ChangeBox1Assets.tokens[i].id,
          );
          expect(token.amount().as_i64().to_str()).toEqual(
            transactionTestData.transaction3ChangeBox1Assets.tokens[
              i
            ].value.toString(),
          );
        }
        const changeBox2 = tx.output_candidates().get(outputsLength - 2);
        expect(changeBox2.value().as_i64().to_str()).toEqual(
          transactionTestData.transaction3ChangeBox2Assets.nativeToken.toString(),
        );
        const changeBox2Tokens = changeBox2.tokens();
        expect(changeBox2Tokens.len()).toEqual(
          transactionTestData.transaction3ChangeBox2Assets.tokens.length,
        );
        for (let i = 0; i < changeBox2Tokens.len(); i++) {
          const token = changeBox2Tokens.get(i);
          expect(token.id().to_str()).toEqual(
            transactionTestData.transaction3ChangeBox2Assets.tokens[i].id,
          );
          expect(token.amount().as_i64().to_str()).toEqual(
            transactionTestData.transaction3ChangeBox2Assets.tokens[
              i
            ].value.toString(),
          );
        }
      });
    });

    describe('getTransactionAssets', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.getTransactionAssets should get transaction assets
       * successfully
       * @dependencies
       * @scenario
       * - mock PaymentTransaction
       * - run test
       * - check returned value
       * @expected
       * - it should return mocked transaction assets
       */
      it('should get transaction assets successfully', async () => {
        // mock PaymentTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );
        const expectedAssets = transactionTestData.transaction3Assets;

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.getTransactionAssets(paymentTx);

        // check returned value
        expect(result).toEqual(expectedAssets);
      });

      /**
       * @target ErgoChain.getTransactionAssets should wrap transaction assets
       * successfully
       * @dependencies
       * @scenario
       * - mock PaymentTransaction
       * - run test
       * - check returned value
       * @expected
       * - it should return mocked transaction assets
       */
      it('should wrap transaction assets successfully', async () => {
        // mock PaymentTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );
        const expectedAssets = transactionTestData.transaction3WrappedAssets;

        // run test
        const ergoChain =
          await ergoTestUtils.generateDefaultChainObjectWithTokenMap(
            network,
            ergoTestUtils.multiDecimalTokenMap,
          );
        const result = await ergoChain.getTransactionAssets(paymentTx);

        // check returned value
        expect(result).toEqual(expectedAssets);
      });
    });

    describe('extractTransactionOrder', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.extractTransactionOrder should extract transaction
       * order successfully
       * @dependencies
       * @scenario
       * - mock PaymentTransaction
       * - run test
       * - check returned value
       * @expected
       * - it should return mocked transaction order
       */
      it('should extract transaction order successfully', async () => {
        // mock PaymentTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction6PaymentTransaction,
        );
        const expectedOrder = transactionTestData.transaction6Order;
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: transactionTestData.transaction6InAddress,
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };

        // run test
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result = ergoChain.extractTransactionOrder(paymentTx);

        // check returned value
        expect(result).toEqual(expectedOrder);
      });

      /**
       * @target ErgoChain.extractTransactionOrder should wrap transaction
       * order successfully
       * @dependencies
       * @scenario
       * - mock PaymentTransaction
       * - run test
       * - check returned value
       * @expected
       * - it should return mocked transaction order
       */
      it('should wrap transaction order successfully', async () => {
        // mock PaymentTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction6PaymentTransaction,
        );
        const expectedOrder = transactionTestData.transaction6WrappedOrder;
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: transactionTestData.transaction6InAddress,
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };

        // run test
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.multiDecimalTokenMap);
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result = ergoChain.extractTransactionOrder(paymentTx);

        // check returned value
        expect(result).toEqual(expectedOrder);
      });
    });

    describe('verifyTransactionFee', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.verifyTransactionFee should return true when fee is
       * less than config fee
       * @dependencies
       * @scenario
       * - mock PaymentTransaction
       * - mock a config that has more fee comparing to mocked transaction fee
       * - run test
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should return true when fee is less than config fee', async () => {
        // mock PaymentTransaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          wasm.ReducedTransaction.sigma_parse_bytes(
            Buffer.from(
              transactionTestData.transaction2UnsignedSerialized,
              'hex',
            ),
          ).sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // mock a config that has more fee comparing to mocked transaction fee
        const config: ErgoConfigs = {
          fee: 1200000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: boxTestData.testLockAddress,
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };

        // run test
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result = await ergoChain.verifyTransactionFee(paymentTx);

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target ErgoChain.verifyTransactionFee should return false when fee is
       * more than config fee
       * @dependencies
       * @scenario
       * - mock PaymentTransaction
       * - mock a config that has less fee comparing to mocked transaction fee
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when fee is more than config fee', async () => {
        // mock PaymentTransaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          wasm.ReducedTransaction.sigma_parse_bytes(
            Buffer.from(
              transactionTestData.transaction2UnsignedSerialized,
              'hex',
            ),
          ).sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // mock a config that has less fee comparing to mocked transaction fee
        const config: ErgoConfigs = {
          fee: 100n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: boxTestData.testLockAddress,
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };

        // run test
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result = await ergoChain.verifyTransactionFee(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });
    });

    describe('verifyLockTransactionExtraConditions', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.verifyLockTransactionExtraConditions should return false when
       * output box creation height is more than a year ago
       * @dependencies
       * @scenario
       * - mock a tx with block info
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when output box creation height is more than a year ago', async () => {
        const blockInfo: BlockInfo = {
          hash: ergoTestUtils.generateRandomId(),
          parentHash: ergoTestUtils.generateRandomId(),
          height: 2000000,
        };
        const mockedTx = ergoTestUtils.deserializeTransaction(
          transactionTestData.transaction2SignedSerialized,
        );

        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.verifyLockTransactionExtraConditions(
          mockedTx,
          blockInfo,
        );

        expect(result).toEqual(false);
      });

      /**
       * @target ErgoChain.verifyLockTransactionExtraConditions should return true when
       * all output boxes creation heights are fresh
       * @dependencies
       * @scenario
       * - mock a tx with block info
       * - run test
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should return true when all output boxes creation heights are fresh', async () => {
        const blockInfo: BlockInfo = {
          hash: ergoTestUtils.generateRandomId(),
          parentHash: ergoTestUtils.generateRandomId(),
          height: 100000,
        };
        const mockedTx = ergoTestUtils.deserializeTransaction(
          transactionTestData.transaction2SignedSerialized,
        );

        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.verifyLockTransactionExtraConditions(
          mockedTx,
          blockInfo,
        );

        expect(result).toEqual(true);
      });
    });

    describe('verifyTransactionExtraConditions', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.verifyTransactionExtraConditions should return true
       * when change box conditions are met
       * @dependencies
       * @scenario
       * - mock valid PaymentTransaction
       * - mock a config with valid lockAddress
       * - run test
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should return true when change box conditions are met', async () => {
        // mock PaymentTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );

        // mock a config with valid lockAddress
        const config: ErgoConfigs = {
          fee: 1200000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);

        // run test
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result =
          await ergoChain.verifyTransactionExtraConditions(paymentTx);

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target ErgoChain.verifyTransactionExtraConditions should return true
       * event when signing status is wrong
       * @dependencies
       * @scenario
       * - mock valid PaymentTransaction
       * - mock a config with valid lockAddress
       * - run test with signing status as signed
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should return true event when signing status is wrong', async () => {
        // mock PaymentTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction3PaymentTransaction,
        );

        // mock a config with valid lockAddress
        const config: ErgoConfigs = {
          fee: 1200000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);

        // run test
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result = await ergoChain.verifyTransactionExtraConditions(
          paymentTx,
          SigningStatus.Signed,
        );

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target ErgoChain.verifyTransactionExtraConditions should return true
       * when change box conditions are met for signed transaction
       * @dependencies
       * @scenario
       * - mock PaymentTransaction of signed transaction
       * - mock a config with valid lockAddress
       * - run test
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should return true when change box conditions are met for signed transaction', async () => {
        // mock PaymentTransaction of signed transaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          wasm.Transaction.sigma_parse_bytes(
            Buffer.from(
              transactionTestData.transaction2SignedSerialized,
              'hex',
            ),
          ).sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // mock a config with valid lockAddress
        const config: ErgoConfigs = {
          fee: 1200000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);

        // run test
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result = await ergoChain.verifyTransactionExtraConditions(
          paymentTx,
          SigningStatus.Signed,
        );

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target ErgoChain.verifyTransactionExtraConditions should return false
       * when change box has value in R4
       * @dependencies
       * @scenario
       * - mock PaymentTransaction with value in change box R4
       * - mock a config with valid lockAddress
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when change box has value in R4', async () => {
        // mock PaymentTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction4PaymentTransaction,
        );

        // mock a config with valid lockAddress
        const config: ErgoConfigs = {
          fee: 1200000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);

        // run test
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result =
          await ergoChain.verifyTransactionExtraConditions(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target ErgoChain.verifyTransactionExtraConditions should return false
       * when output creation height is less than an input
       * @dependencies
       * @scenario
       * - mock valid PaymentTransaction
       * - mock a config with valid lockAddress
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when output creation height is less than an input', async () => {
        // mock PaymentTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction7PaymentTransaction,
        );

        // mock a config with valid lockAddress
        const config: ErgoConfigs = {
          fee: 1200000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: 'nB3L2PD3LG4ydEj62n9aymRyPCEbkBdzaubgvCWDH2oxHxFBfAUy9GhWDvteDbbUh5qhXxnW8R46qmEiZfkej8gt4kZYvbeobZJADMrWXwFJTsZ17euEcoAp3KDk31Q26okFpgK9SKdi4',
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud_addr',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);

        // run test
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result =
          await ergoChain.verifyTransactionExtraConditions(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });
    });

    describe('isTxValid', () => {
      /**
       * @target ErgoChain.isTxValid should return true when all inputs are valid
       * @dependencies
       * @scenario
       * - mock a network object to return as valid for all inputs of a mocked
       *   transaction
       * - mock PaymentTransaction
       * - run test
       * - check returned value
       * - check if function got called
       * @expected
       * - it should return true with no details
       * - `isBoxUnspentAndValid` should have been called for all inputs
       */
      it('should return true when all inputs are valid', async () => {
        // mock a network object to return as valid for all inputs of a mocked transaction
        const network = new TestErgoNetwork();
        const isBoxUnspentAndValidSpy = vi.spyOn(
          network,
          'isBoxUnspentAndValid',
        );
        isBoxUnspentAndValidSpy.mockResolvedValue(true);

        // mock PaymentTransaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          ergoTestUtils
            .toTransaction(transactionTestData.transaction0)
            .sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.isTxValid(paymentTx);

        // check returned value
        expect(result).toEqual({
          isValid: true,
          details: undefined,
        });

        // check if function got called
        expect(isBoxUnspentAndValidSpy).toHaveBeenNthCalledWith(
          1,
          transactionTestData.transaction0InputIds[0],
        );
        expect(isBoxUnspentAndValidSpy).toHaveBeenNthCalledWith(
          2,
          transactionTestData.transaction0InputIds[1],
        );
        expect(isBoxUnspentAndValidSpy).toHaveBeenNthCalledWith(
          3,
          transactionTestData.transaction0InputIds[2],
        );
      });

      /**
       * @target ErgoChain.isTxValid should return false when at least one input
       * is invalid
       * @dependencies
       * @scenario
       * - mock a network object to return as valid for all inputs of a mocked
       *   transaction except for the first one
       * - mock PaymentTransaction
       * - run test
       * - check returned value
       * - check if function got called
       * @expected
       * - it should return false and as expected invalidation
       * - `isBoxUnspentAndValid` should have been called only for the first box
       */
      it('should return false when at least one input is invalid', async () => {
        // mock a network object to return as valid for all inputs of a mocked transaction except for the first one
        const network = new TestErgoNetwork();
        const isBoxUnspentAndValidSpy = vi.spyOn(
          network,
          'isBoxUnspentAndValid',
        );
        isBoxUnspentAndValidSpy
          .mockResolvedValueOnce(false)
          .mockResolvedValue(true);

        // mock PaymentTransaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          ergoTestUtils
            .toTransaction(transactionTestData.transaction0)
            .sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.isTxValid(paymentTx);

        // check returned value
        expect(result).toEqual({
          isValid: false,
          details: {
            reason: expect.any(String),
            unexpected: false,
          },
        });

        // check if function got called
        expect(isBoxUnspentAndValidSpy).toHaveBeenCalledExactlyOnceWith(
          transactionTestData.transaction0InputIds[0],
        );
      });
    });

    describe('signTransaction', () => {
      const ergoChain = ergoTestUtils.generateChainObject(
        new TestErgoNetwork(),
      );

      /**
       * @target ErgoChain.signTransaction should return PaymentTransaction of the
       * signed transaction
       * @dependencies
       * @scenario
       * - mock a sign function to return signed transaction
       * - mock PaymentTransaction of unsigned transaction
       * - run test
       * - check returned value
       * @expected
       * - it should return PaymentTransaction of signed transaction (all fields
       *   are same as input object, except txBytes which is signed transaction)
       */
      it('should return PaymentTransaction of the signed transaction', async () => {
        // mock PaymentTransaction of unsigned transaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          wasm.ReducedTransaction.sigma_parse_bytes(
            Buffer.from(
              transactionTestData.transaction2UnsignedSerialized,
              'hex',
            ),
          ).sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // run test
        const result = (await ergoChain.signTransaction(
          paymentTx,
          0,
        )) as ErgoTransaction;

        // check returned value
        expect(result.txId).toEqual(paymentTx.txId);
        expect(result.eventId).toEqual(paymentTx.eventId);
        expect(result.txBytes).toEqual(
          ergoTestUtils
            .deserializeTransaction(
              transactionTestData.transaction2SignedSerialized,
            )
            .sigma_serialize_bytes(),
        );
        expect(result.inputBoxes).toEqual(paymentTx.inputBoxes);
        expect(result.dataInputs).toEqual(paymentTx.dataInputs);
        expect(result.txType).toEqual(paymentTx.txType);
      });

      /**
       * @target ErgoChain.signTransaction should throw error when signing failed
       * @dependencies
       * @scenario
       * - mock a sign function to throw error
       * - mock PaymentTransaction of unsigned transaction
       * - run test & check thrown exception
       * @expected
       * - it should throw the exact error thrown by sign function
       */
      it('should throw error when signing failed', async () => {
        // mock a sign function to throw error
        const signFunction = async (
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          tx: wasm.ReducedTransaction,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          requiredSign: number,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          boxes: Array<wasm.ErgoBox>,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          dataBoxes?: Array<wasm.ErgoBox>,
        ): Promise<wasm.Transaction> => {
          throw Error(`TestError: sign failed`);
        };
        const ergoChain = ergoTestUtils.generateChainObject(
          new TestErgoNetwork(),
          ergoTestUtils.rwtId,
          { sign: signFunction, isInSign: vi.fn() },
        );
        // mock PaymentTransaction of unsigned transaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          wasm.ReducedTransaction.sigma_parse_bytes(
            Buffer.from(
              transactionTestData.transaction2UnsignedSerialized,
              'hex',
            ),
          ).sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // run test & check thrown exception
        await expect(async () => {
          await ergoChain.signTransaction(paymentTx, 0);
        }).rejects.toThrow(`TestError: sign failed`);
      });
    });

    describe('isTransactionInSign', () => {
      const ergoChain = ergoTestUtils.generateChainObject(
        new TestErgoNetwork(),
      );

      /**
       * @target ErgoChain.isTransactionInSign should return true if transaction is in sign
       * @dependencies
       * @scenario
       * - mock PaymentTransaction of unsigned transaction
       * - run test (ergoChain default signMediator returns true when asked the status for any txId)
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should return true if transaction is in sign', async () => {
        // mock PaymentTransaction of unsigned transaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          wasm.ReducedTransaction.sigma_parse_bytes(
            Buffer.from(
              transactionTestData.transaction2UnsignedSerialized,
              'hex',
            ),
          ).sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // run test
        const result = await ergoChain.isTransactionInSign(paymentTx);

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target ErgoChain.isTransactionInSign should return false when transaction is not in sign
       * @dependencies
       * @scenario
       * - mock an isinSignFunction to return false
       * - mock PaymentTransaction of unsigned transaction
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when transaction is not in sign', async () => {
        // mock an isinSignFunction to return false
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const isInSignFunction = async (txId: string): Promise<boolean> => {
          return false;
        };
        const ergoChain = ergoTestUtils.generateChainObject(
          new TestErgoNetwork(),
          ergoTestUtils.rwtId,
          { sign: vi.fn(), isInSign: isInSignFunction },
        );
        // mock PaymentTransaction of unsigned transaction
        const paymentTx = new ErgoTransaction(
          'txId',
          'eventId',
          wasm.ReducedTransaction.sigma_parse_bytes(
            Buffer.from(
              transactionTestData.transaction2UnsignedSerialized,
              'hex',
            ),
          ).sigma_serialize_bytes(),
          TransactionType.payment,
          [],
          [],
        );

        // run test
        const result = await ergoChain.isTransactionInSign(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });
    });

    describe('isTxInMempool', () => {
      /**
       * @target ErgoChain.isTxInMempool should true when tx is in mempool
       * @dependencies
       * @scenario
       * - mock list of transactions
       * - mock a network object to return mocked transactions for mempool
       * - get txId of one of the transactions
       * - run test
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should true when tx is in mempool', async () => {
        // mock list of transactions
        const transactions = [
          transactionTestData.transaction0,
          transactionTestData.transaction1,
        ].map(ergoTestUtils.toTransaction);

        // mock a network object to return mocked transactions for mempool
        const network = new TestErgoNetwork();
        vi.spyOn(network, 'getMempoolTransactions').mockResolvedValueOnce(
          transactions,
        );

        // get txId of one of the transactions
        const txId = transactions[0].id().to_str();

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.isTxInMempool(txId);

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target ErgoChain.isTxInMempool should return false when tx is NOT in mempool
       * @dependencies
       * @scenario
       * - mock list of transactions
       * - mock a network object to return mocked transactions for mempool
       * - generate a random txId
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when tx is NOT in mempool', async () => {
        // mock list of transactions
        const transactions = [
          transactionTestData.transaction0,
          transactionTestData.transaction1,
        ].map(ergoTestUtils.toTransaction);

        // mock a network object to return mocked transactions for mempool
        const network = new TestErgoNetwork();
        vi.spyOn(network, 'getMempoolTransactions').mockResolvedValueOnce(
          transactions,
        );

        // generate a random txId
        const txId = ergoTestUtils.generateRandomId();

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.isTxInMempool(txId);

        // check returned value
        expect(result).toEqual(false);
      });
    });

    describe('getMempoolBoxMapping', () => {
      const trackingAddress =
        'nB3L2PD3LBtiNhDYK7XhZ8nVt6uekBXN7RcPUKgdKLXFcrJiSPxmQsUKuUkTRQ1hbvDrxEQAKYurGFbaGD1RPxU7XqQimD78j23HHMQKL1boUGsnNhCxaVNAYMcFbQNo355Af8cWkhAN6';

      /**
       * @target ErgoChain.getMempoolBoxMapping should construct mapping
       * successfully when no token provided
       * @dependencies
       * @scenario
       * - mock list of transactions with their box mapping
       * - mock a network object to return mocked transactions for mempool
       * - construct trackMap using transaction box mappings
       * - run test
       * - check returned value
       * @expected
       * - it should return constructed trackMap
       */
      it('should construct mapping successfully when no token provided', async () => {
        // mock list of transactions with their box mapping
        const transactions = [transactionTestData.transaction0].map(
          ergoTestUtils.toTransaction,
        );
        const boxMapping = transactionTestData.transaction0BoxMapping;

        // mock a network object to return mocked transactions for mempool
        const network = new TestErgoNetwork();
        vi.spyOn(network, 'getMempoolTransactions').mockResolvedValueOnce(
          transactions,
        );

        // construct trackMap using transaction box mappings
        const trackMap = new Map<string, string | undefined>();
        boxMapping.forEach((mapping) =>
          trackMap.set(mapping.inputId, mapping.serializedOutput),
        );

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.getMempoolBoxMapping(trackingAddress);

        // check returned value
        const constructedMap = new Map<string, string | undefined>();
        result.forEach((value, key) =>
          constructedMap.set(
            key,
            value
              ? Buffer.from(value.sigma_serialize_bytes()).toString('hex')
              : undefined,
          ),
        );
        expect(constructedMap).toEqual(trackMap);
      });

      /**
       * @target ErgoChain.getMempoolBoxMapping should construct mapping
       * successfully when token provided
       * @dependencies
       * @scenario
       * - mock list of transactions with their box mapping
       * - mock a network object to return mocked transactions for mempool
       * - construct trackMap using transaction box mappings
       * - run test
       * - check returned value
       * @expected
       * - it should return constructed trackMap
       */
      it('should construct mapping successfully when token provided', async () => {
        // mock list of transactions with their box mapping
        const transactions = [transactionTestData.transaction0].map(
          ergoTestUtils.toTransaction,
        );
        const boxMapping = transactionTestData.transaction0BoxMapping;
        const trackingTokenId =
          '03689941746717cddd05c52f454e34eb6e203a84f931fdc47c52f44589f83496';

        // mock a network object to return mocked transactions for mempool
        const network = new TestErgoNetwork();
        vi.spyOn(network, 'getMempoolTransactions').mockResolvedValueOnce(
          transactions,
        );

        // construct trackMap using transaction box mappings
        const trackMap = new Map<string, string | undefined>();
        boxMapping.forEach((mapping) =>
          trackMap.set(mapping.inputId, mapping.serializedOutput),
        );

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.getMempoolBoxMapping(
          trackingAddress,
          trackingTokenId,
        );

        // check returned value
        const constructedMap = new Map<string, string | undefined>();
        result.forEach((value, key) =>
          constructedMap.set(
            key,
            value
              ? Buffer.from(value.sigma_serialize_bytes()).toString('hex')
              : undefined,
          ),
        );
        expect(constructedMap).toEqual(trackMap);
      });

      /**
       * @target ErgoChain.getMempoolBoxMapping should construct mapping
       * successfully when token provided
       * @dependencies
       * @scenario
       * - mock list of transactions with their box mapping
       * - mock a network object to return mocked transactions for mempool
       * - construct trackMap using transaction box mappings (set outputs as
       *   undefined)
       * - run test
       * - check returned value
       * @expected
       * - it should return constructed trackMap
       */
      it('should map inputs to undefined when no valid output box found', async () => {
        // mock list of transactions with their box mapping
        const transactions = [transactionTestData.transaction0].map(
          ergoTestUtils.toTransaction,
        );
        const boxMapping = transactionTestData.transaction0BoxMapping;
        const trackingTokenId =
          '3f3add41746717cddd05c52f454e34eb98424408a931fdc47c52f44f0537f126';

        // mock a network object to return mocked transactions for mempool
        const network = new TestErgoNetwork();
        vi.spyOn(network, 'getMempoolTransactions').mockResolvedValueOnce(
          transactions,
        );

        // construct trackMap using transaction box mappings
        const trackMap = new Map<string, string | undefined>();
        boxMapping.forEach((mapping) =>
          trackMap.set(mapping.inputId, undefined),
        );

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.getMempoolBoxMapping(
          trackingAddress,
          trackingTokenId,
        );

        // check returned value
        expect(result).toEqual(trackMap);
      });
    });

    describe('getBoxInfo', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.getBoxInfo should get box id and assets successfully
       * @dependencies
       * @scenario
       * - mock an ErgoBox with assets
       * - construct serialized box and BoxInfo
       * - run test
       * - check returned value
       * @expected
       * - it should return constructed BoxInfo
       */
      it('should get box id and assets successfully', () => {
        // mock an ErgoBox with assets
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox1);
        const boxInfo: BoxInfo = {
          id: box.box_id().to_str(),
          assets: boxTestData.box1Assets,
        };

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (ergoChain as any).getBoxInfo(box);

        // check returned value
        expect(result).toEqual(boxInfo);
      });
    });

    describe('getBoxHeight', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.getBoxHeight should get box height successfully
       * @dependencies
       * @scenario
       * - mock an ErgoBox and construct serialized box
       * - run test
       * - check returned value
       * @expected
       * - it should return constructed BoxInfo
       */
      it('should get box height successfully', () => {
        // mock an ErgoBox and construct serialized box
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox1);
        const serializedBox = Buffer.from(box.sigma_serialize_bytes()).toString(
          'hex',
        );

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = ergoChain.getBoxHeight(serializedBox);

        // check returned value
        expect(result).toEqual(box.creation_height());
      });
    });

    describe('getBoxWID', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.getBoxWID should get box WID successfully
       * @dependencies
       * @scenario
       * - mock an ErgoBox with WID and construct serialized box
       * - run test
       * - check returned value
       * @expected
       * - it should return constructed BoxInfo
       */
      it('should get box WID successfully', () => {
        // mock an ErgoBox with WID and construct serialized box
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox2);
        const serializedBox = Buffer.from(box.sigma_serialize_bytes()).toString(
          'hex',
        );
        const wid =
          '97a2dabcd974d69a07c3a03e20d05a36d13b986ffca5670302997484dd87e247';

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = ergoChain.getBoxWID(serializedBox);

        // check returned value
        expect(result).toEqual(wid);
      });

      /**
       * @target ErgoChain.getBoxWID should throw Error when box has no WID
       * @dependencies
       * @scenario
       * - mock an ErgoBox without WID and construct serialized box
       * - run test and expect exception thrown
       * @expected
       * - it should throw Error
       */
      it('should throw Error when box has no WID', () => {
        // mock an ErgoBox without WID and construct serialized box
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox1);
        const serializedBox = Buffer.from(box.sigma_serialize_bytes()).toString(
          'hex',
        );

        // run test and expect exception thrown
        const ergoChain = ergoTestUtils.generateChainObject(network);
        expect(() => {
          ergoChain.getBoxWID(serializedBox);
        }).toThrow(Error);
      });
    });

    describe('getBoxRWT', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.getBoxRWT should get box RWT successfully
       * @dependencies
       * @scenario
       * - mock an ErgoBox with RWT and construct serialized box
       * - run test
       * - check returned value
       * @expected
       * - it should return RWT amount
       */
      it('should get box RWT successfully', () => {
        // mock an ErgoBox with RWT and construct serialized box
        const serializedBox = Buffer.from(
          ergoTestUtils
            .toErgoBox(boxTestData.eventBox1)
            .sigma_serialize_bytes(),
        ).toString('hex');

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = ergoChain.getBoxRWT(serializedBox);

        // check returned value
        expect(result).toEqual(10n);
      });

      /**
       * @target ErgoChain.getBoxRWT should wrap RWT amount successfully
       * @dependencies
       * @scenario
       * - mock an ErgoBox with RWT and construct serialized box
       * - run test
       * - check returned value
       * @expected
       * - it should return RWT amount
       */
      it('should wrap RWT amount successfully', async () => {
        // mock an ErgoBox with RWT and construct serialized box
        const serializedBox = Buffer.from(
          ergoTestUtils
            .toErgoBox(boxTestData.eventBox1)
            .sigma_serialize_bytes(),
        ).toString('hex');

        // run test
        const ergoChain =
          await ergoTestUtils.generateDefaultChainObjectWithTokenMap(
            network,
            ergoTestUtils.wrappedRwtTokenMap,
          );
        const result = ergoChain.getBoxRWT(serializedBox);

        // check returned value
        expect(result).toEqual(1n);
      });

      /**
       * @target ErgoChain.getBoxRWT should throw Error when box has no token
       * @dependencies
       * @scenario
       * - mock an ErgoBox without token and construct serialized box
       * - run test and expect exception thrown
       * @expected
       * - it should throw Error
       */
      it('should throw Error when box has no token', () => {
        // mock an ErgoBox without token and construct serialized box
        const serializedBox = Buffer.from(
          ergoTestUtils.toErgoBox(boxTestData.ergoBox3).sigma_serialize_bytes(),
        ).toString('hex');

        // run test and expect exception thrown
        const ergoChain = ergoTestUtils.generateChainObject(network);
        expect(() => {
          ergoChain.getBoxRWT(serializedBox);
        }).toThrow(Error);
      });
    });

    describe('getSerializedBoxInfo', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.getSerializedBoxInfo should get box id and assets successfully
       * @dependencies
       * @scenario
       * - mock an ErgoBox with assets
       * - construct serialized box and BoxInfo
       * - run test
       * - check returned value
       * @expected
       * - it should return constructed BoxInfo
       */
      it('should get box id and assets successfully', () => {
        // mock an ErgoBox with assets
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox1);
        const serializedBox = Buffer.from(box.sigma_serialize_bytes()).toString(
          'hex',
        );
        const boxInfo: BoxInfo = {
          id: box.box_id().to_str(),
          assets: boxTestData.box1Assets,
        };

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = ergoChain.getSerializedBoxInfo(serializedBox);

        // check returned value
        expect(result).toEqual(boxInfo);
      });

      /**
       * @target ErgoChain.getSerializedBoxInfo should wrap assets successfully
       * @dependencies
       * @scenario
       * - mock an ErgoBox with assets
       * - construct serialized box and BoxInfo
       * - run test
       * - check returned value
       * @expected
       * - it should return constructed BoxInfo
       */
      it('should wrap assets successfully', async () => {
        // mock an ErgoBox with assets
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox1);
        const serializedBox = Buffer.from(box.sigma_serialize_bytes()).toString(
          'hex',
        );
        const boxInfo: BoxInfo = {
          id: box.box_id().to_str(),
          assets: boxTestData.box1WrappedAssets,
        };

        // run test
        const ergoChain =
          await ergoTestUtils.generateDefaultChainObjectWithTokenMap(
            network,
            ergoTestUtils.multiDecimalTokenMap,
          );
        const result = ergoChain.getSerializedBoxInfo(serializedBox);

        // check returned value
        expect(result).toEqual(boxInfo);
      });
    });

    describe('getGuardsConfigBox', () => {
      /**
       * @target ErgoChain.getGuardsConfigBox should get guard box successfully
       * @dependencies
       * @scenario
       * - mock serialized box and guardNFT
       * - mock a network object with mocked 'getBoxesByTokenId'
       * - run test
       * - check returned value
       * @expected
       * - it should return mocked serializedBox
       */
      it('should get guard box successfully', async () => {
        // mock serialized box and guardNFT (the box itself doesn't matter)
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox2);
        const serializedBox = Buffer.from(box.sigma_serialize_bytes()).toString(
          'hex',
        );
        const guardNFT = ergoTestUtils.generateRandomId();

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getBoxesByTokenId'
        const getBoxesByTokenIdSpy = vi.spyOn(network, 'getBoxesByTokenId');
        getBoxesByTokenIdSpy.mockResolvedValue([box]);

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.getGuardsConfigBox(
          guardNFT,
          boxTestData.testLockAddress,
        );

        // check returned value
        expect(result).toEqual(serializedBox);
      });

      /**
       * @target ErgoChain.getGuardsConfigBox should throw error when
       * no guard box found
       * @dependencies
       * @scenario
       * - mock guardNFT
       * - mock a network object with mocked 'getBoxesByTokenId'
       * - run test and expect exception thrown
       * @expected
       * - it should return Error
       */
      it('should throw error when no guard box found', async () => {
        // mock guardNFT
        const guardNFT = ergoTestUtils.generateRandomId();

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getBoxesByTokenId'
        const getBoxesByTokenIdSpy = vi.spyOn(network, 'getBoxesByTokenId');
        getBoxesByTokenIdSpy.mockResolvedValue([]);

        // run test and expect exception thrown
        const ergoChain = ergoTestUtils.generateChainObject(network);
        await expect(async () => {
          await ergoChain.getGuardsConfigBox(
            guardNFT,
            boxTestData.testLockAddress,
          );
        }).rejects.toThrow(Error);
      });

      /**
       * @target ErgoChain.getGuardsConfigBox should throw error when
       * multiple guard box found
       * @dependencies
       * @scenario
       * - mock guardNFT and multiple serializedBoxes
       * - mock a network object with mocked 'getBoxesByTokenId'
       * - run test and expect exception thrown
       * @expected
       * - it should return Error
       */
      it('should throw error when multiple guard box found', async () => {
        // mock guardNFT and multiple serializedBoxes (the boxes themselves don't matter)
        const guardNFT = ergoTestUtils.generateRandomId();
        const serializedBoxes = [
          ergoTestUtils.toErgoBox(boxTestData.ergoBox1),
          ergoTestUtils.toErgoBox(boxTestData.ergoBox2),
          ergoTestUtils.toErgoBox(boxTestData.ergoBox3),
        ];

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getBoxesByTokenId'
        const getBoxesByTokenIdSpy = vi.spyOn(network, 'getBoxesByTokenId');
        getBoxesByTokenIdSpy.mockResolvedValue(serializedBoxes);

        // run test and expect exception thrown
        const ergoChain = ergoTestUtils.generateChainObject(network);
        await expect(async () => {
          await ergoChain.getGuardsConfigBox(
            guardNFT,
            boxTestData.testLockAddress,
          );
        }).rejects.toThrow(Error);
      });
    });

    describe('verifyEventRWT', () => {
      const network = new TestErgoNetwork();
      const serializedEventBox = Buffer.from(
        ergoTestUtils.toErgoBox(boxTestData.eventBox1).sigma_serialize_bytes(),
      ).toString('hex');
      const eventRwtId =
        '9410db5b39388c6b515160e7248346d7ec63d5457292326da12a26cc02efb526';

      /**
       * @target ErgoChain.verifyEventRWT should return true
       * when RWT token is correct
       * @dependencies
       * @scenario
       * - run test
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should return true when RWT token is correct', async () => {
        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = ergoChain.verifyEventRWT(serializedEventBox, eventRwtId);

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target ErgoChain.verifyEventRWT should return false
       * when box has no token
       * @dependencies
       * @scenario
       * - mock an ergo box with no token
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when box has no token', async () => {
        // mock an ergo box with no token
        const serializedBox = Buffer.from(
          ergoTestUtils.toErgoBox(boxTestData.ergoBox3).sigma_serialize_bytes(),
        ).toString('hex');

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = ergoChain.verifyEventRWT(serializedBox, eventRwtId);

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target ErgoChain.verifyEventRWT should return false
       * when rwt token id is wrong
       * @dependencies
       * @scenario
       * - run test with wrong rwt token id
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when rwt token id is wrong', async () => {
        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = ergoChain.verifyEventRWT(
          serializedEventBox,
          'fake_rwt_id',
        );

        // check returned value
        expect(result).toEqual(false);
      });
    });

    describe('getGuardsPkConfig', () => {
      /**
       * @target ErgoChain.getGuardsPkConfig should get guards public key config successfully
       * @dependencies
       * @scenario
       * - mock guard config box and guardNFT
       * - mock a network object with mocked 'getBoxesByTokenId'
       * - run test
       * - check returned value
       * @expected
       * - it should return expected public keys and requiredSigns
       */
      it('should get guards public key config successfully', async () => {
        // mock guard config box and guardNFT
        const box = ergoTestUtils.toErgoBox(boxTestData.guardConfigBox);
        const guardNFT = boxTestData.guardNFT;

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getBoxesByTokenId'
        const getBoxesByTokenIdSpy = vi.spyOn(network, 'getBoxesByTokenId');
        getBoxesByTokenIdSpy.mockResolvedValue([box]);

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.getGuardsPkConfig(
          guardNFT,
          boxTestData.testLockAddress,
        );

        // check returned value
        expect(result).toEqual(boxTestData.guardPks);
      });

      /**
       * @target ErgoChain.getGuardsPkConfig should throw error when
       * register values are invalid
       * @dependencies
       * @scenario
       * - mock an invalid box and guardNFT
       * - mock a network object with mocked 'getBoxesByTokenId'
       * - run test and expect exception thrown
       * @expected
       * - it should throw Error
       */
      it('should throw error when register values are invalid', async () => {
        // mock an invalid box and guardNFT
        const box = ergoTestUtils.toErgoBox(boxTestData.eventBox1);
        const guardNFT = boxTestData.guardNFT;

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getBoxesByTokenId'
        const getBoxesByTokenIdSpy = vi.spyOn(network, 'getBoxesByTokenId');
        getBoxesByTokenIdSpy.mockResolvedValue([box]);

        // run test and expect exception thrown
        const ergoChain = ergoTestUtils.generateChainObject(network);
        await expect(async () => {
          await ergoChain.getGuardsPkConfig(
            guardNFT,
            boxTestData.testLockAddress,
          );
        }).rejects.toThrow(Error);
      });
    });

    describe('extractSignedTransactionOrder', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.extractSignedTransactionOrder should extract transaction
       * order successfully
       * @dependencies
       * @scenario
       * - mock serialized transaction
       * - run test
       * - check returned value
       * @expected
       * - it should return mocked transaction order
       */
      it('should extract transaction order successfully', async () => {
        // mock serialized transaction
        const serializedTx = Buffer.from(
          ergoTestUtils
            .toTransaction(transactionTestData.transaction6)
            .sigma_serialize_bytes(),
        ).toString('hex');

        const expectedOrder = transactionTestData.transaction6Order;
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: transactionTestData.transaction6InAddress,
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };

        // run test
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.testTokenMap);
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result = ergoChain.extractSignedTransactionOrder(serializedTx);

        // check returned value
        expect(result).toEqual(expectedOrder);
      });

      /**
       * @target ErgoChain.extractSignedTransactionOrder should wrap transaction
       * order successfully
       * @dependencies
       * @scenario
       * - mock serialized transaction
       * - run test
       * - check returned value
       * @expected
       * - it should return mocked transaction order
       */
      it('should wrap transaction order successfully', async () => {
        // mock serialized transaction
        const serializedTx = Buffer.from(
          ergoTestUtils
            .toTransaction(transactionTestData.transaction6)
            .sigma_serialize_bytes(),
        ).toString('hex');

        const expectedOrder = transactionTestData.transaction6WrappedOrder;
        const config: ErgoConfigs = {
          fee: 1100000n,
          confirmations: ergoTestUtils.defaultConfirmations,
          addresses: {
            lock: transactionTestData.transaction6InAddress,
            cold: 'cold_addr',
            permit: 'permit_addr',
            fraud: 'fraud',
          },
          rwtId: ergoTestUtils.rwtId,
          minBoxValue: 1000000n,
          eventTxConfirmation: 18,
        };
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson(ergoTestUtils.multiDecimalTokenMap);

        // run test
        const ergoChain = new ErgoChain(
          network,
          config,
          tokenMap,
          ergoTestUtils.defaultSignMediator,
        );
        const result = ergoChain.extractSignedTransactionOrder(serializedTx);

        // check returned value
        expect(result).toEqual(expectedOrder);
      });
    });

    describe('rawTxToPaymentTransaction', () => {
      /**
       * @target ErgoChain.rawTxToPaymentTransaction should construct transaction successfully
       * @dependencies
       * @scenario
       * - mock PaymentTransaction
       * - mock a network object
       *   - mock 'getHeight'
       *   - mock 'getStateContext'
       * - call the function
       * - check returned value
       * @expected
       * - it should return mocked transaction order
       */
      it('should construct transaction successfully', async () => {
        // mock PaymentTransaction
        const expectedTx = ErgoTransaction.fromJson(
          transactionTestData.transaction5PaymentTransaction,
        );
        const rawTxJsonString = transactionTestData.transaction5UnsignedJson;
        expectedTx.eventId = '';
        expectedTx.txType = TransactionType.manual;

        // mock a network object
        const network = new TestErgoNetwork();
        // mock 'getStateContext'
        const getStateContextSpy = vi.spyOn(network, 'getStateContext');
        getStateContextSpy.mockResolvedValue(
          transactionTestData.mockedStateContext,
        );
        // mock getBox
        const getBoxSpy = vi.spyOn(network, 'getBox');
        [...expectedTx.inputBoxes, ...expectedTx.dataInputs].forEach((box) =>
          getBoxSpy.mockResolvedValueOnce(wasm.ErgoBox.sigma_parse_bytes(box)),
        );

        // call the function
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result =
          await ergoChain.rawTxToPaymentTransaction(rawTxJsonString);

        // check returned value
        expect(result.toJson()).toEqual(expectedTx.toJson());
      });
    });

    describe('verifyPaymentTransaction', () => {
      const network = new TestErgoNetwork();

      /**
       * @target ErgoChain.verifyPaymentTransaction should return true
       * when data is consistent
       * @dependencies
       * @scenario
       * - mock a ErgoTransaction
       * - run test
       * - check returned value
       * @expected
       * - it should return true
       */
      it('should return true when data is consistent', async () => {
        // mock a ErgoTransaction
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction5PaymentTransaction,
        );

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.verifyPaymentTransaction(paymentTx);

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target ErgoChain.verifyPaymentTransaction should return false
       * when transaction id is wrong
       * @dependencies
       * @scenario
       * - mock a ErgoTransaction with changed txId
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when transaction id is wrong', async () => {
        // mock a ErgoTransaction with changed txId
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction5PaymentTransaction,
        );
        paymentTx.txId = ergoTestUtils.generateRandomId();

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.verifyPaymentTransaction(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target ErgoChain.verifyPaymentTransaction should return false
       * when number of boxes is wrong
       * @dependencies
       * @scenario
       * - mock a ErgoTransaction with less boxes
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when number of boxes is wrong', async () => {
        // mock a ErgoTransaction with less boxes
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction5PaymentTransaction,
        );
        paymentTx.inputBoxes.pop();

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.verifyPaymentTransaction(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target ErgoChain.verifyPaymentTransaction should return false
       * when at least one of the boxes is wrong
       * @dependencies
       * @scenario
       * - mock a ErgoTransaction with changed box
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when at least one of the boxes is wrong', async () => {
        // mock a ErgoTransaction with changed box
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction5PaymentTransaction,
        );
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox1);
        paymentTx.inputBoxes[1] = box.sigma_serialize_bytes();

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.verifyPaymentTransaction(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target ErgoChain.verifyPaymentTransaction should return false
       * when number of data inputs is wrong
       * @dependencies
       * @scenario
       * - mock a ErgoTransaction with less data inputs
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when number of data inputs is wrong', async () => {
        // mock a ErgoTransaction with less data inputs
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction5PaymentTransaction,
        );
        paymentTx.dataInputs.pop();

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.verifyPaymentTransaction(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target ErgoChain.verifyPaymentTransaction should return false
       * when at least one of the data inputs is wrong
       * @dependencies
       * @scenario
       * - mock a ErgoTransaction with changed data input
       * - run test
       * - check returned value
       * @expected
       * - it should return false
       */
      it('should return false when at least one of the data inputs is wrong', async () => {
        // mock a ErgoTransaction with changed data input
        const paymentTx = ErgoTransaction.fromJson(
          transactionTestData.transaction5PaymentTransaction,
        );
        const box = ergoTestUtils.toErgoBox(boxTestData.ergoBox1);
        paymentTx.dataInputs[0] = box.sigma_serialize_bytes();

        // run test
        const ergoChain = ergoTestUtils.generateChainObject(network);
        const result = await ergoChain.verifyPaymentTransaction(paymentTx);

        // check returned value
        expect(result).toEqual(false);
      });
    });
  });
  describe('submitTransaction', () => {
    describe('submitTransaction', () => {
      describe('qualified chain authorization 1', () => {
        const payment = generateAuthorizedPayment;
        const options = generateSubmissionOptions;

        const method = 'submitTransaction' as const;
        /**
         * @target ErgoChain.submitTransaction `${method} denies an unsupported network before invoking its legacy submit method`
         * @dependencies
         * - TestErgoNetwork and signed payment fixtures; explicit authorization
         * callback.
         * @scenario
         * - Create the network/payment/callback fixtures. Apply the case-specific
         * denial or mutation, invoke the selected chain method, and inspect
         * captured bytes and downstream calls. - Prepare `network`, `legacy`.
         * @expected
         * - `expect( generateChainObject(network)[method](payment(), options()),
         * ).rejects.toBeInstanceOf(AuthorizedSubmissionError)`. -
         * `expect(legacy).not.toHaveBeenCalled()`.
         */
        it(`${method} denies an unsupported network before invoking its legacy submit method`, async () => {
          const network = new TestErgoNetwork(),
            legacy = vi.spyOn(network, 'submitTransaction');
          await expect(
            generateChainObject(network)[method](payment(), options()),
          ).rejects.toBeInstanceOf(AuthorizedSubmissionError);
          expect(legacy).not.toHaveBeenCalled();
        });
        /**
         * @target ErgoChain.submitTransaction `${method} propagates qualified failure without reporting success: %s`
         * @dependencies
         * - TestErgoNetwork and signed payment fixtures; explicit authorization
         * callback.
         * @scenario
         * - Create the network/payment/callback fixtures. Apply the case-specific
         * denial or mutation, invoke the selected chain method, and inspect
         * captured bytes and downstream calls. - Prepare `network`. - Apply
         * `vi.spyOn(network, 'submitAuthorizedTransaction').mockRejectedValue(
         * failure, )`. - Prepare `legacy`.
         * @expected
         * - `expect( generateChainObject(network)[method](payment(), options()),
         * ).rejects.toBe(failure)`. - `expect(legacy).not.toHaveBeenCalled()`.
         */
        it.each([
          new AuthorizedSubmissionError('denied'),
          new AuthorizedSubmissionError('expired'),
          new Error('HTTP failure'),
        ])(
          `${method} propagates qualified failure without reporting success: %s`,
          async (failure) => {
            const network = new TestErgoNetwork();
            vi.spyOn(network, 'submitAuthorizedTransaction').mockRejectedValue(
              failure,
            );
            const legacy = vi.spyOn(network, 'submitTransaction');
            await expect(
              generateChainObject(network)[method](payment(), options()),
            ).rejects.toBe(failure);
            expect(legacy).not.toHaveBeenCalled();
          },
        );
        /**
         * @target ErgoChain.submitTransaction `${method} captures immutable callback/timeout and exact signed bytes before waiting`
         * @dependencies
         * - TestErgoNetwork and signed payment fixtures; explicit authorization
         * callback.
         * @scenario
         * - Create the network/payment/callback fixtures. Apply the case-specific
         * denial or mutation, invoke the selected chain method, and inspect
         * captured bytes and downstream calls. - Prepare `network`, `tx`, `input`.
         * - Prepare `callback`. - Prepare `finish`. - Prepare `gate`. - Prepare
         * `received`. - Prepare `pending`. - Apply `input.timeoutMs = 1`. - Apply
         * `input.authorizeSubmit = async () => { throw Error('replacement'); }`. -
         * Apply `tx.txBytes = Buffer.from('00', 'hex')`. - Apply `finish()`. -
         * Apply `await pending`.
         * @expected
         * - `expect( Buffer.from(signed.sigma_serialize_bytes()).toString('hex'),
         * ).toEqual(transaction2SignedSerialized)`. -
         * `expect(authorization.authorizeSubmit).toBe(callback)`. -
         * `expect(authorization.timeoutMs).toEqual(1000)`. -
         * `expect(Object.isFrozen(authorization)).toEqual(true)`. -
         * `expect(received).toBeDefined()`.
         */
        it(`${method} captures immutable callback/timeout and exact signed bytes before waiting`, async () => {
          const network = new TestErgoNetwork(),
            tx = payment(),
            input = options();
          const callback = input.authorizeSubmit;
          let finish!: () => void;
          const gate = new Promise<void>((resolve) => {
            finish = resolve;
          });
          let received:
            | Parameters<typeof network.submitAuthorizedTransaction>[1]
            | undefined;
          vi.spyOn(network, 'submitAuthorizedTransaction').mockImplementation(
            async (signed, authorization) => {
              received = authorization;
              expect(
                Buffer.from(signed.sigma_serialize_bytes()).toString('hex'),
              ).toEqual(transaction2SignedSerialized);
              await gate;
              expect(authorization.authorizeSubmit).toBe(callback);
              expect(authorization.timeoutMs).toEqual(1000);
              expect(Object.isFrozen(authorization)).toEqual(true);
            },
          );
          const pending = generateChainObject(network)[method](tx, input);
          expect(received).toBeDefined();
          input.timeoutMs = 1;
          input.authorizeSubmit = async () => {
            throw Error('replacement');
          };
          tx.txBytes = Buffer.from('00', 'hex');
          finish();
          await pending;
        });
      });
      describe('qualified chain authorization 4', () => {
        const payment = generateAuthorizedPayment;

        /**
         * @target ErgoChain.submitTransaction 'preserves legacy behavior when legacy network fails=%s'
         * @dependencies
         * - TestErgoNetwork legacy and qualified submit spies.
         * @scenario
         * - Configure the legacy network to succeed or fail. Submit without
         * explicit authorization and inspect the legacy and qualified call paths.
         * - Prepare `network`. - Prepare `legacy`. - Prepare `qualified`.
         * @expected
         * - `expect( generateChainObject(network).submitTransaction(payment()),
         * ).resolves.toBeUndefined()`. - `expect(legacy).toHaveBeenCalledOnce()`.
         * - `expect(qualified).not.toHaveBeenCalled()`.
         */
        it.each([false, true])(
          'preserves legacy behavior when legacy network fails=%s',
          async (fail) => {
            const network = new TestErgoNetwork();
            const legacy = vi
              .spyOn(network as AbstractErgoNetwork, 'submitTransaction')
              .mockImplementation(async () => {
                if (fail) throw Error('legacy failure');
              });
            const qualified = vi.spyOn(network, 'submitAuthorizedTransaction');
            await expect(
              generateChainObject(network).submitTransaction(payment()),
            ).resolves.toBeUndefined();
            expect(legacy).toHaveBeenCalledOnce();
            expect(qualified).not.toHaveBeenCalled();
          },
        );
      });
    });
  });
  describe('submitAuthorizedTransaction', () => {
    describe('submitAuthorizedTransaction', () => {
      describe('qualified chain authorization 2', () => {
        const payment = generateAuthorizedPayment;
        const options = generateSubmissionOptions;

        const method = 'submitAuthorizedTransaction' as const;
        /**
         * @target ErgoChain.submitAuthorizedTransaction `${method} denies an unsupported network before invoking its legacy submit method`
         * @dependencies
         * - TestErgoNetwork and signed payment fixtures; explicit authorization
         * callback.
         * @scenario
         * - Create the network/payment/callback fixtures. Apply the case-specific
         * denial or mutation, invoke the selected chain method, and inspect
         * captured bytes and downstream calls. - Prepare `network`, `legacy`.
         * @expected
         * - `expect( generateChainObject(network)[method](payment(), options()),
         * ).rejects.toBeInstanceOf(AuthorizedSubmissionError)`. -
         * `expect(legacy).not.toHaveBeenCalled()`.
         */
        it(`${method} denies an unsupported network before invoking its legacy submit method`, async () => {
          const network = new TestErgoNetwork(),
            legacy = vi.spyOn(network, 'submitTransaction');
          await expect(
            generateChainObject(network)[method](payment(), options()),
          ).rejects.toBeInstanceOf(AuthorizedSubmissionError);
          expect(legacy).not.toHaveBeenCalled();
        });
        /**
         * @target ErgoChain.submitAuthorizedTransaction `${method} propagates qualified failure without reporting success: %s`
         * @dependencies
         * - TestErgoNetwork and signed payment fixtures; explicit authorization
         * callback.
         * @scenario
         * - Create the network/payment/callback fixtures. Apply the case-specific
         * denial or mutation, invoke the selected chain method, and inspect
         * captured bytes and downstream calls. - Prepare `network`. - Apply
         * `vi.spyOn(network, 'submitAuthorizedTransaction').mockRejectedValue(
         * failure, )`. - Prepare `legacy`.
         * @expected
         * - `expect( generateChainObject(network)[method](payment(), options()),
         * ).rejects.toBe(failure)`. - `expect(legacy).not.toHaveBeenCalled()`.
         */
        it.each([
          new AuthorizedSubmissionError('denied'),
          new AuthorizedSubmissionError('expired'),
          new Error('HTTP failure'),
        ])(
          `${method} propagates qualified failure without reporting success: %s`,
          async (failure) => {
            const network = new TestErgoNetwork();
            vi.spyOn(network, 'submitAuthorizedTransaction').mockRejectedValue(
              failure,
            );
            const legacy = vi.spyOn(network, 'submitTransaction');
            await expect(
              generateChainObject(network)[method](payment(), options()),
            ).rejects.toBe(failure);
            expect(legacy).not.toHaveBeenCalled();
          },
        );
        /**
         * @target ErgoChain.submitAuthorizedTransaction `${method} captures immutable callback/timeout and exact signed bytes before waiting`
         * @dependencies
         * - TestErgoNetwork and signed payment fixtures; explicit authorization
         * callback.
         * @scenario
         * - Create the network/payment/callback fixtures. Apply the case-specific
         * denial or mutation, invoke the selected chain method, and inspect
         * captured bytes and downstream calls. - Prepare `network`, `tx`, `input`.
         * - Prepare `callback`. - Prepare `finish`. - Prepare `gate`. - Prepare
         * `received`. - Prepare `pending`. - Apply `input.timeoutMs = 1`. - Apply
         * `input.authorizeSubmit = async () => { throw Error('replacement'); }`. -
         * Apply `tx.txBytes = Buffer.from('00', 'hex')`. - Apply `finish()`. -
         * Apply `await pending`.
         * @expected
         * - `expect( Buffer.from(signed.sigma_serialize_bytes()).toString('hex'),
         * ).toEqual(transaction2SignedSerialized)`. -
         * `expect(authorization.authorizeSubmit).toBe(callback)`. -
         * `expect(authorization.timeoutMs).toEqual(1000)`. -
         * `expect(Object.isFrozen(authorization)).toEqual(true)`. -
         * `expect(received).toBeDefined()`.
         */
        it(`${method} captures immutable callback/timeout and exact signed bytes before waiting`, async () => {
          const network = new TestErgoNetwork(),
            tx = payment(),
            input = options();
          const callback = input.authorizeSubmit;
          let finish!: () => void;
          const gate = new Promise<void>((resolve) => {
            finish = resolve;
          });
          let received:
            | Parameters<typeof network.submitAuthorizedTransaction>[1]
            | undefined;
          vi.spyOn(network, 'submitAuthorizedTransaction').mockImplementation(
            async (signed, authorization) => {
              received = authorization;
              expect(
                Buffer.from(signed.sigma_serialize_bytes()).toString('hex'),
              ).toEqual(transaction2SignedSerialized);
              await gate;
              expect(authorization.authorizeSubmit).toBe(callback);
              expect(authorization.timeoutMs).toEqual(1000);
              expect(Object.isFrozen(authorization)).toEqual(true);
            },
          );
          const pending = generateChainObject(network)[method](tx, input);
          expect(received).toBeDefined();
          input.timeoutMs = 1;
          input.authorizeSubmit = async () => {
            throw Error('replacement');
          };
          tx.txBytes = Buffer.from('00', 'hex');
          finish();
          await pending;
        });
      });
      describe('qualified chain authorization 3', () => {
        const payment = generateAuthorizedPayment;
        const options = generateSubmissionOptions;

        /**
         * @target ErgoChain.submitAuthorizedTransaction 'rejects malformed explicit authorization before any submission: %s'
         * @dependencies
         * - TestErgoNetwork, real loopback ErgoNodeNetwork, signed transaction
         * fixture and explicit authorization.
         * @scenario
         * - Prepare the signed payment and authorization input. Apply isolated
         * malformed or overridden-legacy conditions, or hold the loopback dispatch
         * gate. Invoke the explicit API and inspect authorization/transport calls.
         * - Prepare `network`. - Prepare `chain`. - Prepare `legacy`. - Prepare
         * `networkLegacy`. - Prepare `qualified`. - Prepare `malformed`. - Apply
         * `malformed.txBytes = Uint8Array.of(255)`.
         * @expected
         * - `expect( chain.submitAuthorizedTransaction( malformed, authorization
         * as Parameters< typeof chain.submitAuthorizedTransaction >[1], ),
         * ).rejects.toMatchObject({ reason: 'invalid' })`. -
         * `expect(legacy).not.toHaveBeenCalled()`. -
         * `expect(networkLegacy).not.toHaveBeenCalled()`. -
         * `expect(qualified).not.toHaveBeenCalled()`.
         */
        it.each([
          undefined,
          null,
          {},
          { timeoutMs: 1000 },
          { authorizeSubmit: options().authorizeSubmit },
          ...[0, -1, 0.5, NaN, Infinity, 2147483648, '1000'].map(
            (timeoutMs) => ({
              timeoutMs,
              authorizeSubmit: options().authorizeSubmit,
            }),
          ),
          ...[undefined, null, 1, 'callback', {}].map((authorizeSubmit) => ({
            timeoutMs: 1000,
            authorizeSubmit,
          })),
        ])(
          'rejects malformed explicit authorization before any submission: %s',
          async (authorization) => {
            const network = new TestErgoNetwork();
            const chain = generateChainObject(network);
            const legacy = vi.spyOn(chain, 'submitTransaction');
            const networkLegacy = vi.spyOn(network, 'submitTransaction');
            const qualified = vi.spyOn(network, 'submitAuthorizedTransaction');
            const malformed = payment();
            malformed.txBytes = Uint8Array.of(255);
            await expect(
              chain.submitAuthorizedTransaction(
                malformed,
                authorization as Parameters<
                  typeof chain.submitAuthorizedTransaction
                >[1],
              ),
            ).rejects.toMatchObject({ reason: 'invalid' });
            expect(legacy).not.toHaveBeenCalled();
            expect(networkLegacy).not.toHaveBeenCalled();
            expect(qualified).not.toHaveBeenCalled();
          },
        );
        /**
         * @target ErgoChain.submitAuthorizedTransaction 'never invokes an overridden legacy chain method from the explicit API'
         * @dependencies
         * - TestErgoNetwork, real loopback ErgoNodeNetwork, signed transaction
         * fixture and explicit authorization.
         * @scenario
         * - Prepare the signed payment and authorization input. Apply isolated
         * malformed or overridden-legacy conditions, or hold the loopback dispatch
         * gate. Invoke the explicit API and inspect authorization/transport calls.
         * - Prepare `network`. - Prepare `chain`. - Apply `chain.submitTransaction
         * = vi.fn(async () => undefined)`. - Prepare `failure`. - Prepare
         * `qualified`.
         * @expected
         * - `expect( chain.submitAuthorizedTransaction(payment(), options()),
         * ).rejects.toBe(failure)`. - `expect(qualified).toHaveBeenCalledOnce()`.
         * - `expect(chain.submitTransaction).not.toHaveBeenCalled()`.
         */
        it('never invokes an overridden legacy chain method from the explicit API', async () => {
          const network = new TestErgoNetwork();
          const chain = generateChainObject(network);
          chain.submitTransaction = vi.fn(async () => undefined);
          const failure = new AuthorizedSubmissionError('denied');
          const qualified = vi
            .spyOn(network, 'submitAuthorizedTransaction')
            .mockRejectedValue(failure);
          await expect(
            chain.submitAuthorizedTransaction(payment(), options()),
          ).rejects.toBe(failure);
          expect(qualified).toHaveBeenCalledOnce();
          expect(chain.submitTransaction).not.toHaveBeenCalled();
        });
        /**
         * @target ErgoChain.submitAuthorizedTransaction 'dispatches exact bytes through the real Node network only after explicit admission'
         * @dependencies
         * - TestErgoNetwork, real loopback ErgoNodeNetwork, signed transaction
         * fixture and explicit authorization.
         * @scenario
         * - Prepare the signed payment and authorization input. Apply isolated
         * malformed or overridden-legacy conditions, or hold the loopback dispatch
         * gate. Invoke the explicit API and inspect authorization/transport calls.
         * - Prepare `bodies`. - Prepare `paths`. - Prepare `server`. - Apply
         * `await new Promise<void>((resolve) => server.listen(0, '127.0.0.1',
         * resolve))`. - Observe the transaction operation and reclaim the owned
         * WASM or HTTP fixture in the finally branch.
         * @expected
         * - `expect(bodies).toEqual([])`. -
         * `expect(authorization).toHaveBeenCalledOnce()`. -
         * `expect(paths).toEqual(['/transactions/bytes'])`. -
         * `expect(bodies).toEqual([JSON.stringify(transaction2SignedSerialized)])`.
         * - `expect(legacy).not.toHaveBeenCalled()`.
         */
        it('dispatches exact bytes through the real Node network only after explicit admission', async () => {
          const bodies: string[] = [];
          const paths: string[] = [];
          const server = createServer((request, response) => {
            paths.push(request.url!);
            let body = '';
            request.on('data', (chunk) => {
              body += chunk;
            });
            request.on('end', () => {
              bodies.push(body);
              response.writeHead(200, { 'Content-Type': 'application/json' });
              response.end('"accepted"');
            });
          });
          await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
          );
          try {
            const address = server.address();
            if (!address || typeof address === 'string')
              throw Error('No listener');
            const network = new ErgoNodeNetwork({
              nodeBaseUrl: `http://127.0.0.1:${address.port}`,
            });
            const chain = generateChainObject(new TestErgoNetwork());
            chain.network = network;
            const legacy = vi.spyOn(network, 'submitTransaction');
            const authorization = vi.fn(async (start: () => void) => {
              expect(bodies).toEqual([]);
              start();
            });
            await chain.submitAuthorizedTransaction(payment(), {
              timeoutMs: 1000,
              authorizeSubmit: authorization,
            });
            expect(authorization).toHaveBeenCalledOnce();
            expect(paths).toEqual(['/transactions/bytes']);
            expect(bodies).toEqual([
              JSON.stringify(transaction2SignedSerialized),
            ]);
            expect(legacy).not.toHaveBeenCalled();
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        });
      });
    });
  });
  describe('getTransactionAssets', () => {
    describe('signed accounting 1', () => {
      const { reduced, chain, signed } = createSignedAccountingFixtures();

      const method = 'getTransactionAssets' as const;
      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.getTransactionAssets `${method} rejects noncanonical signed bytes with suffix %s`
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Prepare `canonical`. - Apply
       * `payment.txBytes = Buffer.concat([canonical, Buffer.from(suffix,
       * 'hex')])`. - Prepare `parsed`.
       * @expected
       * - `expect(parsed.id().to_str()).toEqual(payment.txId)`. -
       * `expect(Buffer.from(parsed.sigma_serialize_bytes())).toEqual(canonical)`.
       * - `expect( chain()[method](payment, SigningStatus.Signed),
       * ).rejects.toThrow('identity mismatch')`.
       */
      it.each(['00', 'ff', '000102'])(
        `${method} rejects noncanonical signed bytes with suffix %s`,
        async (suffix) => {
          const payment = signed();
          const canonical = Buffer.from(payment.txBytes);
          payment.txBytes = Buffer.concat([
            canonical,
            Buffer.from(suffix, 'hex'),
          ]);
          // The real WASM parser ignores this suffix; txId alone cannot bind it.
          const parsed = Serializer.signedDeserialize(payment.txBytes);
          expect(parsed.id().to_str()).toEqual(payment.txId);
          expect(Buffer.from(parsed.sigma_serialize_bytes())).toEqual(
            canonical,
          );
          await expect(
            chain()[method](payment, SigningStatus.Signed),
          ).rejects.toThrow('identity mismatch');
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets '%s retains the default reduced semantics'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `ergo`.
       * @expected
       * - `expect(await ergo[method](reduced())).toEqual( await
       * ergo[method](reduced(), SigningStatus.UnSigned), )`.
       */
      it.each([method])(
        '%s retains the default reduced semantics',
        async (method) => {
          const ergo = chain();
          expect(await ergo[method](reduced())).toEqual(
            await ergo[method](reduced(), SigningStatus.UnSigned),
          );
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets '%s strictly separates the two byte formats'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `ergo`. - Prepare `signedPayment`. - Prepare
       * `reducedPayment`. - Prepare `parseSigned`. - Prepare `parseReduced`. -
       * Apply `parseReduced.mockClear()`.
       * @expected
       * - `expect(ergo[method](signedPayment)).rejects.toThrow()`. -
       * `expect(parseSigned).not.toHaveBeenCalled()`. - `expect(
       * ergo[method](reducedPayment, SigningStatus.Signed),
       * ).rejects.toThrow()`. - `expect(parseReduced).not.toHaveBeenCalled()`.
       */
      it.each([method])(
        '%s strictly separates the two byte formats',
        async (method) => {
          const ergo = chain();
          const signedPayment = signed();
          const reducedPayment = reduced();
          const parseSigned = vi.spyOn(Serializer, 'signedDeserialize');
          const parseReduced = vi.spyOn(Serializer, 'deserialize');
          await expect(ergo[method](signedPayment)).rejects.toThrow();
          expect(parseSigned).not.toHaveBeenCalled();
          parseReduced.mockClear();
          await expect(
            ergo[method](reducedPayment, SigningStatus.Signed),
          ).rejects.toThrow();
          expect(parseReduced).not.toHaveBeenCalled();
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets '%s rejects an invalid explicit status before parsing'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Prepare `parseSigned`. - Prepare
       * `parseReduced`. - Repeat the declared observation or isolated-mutation
       * table in order.
       * @expected
       * - `expect( chain()[method](payment, status as SigningStatus),
       * ).rejects.toThrow('Invalid transaction signing status')`. -
       * `expect(parseSigned).not.toHaveBeenCalled()`. -
       * `expect(parseReduced).not.toHaveBeenCalled()`.
       */
      it.each([method])(
        '%s rejects an invalid explicit status before parsing',
        async (method) => {
          const payment = signed();
          const parseSigned = vi.spyOn(Serializer, 'signedDeserialize');
          const parseReduced = vi.spyOn(Serializer, 'deserialize');
          for (const status of ['invalid', null, 99])
            await expect(
              chain()[method](payment, status as SigningStatus),
            ).rejects.toThrow('Invalid transaction signing status');
          expect(parseSigned).not.toHaveBeenCalled();
          expect(parseReduced).not.toHaveBeenCalled();
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets '%s rejects a signed model with a mismatching transaction ID'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Apply `payment.txId =
       * '00'.repeat(32)`.
       * @expected
       * - `expect( chain()[method](payment, SigningStatus.Signed),
       * ).rejects.toThrow('identity mismatch')`.
       */
      it.each([method])(
        '%s rejects a signed model with a mismatching transaction ID',
        async (method) => {
          const payment = signed();
          payment.txId = '00'.repeat(32);
          await expect(
            chain()[method](payment, SigningStatus.Signed),
          ).rejects.toThrow('identity mismatch');
        },
      );
    });

    describe('signed accounting 4', () => {
      const { reduced, chain, model, signed } =
        createSignedAccountingFixtures();

      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.getTransactionAssets 'calculates the same exact assets for real reduced and signed models'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `ergo`. - Prepare `actual`.
       * @expected
       * - `expect(actual).toEqual(await ergo.getTransactionAssets(reduced()))`.
       * - `expect(actual.inputAssets.nativeToken).toBeGreaterThan(0n)`. -
       * `expect(actual.inputAssets.tokens.length).toBeGreaterThan(0)`. -
       * `expect(actual.inputAssets.nativeToken).toEqual(actual.outputAssets.nativeToken)`.
       * - `expect( [...actual.inputAssets.tokens].sort((a, b) =>
       * a.id.localeCompare(b.id)), ).toEqual(
       * [...actual.outputAssets.tokens].sort((a, b) =>
       * a.id.localeCompare(b.id)), )`. - `expect(
       * ergo.verifyNoTokenBurned(signed(), SigningStatus.Signed),
       * ).resolves.toEqual(true)`.
       */
      it('calculates the same exact assets for real reduced and signed models', async () => {
        const ergo = chain();
        const actual = await ergo.getTransactionAssets(
          signed(),
          SigningStatus.Signed,
        );
        expect(actual).toEqual(await ergo.getTransactionAssets(reduced()));
        expect(actual.inputAssets.nativeToken).toBeGreaterThan(0n);
        expect(actual.inputAssets.tokens.length).toBeGreaterThan(0);
        expect(actual.inputAssets.nativeToken).toEqual(
          actual.outputAssets.nativeToken,
        );
        expect(
          [...actual.inputAssets.tokens].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        ).toEqual(
          [...actual.outputAssets.tokens].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        );
        await expect(
          ergo.verifyNoTokenBurned(signed(), SigningStatus.Signed),
        ).resolves.toEqual(true);
      });
      /**
       * @target ErgoChain.getTransactionAssets 'rejects a signed model labelled as another chain'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Apply `payment.network = 'avalanche'`.
       * @expected
       * - `expect( chain().getTransactionAssets(payment, SigningStatus.Signed),
       * ).rejects.toThrow('identity mismatch')`.
       */
      it('rejects a signed model labelled as another chain', async () => {
        const payment = signed();
        payment.network = 'avalanche';
        await expect(
          chain().getTransactionAssets(payment, SigningStatus.Signed),
        ).rejects.toThrow('identity mismatch');
      });
      /**
       * @target ErgoChain.getTransactionAssets 'rejects missing %s'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Apply `payment[field].pop()`.
       * @expected
       * - `expect( chain().getTransactionAssets(payment, SigningStatus.Signed),
       * ).rejects.toThrow('box count')`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects missing %s',
        async (field) => {
          const payment = signed();
          payment[field].pop();
          await expect(
            chain().getTransactionAssets(payment, SigningStatus.Signed),
          ).rejects.toThrow('box count');
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets 'rejects extra %s'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Apply `payment[field].push(payment.inputBoxes[0])`.
       * @expected
       * - `expect( chain().getTransactionAssets(payment, SigningStatus.Signed),
       * ).rejects.toThrow('box count')`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects extra %s',
        async (field) => {
          const payment = signed();
          payment[field].push(payment.inputBoxes[0]);
          await expect(
            chain().getTransactionAssets(payment, SigningStatus.Signed),
          ).rejects.toThrow('box count');
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets 'rejects wrong same-count %s identities'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Apply `payment[field][0] = payment.inputBoxes[1]`.
       * @expected
       * - `expect( chain().getTransactionAssets(payment, SigningStatus.Signed),
       * ).rejects.toThrow('box identity')`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects wrong same-count %s identities',
        async (field) => {
          const payment = signed();
          payment[field][0] = payment.inputBoxes[1];
          await expect(
            chain().getTransactionAssets(payment, SigningStatus.Signed),
          ).rejects.toThrow('box identity');
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets 'rejects a non-array %s'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Apply `Reflect.set(payment, field, undefined)`.
       * @expected
       * - `expect( chain().getTransactionAssets(payment, SigningStatus.Signed),
       * ).rejects.toThrow('box count')`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects a non-array %s',
        async (field) => {
          const payment = signed();
          Reflect.set(payment, field, undefined);
          await expect(
            chain().getTransactionAssets(payment, SigningStatus.Signed),
          ).rejects.toThrow('box count');
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets 'rejects malformed %s bytes'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Apply `payment[field][0] = new Uint8Array([0])`.
       * @expected
       * - `expect( chain().getTransactionAssets(payment, SigningStatus.Signed),
       * ).rejects.toThrow()`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects malformed %s bytes',
        async (field) => {
          const payment = signed();
          payment[field][0] = new Uint8Array([0]);
          await expect(
            chain().getTransactionAssets(payment, SigningStatus.Signed),
          ).rejects.toThrow();
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets 'rejects non-byte %s members'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Apply `Reflect.set(payment[field], 0, '00')`.
       * @expected
       * - `expect( chain().getTransactionAssets(payment, SigningStatus.Signed),
       * ).rejects.toThrow('box bytes')`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects non-byte %s members',
        async (field) => {
          const payment = signed();
          Reflect.set(payment[field], 0, '00');
          await expect(
            chain().getTransactionAssets(payment, SigningStatus.Signed),
          ).rejects.toThrow('box bytes');
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets 'rejects trailing data in %s encoding'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Apply `payment[field][0] =
       * Buffer.concat([payment[field][0], Buffer.from([0])])`.
       * @expected
       * - `expect( chain().getTransactionAssets(payment, SigningStatus.Signed),
       * ).rejects.toThrow()`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects trailing data in %s encoding',
        async (field) => {
          const payment = signed();
          payment[field][0] = Buffer.concat([
            payment[field][0],
            Buffer.from([0]),
          ]);
          await expect(
            chain().getTransactionAssets(payment, SigningStatus.Signed),
          ).rejects.toThrow();
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets 'requires exact ordering of %s'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `payment`. - Prepare `body`. - Prepare `captured`. - Apply
       * `[captured[field][0], captured[field][1]] = [ captured[field][1],
       * captured[field][0], ]`.
       * @expected
       * - `expect( chain().getTransactionAssets(captured, SigningStatus.Signed),
       * ).resolves.toBeDefined()`. - `expect(
       * chain().getTransactionAssets(captured, SigningStatus.Signed),
       * ).rejects.toThrow('box identity')`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'requires exact ordering of %s',
        async (field) => {
          const payment = reduced();
          const body = model();
          if (field === 'dataInputs') {
            payment.dataInputs.push(payment.inputBoxes[0]);
            body.dataInputs = payment.dataInputs.map((box) => ({
              boxId: wasm.ErgoBox.sigma_parse_bytes(box).box_id().to_str(),
            }));
          }
          const captured = signed(body, payment);
          await expect(
            chain().getTransactionAssets(captured, SigningStatus.Signed),
          ).resolves.toBeDefined();
          [captured[field][0], captured[field][1]] = [
            captured[field][1],
            captured[field][0],
          ];
          await expect(
            chain().getTransactionAssets(captured, SigningStatus.Signed),
          ).rejects.toThrow('box identity');
        },
      );
      /**
       * @target ErgoChain.getTransactionAssets 'rejects duplicated signed %s references before summing'
       * @dependencies
       * - Real WASM codecs, Serializer, transaction5 input/data boxes and
       * TestErgoNetwork.
       * @scenario
       * - Build the real signed/reduced asset fixture. Apply the named isolated
       * chain or box-membership/order/encoding mutation. Calculate assets and
       * inspect equality or refusal, keeping the companion checks. - Prepare
       * `body`. - Prepare `payment`.
       * @expected
       * - `expect( chain().getTransactionAssets(signed(body, payment),
       * SigningStatus.Signed), ).rejects.toThrow('box count or identity')`.
       */
      it.each(['inputs', 'dataInputs'] as const)(
        'rejects duplicated signed %s references before summing',
        async (field) => {
          const body = model();
          const payment = reduced();
          if (field === 'inputs') {
            body.inputs[1] = body.inputs[0];
            payment.inputBoxes[1] = payment.inputBoxes[0];
          } else {
            body.dataInputs.push(body.dataInputs[0]);
            payment.dataInputs.push(payment.dataInputs[0]);
          }
          await expect(
            chain().getTransactionAssets(
              signed(body, payment),
              SigningStatus.Signed,
            ),
          ).rejects.toThrow('box count or identity');
        },
      );
    });
  });

  describe('extractTransactionOrder', () => {
    describe('signed payment consistency 1', () => {
      const { chain, pinnedSigned } = createSignedPaymentFixtures();

      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.extractTransactionOrder 'parses the pinned signed ID and matches the existing signed-order extractor'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer and pinned signed
       * transaction fixture.
       * @scenario
       * - Parse the pinned signed transaction identity. Extract its explicit
       * signed order and compare it with the original signed-order extractor. -
       * Prepare `transaction`. - Prepare `ergo`. - Prepare `order`.
       * @expected
       * - `expect(
       * Serializer.signedDeserialize(transaction.txBytes).id().to_str(),
       * ).toEqual('b4ff9c6164d1e6bd74f7af30cf61fe86463a1f0eae1b6439668d6af63cbd08c2')`.
       * - `expect(order.length).toBeGreaterThan(0)`. - `expect(order).toEqual(
       * ergo.extractSignedTransactionOrder(transaction2SignedSerialized), )`.
       */
      it('parses the pinned signed ID and matches the existing signed-order extractor', () => {
        const transaction = pinnedSigned();
        expect(
          Serializer.signedDeserialize(transaction.txBytes).id().to_str(),
        ).toEqual(
          'b4ff9c6164d1e6bd74f7af30cf61fe86463a1f0eae1b6439668d6af63cbd08c2',
        );
        const ergo = chain();
        const order = ergo.extractTransactionOrder(
          transaction,
          SigningStatus.Signed,
        );
        expect(order.length).toBeGreaterThan(0);
        expect(order).toEqual(
          ergo.extractSignedTransactionOrder(transaction2SignedSerialized),
        );
      });
    });
  });
  describe('verifyTransactionFee', () => {
    describe('signed accounting 2', () => {
      const { reduced, chain, signed } = createSignedAccountingFixtures();

      const method = 'verifyTransactionFee' as const;
      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.verifyTransactionFee `${method} rejects noncanonical signed bytes with suffix %s`
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Prepare `canonical`. - Apply
       * `payment.txBytes = Buffer.concat([canonical, Buffer.from(suffix,
       * 'hex')])`. - Prepare `parsed`.
       * @expected
       * - `expect(parsed.id().to_str()).toEqual(payment.txId)`. -
       * `expect(Buffer.from(parsed.sigma_serialize_bytes())).toEqual(canonical)`.
       * - `expect( chain()[method](payment, SigningStatus.Signed),
       * ).rejects.toThrow('identity mismatch')`.
       */
      it.each(['00', 'ff', '000102'])(
        `${method} rejects noncanonical signed bytes with suffix %s`,
        async (suffix) => {
          const payment = signed();
          const canonical = Buffer.from(payment.txBytes);
          payment.txBytes = Buffer.concat([
            canonical,
            Buffer.from(suffix, 'hex'),
          ]);
          // The real WASM parser ignores this suffix; txId alone cannot bind it.
          const parsed = Serializer.signedDeserialize(payment.txBytes);
          expect(parsed.id().to_str()).toEqual(payment.txId);
          expect(Buffer.from(parsed.sigma_serialize_bytes())).toEqual(
            canonical,
          );
          await expect(
            chain()[method](payment, SigningStatus.Signed),
          ).rejects.toThrow('identity mismatch');
        },
      );
      /**
       * @target ErgoChain.verifyTransactionFee '%s retains the default reduced semantics'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `ergo`.
       * @expected
       * - `expect(await ergo[method](reduced())).toEqual( await
       * ergo[method](reduced(), SigningStatus.UnSigned), )`.
       */
      it.each([method])(
        '%s retains the default reduced semantics',
        async (method) => {
          const ergo = chain();
          expect(await ergo[method](reduced())).toEqual(
            await ergo[method](reduced(), SigningStatus.UnSigned),
          );
        },
      );
      /**
       * @target ErgoChain.verifyTransactionFee '%s strictly separates the two byte formats'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `ergo`. - Prepare `signedPayment`. - Prepare
       * `reducedPayment`. - Prepare `parseSigned`. - Prepare `parseReduced`. -
       * Apply `parseReduced.mockClear()`.
       * @expected
       * - `expect(ergo[method](signedPayment)).rejects.toThrow()`. -
       * `expect(parseSigned).not.toHaveBeenCalled()`. - `expect(
       * ergo[method](reducedPayment, SigningStatus.Signed),
       * ).rejects.toThrow()`. - `expect(parseReduced).not.toHaveBeenCalled()`.
       */
      it.each([method])(
        '%s strictly separates the two byte formats',
        async (method) => {
          const ergo = chain();
          const signedPayment = signed();
          const reducedPayment = reduced();
          const parseSigned = vi.spyOn(Serializer, 'signedDeserialize');
          const parseReduced = vi.spyOn(Serializer, 'deserialize');
          await expect(ergo[method](signedPayment)).rejects.toThrow();
          expect(parseSigned).not.toHaveBeenCalled();
          parseReduced.mockClear();
          await expect(
            ergo[method](reducedPayment, SigningStatus.Signed),
          ).rejects.toThrow();
          expect(parseReduced).not.toHaveBeenCalled();
        },
      );
      /**
       * @target ErgoChain.verifyTransactionFee '%s rejects an invalid explicit status before parsing'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Prepare `parseSigned`. - Prepare
       * `parseReduced`. - Repeat the declared observation or isolated-mutation
       * table in order.
       * @expected
       * - `expect( chain()[method](payment, status as SigningStatus),
       * ).rejects.toThrow('Invalid transaction signing status')`. -
       * `expect(parseSigned).not.toHaveBeenCalled()`. -
       * `expect(parseReduced).not.toHaveBeenCalled()`.
       */
      it.each([method])(
        '%s rejects an invalid explicit status before parsing',
        async (method) => {
          const payment = signed();
          const parseSigned = vi.spyOn(Serializer, 'signedDeserialize');
          const parseReduced = vi.spyOn(Serializer, 'deserialize');
          for (const status of ['invalid', null, 99])
            await expect(
              chain()[method](payment, status as SigningStatus),
            ).rejects.toThrow('Invalid transaction signing status');
          expect(parseSigned).not.toHaveBeenCalled();
          expect(parseReduced).not.toHaveBeenCalled();
        },
      );
      /**
       * @target ErgoChain.verifyTransactionFee '%s rejects a signed model with a mismatching transaction ID'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Apply `payment.txId =
       * '00'.repeat(32)`.
       * @expected
       * - `expect( chain()[method](payment, SigningStatus.Signed),
       * ).rejects.toThrow('identity mismatch')`.
       */
      it.each([method])(
        '%s rejects a signed model with a mismatching transaction ID',
        async (method) => {
          const payment = signed();
          payment.txId = '00'.repeat(32);
          await expect(
            chain()[method](payment, SigningStatus.Signed),
          ).rejects.toThrow('identity mismatch');
        },
      );
    });

    describe('signed accounting 5', () => {
      const { reduced, chain, model, signed } =
        createSignedAccountingFixtures();

      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.verifyTransactionFee 'applies the existing fee ceiling %s to signed outputs'
       * @dependencies
       * - Real signed/reduced transaction5 fixture, fee output and configured
       * fee ceiling.
       * @scenario
       * - Set each ceiling or replace the fee recipient in the signed model.
       * Verify the transaction fee and compare signed/reduced results or the
       * missing-recipient refusal. - Prepare `ergo`. - Apply `ergo.configs.fee =
       * ceiling`.
       * @expected
       * - `expect( ergo.verifyTransactionFee(signed(), SigningStatus.Signed),
       * ).resolves.toEqual(ceiling >= 1100000n)`. -
       * `expect(ergo.verifyTransactionFee(reduced())).resolves.toEqual( ceiling
       * >= 1100000n, )`.
       */
      it.each([1100001n, 1100000n, 1099999n])(
        'applies the existing fee ceiling %s to signed outputs',
        async (ceiling) => {
          const ergo = chain();
          ergo.configs.fee = ceiling;
          await expect(
            ergo.verifyTransactionFee(signed(), SigningStatus.Signed),
          ).resolves.toEqual(ceiling >= 1100000n);
          await expect(ergo.verifyTransactionFee(reduced())).resolves.toEqual(
            ceiling >= 1100000n,
          );
        },
      );
      /**
       * @target ErgoChain.verifyTransactionFee 'rejects an absent fee recipient without treating another output as fee'
       * @dependencies
       * - Real signed/reduced transaction5 fixture, fee output and configured
       * fee ceiling.
       * @scenario
       * - Set each ceiling or replace the fee recipient in the signed model.
       * Verify the transaction fee and compare signed/reduced results or the
       * missing-recipient refusal. - Prepare `body`. - Prepare `fee`. - Apply
       * `fee.ergoTree = body.outputs[0].ergoTree`.
       * @expected
       * - `expect(fee).toBeDefined()`. - `expect(
       * chain().verifyTransactionFee(signed(body), SigningStatus.Signed),
       * ).rejects.toThrow('No box matching fee box ergo tree')`.
       */
      it('rejects an absent fee recipient without treating another output as fee', async () => {
        const body = model();
        const fee = body.outputs.find(
          (output: { ergoTree: string }) =>
            output.ergoTree === ErgoChain.feeBoxErgoTree,
        );
        expect(fee).toBeDefined();
        fee.ergoTree = body.outputs[0].ergoTree;
        await expect(
          chain().verifyTransactionFee(signed(body), SigningStatus.Signed),
        ).rejects.toThrow('No box matching fee box ergo tree');
      });
    });
  });

  describe('verifyPaymentTransaction', () => {
    describe('signed payment consistency 2', () => {
      const { chain, pinnedSigned, completeSigned } =
        createSignedPaymentFixtures();

      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.verifyPaymentTransaction 'rejects the pinned signed fixture when its required input box is missing'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(pinnedSigned(),
       * SigningStatus.Signed), ).resolves.toEqual(false)`.
       */
      it('rejects the pinned signed fixture when its required input box is missing', async () => {
        await expect(
          chain().verifyPaymentTransaction(
            pinnedSigned(),
            SigningStatus.Signed,
          ),
        ).resolves.toEqual(false);
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'rejects a wrong real box supplied for the pinned signed input'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Apply `transaction.inputBoxes =
       * [completeSigned().inputBoxes[0]]`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction,
       * SigningStatus.Signed), ).resolves.toEqual(false)`.
       */
      it('rejects a wrong real box supplied for the pinned signed input', async () => {
        const transaction = pinnedSigned();
        transaction.inputBoxes = [completeSigned().inputBoxes[0]];
        await expect(
          chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
        ).resolves.toEqual(false);
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'checks the signed transaction ID and all ordered input/data box IDs'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`.
       * @expected
       * - `expect(transaction.inputBoxes.length).toBeGreaterThan(1)`. -
       * `expect(transaction.dataInputs.length).toBeGreaterThan(0)`. - `expect(
       * chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
       * ).resolves.toEqual(true)`.
       */
      it('checks the signed transaction ID and all ordered input/data box IDs', async () => {
        const transaction = completeSigned();
        expect(transaction.inputBoxes.length).toBeGreaterThan(1);
        expect(transaction.dataInputs.length).toBeGreaterThan(0);
        await expect(
          chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
        ).resolves.toEqual(true);
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'rejects an isolated signed transaction ID mismatch'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Apply `transaction.txId = '00'.repeat(32)`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction,
       * SigningStatus.Signed), ).resolves.toEqual(false)`.
       */
      it('rejects an isolated signed transaction ID mismatch', async () => {
        const transaction = completeSigned();
        transaction.txId = '00'.repeat(32);
        await expect(
          chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
        ).resolves.toEqual(false);
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'rejects missing or additional %s'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Apply `transaction[field].pop()`. - Prepare
       * `extra`. - Apply `extra[field].push(extra.inputBoxes[0])`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction,
       * SigningStatus.Signed), ).resolves.toEqual(false)`. - `expect(
       * chain().verifyPaymentTransaction(extra, SigningStatus.Signed),
       * ).resolves.toEqual(false)`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects missing or additional %s',
        async (field) => {
          const transaction = completeSigned();
          transaction[field].pop();
          await expect(
            chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
          ).resolves.toEqual(false);
          const extra = completeSigned();
          extra[field].push(extra.inputBoxes[0]);
          await expect(
            chain().verifyPaymentTransaction(extra, SigningStatus.Signed),
          ).resolves.toEqual(false);
        },
      );
      /**
       * @target ErgoChain.verifyPaymentTransaction 'rejects a wrong same-count %s identity'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Apply `transaction[field][0] =
       * transaction.inputBoxes[1]`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction,
       * SigningStatus.Signed), ).resolves.toEqual(false)`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects a wrong same-count %s identity',
        async (field) => {
          const transaction = completeSigned();
          transaction[field][0] = transaction.inputBoxes[1];
          await expect(
            chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
          ).resolves.toEqual(false);
        },
      );
      /**
       * @target ErgoChain.verifyPaymentTransaction 'rejects swapped input boxes despite equal membership'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Apply `[transaction.inputBoxes[0],
       * transaction.inputBoxes[1]] = [ transaction.inputBoxes[1],
       * transaction.inputBoxes[0], ]`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction,
       * SigningStatus.Signed), ).resolves.toEqual(false)`.
       */
      it('rejects swapped input boxes despite equal membership', async () => {
        const transaction = completeSigned();
        [transaction.inputBoxes[0], transaction.inputBoxes[1]] = [
          transaction.inputBoxes[1],
          transaction.inputBoxes[0],
        ];
        await expect(
          chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
        ).resolves.toEqual(false);
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'requires ordered data box IDs in a two-data-input signed encoding'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Apply
       * `transaction.dataInputs.push(transaction.inputBoxes[0])`. - Prepare
       * `model`. - Apply `model.dataInputs = transaction.dataInputs.map((box) =>
       * ({ boxId: wasm.ErgoBox.sigma_parse_bytes(box).box_id().to_str(), }))`. -
       * Prepare `unsigned`. - Prepare `signed`. - Apply `transaction.txId =
       * signed.id().to_str()`. - Apply `transaction.txBytes =
       * Serializer.signedSerialize(signed)`. - Apply
       * `transaction.dataInputs.reverse()`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction,
       * SigningStatus.Signed), ).resolves.toEqual(true)`. - `expect(
       * chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
       * ).resolves.toEqual(false)`.
       */
      it('requires ordered data box IDs in a two-data-input signed encoding', async () => {
        const transaction = ErgoTransaction.fromJson(
          transaction5PaymentTransaction,
        );
        transaction.dataInputs.push(transaction.inputBoxes[0]);
        const model = JSON.parse(
          Serializer.deserialize(transaction.txBytes).unsigned_tx().to_json(),
        );
        model.dataInputs = transaction.dataInputs.map((box) => ({
          boxId: wasm.ErgoBox.sigma_parse_bytes(box).box_id().to_str(),
        }));
        const unsigned = wasm.UnsignedTransaction.from_json(
          JSON.stringify(model),
        );
        const signed = wasm.Transaction.from_unsigned_tx(
          unsigned,
          Array.from(
            { length: unsigned.inputs().len() },
            () => new Uint8Array(),
          ),
        );
        transaction.txId = signed.id().to_str();
        transaction.txBytes = Serializer.signedSerialize(signed);
        await expect(
          chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
        ).resolves.toEqual(true);
        transaction.dataInputs.reverse();
        await expect(
          chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
        ).resolves.toEqual(false);
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'rejects malformed %s bytes'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Apply `transaction[field][0] = new
       * Uint8Array([0])`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction,
       * SigningStatus.Signed), ).rejects.toThrow()`.
       */
      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects malformed %s bytes',
        async (field) => {
          const transaction = completeSigned();
          transaction[field][0] = new Uint8Array([0]);
          await expect(
            chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
          ).rejects.toThrow();
        },
      );
      /**
       * @target ErgoChain.verifyPaymentTransaction 'keeps the unsigned default and explicit unsigned behavior equivalent'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Prepare `ergo`. - Prepare `orderTransaction`.
       * @expected
       * - `expect(ergo.verifyPaymentTransaction(transaction)).resolves.toEqual(
       * true, )`. - `expect( ergo.verifyPaymentTransaction(transaction,
       * SigningStatus.UnSigned), ).resolves.toEqual(true)`. -
       * `expect(ergo.extractTransactionOrder(orderTransaction)).toEqual(
       * ergo.extractTransactionOrder(orderTransaction, SigningStatus.UnSigned),
       * )`.
       */
      it('keeps the unsigned default and explicit unsigned behavior equivalent', async () => {
        const transaction = ErgoTransaction.fromJson(
          transaction5PaymentTransaction,
        );
        const ergo = chain();
        await expect(
          ergo.verifyPaymentTransaction(transaction),
        ).resolves.toEqual(true);
        await expect(
          ergo.verifyPaymentTransaction(transaction, SigningStatus.UnSigned),
        ).resolves.toEqual(true);
        const orderTransaction = ErgoTransaction.fromJson(
          transaction2PartialUnsignedPaymentTransaction,
        );
        expect(ergo.extractTransactionOrder(orderTransaction)).toEqual(
          ergo.extractTransactionOrder(
            orderTransaction,
            SigningStatus.UnSigned,
          ),
        );
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'does not fall back to reduced parsing when signed parsing fails'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Prepare `reduced`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction,
       * SigningStatus.Signed), ).rejects.toThrow()`. - `expect(() =>
       * chain().extractTransactionOrder(transaction, SigningStatus.Signed),
       * ).toThrow()`. - `expect(reduced).not.toHaveBeenCalled()`.
       */
      it('does not fall back to reduced parsing when signed parsing fails', async () => {
        const transaction = ErgoTransaction.fromJson(
          transaction5PaymentTransaction,
        );
        const reduced = vi.spyOn(Serializer, 'deserialize');
        await expect(
          chain().verifyPaymentTransaction(transaction, SigningStatus.Signed),
        ).rejects.toThrow();
        expect(() =>
          chain().extractTransactionOrder(transaction, SigningStatus.Signed),
        ).toThrow();
        expect(reduced).not.toHaveBeenCalled();
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'does not fall back to signed parsing in the default unsigned mode'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Prepare `signed`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction),
       * ).rejects.toThrow()`. - `expect(() =>
       * chain().extractTransactionOrder(transaction)).toThrow()`. -
       * `expect(signed).not.toHaveBeenCalled()`.
       */
      it('does not fall back to signed parsing in the default unsigned mode', async () => {
        const transaction = pinnedSigned();
        const signed = vi.spyOn(Serializer, 'signedDeserialize');
        await expect(
          chain().verifyPaymentTransaction(transaction),
        ).rejects.toThrow();
        expect(() => chain().extractTransactionOrder(transaction)).toThrow();
        expect(signed).not.toHaveBeenCalled();
      });
      /**
       * @target ErgoChain.verifyPaymentTransaction 'rejects an unknown signing status before parsing'
       * @dependencies
       * - Real signed/reduced WASM codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or unsigned payment fixture. Apply the named
       * isolated transaction-ID, ordered-box, encoding or signing-status
       * mutation. Verify payment and retain companion order/parser assertions. -
       * Prepare `transaction`. - Prepare `signed`. - Prepare `reduced`.
       * @expected
       * - `expect( chain().verifyPaymentTransaction(transaction, 999 as
       * SigningStatus), ).rejects.toThrow('signing status')`. - `expect(() =>
       * chain().extractTransactionOrder(transaction, 999 as SigningStatus),
       * ).toThrow('signing status')`. - `expect(signed).not.toHaveBeenCalled()`.
       * - `expect(reduced).not.toHaveBeenCalled()`.
       */
      it('rejects an unknown signing status before parsing', async () => {
        const transaction = completeSigned();
        const signed = vi.spyOn(Serializer, 'signedDeserialize');
        const reduced = vi.spyOn(Serializer, 'deserialize');
        await expect(
          chain().verifyPaymentTransaction(transaction, 999 as SigningStatus),
        ).rejects.toThrow('signing status');
        expect(() =>
          chain().extractTransactionOrder(transaction, 999 as SigningStatus),
        ).toThrow('signing status');
        expect(signed).not.toHaveBeenCalled();
        expect(reduced).not.toHaveBeenCalled();
      });
    });
  });
  describe('verifyNoTokenBurned', () => {
    describe('signed accounting 3', () => {
      const { reduced, chain, signed } = createSignedAccountingFixtures();

      const method = 'verifyNoTokenBurned' as const;
      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.verifyNoTokenBurned `${method} rejects noncanonical signed bytes with suffix %s`
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Prepare `canonical`. - Apply
       * `payment.txBytes = Buffer.concat([canonical, Buffer.from(suffix,
       * 'hex')])`. - Prepare `parsed`.
       * @expected
       * - `expect(parsed.id().to_str()).toEqual(payment.txId)`. -
       * `expect(Buffer.from(parsed.sigma_serialize_bytes())).toEqual(canonical)`.
       * - `expect( chain()[method](payment, SigningStatus.Signed),
       * ).rejects.toThrow('identity mismatch')`.
       */
      it.each(['00', 'ff', '000102'])(
        `${method} rejects noncanonical signed bytes with suffix %s`,
        async (suffix) => {
          const payment = signed();
          const canonical = Buffer.from(payment.txBytes);
          payment.txBytes = Buffer.concat([
            canonical,
            Buffer.from(suffix, 'hex'),
          ]);
          // The real WASM parser ignores this suffix; txId alone cannot bind it.
          const parsed = Serializer.signedDeserialize(payment.txBytes);
          expect(parsed.id().to_str()).toEqual(payment.txId);
          expect(Buffer.from(parsed.sigma_serialize_bytes())).toEqual(
            canonical,
          );
          await expect(
            chain()[method](payment, SigningStatus.Signed),
          ).rejects.toThrow('identity mismatch');
        },
      );
      /**
       * @target ErgoChain.verifyNoTokenBurned '%s retains the default reduced semantics'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `ergo`.
       * @expected
       * - `expect(await ergo[method](reduced())).toEqual( await
       * ergo[method](reduced(), SigningStatus.UnSigned), )`.
       */
      it.each([method])(
        '%s retains the default reduced semantics',
        async (method) => {
          const ergo = chain();
          expect(await ergo[method](reduced())).toEqual(
            await ergo[method](reduced(), SigningStatus.UnSigned),
          );
        },
      );
      /**
       * @target ErgoChain.verifyNoTokenBurned '%s strictly separates the two byte formats'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `ergo`. - Prepare `signedPayment`. - Prepare
       * `reducedPayment`. - Prepare `parseSigned`. - Prepare `parseReduced`. -
       * Apply `parseReduced.mockClear()`.
       * @expected
       * - `expect(ergo[method](signedPayment)).rejects.toThrow()`. -
       * `expect(parseSigned).not.toHaveBeenCalled()`. - `expect(
       * ergo[method](reducedPayment, SigningStatus.Signed),
       * ).rejects.toThrow()`. - `expect(parseReduced).not.toHaveBeenCalled()`.
       */
      it.each([method])(
        '%s strictly separates the two byte formats',
        async (method) => {
          const ergo = chain();
          const signedPayment = signed();
          const reducedPayment = reduced();
          const parseSigned = vi.spyOn(Serializer, 'signedDeserialize');
          const parseReduced = vi.spyOn(Serializer, 'deserialize');
          await expect(ergo[method](signedPayment)).rejects.toThrow();
          expect(parseSigned).not.toHaveBeenCalled();
          parseReduced.mockClear();
          await expect(
            ergo[method](reducedPayment, SigningStatus.Signed),
          ).rejects.toThrow();
          expect(parseReduced).not.toHaveBeenCalled();
        },
      );
      /**
       * @target ErgoChain.verifyNoTokenBurned '%s rejects an invalid explicit status before parsing'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Prepare `parseSigned`. - Prepare
       * `parseReduced`. - Repeat the declared observation or isolated-mutation
       * table in order.
       * @expected
       * - `expect( chain()[method](payment, status as SigningStatus),
       * ).rejects.toThrow('Invalid transaction signing status')`. -
       * `expect(parseSigned).not.toHaveBeenCalled()`. -
       * `expect(parseReduced).not.toHaveBeenCalled()`.
       */
      it.each([method])(
        '%s rejects an invalid explicit status before parsing',
        async (method) => {
          const payment = signed();
          const parseSigned = vi.spyOn(Serializer, 'signedDeserialize');
          const parseReduced = vi.spyOn(Serializer, 'deserialize');
          for (const status of ['invalid', null, 99])
            await expect(
              chain()[method](payment, status as SigningStatus),
            ).rejects.toThrow('Invalid transaction signing status');
          expect(parseSigned).not.toHaveBeenCalled();
          expect(parseReduced).not.toHaveBeenCalled();
        },
      );
      /**
       * @target ErgoChain.verifyNoTokenBurned '%s rejects a signed model with a mismatching transaction ID'
       * @dependencies
       * - Real WASM signed/reduced codecs, Serializer, complete transaction5
       * boxes and TestErgoNetwork.
       * @scenario
       * - Construct the signed or reduced model and capture parser spies. Apply
       * the named isolated format, signing-status or transaction-ID mutation.
       * Invoke the selected accounting method and compare results/refusals and
       * parser calls. - Prepare `payment`. - Apply `payment.txId =
       * '00'.repeat(32)`.
       * @expected
       * - `expect( chain()[method](payment, SigningStatus.Signed),
       * ).rejects.toThrow('identity mismatch')`.
       */
      it.each([method])(
        '%s rejects a signed model with a mismatching transaction ID',
        async (method) => {
          const payment = signed();
          payment.txId = '00'.repeat(32);
          await expect(
            chain()[method](payment, SigningStatus.Signed),
          ).rejects.toThrow('identity mismatch');
        },
      );
    });

    describe('signed accounting 6', () => {
      const { chain, model, signed } = createSignedAccountingFixtures();

      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.verifyNoTokenBurned 'detects a burned token in the actual signed output model'
       * @dependencies
       * - Real signed transaction5 fixture and companion payment/fee verifiers.
       * @scenario
       * - Reduce one signed output token amount while preserving payment and fee
       * context. Check the burn refusal and retain the payment/fee assertions. -
       * Prepare `body`. - Apply `body.outputs[0].assets[1].amount -= 1`. -
       * Prepare `payment`. - Prepare `ergo`.
       * @expected
       * - `expect( ergo.verifyPaymentTransaction(payment, SigningStatus.Signed),
       * ).resolves.toEqual(true)`. - `expect( ergo.verifyNoTokenBurned(payment,
       * SigningStatus.Signed), ).resolves.toEqual(false)`. - `expect(
       * ergo.verifyTransactionFee(payment, SigningStatus.Signed),
       * ).resolves.toEqual(true)`.
       */
      it('detects a burned token in the actual signed output model', async () => {
        const body = model();
        body.outputs[0].assets[1].amount -= 1;
        const payment = signed(body);
        const ergo = chain();
        await expect(
          ergo.verifyPaymentTransaction(payment, SigningStatus.Signed),
        ).resolves.toEqual(true);
        await expect(
          ergo.verifyNoTokenBurned(payment, SigningStatus.Signed),
        ).resolves.toEqual(false);
        await expect(
          ergo.verifyTransactionFee(payment, SigningStatus.Signed),
        ).resolves.toEqual(true);
      });
    });
  });

  describe('getTransaction', () => {
    describe('network transaction lifetime 1', () => {
      const fixture = createTransactionLifetimeFixture;

      afterEach(() => vi.restoreAllMocks());
      /**
       * @target ErgoChain.getTransaction 'returns the exact bytes and frees the fetched WASM transaction once'
       * @dependencies
       * - TestErgoNetwork, Serializer and real owned WASM transaction
       * allocations.
       * @scenario
       * - Configure network fetch and serialization spies, including isolated
       * failures. Fetch the transaction, observe exact bytes/error identity, and
       * check that each fetched WASM allocation is freed exactly once. - Prepare
       * `f`. - Observe the transaction operation and reclaim the owned WASM or
       * HTTP fixture in the finally branch.
       * @expected
       * - `expect(f.fetch).toHaveBeenCalledWith('tx-id', 'block-id')`. -
       * `expect(result).toEqual(transaction2SignedSerialized)`. -
       * `expect(f.free).toHaveBeenCalledTimes(1)`.
       */
      it('returns the exact bytes and frees the fetched WASM transaction once', async () => {
        const f = fixture();
        try {
          const result = await f.chain.getTransaction('tx-id', 'block-id');
          expect(f.fetch).toHaveBeenCalledWith('tx-id', 'block-id');
          expect(result).toEqual(transaction2SignedSerialized);
          expect(f.free).toHaveBeenCalledTimes(1);
        } finally {
          // Also reclaim the object when this regression runs against the old source.
          if (!f.free.mock.calls.length) f.transaction.free();
        }
      });
      /**
       * @target ErgoChain.getTransaction 'frees ownership and preserves the original serialization error'
       * @dependencies
       * - TestErgoNetwork, Serializer and real owned WASM transaction
       * allocations.
       * @scenario
       * - Configure network fetch and serialization spies, including isolated
       * failures. Fetch the transaction, observe exact bytes/error identity, and
       * check that each fetched WASM allocation is freed exactly once. - Prepare
       * `f`. - Prepare `error`. - Apply `vi.spyOn(Serializer,
       * 'signedSerialize').mockImplementationOnce(() => { throw error; })`. -
       * Observe the transaction operation and reclaim the owned WASM or HTTP
       * fixture in the finally branch.
       * @expected
       * - `expect(f.chain.getTransaction('tx-id', 'block-id')).rejects.toBe(
       * error, )`. - `expect(f.free).toHaveBeenCalledTimes(1)`.
       */
      it('frees ownership and preserves the original serialization error', async () => {
        const f = fixture();
        const error = new Error('serialization failed');
        vi.spyOn(Serializer, 'signedSerialize').mockImplementationOnce(() => {
          throw error;
        });
        try {
          await expect(
            f.chain.getTransaction('tx-id', 'block-id'),
          ).rejects.toBe(error);
          expect(f.free).toHaveBeenCalledTimes(1);
        } finally {
          if (!f.free.mock.calls.length) f.transaction.free();
        }
      });
      /**
       * @target ErgoChain.getTransaction 'propagates a failed fetch without attempting serialization'
       * @dependencies
       * - TestErgoNetwork, Serializer and real owned WASM transaction
       * allocations.
       * @scenario
       * - Configure network fetch and serialization spies, including isolated
       * failures. Fetch the transaction, observe exact bytes/error identity, and
       * check that each fetched WASM allocation is freed exactly once. - Prepare
       * `network`. - Prepare `error`. - Apply `vi.spyOn(network,
       * 'getTransaction').mockRejectedValue(error)`. - Prepare `serialize`.
       * @expected
       * - `expect( generateChainObject(network).getTransaction('tx-id',
       * 'block-id'), ).rejects.toBe(error)`. -
       * `expect(serialize).not.toHaveBeenCalled()`.
       */
      it('propagates a failed fetch without attempting serialization', async () => {
        const network = new TestErgoNetwork();
        const error = new Error('network unavailable');
        vi.spyOn(network, 'getTransaction').mockRejectedValue(error);
        const serialize = vi.spyOn(Serializer, 'signedSerialize');
        await expect(
          generateChainObject(network).getTransaction('tx-id', 'block-id'),
        ).rejects.toBe(error);
        expect(serialize).not.toHaveBeenCalled();
      });
      /**
       * @target ErgoChain.getTransaction 'releases each fresh network allocation across repeated observations'
       * @dependencies
       * - TestErgoNetwork, Serializer and real owned WASM transaction
       * allocations.
       * @scenario
       * - Configure network fetch and serialization spies, including isolated
       * failures. Fetch the transaction, observe exact bytes/error identity, and
       * check that each fetched WASM allocation is freed exactly once. - Prepare
       * `network`. - Prepare `frees`. - Prepare `allocated`. - Prepare `chain`.
       * - Observe the transaction operation and reclaim the owned WASM or HTTP
       * fixture in the finally branch.
       * @expected
       * - `expect(await chain.getTransaction('tx-id', 'block-id')).toEqual(
       * transaction2SignedSerialized, )`. - `expect(frees).toHaveLength(4)`. -
       * `expect(free).toHaveBeenCalledTimes(1)`.
       */
      it('releases each fresh network allocation across repeated observations', async () => {
        const network = new TestErgoNetwork();
        const frees: ReturnType<typeof vi.spyOn>[] = [];
        const allocated: wasm.Transaction[] = [];
        vi.spyOn(network, 'getTransaction').mockImplementation(async () => {
          const transaction = wasm.Transaction.sigma_parse_bytes(
            Buffer.from(transaction2SignedSerialized, 'hex'),
          );
          allocated.push(transaction);
          frees.push(vi.spyOn(transaction, 'free'));
          return transaction;
        });
        const chain = generateChainObject(network);
        try {
          for (let i = 0; i < 4; i++) {
            expect(await chain.getTransaction('tx-id', 'block-id')).toEqual(
              transaction2SignedSerialized,
            );
          }
          expect(frees).toHaveLength(4);
          for (const free of frees) expect(free).toHaveBeenCalledTimes(1);
        } finally {
          for (const [i, transaction] of allocated.entries())
            if (!frees[i].mock.calls.length) transaction.free();
        }
      });
    });
  });
});
