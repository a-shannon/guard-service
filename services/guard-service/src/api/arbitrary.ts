import { isAddress } from 'ethers';

import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import { FastifyWithZod } from '@rosen-bridge/fastify-enhanced';
import { ChainUtils } from '@rosen-chains/abstract-chain';
import {
  AVALANCHE_CHAIN,
  captureAvalancheAssets,
} from '@rosen-chains/avalanche';

import Configs from '../configs/configs';
import DatabaseHandler from '../db/databaseHandler';
import { TokenHandler } from '../handlers/tokenHandler';
import { authenticateKey } from '../utils/authentication';
import { isAvalancheManagementRouteEnabled } from '../utils/avalancheManagementRoutes';
import { ARBITRARY_ORDER_CHAINS } from '../utils/constants';
import { DuplicateOrder } from '../utils/errors';
import { MessageResponseSchema, OrderQuerySchema } from './schemas';

const logger = DefaultLogger.getInstance().child(import.meta.url);

/**
 * setup arbitrary order route
 * @param server
 */
const orderRoute = (server: FastifyWithZod) => {
  server.post(
    '/order',
    {
      config: {
        rateLimit: {
          max: Configs.apiMaxRequestsPerMinutePostRoutes,
        },
      },
      schema: {
        body: OrderQuerySchema,
        response: {
          200: MessageResponseSchema,
          400: MessageResponseSchema,
          403: MessageResponseSchema,
          409: MessageResponseSchema,
        },
        security: [{ apiKey: [] }],
      },
      preHandler: [authenticateKey],
    },
    async (request, reply) => {
      const { id, chain, orderJson } = request.body;
      if (!Configs.isArbitraryOrderRequestActive) {
        reply.status(400).send({
          message: `Arbitrary order request is disabled in config`,
        });
        return;
      }

      if (!ARBITRARY_ORDER_CHAINS.includes(chain)) {
        reply.status(400).send({
          message: `Invalid value for chain (chain [${chain}] is not supported)`,
        });
        return;
      }

      if (
        chain === AVALANCHE_CHAIN &&
        !isAvalancheManagementRouteEnabled('arbitrary')
      ) {
        reply.status(400).send({
          message: 'Avalanche arbitrary order route is disabled',
        });
        return;
      }

      // id should be a 32bytes hex string
      if (id.length !== 64 || !id.match(/^[0-9a-f]+$/)) {
        reply.status(400).send({
          message: `Invalid value for id (expected 32Bytes hex string, found [${id}])`,
        });
        return;
      }

      try {
        // try to decode order
        const order = ChainUtils.decodeOrder(orderJson);
        if (chain === AVALANCHE_CHAIN) {
          if (
            order.length !== 1 ||
            typeof order[0].address !== 'string' ||
            !isAddress(order[0].address) ||
            /^0x0{40}$/i.test(order[0].address) ||
            typeof order[0].assets.nativeToken !== 'bigint' ||
            order[0].assets.nativeToken < 0n ||
            !Array.isArray(order[0].assets.tokens) ||
            order[0].assets.tokens.length > 1
          )
            throw new Error('Invalid Avalanche order');
          const tokens = TokenHandler.getInstance().getTokenMap();
          const policy = captureAvalancheAssets(tokens);
          const assets = order[0].assets;
          if (assets.tokens.length === 0) {
            const raw = tokens.unwrapAmount(
              'avax',
              assets.nativeToken,
              AVALANCHE_CHAIN,
            ).amount;
            if (assets.nativeToken <= 0n || raw <= 0n || raw >= 1n << 256n)
              throw new Error('Invalid Avalanche native amount');
          } else {
            const token = assets.tokens[0];
            if (
              assets.nativeToken !== 0n ||
              !token ||
              typeof token.value !== 'bigint' ||
              token.value <= 0n
            )
              throw new Error('Invalid Avalanche token order');
            policy.unwrap(token.id, token.value);
          }
          policy.assertFresh(policy.ids);
          order[0].address = order[0].address.toLowerCase();
        }

        await DatabaseHandler.insertOrder(
          id,
          chain,
          ChainUtils.encodeOrder(order),
        );
        reply.status(200).send({
          message: 'Ok',
        });
      } catch (e) {
        if (e instanceof DuplicateOrder) {
          logger.warn(
            `Failed to insert arbitrary order due to duplication: ${e}`,
          );
          reply.status(409).send({
            message: `Order is already in database`,
          });
        } else {
          logger.warn(`Failed to insert arbitrary order into database: ${e}`);
          logger.debug(`Requested order: ${orderJson}`);
          reply.status(400).send({
            message: `Request failed: ${e}`,
          });
        }
      }
    },
  );
};

const arbitraryOrderRoute = async (server: FastifyWithZod) => {
  orderRoute(server);
};

export { arbitraryOrderRoute };
