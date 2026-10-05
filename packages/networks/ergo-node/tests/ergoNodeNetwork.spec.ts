import { ErgoBox, ErgoStateContext, Transaction } from 'ergo-lib-wasm-nodejs';
import { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import JsonBigInt from '@rosen-bridge/json-bigint';

import ErgoNodeNetwork from '../lib/ergoNodeNetwork';
import {
  mockApiToThrow,
  mockGetAddressBalanceTotal,
  mockGetBlockHeaderById,
  mockGetBlockTransactionsById,
  mockIndexedBoxById,
  mockGetBoxesByAddressUnspent,
  mockGetLastHeaders,
  mockGetNodeInfo,
  mockGetTokenById,
  mockGetTxById,
  mockGetTxByIdAndGetBlockTransactionsById,
  mockGetUnconfirmedTransactions,
  mockSendTransactionAsBytes,
} from './mocked/ergoNodeClient.mock';
import {
  expectedTokenDetail,
  testAddress,
  testAddressBalance,
  testAddressBalanceWithInvalidTokens,
  testAddressBoxes,
  testAddressBoxesBytes,
  testBlockHeaders,
  testBlockId,
  testHeight,
  testMempoolTransactions,
  testPartialTransactions,
  testPartialTransactionsWithAbsentIds,
  testTransaction,
  testTransactionBytes,
  tokenId,
} from './testData';
import {
  createAuthorizedSubmissionFixtures,
  getNetwork,
} from './testUtils/authorizedSubmission';

// Test-only source resolution: do not rebuild or overlay the installed package.
vi.mock(
  '@rosen-chains/ergo',
  async () =>
    await vi.importActual<Record<string, unknown>>('../../../chains/ergo/lib'),
);
vi.mock('@rosen-clients/ergo-node');

describe('ErgoNodeNetwork', () => {
  describe('getHeight', () => {
    /**
     * @target ErgoNodeNetwork.getHeight 'should return current height'
     * @dependencies
     * @scenario
     * - mock `getNodeInfo` of ergo node client
     * @expected
     * - returned height should equal mocked height
     */
    it('should return current height', async () => {
      mockGetNodeInfo();
      const network = getNetwork();

      const actualHeight = await network.getHeight();

      const expectedHeight = Number(testHeight);
      expect(actualHeight).toEqual(expectedHeight);
    });
  });

  describe('getTxConfirmation', () => {
    /**
     * @target ErgoNodeNetwork.getTxConfirmation 'should return tx confirmations'
     * @dependencies
     * @scenario
     * - mock `getTxById` of ergo node client
     * @expected
     * - returned confirmations should equal mocked tx confirmations
     */
    it('should return tx confirmations', async () => {
      mockGetTxById();
      const network = getNetwork();

      const actualConfirmations = await network.getTxConfirmation(
        testTransaction.id,
      );

      const expectedConfirmations = Number(testTransaction.numConfirmations);
      expect(actualConfirmations).toEqual(expectedConfirmations);
    });

    /**
     * @target ErgoNodeNetwork.getTxConfirmation 'should return `-1` if tx is not found in the blockchain'
     * @dependencies
     * @scenario
     * - mock `getTxById` of ergo node client to reject with a 404 error
     * @expected
     * - returned confirmations should equal -1
     */
    it('should return `-1` if tx is not found in the blockchain', async () => {
      mockApiToThrow('getTxById', {
        response: {
          status: 404,
        },
      });
      const network = getNetwork();

      const actualConfirmations = await network.getTxConfirmation(
        testTransaction.id,
      );

      const expectedConfirmations = -1;
      expect(actualConfirmations).toEqual(expectedConfirmations);
    });
  });

  describe('getAddressAssets', () => {
    /**
     * @target ErgoNodeNetwork.getAddressAssets 'should return address assets'
     * @dependencies
     * @scenario
     * - mock `getAddressBalanceTotal` of ergo node client
     * @expected
     * - returned assets should equal mocked assets
     */
    it('should return address assets', async () => {
      mockGetAddressBalanceTotal();
      const network = getNetwork();

      const actualAssets = await network.getAddressAssets(testAddress);

      const expectedAssets = {
        nativeToken: testAddressBalance.nanoErgs,
        tokens: testAddressBalance.tokens.map((token) => ({
          id: token.tokenId,
          value: token.amount,
        })),
      };
      expect(actualAssets).toEqual(expectedAssets);
    });

    /**
     * @target ErgoNodeNetwork.getAddressAssets 'should return zero assets if no confirmed field is present in api result'
     * @dependencies
     * @scenario
     * - mock `getAddressBalanceTotal` of ergo node client to return an object
     *   with no `confirmed` field
     * @expected
     * - returned assets should be all zero
     */
    it('should return zero assets if no confirmed field is present in api result', async () => {
      mockGetAddressBalanceTotal(null);
      const network = getNetwork();

      const actualAssets = await network.getAddressAssets(testAddress);

      const expectedAssets = {
        nativeToken: 0n,
        tokens: [],
      };
      expect(actualAssets).toEqual(expectedAssets);
    });

    /**
     * @target ErgoNodeNetwork.getAddressAssets "should throw when some tokens don't have a `tokenId` or `amount` field"
     * @dependencies
     * @scenario
     * - mock `getAddressBalanceTotal` of ergo node client to an object
     *   containing invalid tokens
     * @expected
     * - the api call should throw
     */
    it("should throw when some tokens don't have a `tokenId` or `amount` field", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetAddressBalanceTotal(testAddressBalanceWithInvalidTokens as any);
      const network = getNetwork();

      await expect(() =>
        network.getAddressAssets(testAddress),
      ).rejects.toThrow();
    });
  });

  describe('getBlockTransactionIds', () => {
    /**
     * @target ErgoNodeNetwork.getBlockTransactionIds 'should return block transaction ids'
     * @dependencies
     * @scenario
     * - mock `getBlockTransactionsById` of ergo node client
     * @expected
     * - returned tx ids should equal mocked tx ids
     */
    it('should return block transaction ids', async () => {
      mockGetBlockTransactionsById();
      const network = getNetwork();

      const actualTxIds = await network.getBlockTransactionIds(testBlockId);

      const expectedTxIds = testPartialTransactions.map((tx) => tx.id);
      expect(actualTxIds).toEqual(expectedTxIds);
    });

    /**
     * @target ErgoNodeNetwork.getBlockTransactionIds 'should throw an error if some transaction ids are undefined'
     * @dependencies
     * @scenario
     * - mock `getBlockTransactionsById` of ergo node client with some invalid
     *   txs
     * @expected
     * - the method should throw
     */
    it('should throw an error if some transaction ids are undefined', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetBlockTransactionsById(testPartialTransactionsWithAbsentIds as any);
      const network = getNetwork();

      await expect(() =>
        network.getBlockTransactionIds(testBlockId),
      ).rejects.toThrow();
    });

    /**
     * @target ErgoNodeNetwork.getBlockTransactionIds 'should return an empty array if block is not found in the blockchain'
     * @dependencies
     * @scenario
     * - mock `getBlockTransactionsById` of ergo node client to reject with a
     *   404 error
     * @expected
     * - returned tx ids should be an empty array
     */
    it('should return an empty array if block is not found in the blockchain', async () => {
      mockApiToThrow('getBlockTransactionsById', {
        response: {
          status: 404,
        },
      });
      const network = getNetwork();

      const actualTxIds = await network.getBlockTransactionIds(testBlockId);

      const expectedTxIds: string[] = [];
      expect(actualTxIds).toEqual(expectedTxIds);
    });
  });

  describe('getBlockInfo', () => {
    /**
     * @target ErgoNodeNetwork.getBlockInfo 'should return block info'
     * @dependencies
     * @scenario
     * - mock `getBlockHeaderById` of ergo node client
     * @expected
     * - returned block info should equal mocked block info
     */
    it('should return block info', async () => {
      mockGetBlockHeaderById();
      const network = getNetwork();

      const actualInfo = await network.getBlockInfo(testBlockId);

      const expectedInfo = {
        hash: testBlockId,
        parentHash: testBlockHeaders.parentId,
        height: Number(testBlockHeaders.height),
      };
      expect(actualInfo).toEqual(expectedInfo);
    });
  });

  describe('getTransaction', () => {
    /**
     * @target ErgoNodeNetwork.getTransaction 'should return transaction bytes hex representation'
     * @dependencies
     * @scenario
     * - mock `getTxById` and `getBlockTransactionsById` of ergo node client
     * @expected
     * - returned tx bytes should equal mocked tx bytes
     */
    it('should return transaction bytes hex representation', async () => {
      mockGetTxByIdAndGetBlockTransactionsById();
      const network = getNetwork();

      const actual = await network.getTransaction(
        testTransaction.id,
        testTransaction.blockId,
      );

      const expectedBytes = testTransactionBytes;
      expect(
        Buffer.from(actual.sigma_serialize_bytes()).toString('hex'),
      ).toEqual(expectedBytes);
    });
  });

  describe('submitTransaction', () => {
    /**
     * @target ErgoNodeNetwork.submitTransaction 'should submit transaction'
     * @dependencies
     * @scenario
     * - mock `sendTransactionAsBytes` of ergo node client
     * @expected
     * - `sendTransactionAsBytes` of ergo node client should be called with
     *   correct arguments
     */
    it('should submit transaction', async () => {
      const sendTransactionAsBytesSpy = mockSendTransactionAsBytes();
      const network = getNetwork();

      await network.submitTransaction(
        Transaction.sigma_parse_bytes(Buffer.from(testTransactionBytes, 'hex')),
      );

      expect(sendTransactionAsBytesSpy).toHaveBeenCalledExactlyOnceWith(
        testTransactionBytes,
      );
    });
  });

  describe('getMempoolTransactions', () => {
    /**
     * @target ErgoNodeNetwork.getMempoolTransactions 'should return all mempool transactions'
     * @dependencies
     * @scenario
     * - mock `getUnconfirmedTransactions` of ergo node client
     * @expected
     * - returned txs should equal mocked txs
     */
    it('should return all mempool transactions', async () => {
      mockGetUnconfirmedTransactions();
      const network = getNetwork();

      const actualTxs = await network.getMempoolTransactions();

      const expectedTxs = testMempoolTransactions.map(
        () => testTransactionBytes,
      );
      expect(
        actualTxs.map((tx) =>
          Buffer.from(tx.sigma_serialize_bytes()).toString('hex'),
        ),
      ).toEqual(expectedTxs);
    });
  });

  describe('getAddressBoxes', () => {
    /**
     * @target ErgoNodeNetwork.getAddressBoxes 'should return address boxes'
     * @dependencies
     * @scenario
     * - mock `getBoxesByAddressUnspent` of ergo node client
     * @expected
     * - returned box bytes should equal mocked box bytes
     */
    it('should return address boxes', async () => {
      mockGetBoxesByAddressUnspent();
      const network = getNetwork();

      const actualBoxes = await network.getAddressBoxes(testAddress, 0, 5);

      const expectedBoxBytes = testAddressBoxesBytes.slice(0, 5);
      expect(
        actualBoxes.map((box) =>
          Buffer.from(box.sigma_serialize_bytes()).toString('hex'),
        ),
      ).toEqual(expectedBoxBytes);
    });

    /**
     * @target ErgoNodeNetwork.getAddressBoxes 'should return an empty array if address is not found or is invalid'
     * @dependencies
     * @scenario
     * - mock `getBoxesByAddressUnspent` of ergo node client to reject with a
     *   400 error
     * @expected
     * - returned box bytes should equal an empty array
     */
    it('should return an empty array if address is not found or is invalid', async () => {
      mockApiToThrow('getBoxesByAddressUnspent', {
        response: {
          status: 400,
        },
      });
      const network = getNetwork();

      const actualBoxes = await network.getAddressBoxes(testAddress, 0, 5);

      const expectedBoxBytes: string[] = [];
      expect(
        actualBoxes.map((box) =>
          Buffer.from(box.sigma_serialize_bytes()).toString('hex'),
        ),
      ).toEqual(expectedBoxBytes);
    });
  });

  describe('getBoxesByTokenId', () => {
    /**
     * @target ErgoNodeNetwork.getBoxesByTokenId 'should return address boxes by token id'
     * @dependencies
     * @scenario
     * - mock `getBoxesByAddressUnspent` of ergo node client
     * @expected
     * - returned box bytes should equal mocked box bytes
     */
    it('should return address boxes by token id', async () => {
      mockGetBoxesByAddressUnspent();
      const network = getNetwork();
      const testTokenId = testAddressBoxes[0].assets[0].tokenId;

      const actualBoxes = await network.getBoxesByTokenId(
        testTokenId,
        testAddress,
        0,
        5,
      );

      const expectedBoxBytes = testAddressBoxes
        .reduce(
          (boxBytes, box, index) =>
            box.assets.some((asset) => asset.tokenId === testTokenId)
              ? [...boxBytes, testAddressBoxesBytes[index]]
              : boxBytes,
          [] as string[],
        )
        .slice(0, 5);

      expect(
        actualBoxes.map((box) =>
          Buffer.from(box.sigma_serialize_bytes()).toString('hex'),
        ),
      ).toEqual(expectedBoxBytes);
    });

    /**
     * @target ErgoNodeNetwork.getBoxesByTokenId 'should return an empty array if address is not found or is invalid'
     * @dependencies
     * @scenario
     * - mock `getBoxesByAddressUnspent` of ergo node client to reject with a
     *   400 error
     * @expected
     * - returned box bytes should equal an empty array
     */
    it('should return an empty array if address is not found or is invalid', async () => {
      mockApiToThrow('getBoxesByAddressUnspent', {
        response: {
          status: 400,
        },
      });
      const network = getNetwork();
      const testTokenId = testAddressBoxes[0].assets[0].tokenId;

      const actualBoxes = await network.getBoxesByTokenId(
        testTokenId,
        testAddress,
        0,
        5,
      );

      const expectedBoxBytes: string[] = [];
      expect(
        actualBoxes.map((box) =>
          Buffer.from(box.sigma_serialize_bytes()).toString('hex'),
        ),
      ).toEqual(expectedBoxBytes);
    });

    /**
     * @target ErgoNodeNetwork.getBoxesByTokenId 'should apply offset and limit to boxes with tokens'
     * @dependencies
     * @scenario
     * - mock `getBoxesByAddressUnspent` of ergo node client
     * @expected
     * - returned box bytes should equal mocked box bytes
     */
    it('should apply offset and limit to boxes with tokens', async () => {
      mockGetBoxesByAddressUnspent();
      const network = getNetwork();
      const testTokenId = testAddressBoxes[2].assets[0].tokenId;

      const actualBoxes = await network.getBoxesByTokenId(
        testTokenId,
        testAddress,
        0,
        1,
      );

      const expectedBoxBytes = [testAddressBoxesBytes[2]];

      expect(
        actualBoxes.map((box) =>
          Buffer.from(box.sigma_serialize_bytes()).toString('hex'),
        ),
      ).toEqual(expectedBoxBytes);
    });
  });

  describe('getStateContext', () => {
    /**
     * @target ErgoNodeNetwork.getStateContext 'should get state context'
     * @dependencies
     * @scenario
     * - mock `getLastHeaders` of ergo node client
     * @expected
     * - returned state context should be a valid one
     */
    it('should get state context', async () => {
      mockGetLastHeaders();
      const network = getNetwork();

      const actualStateContext = await network.getStateContext();

      expect(actualStateContext).toBeInstanceOf(ErgoStateContext);
    });
  });

  describe('isBoxUnspentAndValid', () => {
    /**
     * @target ErgoNodeNetwork.isBoxUnspentAndValid 'should check if box is unspent and valid'
     * @dependencies
     * @scenario
     * - mock `getIndexedBoxById` of ergo node client
     * @expected
     * - should return true
     */
    it('should check if box is unspent and valid', async () => {
      mockIndexedBoxById();
      const network = getNetwork();

      const actualIsValid = await network.isBoxUnspentAndValid(
        testAddressBoxes[0].boxId,
      );

      expect(actualIsValid).toEqual(true);
    });

    /**
     * @target ErgoNodeNetwork.isBoxUnspentAndValid 'should return `false` if box is not found in the blockchain'
     * @dependencies
     * @scenario
     * - mock `getIndexedBoxById` of ergo node client to reject with a 404 error
     * @expected
     * - should return false
     */
    it('should return `false` if box is not found in the blockchain', async () => {
      mockApiToThrow('getIndexedBoxById', {
        response: {
          status: 404,
        },
      });
      const network = getNetwork();

      const actualIsValid = await network.isBoxUnspentAndValid(
        testAddressBoxes[0].boxId,
      );

      expect(actualIsValid).toEqual(false);
    });
  });

  describe('getBox', () => {
    /**
     * @target ErgoNodeNetwork.getBox 'should return the box successfully'
     * @dependencies
     * @scenario
     * - mock `getIndexedBoxById` of ergo node client
     * @expected
     * - returned expected box
     */
    it('should return the box successfully', async () => {
      mockIndexedBoxById();
      const network = getNetwork();
      const serializedBox = testAddressBoxes[0];
      const expectedBoxesBytes = Buffer.from(
        ErgoBox.from_json(
          JsonBigInt.stringify(serializedBox),
        ).sigma_serialize_bytes(),
      ).toString('hex');

      const box = await network.getBox(serializedBox.boxId);
      expect(Buffer.from(box.sigma_serialize_bytes()).toString('hex')).toEqual(
        expectedBoxesBytes,
      );
    });
  });

  describe('getTokenDetail', () => {
    /**
     * @target ErgoNodeNetwork.getTokenDetail 'should return token detail successfully'
     * @dependencies
     * @scenario
     * - mock `getApiV1TokensP1` of ergo explorer client
     * @expected
     * - returned expected token info
     */
    it('should return token detail successfully', async () => {
      mockGetTokenById();

      // run test
      const network = getNetwork();
      const result = await network.getTokenDetail(tokenId);

      // check returned value
      expect(result).toEqual(expectedTokenDetail);
    });
  });
  describe('submitAuthorizedTransaction', () => {
    let server: Server | undefined;
    const { listen, tx } = createAuthorizedSubmissionFixtures((created) => {
      server = created;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
    });
    /**
     * @target ErgoNodeNetwork.submitAuthorizedTransaction 'forwards exact Node wire bytes after the captured callback with URL credentials'
     * @dependencies
     * - Real loopback HTTP server, explicit authorizer, native WASM
     * transaction fixture and legacy-submit spy.
     * @scenario
     * - Create the loopback server and network. Hold or deny explicit
     * authorization, mutate inputs after capture, or return the selected HTTP
     * failure. Submit and inspect exact body/path/authentication or the
     * refusal without legacy dispatch. - Prepare `fixture`, `config`,
     * `network`, `transaction`. - Prepare `dispatch`, `release`. - Prepare
     * `gate`. - Prepare `options`. - Prepare `pending`. - Apply
     * `options.timeoutMs = 1`. - Apply `options.authorizeSubmit = async () =>
     * { throw Error('replacement'); }`. - Apply `config.nodeBaseUrl =
     * 'https://invalid.invalid'`. - Apply `vi.spyOn(transaction,
     * 'sigma_serialize_bytes').mockReturnValue( new Uint8Array([0]), )`. -
     * Apply `release()`. - Apply `await pending`.
     * @expected
     * - `expect(dispatch).toBeDefined()`. -
     * `expect(fixture.bodies).toEqual([])`. -
     * `expect(fixture.bodies).toEqual([JSON.stringify(testTransactionBytes)])`.
     * - `expect(fixture.paths).toEqual(['/prefix/transactions/bytes'])`. -
     * `expect(fixture.auth).toEqual([ 'Basic ' +
     * Buffer.from('fixture:password').toString('base64'), ])`.
     */
    it('forwards exact Node wire bytes after the captured callback with URL credentials', async () => {
      const fixture = await listen(),
        config = { nodeBaseUrl: fixture.url },
        network = new ErgoNodeNetwork(config),
        transaction = tx();
      let dispatch!: () => void, release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const options = {
        timeoutMs: 1000,
        authorizeSubmit: async (start: () => void) => {
          dispatch = start;
          await gate;
          start();
        },
      };
      const pending = network.submitAuthorizedTransaction(transaction, options);
      await vi.waitFor(() => expect(dispatch).toBeDefined());
      expect(fixture.bodies).toEqual([]);
      options.timeoutMs = 1;
      options.authorizeSubmit = async () => {
        throw Error('replacement');
      };
      config.nodeBaseUrl = 'https://invalid.invalid';
      vi.spyOn(transaction, 'sigma_serialize_bytes').mockReturnValue(
        new Uint8Array([0]),
      );
      release();
      await pending;
      expect(fixture.bodies).toEqual([JSON.stringify(testTransactionBytes)]);
      expect(fixture.paths).toEqual(['/prefix/transactions/bytes']);
      expect(fixture.auth).toEqual([
        'Basic ' + Buffer.from('fixture:password').toString('base64'),
      ]);
    });
    /**
     * @target ErgoNodeNetwork.submitAuthorizedTransaction 'propagates authorization denial without invoking legacy send'
     * @dependencies
     * - Real loopback HTTP server, explicit authorizer, native WASM
     * transaction fixture and legacy-submit spy.
     * @scenario
     * - Create the loopback server and network. Hold or deny explicit
     * authorization, mutate inputs after capture, or return the selected HTTP
     * failure. Submit and inspect exact body/path/authentication or the
     * refusal without legacy dispatch. - Prepare `fixture`, `network`,
     * `legacy`.
     * @expected
     * - `expect( network.submitAuthorizedTransaction(tx(), { timeoutMs: 1000,
     * authorizeSubmit: async () => { throw Error('held'); }, }),
     * ).rejects.toMatchObject({ reason: 'denied' })`. -
     * `expect(fixture.bodies).toEqual([])`. -
     * `expect(legacy).not.toHaveBeenCalled()`.
     */
    it('propagates authorization denial without invoking legacy send', async () => {
      const fixture = await listen(),
        network = new ErgoNodeNetwork({ nodeBaseUrl: fixture.url }),
        legacy = vi.spyOn(network, 'submitTransaction');
      await expect(
        network.submitAuthorizedTransaction(tx(), {
          timeoutMs: 1000,
          authorizeSubmit: async () => {
            throw Error('held');
          },
        }),
      ).rejects.toMatchObject({ reason: 'denied' });
      expect(fixture.bodies).toEqual([]);
      expect(legacy).not.toHaveBeenCalled();
    });
    /**
     * @target ErgoNodeNetwork.submitAuthorizedTransaction 'propagates HTTP failure rather than mapping it to success'
     * @dependencies
     * - Real loopback HTTP server, explicit authorizer, native WASM
     * transaction fixture and legacy-submit spy.
     * @scenario
     * - Create the loopback server and network. Hold or deny explicit
     * authorization, mutate inputs after capture, or return the selected HTTP
     * failure. Submit and inspect exact body/path/authentication or the
     * refusal without legacy dispatch. - Prepare `fixture`, `network`.
     * @expected
     * - `expect( network.submitAuthorizedTransaction(tx(), { timeoutMs: 1000,
     * authorizeSubmit: async (start) => start(), }), ).rejects.toMatchObject({
     * response: { status: 503 } })`. -
     * `expect(fixture.bodies).toHaveLength(1)`.
     */
    it('propagates HTTP failure rather than mapping it to success', async () => {
      const fixture = await listen(503),
        network = new ErgoNodeNetwork({ nodeBaseUrl: fixture.url });
      await expect(
        network.submitAuthorizedTransaction(tx(), {
          timeoutMs: 1000,
          authorizeSubmit: async (start) => start(),
        }),
      ).rejects.toMatchObject({ response: { status: 503 } });
      expect(fixture.bodies).toHaveLength(1);
    });
    /**
     * @target ErgoNodeNetwork.submitAuthorizedTransaction 'requires an explicit valid timeout before invoking authorization'
     * @dependencies
     * - Real loopback HTTP server, explicit authorizer, native WASM
     * transaction fixture and legacy-submit spy.
     * @scenario
     * - Create the loopback server and network. Hold or deny explicit
     * authorization, mutate inputs after capture, or return the selected HTTP
     * failure. Submit and inspect exact body/path/authentication or the
     * refusal without legacy dispatch. - Prepare `fixture`, `network`,
     * `authorize`.
     * @expected
     * - `expect( network.submitAuthorizedTransaction(tx(), { timeoutMs: 0,
     * authorizeSubmit: authorize, }), ).rejects.toMatchObject({ reason:
     * 'invalid' })`. - `expect(authorize).not.toHaveBeenCalled()`. -
     * `expect(fixture.bodies).toEqual([])`.
     */
    it('requires an explicit valid timeout before invoking authorization', async () => {
      const fixture = await listen(),
        network = new ErgoNodeNetwork({ nodeBaseUrl: fixture.url }),
        authorize = vi.fn();
      await expect(
        network.submitAuthorizedTransaction(tx(), {
          timeoutMs: 0,
          authorizeSubmit: authorize,
        }),
      ).rejects.toMatchObject({ reason: 'invalid' });
      expect(authorize).not.toHaveBeenCalled();
      expect(fixture.bodies).toEqual([]);
    });
  });
});
