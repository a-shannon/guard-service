import {
  type FastifyWithZod as ColdFastifyWithZod,
  makeFastify as makeColdFastify,
} from '@rosen-bridge/fastify-enhanced';
import { FastifyWithZod, makeFastify } from '@rosen-bridge/fastify-enhanced';

import { balanceRoutes as coldBalanceRoutes } from '../../src/api/balance';
import { balanceRoutes } from '../../src/api/balance';
import ColdBalanceHandler from '../../src/handlers/balanceHandler';
import BalanceHandler from '../../src/handlers/balanceHandler';
import ChainHandler from '../../src/handlers/chainHandler';
import { TokenHandler as ColdTokenHandler } from '../../src/handlers/tokenHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import type { AvalancheLockBalance as ColdAvalancheLockBalance } from '../../src/types/api';
import {
  avalancheAddress as address,
  avalancheErc20 as erc20,
} from '../avalancheRegistryTestData';
import ColdDatabaseActionMock from '../db/mocked/databaseAction.mock';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { policy as coldPolicy } from '../handlers/avalancheBalanceTestUtils';
import BalanceHandlerMock from '../handlers/mocked/balanceHandler.mock';
import { insert, createAvalancheTokenMap } from './avalancheBalanceTestUtils';
import {
  cold as coldCustodyAddress,
  coldBalanceFixture as cachedColdFixture,
  joe as coldJoe,
  lock as coldLockAddress,
} from './avalancheColdBalanceTestData';
import {
  createColdTokenMap as createColdMap,
  insertColdBalance,
} from './avalancheColdBalanceTestUtils';
import {
  createColdAddressMock,
  mockApiBalanceChain,
} from './mocked/avalancheBalance.mock';
import { mockColdBalanceCustody } from './mocked/avalancheColdBalance.mock';
import {
  mockLockBalances,
  mockColdBalances,
  mockBalancesObj,
} from './testData';

