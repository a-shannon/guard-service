import {
  type FastifyWithZod as ColdFastifyWithZod,
  makeFastify as makeColdFastify,
} from '@rosen-bridge/fastify-enhanced';
import { TokenMap } from '@rosen-bridge/tokens';
import { AssetBalance } from '@rosen-chains/abstract-chain';
import { BITCOIN_CHAIN } from '@rosen-chains/bitcoin';
import { ADA, CARDANO_CHAIN } from '@rosen-chains/cardano';
import { DOGE_CHAIN } from '@rosen-chains/doge';

import { balanceRoutes as coldBalanceRoutes } from '../../src/api/balance';
import { DatabaseAction } from '../../src/db/databaseAction';
import ColdBalanceHandler from '../../src/handlers/balanceHandler';
import ChainHandler from '../../src/handlers/chainHandler';
import { TokenHandler as ColdTokenHandler } from '../../src/handlers/tokenHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import { LEGACY_BALANCE_CHAINS } from '../../src/utils/constants';
import {
  changed as coldChangedAddress,
  cold as coldCustodyAddress,
  joe as coldJoe,
  lock as coldLockAddress,
} from '../api/avalancheColdBalanceTestData';
import {
  createColdTokenMap as createColdMap,
  insertColdBalance,
} from '../api/avalancheColdBalanceTestUtils';
import { mockColdBalanceCustody } from '../api/mocked/avalancheColdBalance.mock';
import { avalancheAddress as address } from '../avalancheRegistryTestData';
import ColdDatabaseActionMock from '../db/mocked/databaseAction.mock';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import {
  policy as coldPolicy,
  TestBalances as ColdTestBalances,
} from './avalancheBalanceTestUtils';
import { TestBalances, policy } from './avalancheBalanceTestUtils';
import ChainHandlerMock from './chainHandler.mock';
import {
  createAssetsMock,
  resetAssetsMock,
  mockBalanceChain,
} from './mocked/avalancheBalance.mock';
import TestBalanceHandler from './testBalanceHandler';
import {
  cardanoCometTokenId,
  cardanoLockAddress,
  cardanoTokenIds,
  mockAddressBalance,
  mockAddressBalance2,
  mockAddressBalance3,
  mockBalances,
  mockCardanoBalances,
  mockPartialCardanoBalances,
} from './testData';

