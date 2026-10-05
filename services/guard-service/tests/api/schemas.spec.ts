import {
  type FastifyWithZod as ColdFastifyWithZod,
  makeFastify as makeColdFastify,
} from '@rosen-bridge/fastify-enhanced';

import { balanceRoutes as coldBalanceRoutes } from '../../src/api/balance';
import { BalanceResponseSchema as ColdBalanceResponseSchema } from '../../src/api/schemas';
import {
  AddressQuerySchema,
  BalanceQuerySchema,
  BalanceResponseSchema,
  AssetsResponseSchema,
  OrderQuerySchema,
  SupportedChainsSchema,
} from '../../src/api/schemas';
import ColdBalanceHandler from '../../src/handlers/balanceHandler';
import { TokenHandler as ColdTokenHandler } from '../../src/handlers/tokenHandler';
import { avalancheErc20 as erc20 } from '../avalancheRegistryTestData';
import ColdDatabaseActionMock from '../db/mocked/databaseAction.mock';
import { policy as coldPolicy } from '../handlers/avalancheBalanceTestUtils';
import { balance } from './avalancheBalanceTestUtils';
import { cold as coldCustodyAddress } from './avalancheColdBalanceTestData';
import { createColdTokenMap as createColdMap } from './avalancheColdBalanceTestUtils';
import { mockColdBalanceCustody } from './mocked/avalancheColdBalance.mock';

describe('SupportedChainsSchema', () => {
  /**
   * @target SupportedChainsSchema accepts Avalanche as a known chain
   * @dependencies Real Zod schemas; no mocked dependencies.
   * @scenario Parse Avalanche through known-chain and address-query schemas.
   * @expected Accept the identity without implying an enabled chain runtime.
   */
  it('accepts Avalanche as a known chain', () => {
    expect(SupportedChainsSchema.parse('avalanche')).toEqual('avalanche');
    expect(AddressQuerySchema.parse({ chain: 'avalanche' }).chain).toEqual(
      'avalanche',
    );
  });
});
describe('BalanceResponseSchema', () => {
  /**
   * @target BalanceResponseSchema rejects numeric Avalanche amounts while preserving exact strings
   * @dependencies Real response schema; no mocked dependencies.
   * @scenario Parse an Avalanche cached amount larger than MAX_SAFE_INTEGER.
   * @expected Return the exact string and reject its numeric counterpart.
   */
  it('rejects numeric Avalanche amounts while preserving exact strings', () => {
    const exact = balance('9007199254740993');
    expect(BalanceResponseSchema.parse(exact)).toEqual(exact);
    expect(
      BalanceResponseSchema.safeParse(balance(9007199254740992)).success,
    ).toEqual(false);
  });
  /**
   * @target BalanceResponseSchema retains numeric balances for existing chains
   * @dependencies Real response schema; no mocked dependencies.
   * @scenario Parse an existing chain's numeric cached balance.
   * @expected Preserve the numeric response unchanged.
   */
  it('retains numeric balances for existing chains', () => {
    const legacy = balance(42, 'bitcoin');
    expect(BalanceResponseSchema.parse(legacy)).toEqual(legacy);
  });
  /**
   * @target BalanceResponseSchema preserves exact Avalanche cold balance entries
   * @dependencies Real response schema; no mocked dependencies.
   * @scenario Add a cold entry to an otherwise valid exact Avalanche response.
   * @expected Preserve its wrapped-unit string and refuse a numeric cold amount.
   */
  it('preserves exact Avalanche cold balance entries', () => {
    const exact = balance('9007199254740993');
    const input = { ...exact, cold: exact.hot };
    expect(BalanceResponseSchema.parse(input)).toEqual(input);
    const numeric = balance(9007199254740992);
    expect(
      BalanceResponseSchema.safeParse({ ...exact, cold: numeric.hot }).success,
    ).toEqual(false);
  });
});
describe('BalanceQuerySchema', () => {
  /**
   * @target BalanceQuerySchema recognizes Avalanche in exact balance and read-only address queries
   * @dependencies Real schemas; no mocked dependencies.
   * @scenario Parse explicit Avalanche queries and a case-preserving token ID.
   * @expected Accept Avalanche identity without widening legacy token syntax.
   */
  it('recognizes Avalanche in exact balance and read-only address queries', () => {
    expect(
      BalanceQuerySchema.safeParse({ chain: 'avalanche' }).success,
    ).toEqual(true);
    expect(
      AddressQuerySchema.safeParse({ chain: 'avalanche' }).success,
    ).toEqual(true);
    expect(
      BalanceQuerySchema.safeParse({ chain: 'avalanche', tokenId: erc20 })
        .success,
    ).toEqual(true);
    expect(
      BalanceQuerySchema.safeParse({ chain: 'ethereum', tokenId: erc20 })
        .success,
    ).toEqual(false);
  });
  /**
   * @target BalanceQuerySchema routes Avalanche only through the explicit exact balance query
   * @dependencies Real query and asset schemas; no mocked dependencies.
   * @scenario Parse an explicit Avalanche query and a numeric Avalanche asset row.
   * @expected Accept the query, reject the legacy numeric asset row, preserve defaults.
   */
  it('routes Avalanche only through the explicit exact balance query', () => {
    expect(BalanceQuerySchema.parse({ chain: 'avalanche' })).toEqual({
      chain: 'avalanche',
      offset: 0,
      limit: 10,
    });
    expect(BalanceQuerySchema.parse({})).toEqual({ offset: 0, limit: 10 });
    expect(
      AssetsResponseSchema.safeParse({
        items: [
          {
            tokenId: 'avax',
            amount: 1,
            coldAmount: 0,
            decimals: 18,
            chain: 'avalanche',
            isNativeToken: true,
          },
        ],
        total: 1,
      }).success,
    ).toEqual(false);
  });
});
describe('OrderQuerySchema', () => {
  /**
   * @target OrderQuerySchema does not derive arbitrary-order capability from known-chain registration
   * @dependencies Real order schema; no mocked dependencies.
   * @scenario Parse an Avalanche order and an equivalent existing-chain order.
   * @expected Reject Avalanche and retain existing Ergo request support.
   */
  it('does not derive arbitrary-order capability from known-chain registration', () => {
    const request = {
      id: '11'.repeat(32),
      chain: 'avalanche',
      orderJson: '[]',
    };
    expect(OrderQuerySchema.safeParse(request).success).toEqual(false);
    expect(OrderQuerySchema.parse({ ...request, chain: 'ergo' }).chain).toEqual(
      'ergo',
    );
  });
});