describe('balanceRoutes', () => {
  describe('GET /balance', () => {
    describe('legacy behavior', () => {
      let mockedServer: FastifyWithZod;

      beforeEach(async () => {
        mockedServer = await makeFastify();
        mockedServer.register(balanceRoutes);

        BalanceHandlerMock.resetMock();
        BalanceHandlerMock.mock();
      });

      afterEach(() => {
        mockedServer.close();
      });

      /**
       * @target fastifyServer[GET /balance] should return lock balance with hot and cold arrays populated
       * @dependencies
       * @scenario
       * - stub BalanceHandler.getAddressAssets to return mock balances for both lock and cold addresses
       * - call handler
       * @expected
       * - response status should have been 200
       * - response should have matched hot and cold balances from mockBalances
       */
      it('should return lock balance with hot and cold arrays populated', async () => {
        // arrange
        BalanceHandlerMock.mockGetAddressAssets().mockImplementation(
          async (address) =>
            address === 'lock' ? mockLockBalances : mockColdBalances,
        );

        // act
        const result = await mockedServer.inject({
          method: 'GET',
          url: '/balance',
        });

        // assert
        expect(result.json()).toEqual(mockBalancesObj);
        expect(result.statusCode).toEqual(200);
      });

      /**
       * @target fastifyServer[GET /balance] should return empty lock balance when no balances are returned
       * @dependencies
       * @scenario
       * - stub BalanceHandler.getAddressAssets to return empty array for both lock and cold addresses
       * - call handler
       * @expected
       * - response status should have been 200
       * - response balance arrays should have been an empty
       */
      it('should return empty lock balance when no balances are returned', async () => {
        // arrange
        BalanceHandlerMock.mockGetAddressAssets().mockResolvedValue({
          items: [],
          total: 0,
        });

        // act
        const result = await mockedServer.inject({
          method: 'GET',
          url: '/balance',
        });

        // assert
        expect(result.statusCode).toEqual(200);
        expect(result.json()).toEqual({
          hot: {
            items: [],
            total: 0,
          },
          cold: {
            items: [],
            total: 0,
          },
        });
      });

      /**
       * @target fastifyServer[GET /balance] should return error response when an exception is thrown during balance retrieval
       * @dependencies
       * @scenario
       * - stub BalanceHandler.getAddressAssets to reject for lock address and return mock balances for cold address
       * - call handler
       * @expected
       * - response status should have been 500
       * - response should have matched the correct error message
       */
      it('should return error response when an exception is thrown during balance retrieval', async () => {
        // arrange
        BalanceHandlerMock.mockGetAddressAssets().mockImplementation(
          async (address) => {
            if (address === 'lock') throw new Error('custom_error');
            else return { items: [], total: 0 };
          },
        );

        // act
        const result = await mockedServer.inject({
          method: 'GET',
          url: '/balance',
        });

        // assert
        expect(result.statusCode).toEqual(500);
        expect(result.json()).toEqual({
          message: 'custom_error',
        });
      });
    });
    describe('Avalanche registry boundaries', () => {
      let server: FastifyWithZod;
      const cold = createColdAddressMock();

      beforeEach(async () => {
        vi.restoreAllMocks();
        await DatabaseActionMock.clearTables();
        cold.mockClear();
        BalanceHandler.init({
          updateInterval: 12,
          updateBatchInterval: 1,
          tokensPerIteration: { rpc: 2 },
        });
        mockApiBalanceChain(address, cold);
        const tokens = await createAvalancheTokenMap();
        vi.spyOn(TokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
          tokens,
        );
        server = await makeFastify();
        await server.register(balanceRoutes);
      });
      afterEach(async () => {
        await server.close();
        vi.restoreAllMocks();
      });

      /**
       * @target balanceRoutes preserves an amount above 2^53 through storage and the HTTP serializer
       * @dependencies Real Fastify serializer, SQLite and TokenMap; mocked chain lookup.
       * @scenario Store an amount above 2^53 and request the explicit Avalanche balance.
       * @expected Return exact wrapped units and significant decimals with absent cold custody.
       */
      it('preserves an amount above 2^53 through storage and the HTTP serializer', async () => {
        await insert('avalanche', 'avax', 9007199254740993n);
        const response = await server.inject('/balance?chain=avalanche');
        expect(response.statusCode).toEqual(200);
        expect(response.json()).toEqual({
          chainId: 43114,
          hot: {
            items: [
              {
                address,
                chain: 'avalanche',
                balance: {
                  tokenId: 'avax',
                  name: 'AVAX',
                  decimals: 9,
                  isNativeToken: true,
                  amount: '9007199254740993',
                },
              },
            ],
            total: 1,
          },
          cold: { items: [], total: 0 },
        });
        expect(cold).toHaveBeenCalled();
      });

      /**
       * @target balanceRoutes excludes shared-address Avalanche cache rows before legacy pagination
       * @dependencies Real Fastify serializer, SQLite and TokenMap; mocked chain lookup.
       * @scenario Store Ethereum and Avalanche rows at a shared address and request page one.
       * @expected Return only Ethereum with the legacy total, without cold Avalanche access.
       */
      it('excludes shared-address Avalanche cache rows before legacy pagination', async () => {
        await insert('avalanche', 'avax', 9007199254740993n);
        await insert('ethereum', 'eth', 3n);
        const response = await server.inject('/balance?limit=1&offset=0');
        expect(response.statusCode).toEqual(200);
        expect(response.json().hot).toMatchObject({
          items: [{ chain: 'ethereum', balance: { amount: 3 } }],
          total: 1,
        });
        expect(cold).not.toHaveBeenCalled();
      });

      /**
       * @target balanceRoutes returns exact boundary %s
       * @dependencies Real Fastify serializer, SQLite and TokenMap; mocked chain lookup.
       * @scenario Store zero or the largest uint256 and request its Avalanche balance.
       * @expected Return the exact corresponding decimal string.
       */
      it.each([0n, (1n << 256n) - 1n])(
        'returns exact boundary %s',
        async (amount) => {
          await insert('avalanche', 'avax', amount);
          const response = await server.inject('/balance?chain=avalanche');
          expect(response.statusCode).toEqual(200);
          expect(response.json().hot.items[0].balance.amount).toEqual(
            amount.toString(),
          );
        },
      );

      /**
       * @target balanceRoutes rejects disabled Avalanche before reading any chain or cache
       * @dependencies Real route and handler; chain and cache lookup spies.
       * @scenario Disable Avalanche balance collection and request its explicit balance.
       * @expected Return the disabled error and perform zero chain/cache lookups.
       */
      it('rejects disabled Avalanche before reading any chain or cache', async () => {
        BalanceHandler.init();
        const chainLookup = vi.spyOn(ChainHandler, 'getInstance');
        const cacheLookup = vi.spyOn(
          DatabaseActionMock.testDatabase,
          'getChainAddressBalanceByAddresses',
        );
        const response = await server.inject('/balance?chain=avalanche');
        expect(response.statusCode).toEqual(500);
        expect(response.json()).toEqual({
          message: 'Avalanche balance collection is not enabled',
        });
        expect(chainLookup).not.toHaveBeenCalled();
        expect(cacheLookup).not.toHaveBeenCalled();
      });

      /**
       * @target balanceRoutes returns only the requested Avalanche token and keeps the total before pagination
       * @dependencies Real Fastify serializer, SQLite and TokenMap; mocked chain lookup.
       * @scenario Store mixed tokens/chains and request successive AVAX pages.
       * @expected Return only AVAX on Avalanche, retaining the filtered total on an empty page.
       */
      it('returns only the requested Avalanche token and keeps the total before pagination', async () => {
        await insert('avalanche', 'avax', 8n);
        await insert('avalanche', `0x${'22'.repeat(20)}`, 3n);
        await insert('ethereum', 'avax', 4n);
        const response = await server.inject(
          '/balance?chain=avalanche&tokenId=avax&offset=0&limit=1',
        );
        expect(response.statusCode).toEqual(200);
        expect(response.json().hot).toMatchObject({
          items: [
            { chain: 'avalanche', balance: { tokenId: 'avax', amount: '8' } },
          ],
          total: 1,
        });
        const next = await server.inject(
          '/balance?chain=avalanche&tokenId=avax&offset=1&limit=1',
        );
        expect(next.statusCode).toEqual(200);
        expect(next.json().hot).toEqual({ items: [], total: 1 });
      });

      /**
       * @target balanceRoutes returns empty pages for an empty cache with absent configured cold custody
       * @dependencies Real Fastify serializer and SQLite; absent cold metadata.
       * @scenario Request Avalanche balances with no cached rows.
       * @expected Return empty hot/cold pages with zero totals and no network state read.
       */
      it('returns empty pages for an empty cache with absent configured cold custody', async () => {
        const response = await server.inject('/balance?chain=avalanche');
        expect(response.statusCode).toEqual(200);
        expect(response.json()).toEqual({
          chainId: 43114,
          hot: { items: [], total: 0 },
          cold: { items: [], total: 0 },
        });
        expect(cold).toHaveBeenCalled();
      });

      /**
       * @target balanceRoutes uses the ERC-20 significant decimals without changing the stored wrapped amount
       * @dependencies Real Fastify serializer, SQLite and TokenMap; mocked chain lookup.
       * @scenario Read a synthetic ERC-20 cached row with case-preserving metadata.
       * @expected Preserve wrapped units as a string and use its significant decimals.
       */
      it('uses the ERC-20 significant decimals without changing the stored wrapped amount', async () => {
        await insert('avalanche', erc20, 123456789012345678901n);
        const response = await server.inject(
          `/balance?chain=avalanche&tokenId=${erc20}`,
        );
        expect(response.statusCode).toEqual(200);
        expect(response.json().hot.items[0].balance).toEqual({
          tokenId: erc20,
          name: 'Token',
          amount: '123456789012345678901',
          decimals: 6,
          isNativeToken: false,
        });
      });

      /**
       * @target balanceRoutes rejects stale unsupported token metadata rather than guessing decimals
       * @dependencies Real Fastify serializer, SQLite and TokenMap; mocked chain lookup.
       * @scenario Store an unknown synthetic token and request Avalanche balances.
       * @expected Return the metadata-unavailable error without emitting a balance.
       */
      it('rejects stale unsupported token metadata rather than guessing decimals', async () => {
        await insert('avalanche', `0x${'33'.repeat(20)}`, 1n);
        const response = await server.inject('/balance?chain=avalanche');
        expect(response.statusCode).toEqual(500);
        expect(response.json()).toEqual({
          message: 'Avalanche cached token metadata is unavailable',
        });
      });

      /**
       * @target balanceRoutes rejects an invalid cached amount %s
       * @dependencies Real Fastify serializer, SQLite and TokenMap; mocked chain lookup.
       * @scenario Store a negative amount or one exceeding uint256.
       * @expected Return the invalid-cached-balance error for each isolated fault.
       */
      it.each([-1n, 1n << 256n])(
        'rejects an invalid cached amount %s',
        async (amount) => {
          await insert('avalanche', 'avax', amount);
          const response = await server.inject('/balance?chain=avalanche');
          expect(response.statusCode).toEqual(500);
          expect(response.json()).toEqual({
            message: 'Invalid Avalanche cached balance',
          });
        },
      );

      /**
       * @target balanceRoutes rejects unknown chain alias %s
       * @dependencies Real Fastify query schema; no mocked schema dependencies.
       * @scenario Request a balance using each unsupported Avalanche alias.
       * @expected Reject the request with status 400 before reading balances.
       */
      it.each(['AVALANCHE', 'avalanche-c-chain', 'avax'])(
        'rejects unknown chain alias %s',
        async (chain) => {
          const response = await server.inject(`/balance?chain=${chain}`);
          expect(response.statusCode).toEqual(400);
        },
      );
    });
  });
});

