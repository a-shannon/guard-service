import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import { FastifyWithZod } from '@rosen-bridge/fastify-enhanced';

import BalanceHandler from '../handlers/balanceHandler';
import { AvalancheLockBalance, LockBalance } from '../types/api';
import {
  AvalancheLockBalanceSchema,
  BalanceQuerySchema,
  BalanceResponseSchema,
  MessageResponseSchema,
} from './schemas';

const logger = DefaultLogger.getInstance().child(import.meta.url);

/**
 * Gets the balance
 * @param server
 */
const getBalanceRoute = (server: FastifyWithZod) => {
  server.get(
    '/balance',
    {
      schema: {
        querystring: BalanceQuerySchema,
        response: {
          200: BalanceResponseSchema,
          500: MessageResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { offset, limit, chain, tokenId } = request.query;

      try {
        if (chain === 'avalanche') {
          const balance: AvalancheLockBalance =
            await BalanceHandler.getInstance().getAvalancheBalances(
              tokenId,
              offset,
              limit,
            );
          return reply
            .status(200)
            .send(AvalancheLockBalanceSchema.parse(balance));
        }
        const balance: LockBalance = {
          hot: { items: [], total: 0 },
          cold: { items: [], total: 0 },
        };

        balance.hot = await BalanceHandler.getInstance().getAddressAssets(
          'lock',
          chain,
          tokenId,
          offset,
          limit,
        );
        balance.cold = await BalanceHandler.getInstance().getAddressAssets(
          'cold',
          chain,
          tokenId,
          offset,
          limit,
        );

        reply.status(200).send(balance);
      } catch (error) {
        logger.error(`An error occurred while fetching balance: ${error}`);
        if (error.stack) logger.error(error.stack);
        reply.status(500).send({ message: error.message });
      }
    },
  );
};

const balanceRoutes = async (server: FastifyWithZod) => {
  getBalanceRoute(server);
};

export { balanceRoutes };