describe('BalanceHandler', () => {
  const balanceHandler = new TestBalanceHandler();
  describe('getNativeTokenBalances', () => {
    describe('legacy behavior', () => {
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
      });

      /**
       * @target BalanceHandler.getNativeTokenBalances should return an empty array when database is empty
       * @dependencies
       * - DatabaseAction
       * @scenario
       * - call getNativeTokenBalances
       * @expected
       * - getNativeTokenBalances should have resolved to an empty array
       */
      it('should return an empty array when database is empty', async () => {
        // act
        const result = await balanceHandler.getNativeTokenBalances();

        // assert
        expect(result).toEqual([]);
      });

      /**
       * @target BalanceHandler.getNativeTokenBalances should return balances when database is not empty
       * @dependencies
       * - DatabaseAction
       * @scenario
       * - populate database with 4 mock ChainAddressBalanceEntity objects
       * - call getNativeTokenBalances
       * @expected
       * - getNativeTokenBalances should have resolved to an array of 2 native token balances for bitcoin and cardano
       */
      it('should return balances when database is not empty', async () => {
        // arrange
        // populate database with mock balance records
        for (const chain of Object.keys(mockBalances)) {
          for (const balance of mockBalances[chain]) {
            await DatabaseActionMock.insertChainAddressBalanceRecord(balance);
          }
        }

        // act
        const result = await balanceHandler.getNativeTokenBalances();

        // assert
        expect(result).toEqual(mockAddressBalance3);
      });
    });
    describe('Avalanche registry boundaries', () => {
      const assets = createAssetsMock();

      let spy: ReturnType<typeof vi.spyOn>;

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        resetAssetsMock(assets);
        spy = mockBalanceChain(address, assets);
      });

      afterEach(() => spy.mockRestore());

      /**
       * @target BalanceHandler.getNativeTokenBalances excludes Avalanche rows from native numeric balance conversion
       * @dependencies Real handler and repository; mocked native-balance query.
       * @scenario Return a stale Avalanche row carrying a legacy native-token ID.
       * @expected Query no AVAX token and filter the row before numeric conversion.
       */
      it('excludes Avalanche rows from native numeric balance conversion', async () => {
        const query = vi
          .spyOn(
            DatabaseAction.getInstance(),
            'getChainAddressBalanceByTokenIds',
          )
          .mockResolvedValue([
            {
              chain: 'avalanche',
              address,
              tokenId: 'btc',
              balance: 9007199254740993n,
              lastUpdate: '1',
            },
          ]);
        try {
          expect(await new TestBalances().getNativeTokenBalances()).toEqual([]);
          expect(query.mock.calls[0][0]).not.toContain('avax');
        } finally {
          query.mockRestore();
        }
      });
    });
  });
  describe('getChainTokenIds', () => {
    describe('legacy behavior', () => {
      /**
       * @target BalanceHandler.getChainTokenIds should return empty array when token map is empty
       * @dependencies
       * - TokensMap
       * @scenario
       * - stub TokenMap.getConfig to return empty array
       * - call getChainTokenIds with CARDANO_CHAIN
       * @expected
       * - result should have been an empty array
       */
      it('should return empty array when token map is empty', () => {
        // arrange
        vi.spyOn(TokenHandler.getInstance(), 'getTokenMap').mockReturnValueOnce(
          {
            getConfig: () => [],
          } as unknown as TokenMap,
        );

        // act
        const result = balanceHandler.callGetChainTokenIds(CARDANO_CHAIN);

        // assert
        expect(result).toEqual([]);
      });

      /**
       * @target BalanceHandler.getChainTokenIds should return empty array when no tokens exist for specified chain
       * @dependencies
       * - TokensMap
       * @scenario
       * - call getChainTokenIds with DOGE_CHAIN
       * @expected
       * - result should have been an empty array
       */
      it('should return empty array when no tokens exist for specified chain', () => {
        // act
        const result = balanceHandler.callGetChainTokenIds(DOGE_CHAIN);

        // assert
        expect(result).toEqual([]);
      });

      /**
       * @target BalanceHandler.getChainTokenIds should return non-native token ids of chain when it has both of the token types
       * @dependencies
       * - TokensMap
       * @scenario
       * - call getChainTokenIds with CARDANO_CHAIN
       * @expected
       * - result length should have been equal to 6
       * - result should have contained all the other 6 tokens of tokensMap that cardano supports except ada
       */
      it('should return non-native token ids of chain when it has both of the token types', () => {
        // act
        const result = balanceHandler.callGetChainTokenIds(CARDANO_CHAIN);

        // assert
        expect(result).toHaveLength(6);
        expect(result).toContain(
          'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
        );
        expect(result).toContain(
          'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
        );
        expect(result).toContain(
          'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59',
        );
        expect(result).toContain(
          '45fdcb56b039bfba0028f350aaabe0508e4bb4d8c4d7c3c7d481c235.48',
        );
        expect(result).toContain(
          '3122541486c983d637e7ed9330c94e490e1fe4a1758725fab7f6d9e0.72734254432d6c6f656e',
        );
        expect(result).toContain(
          'ac0a478c70238bff24e20107ebe399e7f3a3e854037622427206b024.72734d44546f6b656e2d6c6f656e',
        );
        expect(result).not.toContain(ADA);
      });
    });
  });
  describe('getAddressAssets', () => {
    describe('legacy behavior', () => {
      beforeEach(async () => {
        ChainHandlerMock.resetMock();

        await DatabaseActionMock.clearTables();

        // populate database with mock balance records
        for (const chain of Object.keys(mockBalances)) {
          for (const balance of mockBalances[chain]) {
            await DatabaseActionMock.insertChainAddressBalanceRecord(balance);
          }
        }

        for (const chain of LEGACY_BALANCE_CHAINS) {
          ChainHandlerMock.mockChainName(chain);
          ChainHandlerMock.mockChainFunction(
            chain,
            'getChainConfigs',
            {
              addresses: {
                lock: `${chain}_mock_lock_address`,
                cold: `${chain}_mock_cold_address`,
              },
            },
            false,
          );
        }
      });

      /**
       * @target BalanceHandler.getAddressAssets should successfully read balance records of cold addresses from database
       * @dependencies
       * - TokensMap
       * - ChainHandler
       * - DatabaseAction
       * @scenario
       * - stub ChainHandler getChainConfigs to return a mock chainConfig for supported chains
       * - populate database with 4 mock ChainAddressBalanceEntity objects for lock and cold addresses
       * - call getAddressAssets
       * @expected
       * - getAddressAssets should have resolved to an array of 3 AddressBalance objects corresponding to cold addresses of cardano and bitcoin
       */
      it('should successfully read balance records of cold addresses from database', async () => {
        // act
        const result = await balanceHandler.getAddressAssets(
          'cold',
          undefined, // chain,
          undefined, // tokenId,
          0, // offset,
          10, // limit
        );

        // assert
        expect(result.total).toEqual(3);
        expect(result.items).toHaveLength(3);
        expect(result.items).toEqual(mockAddressBalance);
      });

      /**
       * @target BalanceHandler.getAddressAssets should successfully read balance records of lock addresses from database
       * @dependencies
       * - TokensMap
       * - ChainHandler
       * - DatabaseAction
       * @scenario
       * - stub ChainHandler getChainConfigs to return a mock chainConfig for supported chains
       * - populate database with 4 mock ChainAddressBalanceEntity objects for lock and cold addresses
       * - call getAddressAssets
       * @expected
       * - getAddressAssets should have resolved to an array of 1 AddressBalance object corresponding to lockAddress
       */
      it('should successfully read balance records of lock addresses from database', async () => {
        // act
        const result = await balanceHandler.getAddressAssets(
          'lock',
          undefined, // chain
          undefined, // tokenId
          0, // offset
          10, // limit
        );

        // assert
        expect(result.total).toEqual(1);
        expect(result.items).toHaveLength(1);
        expect(result.items).toEqual(mockAddressBalance2);
      });
    });
    describe('Avalanche registry boundaries', () => {
      const assets = createAssetsMock();

      let spy: ReturnType<typeof vi.spyOn>;

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        resetAssetsMock(assets);
        spy = mockBalanceChain(address, assets);
      });

      afterEach(() => spy.mockRestore());

      /**
       * @target BalanceHandler.getAddressAssets cannot route Avalanche through the numeric/cold balance reader
       * @dependencies Real handler; cold-address getter that throws if accessed.
       * @scenario Query explicit Avalanche lock and cold balances through the legacy reader.
       * @expected Reject both requests before consulting any cold address.
       */
      it('cannot route Avalanche through the numeric/cold balance reader', async () => {
        const handler = new TestBalances(policy());
        await expect(async () => {
          await handler.getAddressAssets('lock', 'avalanche');
        }).rejects.toThrow('exact lock-balance reader');
        await expect(async () => {
          await handler.getAddressAssets('cold', 'avalanche');
        }).rejects.toThrow('exact lock-balance reader');
        expect(assets).not.toHaveBeenCalled();
      });
      /**
       * @target BalanceHandler.getAddressAssets does not enumerate Avalanche through default numeric balance readers
       * @dependencies Real balance repository; mocked chain configuration reader.
       * @scenario Query default lock and cold balances after full identity registration.
       * @expected Visit only legacy chains and never request Avalanche configuration.
       */
      it('does not enumerate Avalanche through default numeric balance readers', async () => {
        const getChain = vi.fn((chain: string) => {
          if (chain === 'avalanche')
            throw new Error('unexpected Avalanche read');
          return {
            getChainConfigs: () => ({
              addresses: { lock: `${chain}-lock`, cold: `${chain}-cold` },
            }),
          };
        });
        spy.mockReturnValue({ getChain } as unknown as ChainHandler);
        const handler = new TestBalances();
        expect(await handler.getAddressAssets('lock')).toEqual({
          items: [],
          total: 0,
        });
        expect(await handler.getAddressAssets('cold')).toEqual({
          items: [],
          total: 0,
        });
        expect(getChain.mock.calls.map(([chain]) => chain)).toEqual([
          ...LEGACY_BALANCE_CHAINS,
          ...LEGACY_BALANCE_CHAINS,
        ]);
      });
    });
  });
  describe('updateChainBatchBalances', () => {
    describe('legacy behavior', () => {
      beforeEach(async () => {
        ChainHandlerMock.resetMock();

        await DatabaseActionMock.clearTables();

        // populate database with mock balance records
        for (const chain of Object.keys(mockBalances)) {
          for (const balance of mockBalances[chain]) {
            await DatabaseActionMock.insertChainAddressBalanceRecord(balance);
          }
        }
      });

      /**
       * @target BalanceHandler.updateChainBatchBalances should update batch balances successfully
       * @dependencies
       * - TokensMap
       * - ChainHandler
       * - DatabaseAction
       * @scenario
       * - populate database with 4 mock ChainAddressBalanceEntity objects
       * - stub ChainHandler.getAddressAssets to resolve to a AssetBalance object with a non-native token
       * - call updateChainBatchBalances
       * @expected
       * - database should have contained 5 ChainAddressBalanceEntity objects (4 initial balances + 1 inserted and 1 updated balances)
       */
      it('should update batch balances successfully', async () => {
        // arrange
        const balance: AssetBalance = {
          nativeToken: 123n,
          tokens: [{ id: cardanoCometTokenId, value: 111n }],
        };

        ChainHandlerMock.mockChainName(CARDANO_CHAIN);
        ChainHandlerMock.mockChainFunction(
          CARDANO_CHAIN,
          'getAddressAssets',
          balance,
          true,
        );

        // act
        await balanceHandler.updateChainBatchBalances(
          CARDANO_CHAIN,
          cardanoLockAddress,
          [cardanoCometTokenId],
        );

        // assert
        const mockGetAddressAssets = ChainHandlerMock.getChainMockedFunction(
          CARDANO_CHAIN,
          'getAddressAssets',
        );
        expect(mockGetAddressAssets).toHaveBeenCalledExactlyOnceWith(
          cardanoLockAddress,
          [cardanoCometTokenId],
        );

        const balances =
          await DatabaseActionMock.allChainAddressBalanceRecords();
        expect(balances).toHaveLength(5);
        expect(balances[0]).toEqual(mockBalances[BITCOIN_CHAIN][0]);
        expect(balances[1]).toEqual(mockBalances[CARDANO_CHAIN][0]);
        expect(balances[2]).toEqual(mockBalances[CARDANO_CHAIN][1]);
        expect(balances[3]).toEqual({
          chain: CARDANO_CHAIN,
          address: cardanoLockAddress,
          tokenId: cardanoCometTokenId,
          lastUpdate: expect.any(String),
          balance: 111n,
        });
        expect(balances[4]).toEqual({
          chain: CARDANO_CHAIN,
          address: cardanoLockAddress,
          tokenId: ADA,
          lastUpdate: expect.any(String),
          balance: 123n,
        });
      });
    });
  });
  describe('updateChainBalances', () => {
    describe('legacy behavior', () => {
      beforeEach(async () => {
        ChainHandlerMock.resetMock();

        await DatabaseActionMock.clearTables();
      });

      /**
       * @target BalanceHandler.updateChainBalances should successfully update all balances of a chain
       * @dependencies
       * - TokensMap
       * - ChainHandler
       * - DatabaseAction
       * @scenario
       * - stub ChainHandler getChainConfigs to return a mock chainConfig
       * - stub updateChainBatchBalances to resolve to an empty array
       * - call updateChainBalances
       * @expected
       * - updateChainBatchBalances should have been called 12 times for 2 addresses and 6 tokens each
       */
      it('should successfully update all balances of a chain', async () => {
        // arrange
        const chain = CARDANO_CHAIN;
        const lockAddress = `${chain}_mock_lock_address`;
        const coldAddress = `${chain}_mock_cold_address`;

        ChainHandlerMock.mockChainName(chain);
        ChainHandlerMock.mockChainFunction(
          chain,
          'getChainConfigs',
          {
            addresses: {
              lock: lockAddress,
              cold: coldAddress,
            },
          },
          false,
        );

        const updateChainBatchBalancesSpy = vi
          .spyOn(balanceHandler, 'updateChainBatchBalances')
          .mockResolvedValue([]);

        balanceHandler['chainsTokensPerIteration'][chain] = 1;

        // act
        await balanceHandler.updateChainBalances(chain);

        // assert
        expect(updateChainBatchBalancesSpy).toHaveBeenCalledTimes(12);
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          1,
          chain,
          lockAddress,
          [
            'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          2,
          chain,
          lockAddress,
          [
            'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          3,
          chain,
          lockAddress,
          [
            'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          4,
          chain,
          lockAddress,
          ['45fdcb56b039bfba0028f350aaabe0508e4bb4d8c4d7c3c7d481c235.48'],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          5,
          chain,
          lockAddress,
          [
            '3122541486c983d637e7ed9330c94e490e1fe4a1758725fab7f6d9e0.72734254432d6c6f656e',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          6,
          chain,
          lockAddress,
          [
            'ac0a478c70238bff24e20107ebe399e7f3a3e854037622427206b024.72734d44546f6b656e2d6c6f656e',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          7,
          chain,
          coldAddress,
          [
            'd2f6eb37450a3d568de93d623e69bd0ba1238daacc883d75736abd23.527374457267565465737432',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          8,
          chain,
          coldAddress,
          [
            'bb2250e4c589539fd141fbbd2c322d380f1ce2aaef812cd87110d61b.527374434f4d4554565465737432',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          9,
          chain,
          coldAddress,
          [
            'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          10,
          chain,
          coldAddress,
          ['45fdcb56b039bfba0028f350aaabe0508e4bb4d8c4d7c3c7d481c235.48'],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          11,
          chain,
          coldAddress,
          [
            '3122541486c983d637e7ed9330c94e490e1fe4a1758725fab7f6d9e0.72734254432d6c6f656e',
          ],
        );
        expect(updateChainBatchBalancesSpy).toHaveBeenNthCalledWith(
          12,
          chain,
          coldAddress,
          [
            'ac0a478c70238bff24e20107ebe399e7f3a3e854037622427206b024.72734d44546f6b656e2d6c6f656e',
          ],
        );
      });

      /**
       * @target BalanceHandler.updateChainBalances should skip updating empty addresses
       * @dependencies
       * - TokensMap
       * - ChainHandler
       * - DatabaseAction
       * @scenario
       * - stub ChainHandler getChainConfigs to return a mock chainConfig containing an empty cold address
       * - stub updateChainBatchBalances to resolve to an empty array
       * - call updateChainBalances
       * @expected
       * - updateChainBatchBalances should have been called once for lock address only
       */
      it('should skip updating empty addresses', async () => {
        // arrange
        const chain = CARDANO_CHAIN;
        const lockAddress = `${chain}_mock_lock_address`;
        const coldAddress = '';

        ChainHandlerMock.mockChainName(chain);
        ChainHandlerMock.mockChainFunction(
          chain,
          'getChainConfigs',
          {
            addresses: {
              lock: lockAddress,
              cold: coldAddress,
            },
          },
          false,
        );

        const updateChainBatchBalancesSpy = vi
          .spyOn(balanceHandler, 'updateChainBatchBalances')
          .mockResolvedValue([]);

        balanceHandler['chainsTokensPerIteration'][chain] = 100;

        // act
        await balanceHandler.updateChainBalances(chain);

        // assert
        expect(updateChainBatchBalancesSpy).toHaveBeenCalledExactlyOnceWith(
          chain,
          lockAddress,
          cardanoTokenIds,
        );
      });

      /**
       * @target BalanceHandler.updateChainBalances should remove outdated balance records from database
       * @dependencies
       * - TokensMap
       * - ChainHandler
       * - DatabaseAction
       * @scenario
       * - spy on DatabaseAction.removeChainAddressBalances
       * - stub ChainHandler getChainConfigs to return a mock chainConfig
       * - insert 12 mock balance objects for lock and cold addresses into database
       * - stub updateChainBatchBalances to resolve to 4 mock objects for lock address only
       * - call updateChainBalances
       * @expected
       * - DatabaseAction.removeChainAddressBalances should have been called once
       * - database should have contained the 4 mock objects
       */
      it('should remove outdated balance records from database', async () => {
        // arrange
        const chain = CARDANO_CHAIN;
        const lockAddress = `${chain}_mock_lock_address`;
        const coldAddress = `${chain}_mock_cold_address`;

        const removeSpy = vi.spyOn(
          DatabaseActionMock.testDatabase,
          'removeChainAddressBalances',
        );

        for (const balance of mockCardanoBalances) {
          await DatabaseActionMock.insertChainAddressBalanceRecord(balance);
        }

        ChainHandlerMock.mockChainName(chain);
        ChainHandlerMock.mockChainFunction(
          chain,
          'getChainConfigs',
          {
            addresses: {
              lock: lockAddress,
              cold: coldAddress,
            },
          },
          false,
        );

        vi.spyOn(balanceHandler, 'updateChainBatchBalances').mockImplementation(
          async (chain, address) => {
            if (address === lockAddress) return mockPartialCardanoBalances;
            return [];
          },
        );

        balanceHandler['chainsTokensPerIteration'][chain] = 100;

        // act
        await balanceHandler.updateChainBalances(chain);

        // assert
        expect(removeSpy).toHaveBeenCalledOnce();
        const records =
          await DatabaseActionMock.allChainAddressBalanceRecords();
        expect(records).toEqual(mockPartialCardanoBalances);
      });
    });
    describe('Avalanche registry boundaries', () => {
      const assets = createAssetsMock();

      let spy: ReturnType<typeof vi.spyOn>;

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        resetAssetsMock(assets);
        spy = mockBalanceChain(address, assets);
      });

      afterEach(() => spy.mockRestore());

      /**
       * @target BalanceHandler.updateChainBalances collects AVAX alone with absent configured cold custody
       * @dependencies Real in-memory balance repository; mocked chain asset reader.
       * @scenario Collect a native AVAX balance with an empty configured cold address.
       * @expected Read only the lock address and persist the exact bigint balance.
       */
      it('collects AVAX alone with absent configured cold custody', async () => {
        const handler = new TestBalances(policy());
        await handler.updateChainBalances('avalanche');
        expect(assets).toHaveBeenCalledExactlyOnceWith(address, undefined);
        const rows = await DatabaseActionMock.allChainAddressBalanceRecords();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          chain: 'avalanche',
          address,
          tokenId: 'avax',
          balance: 9n,
        });
      });
      /**
       * @target BalanceHandler.updateChainBalances batches supported tokens only at the lock address and removes obsolete cache rows after success
       * @dependencies Real in-memory balance repository; mocked chain asset reader.
       * @scenario Seed an obsolete row and collect three tokens in batches of two.
       * @expected Read only the lock address and remove the obsolete row after success.
       */
      it('batches supported tokens only at the lock address and removes obsolete cache rows after success', async () => {
        await DatabaseActionMock.testDatabase.upsertChainAddressBalances([
          {
            chain: 'avalanche',
            address,
            tokenId: 'old',
            balance: 1n,
            lastUpdate: '1',
          },
        ]);
        const handler = new TestBalances(policy());
        handler.tokens = ['a', 'b', 'c'];
        await handler.updateChainBalances('avalanche');
        expect(assets).toHaveBeenCalledTimes(2);
        expect(assets).toHaveBeenNthCalledWith(1, address, ['a', 'b']);
        expect(assets).toHaveBeenNthCalledWith(2, address, ['c']);
        const rows = await DatabaseActionMock.allChainAddressBalanceRecords();
        expect(rows.map((row) => row.tokenId).sort()).toEqual([
          'a',
          'avax',
          'b',
          'c',
        ]);
      });
      /**
       * @target BalanceHandler.updateChainBalances rejects disabled collection before reading balances or writing cache
       * @dependencies Real in-memory balance repository; mocked chain asset reader.
       * @scenario Invoke both update entry points without an Avalanche policy.
       * @expected Reject before reading assets or writing any cache row.
       */
      it('rejects disabled collection before reading balances or writing cache', async () => {
        await expect(async () => {
          await new TestBalances().updateChainBalances('avalanche');
        }).rejects.toThrow('not enabled');
        await expect(async () => {
          await new TestBalances().updateChainBatchBalances(
            'avalanche',
            address,
          );
        }).rejects.toThrow('not enabled');
        expect(assets).not.toHaveBeenCalled();
        expect(
          await DatabaseActionMock.allChainAddressBalanceRecords(),
        ).toEqual([]);
      });
      /**
       * @target BalanceHandler.updateChainBalances retains existing cache when the qualified state read fails
       * @dependencies Real in-memory balance repository; failing chain asset reader.
       * @scenario Seed an exact cached AVAX row and reject the qualified asset read.
       * @expected Retain its balance and timestamp without rewriting the cache.
       */
      it('retains existing cache when the qualified state read fails', async () => {
        await DatabaseActionMock.testDatabase.upsertChainAddressBalances([
          {
            chain: 'avalanche',
            address,
            tokenId: 'avax',
            balance: 1n,
            lastUpdate: '1',
          },
        ]);
        assets.mockRejectedValue(new Error('wrong chain'));
        await expect(async () => {
          await new TestBalances(policy()).updateChainBalances('avalanche');
        }).rejects.toThrow('wrong chain');
        const rows = await DatabaseActionMock.allChainAddressBalanceRecords();
        expect(rows[0]).toMatchObject({ balance: 1n, lastUpdate: '1' });
      });
    });
  });
  describe('getUpdateSchedule', () => {
    describe('Avalanche registry boundaries', () => {
      const assets = createAssetsMock();

      let spy: ReturnType<typeof vi.spyOn>;

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        resetAssetsMock(assets);
        spy = mockBalanceChain(address, assets);
      });

      afterEach(() => spy.mockRestore());

      /**
       * @target BalanceHandler.getUpdateSchedule adds exactly one optional schedule without widening management chains
       * @dependencies Real balance handler; synthetic policy and existing test config.
       * @scenario Construct disabled and enabled handlers and alter a returned schedule.
       * @expected Keep the original schedules, add Avalanche once only when enabled,
       * and return a fresh schedule on each read.
       */
      it('adds exactly one optional schedule without widening management chains', () => {
        expect(
          new TestBalances().getUpdateSchedule().map((row) => row.chain),
        ).toEqual([...LEGACY_BALANCE_CHAINS]);
        const schedule = new TestBalances(policy()).getUpdateSchedule();
        expect(schedule.filter((row) => row.chain === 'avalanche')).toEqual([
          { chain: 'avalanche', intervalMs: 12000 },
        ]);
        expect(LEGACY_BALANCE_CHAINS as readonly string[]).not.toContain(
          'avalanche',
        );
        schedule[0].chain = 'modified';
        expect(
          new TestBalances(policy()).getUpdateSchedule()[0].chain,
        ).not.toEqual('modified');
      });
    });
  });
});