describe('BalanceResponseSchema configured Avalanche cold cache', () => {
  let coldServer: ColdFastifyWithZod;
  let coldTokenMap: Awaited<ReturnType<typeof createColdMap>>;
  beforeEach(async () => {
    vi.restoreAllMocks();
    await ColdDatabaseActionMock.clearTables();
    mockColdBalanceCustody();
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
   * @target BalanceResponseSchema should reject malformed cold integer numeric amount through the HTTP serializer
   * @dependencies Actual Fastify response schema and serializer
   * @scenario Return a cold row with a numeric, negative, noncanonical or overflowing amount
   * @expected Return status500 rather than a rounded or malformed balance payload
   */
  it('should reject malformed cold integer numeric amount through the HTTP serializer', async () => {
    const amount: string | number = 123;
    expect(
      ColdBalanceResponseSchema.safeParse({
        chainId: 43114,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }).success,
    ).toBe(false);

    coldServer.get(
      '/cold-fixture',
      { schema: { response: { 200: ColdBalanceResponseSchema } } },
      async () => ({
        chainId: 43114 as const,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }),
    );
    const response = await coldServer.inject('/cold-fixture');
    expect(response.statusCode).toBe(500);
  });
  /**
   * @target BalanceResponseSchema should reject malformed cold integer negative amount through the HTTP serializer
   * @dependencies Actual Fastify response schema and serializer
   * @scenario Return a cold row with a numeric, negative, noncanonical or overflowing amount
   * @expected Return status500 rather than a rounded or malformed balance payload
   */
  it('should reject malformed cold integer negative amount through the HTTP serializer', async () => {
    const amount: string | number = '-1';
    expect(
      ColdBalanceResponseSchema.safeParse({
        chainId: 43114,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }).success,
    ).toBe(false);

    coldServer.get(
      '/cold-fixture',
      { schema: { response: { 200: ColdBalanceResponseSchema } } },
      async () => ({
        chainId: 43114 as const,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }),
    );
    const response = await coldServer.inject('/cold-fixture');
    expect(response.statusCode).toBe(500);
  });
  /**
   * @target BalanceResponseSchema should reject malformed cold integer noncanonical amount through the HTTP serializer
   * @dependencies Actual Fastify response schema and serializer
   * @scenario Return a cold row with a numeric, negative, noncanonical or overflowing amount
   * @expected Return status500 rather than a rounded or malformed balance payload
   */
  it('should reject malformed cold integer noncanonical amount through the HTTP serializer', async () => {
    const amount: string | number = '01';
    expect(
      ColdBalanceResponseSchema.safeParse({
        chainId: 43114,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }).success,
    ).toBe(false);

    coldServer.get(
      '/cold-fixture',
      { schema: { response: { 200: ColdBalanceResponseSchema } } },
      async () => ({
        chainId: 43114 as const,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }),
    );
    const response = await coldServer.inject('/cold-fixture');
    expect(response.statusCode).toBe(500);
  });
  /**
   * @target BalanceResponseSchema should reject malformed cold integer malformed amount through the HTTP serializer
   * @dependencies Actual Fastify response schema and serializer
   * @scenario Return a cold row with a numeric, negative, noncanonical or overflowing amount
   * @expected Return status500 rather than a rounded or malformed balance payload
   */
  it('should reject malformed cold integer malformed amount through the HTTP serializer', async () => {
    const amount: string | number = 'invalid';
    expect(
      ColdBalanceResponseSchema.safeParse({
        chainId: 43114,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }).success,
    ).toBe(false);

    coldServer.get(
      '/cold-fixture',
      { schema: { response: { 200: ColdBalanceResponseSchema } } },
      async () => ({
        chainId: 43114 as const,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }),
    );
    const response = await coldServer.inject('/cold-fixture');
    expect(response.statusCode).toBe(500);
  });
  /**
   * @target BalanceResponseSchema should reject malformed cold integer uint256 overflow through the HTTP serializer
   * @dependencies Actual Fastify response schema and serializer
   * @scenario Return a cold row with a numeric, negative, noncanonical or overflowing amount
   * @expected Return status500 rather than a rounded or malformed balance payload
   */
  it('should reject malformed cold integer uint256 overflow through the HTTP serializer', async () => {
    const amount: string | number = (1n << 256n).toString();
    expect(
      ColdBalanceResponseSchema.safeParse({
        chainId: 43114,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }).success,
    ).toBe(false);

    coldServer.get(
      '/cold-fixture',
      { schema: { response: { 200: ColdBalanceResponseSchema } } },
      async () => ({
        chainId: 43114 as const,
        hot: { items: [], total: 0 },
        cold: {
          items: [
            {
              address: coldCustodyAddress,
              chain: 'avalanche' as const,
              balance: {
                tokenId: 'avax',
                amount: amount as unknown as string,
                decimals: 9,
                isNativeToken: true,
              },
            },
          ],
          total: 1,
        },
      }),
    );
    const response = await coldServer.inject('/cold-fixture');
    expect(response.statusCode).toBe(500);
  });
});

describe('BalanceResponseSchema deployment authority', () => {
  /**
   * @target BalanceResponseSchema should retain deployment 43113 on valid empty pages
   * @dependencies Actual Zod balance response union
   * @scenario Parse empty pages with chainId 43113
   * @expected Preserve the deployment through the Avalanche union branch
   */
  it('should retain deployment 43113 on valid empty pages', async () => {
    const input = {
      chainId: 43113,
      hot: { items: [], total: 0 },
      cold: { items: [], total: 0 },
    };
    expect(BalanceResponseSchema.parse(input)).toEqual(input);
  });

  /**
   * @target BalanceResponseSchema should retain deployment 43114 on valid empty pages
   * @dependencies Actual Zod balance response union
   * @scenario Parse empty pages with chainId 43114
   * @expected Preserve the deployment through the Avalanche union branch
   */
  it('should retain deployment 43114 on valid empty pages', async () => {
    const input = {
      chainId: 43114,
      hot: { items: [], total: 0 },
      cold: { items: [], total: 0 },
    };
    expect(BalanceResponseSchema.parse(input)).toEqual(input);
  });

  /**
   * @target BalanceResponseSchema should reject null deployment without legacy fallback
   * @dependencies Actual Zod response union
   * @scenario Parse empty pages with null chainId
   * @expected Reject the explicit malformed deployment
   */
  it('should reject null deployment without legacy fallback', async () => {
    expect(
      BalanceResponseSchema.safeParse({
        chainId: null,
        hot: { items: [], total: 0 },
        cold: { items: [], total: 0 },
      }).success,
    ).toEqual(false);
  });

  /**
   * @target BalanceResponseSchema should reject string deployment without legacy fallback
   * @dependencies Actual Zod response union
   * @scenario Parse empty pages with string chainId
   * @expected Reject the explicit malformed deployment
   */
  it('should reject string deployment without legacy fallback', async () => {
    expect(
      BalanceResponseSchema.safeParse({
        chainId: '43114',
        hot: { items: [], total: 0 },
        cold: { items: [], total: 0 },
      }).success,
    ).toEqual(false);
  });

  /**
   * @target BalanceResponseSchema should reject unsupported deployment without legacy fallback
   * @dependencies Actual Zod response union
   * @scenario Parse empty pages with unsupported chainId
   * @expected Reject the explicit malformed deployment
   */
  it('should reject unsupported deployment without legacy fallback', async () => {
    expect(
      BalanceResponseSchema.safeParse({
        chainId: 1,
        hot: { items: [], total: 0 },
        cold: { items: [], total: 0 },
      }).success,
    ).toEqual(false);
  });
});
