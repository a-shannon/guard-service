import { randomBytes } from 'crypto';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { vi } from 'vitest';

import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { Repository } from '@rosen-bridge/extended-typeorm';
import { FailedError } from '@rosen-chains/abstract-chain';
import { EvmTxStatus } from '@rosen-chains/evm';

import { mockDataSource } from './mocked/dataSource.mock';
import './mocked/ethers.mock';
import { ContractInstance } from './mocked/ethers.mock';
import { mockGetUrl, mockRealRpcProvider } from './mocked/realRpcProvider.mock';
import * as testData from './testData';
import { TestEvmRpcNetwork } from './testEvmRpcNetwork';

describe('EvmRpcNetwork', () => {
  let network: TestEvmRpcNetwork;
  let addressTxRepository: Repository<AddressTxsEntity>;
  const generateRandomId = (): string => randomBytes(32).toString('hex');

  beforeEach(async () => {
    const dataSource = await mockDataSource();
    network = new TestEvmRpcNetwork(
      'test',
      'custom-url',
      dataSource,
      testData.lockAddress,
    );
    addressTxRepository = dataSource.getRepository(AddressTxsEntity);
  });

  describe('getHeight', () => {
    /**
     * @target `EvmRpcNetwork.getHeight` should return block height successfully
     * @dependencies
     * @scenario
     * - mock provider.`getBlockNumber` to return height
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked block height
     */
    it('should return block height successfully', async () => {
      vi.spyOn(network.getProvider(), 'getBlockNumber').mockResolvedValue(
        testData.blockHeight,
      );

      const result = await network.getHeight();

      expect(result).toEqual(testData.blockHeight);
    });
  });

  describe('getTxConfirmation', () => {
    /**
     * @target `EvmRpcNetwork.getTxConfirmation` should fetch confirmation using unsigned hash successfully
     * @dependencies
     * - database
     * @scenario
     * - insert transaction with expected unsigned hash into database
     * - mock provider.`getTransaction`
     *   - `wait` to return the transaction
     *   - `confirmations` to return confirmation
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - provider.`getTransaction` should have been called with signedHash
     */
    it('should fetch confirmation using unsigned hash successfully', async () => {
      const unsignedHash = generateRandomId();
      const signedHash = generateRandomId();

      await addressTxRepository.insert({
        unsignedHash: unsignedHash,
        signedHash: signedHash,
        nonce: 0,
        address: testData.lockAddress,
        blockId: 'blockId',
        extractor: 'custom-extractor',
        status: 'succeed',
      });

      const mockedConfirmation = 60;
      const transactionInstance = {
        wait: vi.fn(),
        confirmations: vi.fn(),
      };
      transactionInstance.wait.mockResolvedValue(testData.transaction0);
      transactionInstance.confirmations.mockResolvedValue(mockedConfirmation);
      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(transactionInstance as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const result = await network.getTxConfirmation(unsignedHash);
      expect(result).toEqual(mockedConfirmation);
      expect(getTransactionSpy).toHaveBeenCalledExactlyOnceWith(signedHash);
    });

    /**
     * @target `EvmRpcNetwork.getTxConfirmation` should fetch confirmation using txId successfully
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction`
     *   - `wait` to return the transaction
     *   - `confirmations` to return confirmation
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - provider.`getTransaction` should have been called with txId
     */
    it('should fetch confirmation using txId successfully', async () => {
      const txId = generateRandomId();

      const mockedConfirmation = 60;
      const transactionInstance = {
        wait: vi.fn(),
        confirmations: vi.fn(),
      };
      transactionInstance.wait.mockResolvedValue(testData.transaction0);
      transactionInstance.confirmations.mockResolvedValue(mockedConfirmation);
      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(transactionInstance as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const result = await network.getTxConfirmation(txId);
      expect(result).toEqual(mockedConfirmation);
      expect(getTransactionSpy).toHaveBeenCalledExactlyOnceWith(txId);
    });

    /**
     * @target `EvmRpcNetwork.getTxConfirmation` should return -1 when transaction is not found
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction`
     *   - `confirmations` to return null
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be -1
     * - provider.`getTransaction` should have been called with txId
     */
    it('should return -1 when transaction is not found', async () => {
      const txId = generateRandomId();

      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(null);

      const result = await network.getTxConfirmation(txId);
      expect(result).toEqual(-1);
      expect(getTransactionSpy).toHaveBeenCalledExactlyOnceWith(txId);
    });

    /**
     * @target `EvmRpcNetwork.getTxConfirmation` should return -1 for failed tx using unsigned hash
     * @dependencies
     * - database
     * @scenario
     * - insert transaction with expected unsigned hash into database
     * - mock provider.`getTransaction`
     *   - `wait` to return null
     *   - `confirmations` to return confirmation
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - provider.`getTransaction` should have been called with signedHash
     */
    it('should return -1 for failed tx using unsigned hash', async () => {
      const unsignedHash = generateRandomId();
      const signedHash = generateRandomId();

      await addressTxRepository.insert({
        unsignedHash: unsignedHash,
        signedHash: signedHash,
        nonce: 0,
        address: testData.lockAddress,
        blockId: 'blockId',
        extractor: 'custom-extractor',
        status: 'failed',
      });

      const mockedConfirmation = 60;
      const transactionInstance = {
        wait: vi.fn(),
        confirmations: vi.fn(),
      };
      transactionInstance.wait.mockResolvedValue(null);
      transactionInstance.confirmations.mockResolvedValue(mockedConfirmation);
      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(transactionInstance as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const result = await network.getTxConfirmation(unsignedHash);
      expect(result).toEqual(-1);
      expect(getTransactionSpy).toHaveBeenCalledExactlyOnceWith(signedHash);
    });

    /**
     * @target `EvmRpcNetwork.getTxConfirmation` should return -1 for failed tx using signed hash
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction`
     *   - `wait` to return null
     *   - `confirmations` to return confirmation
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - provider.`getTransaction` should have been called with txId
     */
    it('should return -1 for failed tx using signed hash', async () => {
      const txId = generateRandomId();

      const mockedConfirmation = 60;
      const transactionInstance = {
        wait: vi.fn(),
        confirmations: vi.fn(),
      };
      transactionInstance.wait.mockResolvedValue(null);
      transactionInstance.confirmations.mockResolvedValue(mockedConfirmation);
      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(transactionInstance as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const result = await network.getTxConfirmation(txId);
      expect(result).toEqual(-1);
      expect(getTransactionSpy).toHaveBeenCalledExactlyOnceWith(txId);
    });
  });

  describe('getBlockTransactionIds', () => {
    /**
     * @target `EvmRpcNetwork.getBlockTransactionIds` should return block txIds successfully
     * @dependencies
     * @scenario
     * - mock provider.`getBlock` to return txIds
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked block txIds
     */
    it('should return block txIds successfully', async () => {
      vi.spyOn(network.getProvider(), 'getBlock').mockResolvedValue(
        testData.getBlockResponse,
      );

      const result = await network.getBlockTransactionIds(testData.blockHash);

      expect(result).toEqual(testData.blockTxIds);
    });
  });

  describe('getBlockInfo', () => {
    /**
     * @target `EvmRpcNetwork.getBlockInfo` should return block info successfully
     * @dependencies
     * @scenario
     * - mock provider.`getBlock` to return info
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked block info
     */
    it('should return block info successfully', async () => {
      vi.spyOn(network.getProvider(), 'getBlock').mockResolvedValue(
        testData.getBlockResponse,
      );

      const result = await network.getBlockInfo(testData.blockHash);

      expect(result).toEqual(testData.blockInfo);
    });
  });

  describe('getTransaction', () => {
    /**
     * @target `EvmRpcNetwork.getTransaction` should throw error when tx is not found
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction` to return null
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked the transaction
     */
    it('should throw error when tx is not found', async () => {
      vi.spyOn(network.getProvider(), 'getTransaction').mockResolvedValue(null);

      await expect(async () => {
        await network.getTransaction(
          testData.transaction0Id,
          testData.transaction0BlockId,
        );
      }).rejects.toThrow(FailedError);
    });

    /**
     * @target `EvmRpcNetwork.getTransaction` should throw error when tx block does not
     * match with given block id
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction` to return mocked tx
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked the transaction
     */
    it('should throw error when tx block does not match with given block id', async () => {
      vi.spyOn(network.getProvider(), 'getTransaction').mockResolvedValue(
        testData.transaction0Response,
      );

      await expect(async () => {
        await network.getTransaction(
          testData.transaction0Id,
          testData.blockHash,
        );
      }).rejects.toThrow(FailedError);
    });
  });

  describe('getTokenDetail', () => {
    /**
     * @target `EvmRpcNetwork.getTokenDetail` should fetch token info successfully
     * @dependencies
     * @scenario
     * - mock Contract `name` and `decimals` functions
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked confirmation
     */
    it('should fetch token info successfully', async () => {
      vi.spyOn(ContractInstance, 'name').mockResolvedValue(testData.tokenName);
      vi.spyOn(ContractInstance, 'decimals').mockResolvedValue(
        testData.tokenDecimals,
      );
      const result = await network.getTokenDetail(testData.tokenId);
      expect(result).toEqual({
        tokenId: testData.tokenId,
        name: testData.tokenName,
        decimals: testData.tokenDecimals,
      });
    });
  });

  describe('getAddressBalanceForERC20Asset', () => {
    /**
     * @target `EvmRpcNetwork.getAddressBalanceForERC20Asset` should fetch token balance successfully
     * @dependencies
     * @scenario
     * - mock Contract `balanceOf` function
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - Contract `balanceOf` function should have been called with given address
     */
    it('should fetch token balance successfully', async () => {
      const address = testData.lockAddress;
      vi.spyOn(ContractInstance, 'balanceOf').mockResolvedValue(
        testData.balance,
      );

      const result = await network.getAddressBalanceForERC20Asset(
        address,
        testData.tokenId,
      );
      expect(result).toEqual(testData.balance);
      expect(ContractInstance.balanceOf).toHaveBeenCalledExactlyOnceWith(
        address,
      );
    });
  });

  describe('getAddressBalanceForNativeToken', () => {
    /**
     * @target `EvmRpcNetwork.getAddressBalanceForNativeToken` should return address balance successfully
     * @dependencies
     * @scenario
     * - mock provider.`getBalance` to return balance
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked balance
     */
    it('should return address balance successfully', async () => {
      vi.spyOn(network.getProvider(), 'getBalance').mockResolvedValue(
        testData.balance,
      );

      const result = await network.getAddressBalanceForNativeToken(
        testData.lockAddress,
      );

      expect(result).toEqual(testData.balance);
    });
  });

  describe('getAddressNextAvailableNonce', () => {
    /**
     * @target `EvmRpcNetwork.getAddressNextAvailableNonce` should return address nonce successfully
     * @dependencies
     * @scenario
     * - mock provider.`getTransactionCount` to return address tx count
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked nonce
     */
    it('should return address nonce successfully', async () => {
      vi.spyOn(network.getProvider(), 'getTransactionCount').mockResolvedValue(
        testData.addressTxCount,
      );

      const result = await network.getAddressNextAvailableNonce(
        testData.lockAddress,
      );

      expect(result).toEqual(testData.addressTxCount);
    });
  });

  describe('getGasRequired', () => {
    /**
     * @target `EvmRpcNetwork.getGasRequired` should return gas estimation successfully
     * @dependencies
     * @scenario
     * - mock provider.`estimateGas` to return address tx count
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked nonce
     */
    it('should return gas estimation successfully', async () => {
      vi.spyOn(network.getProvider(), 'estimateGas').mockResolvedValue(
        testData.gasLimit,
      );

      const result = await network.getGasRequired(testData.transaction0);

      expect(result).toEqual(testData.gasLimit);
    });
  });

  describe('getFeeData', () => {
    /**
     * @target `EvmRpcNetwork.getFeeData` should return fee data successfully
     * @dependencies
     * @scenario
     * - mock provider.`getFeeData` to return address tx count
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked nonce
     */
    it('should return fee data successfully', async () => {
      vi.spyOn(network.getProvider(), 'getFeeData').mockResolvedValue(
        testData.feeDataResponse,
      );

      const result = await network.getFeeData();

      expect(result).toEqual(testData.feeDataResponse);
    });
  });

  describe('getTransactionStatus', () => {
    /**
     * @target `EvmRpcNetwork.getTransactionStatus` should return not found successfully
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction` to return null
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - provider.`getTransaction` should have been called with signedHash
     */
    it('should return not found successfully', async () => {
      const hash = generateRandomId();

      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(null);

      const result = await network.getTransactionStatus(hash);
      expect(result).toEqual(EvmTxStatus.notFound);
    });

    /**
     * @target `EvmRpcNetwork.getTransactionStatus` should return succeed successfully
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction`.`wait` to return the transaction
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - provider.`getTransaction` should have been called with signedHash
     */
    it('should return succeed successfully', async () => {
      const hash = generateRandomId();

      const transactionInstance = {
        wait: vi.fn(),
        confirmations: vi.fn(),
      };
      transactionInstance.wait.mockResolvedValue(testData.transaction0);
      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(transactionInstance as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const result = await network.getTransactionStatus(hash);
      expect(result).toEqual(EvmTxStatus.succeed);
    });

    /**
     * @target `EvmRpcNetwork.getTransactionStatus` should return mempool successfully
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction`.`wait` to return null
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - provider.`getTransaction` should have been called with signedHash
     */
    it('should return mempool successfully', async () => {
      const hash = generateRandomId();

      const transactionInstance = {
        wait: vi.fn(),
        confirmations: vi.fn(),
      };
      transactionInstance.wait.mockResolvedValue(null);
      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(transactionInstance as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const result = await network.getTransactionStatus(hash);
      expect(result).toEqual(EvmTxStatus.mempool);
    });

    /**
     * @target `EvmRpcNetwork.getTransactionStatus` should return failed when it throws CallbackException
     * @dependencies
     * @scenario
     * - mock provider.`getTransaction`.`wait` to return null
     * - run test
     * - check returned value
     * - check function is called
     * @expected
     * - it should be mocked confirmation
     * - provider.`getTransaction` should have been called with signedHash
     */
    it('should return failed when it throws CallbackException', async () => {
      const hash = generateRandomId();

      const transactionInstance = {
        wait: vi.fn(),
        confirmations: vi.fn(),
      };
      transactionInstance.wait.mockRejectedValue({
        code: 'CALL_EXCEPTION',
      });
      const getTransactionSpy = vi.spyOn(
        network.getProvider(),
        'getTransaction',
      );
      getTransactionSpy.mockResolvedValue(transactionInstance as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const result = await network.getTransactionStatus(hash);
      expect(result).toEqual(EvmTxStatus.failed);
    });
  });

  describe('getTransactionByNonce', () => {
    /**
     * @target `EvmRpcNetwork.getTransactionByNonce` should return hashes when tx is found in database
     * @dependencies
     * - database
     * @scenario
     * - insert transaction into database
     * - run test
     * - check returned value
     * @expected
     * - it should be expected hashes
     */
    it('should return hashes when tx is found in database', async () => {
      const unsignedHash = generateRandomId();
      const signedHash = generateRandomId();

      const nonce = 10;
      await addressTxRepository.insert({
        unsignedHash: unsignedHash,
        signedHash: signedHash,
        nonce: nonce,
        address: testData.lockAddress,
        blockId: 'blockId',
        extractor: 'custom-extractor',
        status: 'succeed',
      });

      const result = await network.getTransactionByNonce(nonce);
      expect(result).toEqual({
        unsignedHash: unsignedHash,
        txId: signedHash,
      });
    });

    /**
     * @target `EvmRpcNetwork.getTransactionByNonce` should throw Error when tx is not found in database
     * @dependencies
     * - database
     * @scenario
     * - run test
     * - check returned value
     * @expected
     * - it should throw Error
     */
    it('should throw Error when tx is not found in database', async () => {
      await expect(async () => {
        await network.getTransactionByNonce(10);
      }).rejects.toThrow(Error);
    });
  });

  describe('getActualTxId', () => {
    /**
     * @target `EvmRpcNetwork.getActualTxId` should return signed hash from db when tx exists in db and network
     * @dependencies
     * @scenario
     * - define a mock unsigned hash
     * - define a mock tx
     * - stub dbAction.getTxByUnsignedHash to return the mock tx
     * - stub provider.getTransaction to return a mock response
     * - call getActualTxId using the unsigned hash
     * @expected
     * - getActualTxId should have returned the signed hash of requested tx
     * - getTxByUnsignedHash should have been called once with the unsigned hash
     */
    it('should return signed hash from db when tx exists in db and network', async () => {
      // arrange
      const unsignedHash = testData.transaction0.unsignedHash;
      const mockTx = { signedHash: testData.transaction0Id };
      const getTxByUnsignedHashSpy = vi
        .spyOn(network.getDbAction(), 'getTxByUnsignedHash')
        .mockResolvedValue(mockTx as AddressTxsEntity);
      vi.spyOn(network.getProvider(), 'getTransaction').mockResolvedValue(
        testData.transaction0Response,
      );

      // act
      const txId = await network.getActualTxId(unsignedHash);

      // assert
      expect(txId).toEqual(testData.transaction0Id);
      expect(getTxByUnsignedHashSpy).toHaveBeenCalledExactlyOnceWith(
        unsignedHash,
      );
    });

    /**
     * @target `EvmRpcNetwork.getActualTxId` should return the same hash when tx exists in network but not in db
     * @dependencies
     * @scenario
     * - define a mock unsigned hash
     * - stub dbAction.getTxByUnsignedHash to return null
     * - stub provider.getTransaction to return a mock response
     * - call getActualTxId using the unsigned hash
     * @expected
     * - getActualTxId should have returned the the same hash
     * - getTxByUnsignedHash should have been called once with the unsigned hash
     */
    it('should return the same hash when tx exists in network but not in db', async () => {
      // arrange
      const unsignedHash = testData.transaction0.unsignedHash;
      const getTxByUnsignedHashSpy = vi
        .spyOn(network.getDbAction(), 'getTxByUnsignedHash')
        .mockResolvedValue(null);
      vi.spyOn(network.getProvider(), 'getTransaction').mockResolvedValue(
        testData.transaction0Response,
      );

      // act
      const txId = await network.getActualTxId(unsignedHash);

      // assert
      expect(txId).toEqual(unsignedHash);
      expect(getTxByUnsignedHashSpy).toHaveBeenCalledExactlyOnceWith(
        unsignedHash,
      );
    });

    /**
     * @target `EvmRpcNetwork.getActualTxId` should throw when tx exists in db but not in network
     * @dependencies
     * @scenario
     * - define a mock unsigned hash
     * - stub dbAction.getTxByUnsignedHash to return a mock tx
     * - stub provider.getTransaction to return null
     * - call getActualTxId using the unsigned hash
     * @expected
     * - getActualTxId should have thrown
     * - getTxByUnsignedHash should have been called once with the unsigned hash
     */
    it('should throw when tx exists in db but not in network', async () => {
      // arrange
      const unsignedHash = testData.transaction0.unsignedHash;
      const getTxByUnsignedHashSpy = vi
        .spyOn(network.getDbAction(), 'getTxByUnsignedHash')
        .mockResolvedValue({ signedHash: 'signedHash' } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      vi.spyOn(network.getProvider(), 'getTransaction').mockResolvedValue(null);

      // act and assert
      await expect(async () => {
        await network.getActualTxId(unsignedHash);
      }).rejects.toThrow();

      expect(getTxByUnsignedHashSpy).toHaveBeenCalledExactlyOnceWith(
        unsignedHash,
      );
    });
  });
  describe('constructor', () => {
    const providers: JsonRpcProvider[] = [];
    const networks: TestEvmRpcNetwork[] = [];
    const { url, lock } = testData.rpcTransportControlData;
    const getRepository = vi.fn(() => ({}));
    const database = { getRepository } as unknown as DataSource;
    const db = database;
    let restoreProvider: () => void;
    beforeEach(async () => {
      getRepository.mockClear();
      restoreProvider = await mockRealRpcProvider();
    });
    afterEach(() => {
      providers.splice(0).forEach((provider) => provider.destroy());
      networks.splice(0).forEach((network) => network['provider'].destroy());
      restoreProvider();
    });
    /**
     * @target EvmRpcNetwork.constructor installs the hook before provider cloning, including when no custom timeout is given
     * @dependencies
     * - Real ethers provider scoped over the existing constructor mock.
     * - Synthetic repository spy and synthetic transport hook.
     * @scenario
     * - Construct generic EVM providers with the hook and both default/explicit deadlines.
     * @expected
     * - The hook reference is installed before cloning and the timeout is exact.
     */
    it('installs the hook before provider cloning, including when no custom timeout is given', () => {
      for (const timeout of [undefined, 120]) {
        const network = new TestEvmRpcNetwork(
          'synthetic',
          'https://fixture.invalid',
          db,
          'lock',
          undefined,
          undefined,
          timeout,
          mockGetUrl,
        );
        const provider = network['provider'];
        providers.push(provider);
        expect(provider._getConnection().getUrlFunc).toEqual(mockGetUrl);
        expect(provider._getConnection().timeout).toEqual(timeout ?? 300000);
      }
    });

    /**
     * @target EvmRpcNetwork.constructor preserves the legacy default transport with and without an explicit timeout
     * @dependencies
     * - Real ethers provider scoped over the existing constructor mock.
     * - Synthetic repository spy and synthetic transport hook.
     * @scenario
     * - Construct generic EVM providers without a hook at default/explicit deadlines.
     * @expected
     * - The original SDK transport reference and deadline remain intact.
     */
    it('preserves the legacy default transport with and without an explicit timeout', () => {
      for (const timeout of [undefined, 120]) {
        const network = new TestEvmRpcNetwork(
          'synthetic',
          'https://fixture.invalid',
          db,
          'lock',
          undefined,
          undefined,
          timeout,
        );
        const provider = network['provider'];
        providers.push(provider);
        expect(provider._getConnection().getUrlFunc).toEqual(
          new FetchRequest('https://fixture.invalid').getUrlFunc,
        );
        expect(provider._getConnection().timeout).toEqual(timeout ?? 300000);
      }
    });

    /**
     * @target EvmRpcNetwork.constructor preserves the old shared EVM default and auth (%s)
     * @dependencies
     * - Real ethers provider scoped over the existing constructor mock.
     * - Synthetic repository spy and synthetic transport hook.
     * @scenario
     * - Construct the old generic EVM adapter with each auth variant and no deadline.
     * @expected
     * - The original300000ms default and auth URL remain intact.
     */
    it.each([undefined, 'synthetic-token'])(
      'preserves the old shared EVM default and auth (%s)',
      (authToken) => {
        const network = new TestEvmRpcNetwork(
          'ethereum',
          url,
          database,
          lock,
          authToken,
        );
        networks.push(network);
        expect(network['provider']._getConnection().timeout).toEqual(300000);
        expect(network['provider']._getConnection().url).toEqual(
          authToken ? `${url}/${authToken}` : url,
        );
      },
    );

    /**
     * @target EvmRpcNetwork.constructor rejects invalid explicitly supplied shared hook timeout %s
     * @dependencies
     * - Real ethers provider scoped over the existing constructor mock.
     * - Synthetic repository spy and synthetic transport hook.
     * @scenario
     * - Supply each malformed explicit deadline to the shared EVM constructor.
     * @expected
     * - Shared timeout validation rejects before repository effects.
     */
    it.each([null, '1000', true, 0, -1, 0.5, NaN, Infinity, 2147483648])(
      'rejects invalid explicitly supplied shared hook timeout %s',
      (timeoutMs) => {
        expect(
          () =>
            new TestEvmRpcNetwork(
              'ethereum',
              url,
              database,
              lock,
              undefined,
              undefined,
              timeoutMs as number,
            ),
        ).toThrow('EVM RPC timeout');
        expect(getRepository).not.toHaveBeenCalled();
      },
    );
  });
});