describe('BalanceHandler.getAvalancheBalances', () => {
  let coldServer: ColdFastifyWithZod;
  let coldCustody: ReturnType<typeof mockColdBalanceCustody>;
  let coldTokenMap: Awaited<ReturnType<typeof createColdMap>>;
  beforeEach(async () => {
    vi.restoreAllMocks();
    await ColdDatabaseActionMock.clearTables();
    coldCustody = mockColdBalanceCustody();
    coldTokenMap = await createColdMap();
    vi.spyOn(ColdTokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
      coldTokenMap,
    );
    ColdBalanceHandler.init(coldPolicy());
    coldServer = await makeColdFastify();
    await coldServer.register(coldBalanceRoutes);
  });
  afterEach(async () => {
    await coldServer.close();
    vi.restoreAllMocks();
  });
  /**
   * @target BalanceHandler.getAvalancheBalances should reject metadata changes between custody page reads
   * @dependencies Actual SQLite DAO and TokenMap with one reader-boundary mutation
   * @scenario Complete the hot reader then alter significant decimals before cold starts
   * @expected Refuse a combined response containing different metadata generations
   */
  it('should reject metadata changes between custody page reads', async () => {
    await insertColdBalance(coldLockAddress, coldJoe, 9n);
    const handler = ColdBalanceHandler.getInstance();
    const hotRead = handler.getAvalancheLockAssets.bind(handler);
    vi.spyOn(handler, 'getAvalancheLockAssets').mockImplementation(
      async (...args) => {
        const page = await hotRead(...args);
        const config = coldTokenMap.getRawConfig();
        config[1].ergo.decimals = 5;
        await coldTokenMap.updateConfigByJson(config);
        return page;
      },
    );
    await expect(handler.getAvalancheBalances()).rejects.toThrow(
      'Avalanche balance token metadata changed',
    );
  });
  /**
   * @target BalanceHandler.getAvalancheBalances should reject invalid configured cold custody undefined before cached reads
   * @dependencies Actual DAO spy and stable configured-chain boundary mock
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject the custody predicate before querying cache or returning any page
   */
  it('should reject invalid configured cold custody undefined before cached reads', async () => {
    const value: unknown = undefined;

    coldCustody.config.addresses.cold = value;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(read).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.getAvalancheBalances should reject invalid configured cold custody null before cached reads
   * @dependencies Actual DAO spy and stable configured-chain boundary mock
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject the custody predicate before querying cache or returning any page
   */
  it('should reject invalid configured cold custody null before cached reads', async () => {
    const value: unknown = null;

    coldCustody.config.addresses.cold = value;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(read).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.getAvalancheBalances should reject invalid configured cold custody number before cached reads
   * @dependencies Actual DAO spy and stable configured-chain boundary mock
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject the custody predicate before querying cache or returning any page
   */
  it('should reject invalid configured cold custody number before cached reads', async () => {
    const value: unknown = 7;

    coldCustody.config.addresses.cold = value;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(read).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.getAvalancheBalances should reject invalid configured cold custody malformed address before cached reads
   * @dependencies Actual DAO spy and stable configured-chain boundary mock
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject the custody predicate before querying cache or returning any page
   */
  it('should reject invalid configured cold custody malformed address before cached reads', async () => {
    const value: unknown = 'invalid';

    coldCustody.config.addresses.cold = value;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(read).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.getAvalancheBalances should reject invalid configured cold custody zero address before cached reads
   * @dependencies Actual DAO spy and stable configured-chain boundary mock
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject the custody predicate before querying cache or returning any page
   */
  it('should reject invalid configured cold custody zero address before cached reads', async () => {
    const value: unknown = `0x${'00'.repeat(20)}`;

    coldCustody.config.addresses.cold = value;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(read).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.getAvalancheBalances should reject invalid configured cold custody lock alias before cached reads
   * @dependencies Actual DAO spy and stable configured-chain boundary mock
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject the custody predicate before querying cache or returning any page
   */
  it('should reject invalid configured cold custody lock alias before cached reads', async () => {
    const value: unknown = coldLockAddress;

    coldCustody.config.addresses.cold = value;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(read).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.getAvalancheBalances should reject invalid configured cold custody case-insensitive lock alias before cached reads
   * @dependencies Actual DAO spy and stable configured-chain boundary mock
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject the custody predicate before querying cache or returning any page
   */
  it('should reject invalid configured cold custody case-insensitive lock alias before cached reads', async () => {
    const value: unknown = `0x${coldLockAddress.slice(2).toUpperCase()}`;

    coldCustody.config.addresses.cold = value;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(read).not.toHaveBeenCalled();
  });

  /**
   * @target BalanceHandler.getAvalancheBalances should refuse missing configured deployment before cache reads
   * @dependencies Actual SQLite DAO and TokenMap; registered chain metadata mock
   * @scenario Set CHAIN_ID to undefined
   * @expected Reject deployment before any DAO query
   */
  it('should refuse missing configured deployment before cache reads', async () => {
    coldCustody.chain.CHAIN_ID = undefined;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance deployment');
    expect(read).not.toHaveBeenCalled();
  });

  /**
   * @target BalanceHandler.getAvalancheBalances should refuse null configured deployment before cache reads
   * @dependencies Actual SQLite DAO and TokenMap; registered chain metadata mock
   * @scenario Set CHAIN_ID to null
   * @expected Reject deployment before any DAO query
   */
  it('should refuse null configured deployment before cache reads', async () => {
    coldCustody.chain.CHAIN_ID = null;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance deployment');
    expect(read).not.toHaveBeenCalled();
  });

  /**
   * @target BalanceHandler.getAvalancheBalances should refuse number configured deployment before cache reads
   * @dependencies Actual SQLite DAO and TokenMap; registered chain metadata mock
   * @scenario Set CHAIN_ID to 43114
   * @expected Reject deployment before any DAO query
   */
  it('should refuse number configured deployment before cache reads', async () => {
    coldCustody.chain.CHAIN_ID = 43114;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance deployment');
    expect(read).not.toHaveBeenCalled();
  });

  /**
   * @target BalanceHandler.getAvalancheBalances should refuse string configured deployment before cache reads
   * @dependencies Actual SQLite DAO and TokenMap; registered chain metadata mock
   * @scenario Set CHAIN_ID to '43114'
   * @expected Reject deployment before any DAO query
   */
  it('should refuse string configured deployment before cache reads', async () => {
    coldCustody.chain.CHAIN_ID = '43114';
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance deployment');
    expect(read).not.toHaveBeenCalled();
  });

  /**
   * @target BalanceHandler.getAvalancheBalances should refuse unsupported configured deployment before cache reads
   * @dependencies Actual SQLite DAO and TokenMap; registered chain metadata mock
   * @scenario Set CHAIN_ID to 43115n
   * @expected Reject deployment before any DAO query
   */
  it('should refuse unsupported configured deployment before cache reads', async () => {
    coldCustody.chain.CHAIN_ID = 43115n;
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheBalances(),
    ).rejects.toThrow('Invalid Avalanche balance deployment');
    expect(read).not.toHaveBeenCalled();
  });

  /**
   * @target BalanceHandler.getAvalancheBalances should refuse deployment drift after the lock cache page
   * @dependencies Actual SQLite reader and TokenMap; isolated reader-return mutation
   * @scenario Change configured CHAIN_ID after getAvalancheLockAssets awaits
   * @expected Reject a combined response from changed deployment metadata
   */
  it('should refuse deployment drift after the lock cache page', async () => {
    const handler = ColdBalanceHandler.getInstance();
    const read = handler.getAvalancheLockAssets.bind(handler);
    vi.spyOn(handler, 'getAvalancheLockAssets').mockImplementation(
      async (...args) => {
        const page = await read(...args);
        coldCustody.chain.CHAIN_ID = 43113n;
        return page;
      },
    );
    await expect(handler.getAvalancheBalances()).rejects.toThrow(
      'Avalanche balance custody changed',
    );
  });

  /**
   * @target BalanceHandler.getAvalancheBalances should refuse deployment drift after the cold cache page
   * @dependencies Actual SQLite reader and TokenMap; isolated reader-return mutation
   * @scenario Change configured CHAIN_ID after getAvalancheColdAssets awaits
   * @expected Reject a combined response from changed deployment metadata
   */
  it('should refuse deployment drift after the cold cache page', async () => {
    const handler = ColdBalanceHandler.getInstance();
    const read = handler.getAvalancheColdAssets.bind(handler);
    vi.spyOn(handler, 'getAvalancheColdAssets').mockImplementation(
      async (...args) => {
        const page = await read(...args);
        coldCustody.chain.CHAIN_ID = 43113n;
        return page;
      },
    );
    await expect(handler.getAvalancheBalances()).rejects.toThrow(
      'Avalanche balance custody changed',
    );
  });
});
describe('BalanceHandler.getAvalancheColdAssets', () => {
  let coldServer: ColdFastifyWithZod;
  let coldCustody: ReturnType<typeof mockColdBalanceCustody>;
  let coldTokenMap: Awaited<ReturnType<typeof createColdMap>>;
  beforeEach(async () => {
    vi.restoreAllMocks();
    await ColdDatabaseActionMock.clearTables();
    coldCustody = mockColdBalanceCustody();
    coldTokenMap = await createColdMap();
    vi.spyOn(ColdTokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
      coldTokenMap,
    );
    ColdBalanceHandler.init(coldPolicy());
    coldServer = await makeColdFastify();
    await coldServer.register(coldBalanceRoutes);
  });
  afterEach(async () => {
    await coldServer.close();
    vi.restoreAllMocks();
  });
  /**
   * @target BalanceHandler.getAvalancheColdAssets should omit absent cold custody without a cache query or state read
   * @dependencies Actual DAO spy and configured-chain boundary mocks
   * @scenario Set the configured cold address to the explicit empty sentinel
   * @expected Return an empty page without looking up stale cold rows or invoking RPC
   */
  it('should omit absent cold custody without a cache query or state read', async () => {
    coldCustody.config.addresses.cold = '';
    await insertColdBalance(coldCustodyAddress, 'avax', 9n);
    const read = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'getChainAddressBalanceByAddresses',
    );
    expect(
      await ColdBalanceHandler.getInstance().getAvalancheColdAssets(),
    ).toEqual({ items: [], total: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.getAvalancheColdAssets should reject configured address changes during awaited cache reads
   * @dependencies Actual SQLite DAO with one post-read mutation
   * @scenario Change the cold address after the real DAO resolves its selected page
   * @expected Reject the changed custody rather than emit rows under stale address authority
   */
  it('should reject configured address changes during awaited cache reads', async () => {
    await insertColdBalance(coldCustodyAddress, 'avax', 7n);
    const dao = ColdDatabaseActionMock.testDatabase;
    const read = dao.getChainAddressBalanceByAddresses.bind(dao);
    vi.spyOn(dao, 'getChainAddressBalanceByAddresses').mockImplementation(
      async (...args) => {
        const page = await read(...args);
        coldCustody.config.addresses.cold = coldChangedAddress;
        return page;
      },
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheColdAssets(),
    ).rejects.toThrow('Avalanche balance custody changed');
  });
  /**
   * @target BalanceHandler.getAvalancheColdAssets should reject conversion metadata changes during awaited cache reads
   * @dependencies Actual SQLite DAO and mutable real TokenMap
   * @scenario Change the significant-decimal map after reading the cached integer
   * @expected Reject instead of relabeling the same cached wrapped units under another scale
   */
  it('should reject conversion metadata changes during awaited cache reads', async () => {
    await insertColdBalance(coldCustodyAddress, coldJoe, 9n);
    const dao = ColdDatabaseActionMock.testDatabase;
    const read = dao.getChainAddressBalanceByAddresses.bind(dao);
    vi.spyOn(dao, 'getChainAddressBalanceByAddresses').mockImplementation(
      async (...args) => {
        const page = await read(...args);
        const config = coldTokenMap.getRawConfig();
        config[1].ergo.decimals = 5;
        await coldTokenMap.updateConfigByJson(config);
        return page;
      },
    );
    await expect(
      ColdBalanceHandler.getInstance().getAvalancheColdAssets(),
    ).rejects.toThrow('Avalanche balance token metadata changed');
  });
});

describe('BalanceHandler.updateChainBalances', () => {
  let coldServer: ColdFastifyWithZod;
  let coldCustody: ReturnType<typeof mockColdBalanceCustody>;
  let coldTokenMap: Awaited<ReturnType<typeof createColdMap>>;
  beforeEach(async () => {
    vi.restoreAllMocks();
    await ColdDatabaseActionMock.clearTables();
    coldCustody = mockColdBalanceCustody();
    coldTokenMap = await createColdMap();
    vi.spyOn(ColdTokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
      coldTokenMap,
    );
    ColdBalanceHandler.init(coldPolicy());
    coldServer = await makeColdFastify();
    await coldServer.register(coldBalanceRoutes);
  });
  afterEach(async () => {
    await coldServer.close();
    vi.restoreAllMocks();
  });
  /**
   * @target BalanceHandler.updateChainBalances should reject invalid configured cold custody undefined before collection writes
   * @dependencies Actual DAO spies and configured-chain method boundaries
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject before any hot/cold RPC, upsert or stale-row cleanup
   */
  it('should reject invalid configured cold custody undefined before collection writes', async () => {
    const value: unknown = undefined;

    coldCustody.config.addresses.cold = value;
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBalances should reject invalid configured cold custody null before collection writes
   * @dependencies Actual DAO spies and configured-chain method boundaries
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject before any hot/cold RPC, upsert or stale-row cleanup
   */
  it('should reject invalid configured cold custody null before collection writes', async () => {
    const value: unknown = null;

    coldCustody.config.addresses.cold = value;
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBalances should reject invalid configured cold custody number before collection writes
   * @dependencies Actual DAO spies and configured-chain method boundaries
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject before any hot/cold RPC, upsert or stale-row cleanup
   */
  it('should reject invalid configured cold custody number before collection writes', async () => {
    const value: unknown = 7;

    coldCustody.config.addresses.cold = value;
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBalances should reject invalid configured cold custody malformed address before collection writes
   * @dependencies Actual DAO spies and configured-chain method boundaries
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject before any hot/cold RPC, upsert or stale-row cleanup
   */
  it('should reject invalid configured cold custody malformed address before collection writes', async () => {
    const value: unknown = 'invalid';

    coldCustody.config.addresses.cold = value;
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBalances should reject invalid configured cold custody zero address before collection writes
   * @dependencies Actual DAO spies and configured-chain method boundaries
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject before any hot/cold RPC, upsert or stale-row cleanup
   */
  it('should reject invalid configured cold custody zero address before collection writes', async () => {
    const value: unknown = `0x${'00'.repeat(20)}`;

    coldCustody.config.addresses.cold = value;
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBalances should reject invalid configured cold custody lock alias before collection writes
   * @dependencies Actual DAO spies and configured-chain method boundaries
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject before any hot/cold RPC, upsert or stale-row cleanup
   */
  it('should reject invalid configured cold custody lock alias before collection writes', async () => {
    const value: unknown = coldLockAddress;

    coldCustody.config.addresses.cold = value;
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBalances should reject invalid configured cold custody case-insensitive lock alias before collection writes
   * @dependencies Actual DAO spies and configured-chain method boundaries
   * @scenario Remove or corrupt cold metadata or alias the lock by EVM address identity
   * @expected Reject before any hot/cold RPC, upsert or stale-row cleanup
   */
  it('should reject invalid configured cold custody case-insensitive lock alias before collection writes', async () => {
    const value: unknown = `0x${coldLockAddress.slice(2).toUpperCase()}`;

    coldCustody.config.addresses.cold = value;
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Invalid Avalanche balance custody');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBalances should collect cold assets through the existing qualified cold reader
   * @dependencies Actual SQLite DAO and controlled chain method boundaries
   * @scenario Return different wrapped AVAX/JOE integers from the lock and cold methods
   * @expected Persist both custodies unchanged and pass token selection only to the cold reader
   */
  it('should collect cold assets through the existing qualified cold reader', async () => {
    coldCustody.hotRead.mockResolvedValue({
      nativeToken: 100n,
      tokens: [{ id: coldJoe, value: 9007199254740993n }],
    });
    coldCustody.coldRead.mockResolvedValue({
      nativeToken: 200n,
      tokens: [{ id: coldJoe, value: 9007199254740993999n }],
    });
    const handler = new ColdTestBalances(coldPolicy());
    handler.tokens = [coldJoe];
    await handler.updateChainBalances('avalanche');
    expect(coldCustody.hotRead).toHaveBeenCalledExactlyOnceWith(
      coldLockAddress,
      [coldJoe],
    );
    expect(coldCustody.coldRead).toHaveBeenCalledExactlyOnceWith([coldJoe]);
    const rows = await ColdDatabaseActionMock.allChainAddressBalanceRecords();
    expect(rows).toHaveLength(4);
    expect(
      rows.find(
        (row) => row.address === coldCustodyAddress && row.tokenId === coldJoe,
      )?.balance,
    ).toBe(9007199254740993999n);
    expect(
      rows.find(
        (row) => row.address === coldCustodyAddress && row.tokenId === 'avax',
      )?.balance,
    ).toBe(200n);
  });
  /**
   * @target BalanceHandler.updateChainBalances should retain cold cache without upsert when the cold reader rejects
   * @dependencies Actual SQLite DAO and rejecting qualified-chain boundary mock
   * @scenario Seed cold custody, allow lock collection and reject the cold method
   * @expected No cold upsert or stale-row cleanup occurs and its old value/timestamp survive
   */
  it('should retain cold cache without upsert when the cold reader rejects', async () => {
    await insertColdBalance(coldCustodyAddress, coldJoe, 17n);
    coldCustody.hotRead.mockResolvedValue({ nativeToken: 100n, tokens: [] });
    coldCustody.coldRead.mockRejectedValue(
      new Error('qualified cold read rejected'),
    );
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('qualified cold read rejected');
    expect(upsert).toHaveBeenCalledOnce();
    expect(
      upsert.mock.calls[0][0].every((row) => row.address === coldLockAddress),
    ).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    const rows = await ColdDatabaseActionMock.allChainAddressBalanceRecords();
    expect(
      rows.find((row) => row.address === coldCustodyAddress),
    ).toMatchObject({
      balance: 17n,
      lastUpdate: '1',
    });
  });
  /**
   * @target BalanceHandler.updateChainBalances should reject TokenHandler map drift across saved cache reads before collection
   * @dependencies Actual SQLite DAO and mutable TokenHandler TokenMap authority
   * @scenario Change map identity or significant scale across the awaited collection boundary
   * @expected Reject before the corresponding upsert or stale-row cleanup
   */
  it('should reject TokenHandler map drift across saved cache reads before collection', async () => {
    const dao = ColdDatabaseActionMock.testDatabase;
    const read = dao.getChainAddressBalanceByChain.bind(dao);
    vi.spyOn(dao, 'getChainAddressBalanceByChain').mockImplementation(
      async (...args) => {
        const rows = await read(...args);
        const config = coldTokenMap.getRawConfig();
        config[0].ergo.decimals = 8;
        await coldTokenMap.updateConfigByJson(config);
        return rows;
      },
    );
    const upsert = vi.spyOn(dao, 'upsertChainAddressBalances');
    const cleanup = vi.spyOn(dao, 'removeChainAddressBalances');
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Avalanche balance token metadata changed');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  /**
   * @target BalanceHandler.updateChainBalances should refuse deployment drift during saved balance lookup
   * @dependencies Actual SQLite DAO and TokenMap with one DAO-return mutation
   * @scenario Change registered CHAIN_ID after saved rows are read
   * @expected Perform no chain state read, upsert or cleanup
   */
  it('should refuse deployment drift during saved balance lookup', async () => {
    const db = ColdDatabaseActionMock.testDatabase;
    const saved = db.getChainAddressBalanceByChain.bind(db);
    vi.spyOn(db, 'getChainAddressBalanceByChain').mockImplementation(
      async (...args) => {
        const rows = await saved(...args);
        coldCustody.chain.CHAIN_ID = 43113n;
        return rows;
      },
    );
    const upsert = vi.spyOn(db, 'upsertChainAddressBalances');
    const cleanup = vi.spyOn(db, 'removeChainAddressBalances');
    await expect(
      ColdBalanceHandler.getInstance().updateChainBalances('avalanche'),
    ).rejects.toThrow('Avalanche balance custody changed');
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
describe('BalanceHandler.updateChainBatchBalances', () => {
  let coldServer: ColdFastifyWithZod;
  let coldCustody: ReturnType<typeof mockColdBalanceCustody>;
  let coldTokenMap: Awaited<ReturnType<typeof createColdMap>>;
  beforeEach(async () => {
    vi.restoreAllMocks();
    await ColdDatabaseActionMock.clearTables();
    coldCustody = mockColdBalanceCustody();
    coldTokenMap = await createColdMap();
    vi.spyOn(ColdTokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
      coldTokenMap,
    );
    ColdBalanceHandler.init(coldPolicy());
    coldServer = await makeColdFastify();
    await coldServer.register(coldBalanceRoutes);
  });
  afterEach(async () => {
    await coldServer.close();
    vi.restoreAllMocks();
  });
  /**
   * @target BalanceHandler.updateChainBatchBalances should refuse cold address drift before its upsert
   * @dependencies Actual SQLite DAO and one awaited cold-method configuration mutation
   * @scenario Mutate configured cold after returning an otherwise valid asset balance
   * @expected Reject the changed custody before any DAO upsert
   */
  it('should refuse cold address drift before its upsert', async () => {
    coldCustody.coldRead.mockImplementation(async () => {
      coldCustody.config.addresses.cold = coldChangedAddress;
      return { nativeToken: 3n, tokens: [] };
    });
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBatchBalances(
        'avalanche',
        coldCustodyAddress,
      ),
    ).rejects.toThrow('Avalanche balance custody changed');
    expect(upsert).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBatchBalances should reject TokenHandler map identity drift during cold reads before upsert
   * @dependencies Actual SQLite DAO and mutable TokenHandler TokenMap authority
   * @scenario Change map identity or significant scale across the awaited collection boundary
   * @expected Reject before the corresponding upsert or stale-row cleanup
   */
  it('should reject TokenHandler map identity drift during cold reads before upsert', async () => {
    const replacement = await createColdMap();
    coldCustody.coldRead.mockImplementation(async () => {
      vi.spyOn(ColdTokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
        replacement,
      );
      return { nativeToken: 8n, tokens: [] };
    });
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBatchBalances(
        'avalanche',
        coldCustodyAddress,
      ),
    ).rejects.toThrow('Avalanche balance token metadata changed');
    expect(upsert).not.toHaveBeenCalled();
  });
  /**
   * @target BalanceHandler.updateChainBatchBalances should reject TokenHandler map policy drift during cold reads before upsert
   * @dependencies Actual SQLite DAO and mutable TokenHandler TokenMap authority
   * @scenario Change map identity or significant scale across the awaited collection boundary
   * @expected Reject before the corresponding upsert or stale-row cleanup
   */
  it('should reject TokenHandler map policy drift during cold reads before upsert', async () => {
    coldCustody.coldRead.mockImplementation(async () => {
      const config = coldTokenMap.getRawConfig();
      config[0].ergo.decimals = 8;
      await coldTokenMap.updateConfigByJson(config);
      return { nativeToken: 8n, tokens: [] };
    });
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBatchBalances(
        'avalanche',
        coldCustodyAddress,
      ),
    ).rejects.toThrow('Avalanche balance token metadata changed');
    expect(upsert).not.toHaveBeenCalled();
  });

  /**
   * @target BalanceHandler.updateChainBatchBalances should refuse deployment drift during qualified cold collection
   * @dependencies Actual SQLite DAO, TokenMap and qualified cold reader mock
   * @scenario Change registered CHAIN_ID while the cold reader is awaited
   * @expected Perform no upsert or cleanup under the changed deployment
   */
  it('should refuse deployment drift during qualified cold collection', async () => {
    coldCustody.coldRead.mockImplementation(async () => {
      coldCustody.chain.CHAIN_ID = 43113n;
      return { nativeToken: 5n, tokens: [] };
    });
    const upsert = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'upsertChainAddressBalances',
    );
    const cleanup = vi.spyOn(
      ColdDatabaseActionMock.testDatabase,
      'removeChainAddressBalances',
    );
    await expect(
      ColdBalanceHandler.getInstance().updateChainBatchBalances(
        'avalanche',
        coldCustodyAddress,
      ),
    ).rejects.toThrow('Avalanche balance custody changed');
    expect(upsert).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
describe('BalanceHandler.updateChainBalances metadata between batches', () => {
  /**
   * @target BalanceHandler.updateChainBalances should reject TokenHandler map changes after a completed hot upsert before cold collection
   * @dependencies Actual SQLite upsert and mutable TokenHandler map identity
   * @scenario Replace the handler map after the first hot DAO upsert resolves
   * @expected Preserve that completed hot write but perform no cold read, cold upsert or cleanup
   */
  it('should reject TokenHandler map changes after a completed hot upsert before cold collection', async () => {
    vi.restoreAllMocks();
    await ColdDatabaseActionMock.clearTables();
    const custody = mockColdBalanceCustody();
    const initial = await createColdMap();
    const replacement = await createColdMap();
    vi.spyOn(ColdTokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
      initial,
    );
    custody.hotRead.mockResolvedValue({ nativeToken: 8n, tokens: [] });
    const dao = ColdDatabaseActionMock.testDatabase;
    const write = dao.upsertChainAddressBalances.bind(dao);
    const upsert = vi
      .spyOn(dao, 'upsertChainAddressBalances')
      .mockImplementation(async (...args) => {
        const result = await write(...args);
        vi.spyOn(ColdTokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
          replacement,
        );
        return result;
      });
    const cleanup = vi.spyOn(dao, 'removeChainAddressBalances');
    await expect(
      new ColdTestBalances(coldPolicy()).updateChainBalances('avalanche'),
    ).rejects.toThrow('Avalanche balance token metadata changed');
    expect(upsert).toHaveBeenCalledOnce();
    expect(
      upsert.mock.calls[0][0].every((row) => row.address === coldLockAddress),
    ).toBe(true);
    expect(custody.coldRead).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      await ColdDatabaseActionMock.allChainAddressBalanceRecords(),
    ).toMatchObject([{ address: coldLockAddress, balance: 8n }]);
    vi.restoreAllMocks();
  });
});
