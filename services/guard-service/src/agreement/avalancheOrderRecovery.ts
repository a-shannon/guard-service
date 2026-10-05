import { IsNull, Not } from '@rosen-bridge/extended-typeorm';
import { TransactionType } from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';

import Configs from '../configs/configs';
import { DatabaseAction } from '../db/databaseAction';
import { ArbitraryEntity } from '../db/entities/arbitraryEntity';
import { TransactionEntity } from '../db/entities/transactionEntity';
import ChainHandler from '../handlers/chainHandler';
import GuardPkHandler from '../handlers/guardPkHandler';
import { TokenHandler } from '../handlers/tokenHandler';
import { getPreparedAvalancheInputs } from '../jobs/initScanner';
import type { TransactionSigningContext } from '../signing/transactionSigningContext';
import { OrderStatus, TransactionStatus } from '../utils/constants';

/** Captures every persisted transaction field, reducing relations to their IDs. */
const rowIdentity = (row: TransactionEntity): string =>
  JSON.stringify({
    txId: row.txId,
    txJson: row.txJson,
    chain: row.chain,
    type: row.type,
    status: row.status,
    requiredSign: row.requiredSign,
    event: row.event?.id ?? null,
    order: row.order?.id ?? null,
    lastCheck: row.lastCheck,
    lastStatusUpdate: row.lastStatusUpdate ?? null,
    failedInSign: row.failedInSign,
    signFailedCount: row.signFailedCount,
  });

/** Captures the order fields whose pending phase was interrupted by approval persistence. */
const orderIdentity = (order: ArbitraryEntity): string =>
  JSON.stringify([
    order.id,
    order.chain,
    order.orderJson,
    order.status,
    order.firstTry ?? null,
    order.unexpectedFails,
  ]);

/** Encodes synchronous startup policy and token amounts without bigint coercion. */
const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? { bigint: item.toString() } : item,
  );

/**
 * Repairs an interrupted Avalanche approval before the periodic processor starts any effect.
 * @param input selected active transaction with its loaded order relation
 * @param getContext current processor-owned signing context resolver
 * @returns the unchanged transaction with its recovered order phase
 */
