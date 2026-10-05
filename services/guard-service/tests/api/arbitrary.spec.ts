import rateLimit from '@fastify/rate-limit';

import { FastifyWithZod, makeFastify } from '@rosen-bridge/fastify-enhanced';
import { TokenMap } from '@rosen-bridge/tokens';
import { ChainUtils } from '@rosen-chains/abstract-chain';
import { ERGO_CHAIN } from '@rosen-chains/ergo';

import { arbitraryOrderRoute } from '../../src/api/arbitrary';
import Configs from '../../src/configs/configs';
import DatabaseHandler from '../../src/db/databaseHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import { OrderStatus } from '../../src/utils/constants';
import {
  arrangedOrderJson,
  disarrangedOrderJson,
  orderJson,
} from '../arbitrary/testData';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { tokenMapping } from '../utils/avalancheChainTestUtils';
import { admissionFixture } from '../verification/avalancheManagementAdmissionTestUtils';
import { invalidOrderJson } from './testData';

/** Minimal captured handler interfaces allow testing the route's own guard. */
type OrderHandler = (
  request: { body: { id: string; chain: string; orderJson: string } },
  reply: { status: (status: number) => { send: (body: unknown) => void } },
) => Promise<void>;
describe('arbitraryOrderRoute', () => {
  describe('POST /order', () => {
    describe('legacy behavior', () => {
      let mockedServer: FastifyWithZod;

      beforeEach(async () => {
        mockedServer = await makeFastify();
        await mockedServer.register(rateLimit, {
          max: Configs.apiMaxRequestsPerMinute,
          timeWindow: '1 minute',
        });
        mockedServer.register(arbitraryOrderRoute);
        await DatabaseActionMock.clearTables();
      });

      afterEach(() => {
        mockedServer.close();
      });

      /**
       * @target fastifyServer[POST /order] should insert new order successfully
       * @dependencies
       * - database
       * @scenario
       * - send a request to the server
       * - check the result
       * - check database
       * @expected
       * - it should return status code 200
       * - order should be inserted into db
       */
      it('should insert new order successfully', async () => {
        // send a request to the server
        const result = await mockedServer.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
            chain: ERGO_CHAIN,
            orderJson: orderJson,
          },
          headers: {
            'Api-Key': 'hello',
          },
        });

        // check the result
        expect(result.statusCode).toEqual(200);

        // check database
        const dbOrders = (await DatabaseActionMock.allOrderRecords()).map(
          (order) => [order.id, order.chain, order.orderJson, order.status],
        );
        expect(dbOrders.length).toEqual(1);
        expect(dbOrders).toContainEqual([
          '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
          ERGO_CHAIN,
          orderJson,
          OrderStatus.pending,
        ]);
      });

      /**
       * @target fastifyServer[POST /order] should insert encoded version of the order
       * @dependencies
       * - database
       * @scenario
       * - send a request to the server
       * - check the result
       * - check database
       * @expected
       * - it should return status code 200
       * - the encoded version of order should be inserted into db
       */
      it('should insert encoded version of the order', async () => {
        // send a request to the server
        const result = await mockedServer.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
            chain: ERGO_CHAIN,
            orderJson: disarrangedOrderJson,
          },
          headers: {
            'Api-Key': 'hello',
          },
        });

        // check the result
        expect(result.statusCode).toEqual(200);

        // check database
        const dbOrders = (await DatabaseActionMock.allOrderRecords()).map(
          (order) => [order.id, order.chain, order.orderJson, order.status],
        );
        expect(dbOrders.length).toEqual(1);
        expect(dbOrders).toContainEqual([
          '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
          ERGO_CHAIN,
          arrangedOrderJson,
          OrderStatus.pending,
        ]);
      });

      /**
       * @target fastifyServer[POST /order] should return 400 when order json is invalid
       * @dependencies
       * - database
       * @scenario
       * - send a request to the server
       * - check the result
       * - check database
       * @expected
       * - it should return status code 400
       * - no order should be inserted into db
       */
      it('should return 400 when order json is invalid', async () => {
        // send a request to the server
        const result = await mockedServer.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
            chain: ERGO_CHAIN,
            orderJson: invalidOrderJson,
          },
          headers: {
            'Api-Key': 'hello',
          },
        });

        // check the result
        expect(result.statusCode).toEqual(400);

        // check database
        const dbOrders = await DatabaseActionMock.allOrderRecords();
        expect(dbOrders.length).toEqual(0);
      });

      /**
       * @target fastifyServer[POST /order] should return 409 when order is already in database
       * @dependencies
       * - database
       * @scenario
       * - insert mocked order into db
       * - send a request to the server
       * - check the result
       * @expected
       * - it should return status code 409
       */
      it('should return 409 when order is already in database', async () => {
        // insert mocked order into db
        await DatabaseActionMock.insertOrderRecord(
          '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
          ERGO_CHAIN,
          orderJson,
          OrderStatus.pending,
        );

        // send a request to the server
        const result = await mockedServer.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
            chain: ERGO_CHAIN,
            orderJson: orderJson,
          },
          headers: {
            'Api-Key': 'hello',
          },
        });

        // check the result
        expect(result.statusCode).toEqual(409);
      });

      /**
       * @target fastifyServer[POST /order] should return 400 when chain is not supported
       * @dependencies
       * - ChainHandler
       * - database
       * @scenario
       * - send a request to the server
       * - check the result
       * @expected
       * - it should return status code 400
       */
      it('should return 400 when chain is not supported', async () => {
        // send a request to the server
        const result = await mockedServer.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
            chain: 'unsupported-chain',
            orderJson: orderJson,
          },
          headers: {
            'Api-Key': 'hello',
          },
        });

        // check the result
        expect(result.statusCode).toEqual(400);
      });

      /**
       * @target fastifyServer[POST /order] should return 400 when id is invalid
       * @dependencies
       * - ChainHandler
       * - database
       * @scenario
       * - send a request to the server
       * - check the result
       * @expected
       * - it should return status code 400
       */
      it('should return 400 when id is invalid', async () => {
        // send a request to the server
        const result = await mockedServer.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: 'id',
            chain: ERGO_CHAIN,
            orderJson: orderJson,
          },
          headers: {
            'Api-Key': 'hello',
          },
        });

        // check the result
        expect(result.statusCode).toEqual(400);
      });

      /**
       * @target fastifyServer[POST /order] should return 403 when Api-Key did not set in header
       * @dependencies
       * @scenario
       * - send a request to the server
       * - check the result
       * @expected
       * - it should return status code 403
       */
      it('should return 403 when Api-Key did not set in header', async () => {
        // send a request to the server
        const result = await mockedServer.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
            chain: ERGO_CHAIN,
            orderJson: orderJson,
          },
        });
        // check the result
        expect(result.statusCode).toEqual(403);
      });

      /**
       * @target fastifyServer[POST /order] should return 403 when Api-Key is wrong
       * @dependencies
       * @scenario
       * - send a request to the server
       * - check the result
       * @expected
       * - it should return status code 403
       */
      it('should return 403 when Api-Key is wrong', async () => {
        // send a request to the server
        const result = await mockedServer.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
            chain: ERGO_CHAIN,
            orderJson: orderJson,
          },
          headers: {
            'Api-Key': 'wrong',
          },
        });
        // check the result
        expect(result.statusCode).toEqual(403);
      });

      /**
       * @target fastifyServer[POST /order] should respond with error when rate limit is triggered
       * @dependencies
       * @scenario
       * - in the test config set rate limit of this route to 2
       * - send 3 requests to the server
       * - check the responses
       * @expected
       * - all 3 responses should contain x-ratelimit-limit header with the value of 2
       * - for the first request
       *   - response status should not be 429
       *   - response header x-ratelimit-remaining should be 1
       * - for the second request
       *   - response status should not be 429
       *   - response header x-ratelimit-remaining should be 0
       * - for the third request
       *   - response status should be 429
       *   - response header x-ratelimit-remaining should be 0
       */
      it('should respond with error when rate limit is triggered', async () => {
        // act
        const responses = [];
        for (
          let i = 1;
          i <= Configs.apiMaxRequestsPerMinutePostRoutes + 1;
          i += 1
        ) {
          const response = await mockedServer.inject({
            method: 'POST',
            url: '/order',
            body: {
              id: '85b5cb7f4e81e1db4e95803b6144c64983f76e776ff75fd04c0ebfc95ae46e4d',
              chain: ERGO_CHAIN,
              orderJson: orderJson,
            },
            headers: {
              'Api-Key': 'hello',
            },
          });

          responses.push(response);
        }

        // assert
        expect(responses[0].statusCode).not.toEqual(429);
        expect(responses[0].headers['x-ratelimit-remaining']).toEqual('1');
        expect(responses[0].headers['x-ratelimit-limit']).toEqual('2');

        expect(responses[1].statusCode).not.toEqual(429);
        expect(responses[1].headers['x-ratelimit-remaining']).toEqual('0');
        expect(responses[1].headers['x-ratelimit-limit']).toEqual('2');

        expect(responses[2].statusCode).toEqual(429);
        expect(responses[2].headers['x-ratelimit-remaining']).toEqual('0');
        expect(responses[2].headers['x-ratelimit-limit']).toEqual('2');
      });
    });
    describe('Avalanche mapped orders', () => {
      let server: FastifyWithZod;
      let fixture: Awaited<ReturnType<typeof admissionFixture>>;
      const previous = Configs.isArbitraryOrderRequestActive;
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        fixture = await admissionFixture(true);
        const tokens = new TokenMap();
        await tokens.updateConfigByJson(tokenMapping());
        vi.spyOn(TokenHandler.getInstance(), 'getTokenMap').mockReturnValue(
          tokens,
        );
        Configs.isArbitraryOrderRequestActive = true;
        server = await makeFastify();
        await server.register(arbitraryOrderRoute);
      });
      afterEach(async () => {
        await server.close();
        fixture.close();
        vi.restoreAllMocks();
        Configs.isArbitraryOrderRequestActive = previous;
      });
      /**
       * @target arbitraryOrderRoute stores an authenticated canonical %s order with exact significant units
       * @dependencies Actual Fastify authentication, generated TokenMap, API and SQLite DAO
       * @scenario Post one AVAX or JOE order on the prepared mainnet profile and read the stored row
       * @expected Return 200 and retain exact asset/amount/recipient under pending status without signing or RPC
       */
      it.each(['AVAX', 'JOE'])(
        'stores an authenticated canonical %s order with exact significant units',
        async (asset) => {
          const order = [
            {
              address: '0x' + 'AB'.repeat(20),
              assets: {
                nativeToken: asset === 'AVAX' ? 123n : 0n,
                tokens:
                  asset === 'JOE' ? [{ id: fixture.joe, value: 123n }] : [],
              },
            },
          ];
          const result = await server.inject({
            method: 'POST',
            url: '/order',
            body: {
              id: '11'.repeat(32),
              chain: 'avalanche',
              orderJson: ChainUtils.encodeOrder(order),
            },
            headers: { 'Api-Key': 'hello' },
          });
          expect(result.statusCode).toEqual(200);
          order[0].address = order[0].address.toLowerCase();
          const rows = await DatabaseActionMock.allOrderRecords();
          expect(rows).toHaveLength(1);
          expect([
            rows[0].id,
            rows[0].chain,
            rows[0].status,
            rows[0].orderJson,
          ]).toEqual([
            '11'.repeat(32),
            'avalanche',
            OrderStatus.pending,
            ChainUtils.encodeOrder(order),
          ]);
          expect(fixture.rpc).not.toHaveBeenCalled();
          expect(fixture.signer).not.toHaveBeenCalled();
        },
      );
      /**
       * @target arbitraryOrderRoute refuses mapped order %s before persistence
       * @dependencies Actual authenticated API and token policy; isolated malformed order
       * @scenario Change one amount, asset, recipient or token cardinality in an otherwise valid JOE order
       * @expected Return 400 and persist no order without signing or RPC
       */
      it.each([
        'unknown token',
        'uppercase token',
        'zero token',
        'negative token',
        'raw token overflow',
        'mixed native and token',
        'two tokens',
        'zero native',
        'raw native overflow',
        'zero recipient',
      ])('refuses mapped order %s before persistence', async (fault) => {
        const order = [
          {
            address: '0x' + 'ab'.repeat(20),
            assets: {
              nativeToken: 0n,
              tokens: [{ id: fixture.joe, value: 123n }],
            },
          },
        ];
        const assets = order[0].assets;
        if (fault === 'unknown token')
          assets.tokens[0].id = '0x' + '78'.repeat(20);
        if (fault === 'uppercase token')
          assets.tokens[0].id = fixture.joe.toUpperCase();
        if (fault === 'zero token') assets.tokens[0].value = 0n;
        if (fault === 'negative token') assets.tokens[0].value = -1n;
        if (fault === 'raw token overflow')
          assets.tokens[0].value = (1n << 256n) - 1n;
        if (fault === 'mixed native and token') assets.nativeToken = 1n;
        if (fault === 'two tokens') assets.tokens.push({ ...assets.tokens[0] });
        if (fault === 'zero native' || fault === 'raw native overflow') {
          assets.tokens = [];
          if (fault === 'raw native overflow')
            assets.nativeToken = (1n << 256n) - 1n;
        }
        if (fault === 'zero recipient')
          order[0].address = '0x' + '00'.repeat(20);
        const result = await server.inject({
          method: 'POST',
          url: '/order',
          body: {
            id: '11'.repeat(32),
            chain: 'avalanche',
            orderJson: ChainUtils.encodeOrder(order),
          },
          headers: { 'Api-Key': 'hello' },
        });
        expect(result.statusCode).toEqual(400);
        expect(await DatabaseActionMock.allOrderRecords()).toEqual([]);
        expect(fixture.rpc).not.toHaveBeenCalled();
        expect(fixture.signer).not.toHaveBeenCalled();
      });
    });
    describe('Avalanche registry boundaries', () => {
      afterEach(() => vi.restoreAllMocks());
      /**
       * @target arbitraryOrderRoute rejects Avalanche without its route opt-in
       * @dependencies Real Fastify route/schema/authentication; insertion API spy.
       * @scenario Send a synthetic authenticated Avalanche order through HTTP injection.
       * @expected Return 400 and never insert an order.
       */
      it('rejects Avalanche without its route opt-in', async () => {
        const insert = vi.spyOn(DatabaseHandler, 'insertOrder');
        const server = await makeFastify();
        await server.register(arbitraryOrderRoute);
        try {
          const result = await server.inject({
            method: 'POST',
            url: '/order',
            body: { id: '11'.repeat(32), chain: 'avalanche', orderJson: '[]' },
            headers: { 'Api-Key': 'hello' },
          });
          expect(result.statusCode).toEqual(400);
          expect(insert).not.toHaveBeenCalled();
        } finally {
          await server.close();
        }
      });
      /**
       * @target arbitraryOrderRoute rejects Avalanche independently of schema validation
       * @dependencies Captured Fastify registration, reply and insertion API spies.
       * @scenario Enable arbitrary requests and call the handler with Avalanche,
       * bypassing schema validation to exercise its separate guard.
       * @expected Return 400 before decoding or inserting the order.
       */
      it('rejects Avalanche independently of schema validation', async () => {
        let handler!: OrderHandler;
        const post = vi.fn(
          (_path: string, _options: unknown, callback: OrderHandler) => {
            handler = callback;
          },
        );
        await arbitraryOrderRoute({ post } as unknown as FastifyWithZod);
        const insert = vi.spyOn(DatabaseHandler, 'insertOrder');
        const send = vi.fn();
        const status = vi.fn(() => ({ send }));
        const previous = Configs.isArbitraryOrderRequestActive;
        Configs.isArbitraryOrderRequestActive = true;
        try {
          await handler(
            {
              body: {
                id: '11'.repeat(32),
                chain: 'avalanche',
                orderJson: '[]',
              },
            },
            { status },
          );
          expect(status).toHaveBeenCalledExactlyOnceWith(400);
          expect(send).toHaveBeenCalledExactlyOnceWith({
            message: 'Avalanche arbitrary order route is disabled',
          });
          expect(insert).not.toHaveBeenCalled();
        } finally {
          Configs.isArbitraryOrderRequestActive = previous;
        }
      });
    });
  });
});