describe('balanceRoutes configured Avalanche cold cache', () => {
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
   * @target balanceRoutes should preserve exact AVAX and JOE wrapped integers for both custody pages
   * @dependencies Actual SQLite DAO, TokenMap and Fastify serializer; configured-chain boundary mocks
   * @scenario Store both assets at distinct configured lock and cold addresses and request balances
   * @expected Return exact strings with significant decimals9/6 and perform zero chain state reads
   */
  it('should preserve exact AVAX and JOE wrapped integers for both custody pages', async () => {
    await insertColdBalance(coldLockAddress, 'avax', 100000000000n);
    await insertColdBalance(
      coldLockAddress,
      coldJoe,
      9007199254740993123456789n,
    );
    await insertColdBalance(coldCustodyAddress, 'avax', 500000000000n);
    await insertColdBalance(
      coldCustodyAddress,
      coldJoe,
      9007199254740993999999999n,
    );
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cachedColdFixture);
    for (const [role, address, avaxAmount, joeAmount] of [
      ['hot', coldLockAddress, '100000000000', '9007199254740993123456789'],
      ['cold', coldCustodyAddress, '500000000000', '9007199254740993999999999'],
    ]) {
      const page =
        response.json<ColdAvalancheLockBalance>()[role as 'hot' | 'cold'];
      expect(page.total).toBe(2);
      expect(page.items.find((row) => row.balance.tokenId === 'avax')).toEqual({
        chain: 'avalanche',
        address,
        balance: {
          tokenId: 'avax',
          name: 'AVAX',
          amount: avaxAmount,
          decimals: 9,
          isNativeToken: true,
        },
      });
      expect(page.items.find((row) => row.balance.tokenId === coldJoe)).toEqual(
        {
          chain: 'avalanche',
          address,
          balance: {
            tokenId: coldJoe,
            name: 'JOE',
            amount: joeAmount,
            decimals: 6,
            isNativeToken: false,
          },
        },
      );
    }
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
  });
  /**
   * @target balanceRoutes should retain independent custody pages when token sets differ
   * @dependencies Actual SQLite DAO without an order clause, TokenMap and Fastify
   * @scenario Insert cold tokens opposite to hot, then remove cold JOE and request limit1
   * @expected Expose different token identities and totals without fabricating paired balances
   */
  it('should retain independent custody pages when token sets differ', async () => {
    await insertColdBalance(coldLockAddress, 'avax', 11n);
    await insertColdBalance(coldLockAddress, coldJoe, 12n);
    await insertColdBalance(coldCustodyAddress, coldJoe, 22n);
    await insertColdBalance(coldCustodyAddress, 'avax', 21n);
    const complete = (
      await coldServer.inject('/balance?chain=avalanche&limit=1')
    ).json<ColdAvalancheLockBalance>();
    expect(complete.hot.total).toBe(2);
    expect(complete.cold.total).toBe(2);
    expect(complete.hot.items).toHaveLength(1);
    expect(complete.cold.items).toHaveLength(1);
    const rows = await ColdDatabaseActionMock.allChainAddressBalanceRecords();
    await ColdDatabaseActionMock.testDatabase.removeChainAddressBalances(
      rows.filter(
        (row) => row.address === coldCustodyAddress && row.tokenId === coldJoe,
      ),
    );
    const first = (
      await coldServer.inject('/balance?chain=avalanche&offset=0&limit=1')
    ).json<ColdAvalancheLockBalance>();
    expect(first.hot).toMatchObject({
      total: 2,
      items: [{ balance: { tokenId: coldJoe, amount: '12' } }],
    });
    expect(first.cold).toMatchObject({
      total: 1,
      items: [{ balance: { tokenId: 'avax', amount: '21' } }],
    });
    const next = (
      await coldServer.inject('/balance?chain=avalanche&offset=1&limit=1')
    ).json<ColdAvalancheLockBalance>();
    expect(next.hot).toMatchObject({
      total: 2,
      items: [{ balance: { tokenId: 'avax', amount: '11' } }],
    });
    expect(next.cold).toEqual({ total: 1, items: [] });
  });
  /**
   * @target balanceRoutes should apply token filtering and pagination independently to both custody pages
   * @dependencies Actual SQLite DAO, TokenMap and Fastify serializer
   * @scenario Store AVAX and JOE in each custody and request successive one-row JOE pages
   * @expected Both filtered totals remain1 and the second page is empty without changing units
   */
  it('should apply token filtering and pagination independently to both custody pages', async () => {
    for (const address of [coldLockAddress, coldCustodyAddress]) {
      await insertColdBalance(address, 'avax', 7n);
      await insertColdBalance(address, coldJoe, 123456789012345678901n);
    }
    const first = await coldServer.inject(
      `/balance?chain=avalanche&tokenId=${coldJoe}&offset=0&limit=1`,
    );
    expect(first.statusCode).toBe(200);
    for (const role of ['hot', 'cold']) {
      expect(first.json()[role]).toMatchObject({
        total: 1,
        items: [
          {
            balance: {
              tokenId: coldJoe,
              amount: '123456789012345678901',
              decimals: 6,
            },
          },
        ],
      });
    }
    const next = await coldServer.inject(
      `/balance?chain=avalanche&tokenId=${coldJoe}&offset=1&limit=1`,
    );
    expect(next.statusCode).toBe(200);
    expect(next.json()).toEqual({
      chainId: 43114,
      hot: { items: [], total: 1 },
      cold: { items: [], total: 1 },
    });
  });
  /**
   * @target balanceRoutes should reject missing or ambiguous cached token metadata missing
   * @dependencies Actual TokenMap, SQLite DAO and Fastify route
   * @scenario Remove the JOE mapping or add a second distinct JOE counterpart
   * @expected Return a metadata error without choosing a first matching significant scale
   */
  it('should reject missing or ambiguous cached token metadata missing', async () => {
    const fault: string = 'missing';

    await insertColdBalance(coldCustodyAddress, coldJoe, 9n);
    const config = coldTokenMap.getRawConfig();
    if (fault === 'missing') config.splice(1, 1);
    else
      config.push({
        avalanche: { ...config[1].avalanche },
        ergo: { ...config[1].ergo, tokenId: 'cc'.repeat(32) },
      });
    await coldTokenMap.updateConfigByJson(config);
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toBe(500);
    expect(response.json().message).toBe(
      'Avalanche cached token metadata is unavailable',
    );
  });
  /**
   * @target balanceRoutes should reject missing or ambiguous cached token metadata ambiguous
   * @dependencies Actual TokenMap, SQLite DAO and Fastify route
   * @scenario Remove the JOE mapping or add a second distinct JOE counterpart
   * @expected Return a metadata error without choosing a first matching significant scale
   */
  it('should reject missing or ambiguous cached token metadata ambiguous', async () => {
    const fault: string = 'ambiguous';

    await insertColdBalance(coldCustodyAddress, coldJoe, 9n);
    const config = coldTokenMap.getRawConfig();
    if (fault === 'missing') config.splice(1, 1);
    else
      config.push({
        avalanche: { ...config[1].avalanche },
        ergo: { ...config[1].ergo, tokenId: 'cc'.repeat(32) },
      });
    await coldTokenMap.updateConfigByJson(config);
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toBe(500);
    expect(response.json().message).toBe(
      'Avalanche cached token metadata is unavailable',
    );
  });

  /**
   * @target balanceRoutes should preserve configured deployment 43113 on an empty Avalanche cache
   * @dependencies Actual SQLite DAO, TokenMap and Fastify; controlled registered chain
   * @scenario Set CHAIN_ID to 43113n with no cached rows
   * @expected Return explicit numeric deployment and empty pages without RPC
   */
  it('should preserve configured deployment 43113 on an empty Avalanche cache', async () => {
    coldCustody.chain.CHAIN_ID = 43113n;
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toEqual(200);
    expect(response.json()).toEqual({
      chainId: 43113,
      hot: { items: [], total: 0 },
      cold: { items: [], total: 0 },
    });
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
  });

  /**
   * @target balanceRoutes should preserve configured deployment 43114 on an empty Avalanche cache
   * @dependencies Actual SQLite DAO, TokenMap and Fastify; controlled registered chain
   * @scenario Set CHAIN_ID to 43114n with no cached rows
   * @expected Return explicit numeric deployment and empty pages without RPC
   */
  it('should preserve configured deployment 43114 on an empty Avalanche cache', async () => {
    coldCustody.chain.CHAIN_ID = 43114n;
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toEqual(200);
    expect(response.json()).toEqual({
      chainId: 43114,
      hot: { items: [], total: 0 },
      cold: { items: [], total: 0 },
    });
    expect(coldCustody.hotRead).not.toHaveBeenCalled();
    expect(coldCustody.coldRead).not.toHaveBeenCalled();
  });

  /**
   * @target balanceRoutes should refuse missing deployment on an empty Avalanche handler response
   * @dependencies Actual Fastify route and serializer; one handler-output mutation
   * @scenario Return empty cached pages with missing deployment
   * @expected Return 500 before the legacy union can accept or strip the deployment
   */
  it('should refuse missing deployment on an empty Avalanche handler response', async () => {
    vi.spyOn(
      ColdBalanceHandler.getInstance(),
      'getAvalancheBalances',
    ).mockResolvedValue({
      chainId: undefined,
      hot: { items: [], total: 0 },
      cold: { items: [], total: 0 },
    } as unknown as ColdAvalancheLockBalance);
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toEqual(500);
  });

  /**
   * @target balanceRoutes should refuse null deployment on an empty Avalanche handler response
   * @dependencies Actual Fastify route and serializer; one handler-output mutation
   * @scenario Return empty cached pages with null deployment
   * @expected Return 500 before the legacy union can accept or strip the deployment
   */
  it('should refuse null deployment on an empty Avalanche handler response', async () => {
    vi.spyOn(
      ColdBalanceHandler.getInstance(),
      'getAvalancheBalances',
    ).mockResolvedValue({
      chainId: null,
      hot: { items: [], total: 0 },
      cold: { items: [], total: 0 },
    } as unknown as ColdAvalancheLockBalance);
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toEqual(500);
  });

  /**
   * @target balanceRoutes should refuse string deployment on an empty Avalanche handler response
   * @dependencies Actual Fastify route and serializer; one handler-output mutation
   * @scenario Return empty cached pages with string deployment
   * @expected Return 500 before the legacy union can accept or strip the deployment
   */
  it('should refuse string deployment on an empty Avalanche handler response', async () => {
    vi.spyOn(
      ColdBalanceHandler.getInstance(),
      'getAvalancheBalances',
    ).mockResolvedValue({
      chainId: '43114',
      hot: { items: [], total: 0 },
      cold: { items: [], total: 0 },
    } as unknown as ColdAvalancheLockBalance);
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toEqual(500);
  });

  /**
   * @target balanceRoutes should refuse unsupported deployment on an empty Avalanche handler response
   * @dependencies Actual Fastify route and serializer; one handler-output mutation
   * @scenario Return empty cached pages with unsupported deployment
   * @expected Return 500 before the legacy union can accept or strip the deployment
   */
  it('should refuse unsupported deployment on an empty Avalanche handler response', async () => {
    vi.spyOn(
      ColdBalanceHandler.getInstance(),
      'getAvalancheBalances',
    ).mockResolvedValue({
      chainId: 1,
      hot: { items: [], total: 0 },
      cold: { items: [], total: 0 },
    } as unknown as ColdAvalancheLockBalance);
    const response = await coldServer.inject('/balance?chain=avalanche');
    expect(response.statusCode).toEqual(500);
  });
});