export const recoverAvalancheApprovedOrder = async (
  input: TransactionEntity,
  getContext: () => TransactionSigningContext,
): Promise<TransactionEntity> => {
  if (
    input.chain !== 'avalanche' ||
    input.type !== TransactionType.arbitrary ||
    input.order?.status !== OrderStatus.pending
  )
    return input;
  const row = {
    ...input,
    event: input.event ? { ...input.event } : null,
    order: { ...input.order },
  };
  const expected = rowIdentity(row);
  const order = { ...row.order! };
  const expectedOrder = orderIdentity(order);
  const statuses = [
    TransactionStatus.approved,
    TransactionStatus.inSign,
    TransactionStatus.signFailed,
    TransactionStatus.signed,
    TransactionStatus.sent,
  ];
  const database = DatabaseAction.getInstance();
  const source = database.dataSource;
  const context = getContext();
  const handler = ChainHandler.getInstance();
  const chain = handler.getChain('avalanche');
  if (!(chain instanceof AvalancheChain))
    throw new Error('Avalanche order recovery adapter is unavailable');
  const tokenHandler = TokenHandler.getInstance();
  const tokens = tokenHandler.getTokenMap();
  const network = chain.network;
  const readers = [
    GuardPkHandler.getInstance,
    ChainHandler.getInstance,
    TokenHandler.getInstance,
    tokenHandler.getTokenMap,
    handler.getChain,
    getPreparedAvalancheInputs,
    chain.getChainConfigs,
    chain.verifyTransactionExtraConditions,
    chain.extractTransactionOrder,
    chain.PaymentTransactionFromJson,
    tokens.getRawConfig,
    tokens.wrapAmount,
    tokens.unwrapAmount,
  ];
  /** Reads only synchronous policy ports while SQL is owned by the recovery manager. */
  const policyIdentity = () => {
    const prepared = getPreparedAvalancheInputs();
    if (
      !prepared ||
      prepared.config.enabled !== true ||
      prepared.config.routes.arbitrary !== true ||
      Configs.isArbitraryOrderRequestActive !== true ||
      prepared.config.chainId !== Number(chain.CHAIN_ID) ||
      ChainHandler.getInstance() !== handler ||
      handler.getChain('avalanche') !== chain ||
      TokenHandler.getInstance() !== tokenHandler ||
      tokenHandler.getTokenMap() !== tokens ||
      chain.network !== network ||
      readers.some(
        (reader, i) =>
          reader !==
          [
            GuardPkHandler.getInstance,
            ChainHandler.getInstance,
            TokenHandler.getInstance,
            tokenHandler.getTokenMap,
            handler.getChain,
            getPreparedAvalancheInputs,
            chain.getChainConfigs,
            chain.verifyTransactionExtraConditions,
            chain.extractTransactionOrder,
            chain.PaymentTransactionFromJson,
            tokens.getRawConfig,
            tokens.wrapAmount,
            tokens.unwrapAmount,
          ][i],
      )
    )
      throw new Error('Avalanche order recovery policy resolver changed');
    return encode([
      prepared,
      chain.getChainConfigs(),
      tokens.getRawConfig(),
      chain.CHAIN_ID,
      Configs.isArbitraryOrderRequestActive,
    ]);
  };
  const policy = policyIdentity();
  /** Captures current quorum and guard keys, rejecting a persisted quorum mismatch. */
  const guardIdentity = () => {
    const guards = GuardPkHandler.getInstance();
    if (
      !Number.isSafeInteger(guards.requiredSign) ||
      guards.requiredSign !== row.requiredSign ||
      !Number.isSafeInteger(guards.guardsLen) ||
      guards.guardsLen < guards.requiredSign
    )
      throw new Error('Avalanche order recovery quorum changed');
    return JSON.stringify([
      guards.publicKeys,
      guards.requiredSign,
      guards.guardsLen,
    ]);
  };
  const guards = guardIdentity();
  if (
    row.event !== null ||
    order.chain !== 'avalanche' ||
    !statuses.includes(row.status) ||
    !Number.isSafeInteger(row.lastCheck) ||
    row.lastCheck < 0 ||
    !Number.isSafeInteger(row.signFailedCount) ||
    row.signFailedCount < 0 ||
    typeof row.failedInSign !== 'boolean' ||
    (row.lastStatusUpdate != null && typeof row.lastStatusUpdate !== 'string')
  )
    throw new Error('Avalanche order recovery row is ineligible');
  const bound = await context.bind(row, statuses);
  /** Rechecks synchronous caller, database and guard authority without a foreign SQL runner. */
  const assertAuthority = () => {
    if (
      DatabaseAction.getInstance() !== database ||
      database.dataSource !== source ||
      getContext() !== context ||
      policyIdentity() !== policy ||
      guardIdentity() !== guards ||
      rowIdentity(input) !== expected ||
      orderIdentity(input.order!) !== expectedOrder
    )
      throw new Error('Avalanche order recovery authority changed');
  };
  const release = await database.txSignSemaphore.acquire();
  let result: TransactionEntity | undefined;
  try {
    await bound.withAction(async () => {
      assertAuthority();
      await source.transaction(async (manager) => {
        const rows = manager.getRepository(TransactionEntity);
        const orders = manager.getRepository(ArbitraryEntity);
        const predicate = {
          txId: row.txId,
          txJson: row.txJson,
          chain: row.chain,
          type: row.type,
          status: row.status,
          requiredSign: row.requiredSign,
          event: IsNull(),
          order: { id: order.id },
          lastCheck: row.lastCheck,
          lastStatusUpdate:
            row.lastStatusUpdate == null ? IsNull() : row.lastStatusUpdate,
          failedInSign: row.failedInSign,
          signFailedCount: row.signFailedCount,
        };
        const orderPredicate = {
          id: order.id,
          chain: order.chain,
          orderJson: order.orderJson,
          status: OrderStatus.pending,
          firstTry: order.firstTry == null ? IsNull() : order.firstTry,
          unexpectedFails: order.unexpectedFails,
        };
        // PostgreSQL UPDATE alone permits concurrent foreign-key owner inserts.
        if (source.options.type === 'postgres') {
          const locked = await orders.findOne({
            where: orderPredicate,
            lock: { mode: 'pessimistic_write' },
          });
          assertAuthority();
          if (!locked || orderIdentity(locked) !== expectedOrder)
            throw new Error('Avalanche order recovery ownership conflict');
        }
        // No-op CAS obtains database row ownership without changing check metadata.
        assertAuthority();
        const lockedOrder = await orders.update(orderPredicate, {
          status: OrderStatus.pending,
        });
        assertAuthority();
        if (lockedOrder.affected !== 1)
          throw new Error('Avalanche order recovery ownership conflict');
        const lockedRow = await rows.update(predicate, { status: row.status });
        assertAuthority();
        if (lockedRow.affected !== 1)
          throw new Error('Avalanche order recovery ownership conflict');
        /** Checks the exact transaction and sole active owner using only the owned manager. */
        const checkRows = async () => {
          const active = await rows.find({
            where: {
              order: { id: order.id },
              status: Not(TransactionStatus.invalid),
            },
            relations: ['event', 'order'],
          });
          assertAuthority();
          if (
            manager.connection !== source ||
            manager.queryRunner?.isTransactionActive !== true ||
            active.length !== 1 ||
            rowIdentity(active[0]) !== expected
          )
            throw new Error('Avalanche order recovery transaction conflict');
          return active[0];
        };
        await checkRows();
        const currentOrder = await orders.findOneBy({ id: order.id });
        assertAuthority();
        if (!currentOrder || orderIdentity(currentOrder) !== expectedOrder)
          throw new Error('Avalanche order recovery order changed');
        const payment = bound.payment();
        // The context verifies the native adapter, mapped envelope and actual extracted order.
        if (payment.toJson() !== row.txJson || payment.eventId !== order.id)
          throw new Error('Avalanche order recovery bytes or order changed');
        assertAuthority();
        if (
          (
            await orders.update(orderPredicate, {
              status: OrderStatus.inProcess,
            })
          ).affected !== 1
        )
          throw new Error('Avalanche order recovery phase conflict');
        assertAuthority();
        result = await checkRows();
        if (
          !result.order ||
          orderIdentity(result.order) !==
            orderIdentity({ ...order, status: OrderStatus.inProcess })
        )
          throw new Error('Avalanche order recovery afterimage changed');
        assertAuthority();
      });
    });
  } finally {
    release();
  }
  if (!result) throw new Error('Avalanche order recovery did not persist');
  return result;
};
