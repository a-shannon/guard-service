import { Transaction } from 'ethers';

import type { EntityManager } from '@rosen-bridge/extended-typeorm';
import {
  ChainUtils,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import {
  AVALANCHE_TX_EXTRACTOR,
  AvalancheRpcNetwork,
} from '@rosen-chains/avalanche-rpc';

import type { DatabaseAction } from '../db/databaseAction';
import { ArbitraryEntity } from '../db/entities/arbitraryEntity';
import { TransactionEntity } from '../db/entities/transactionEntity';
import type {
  SigningRowPreimage,
  SigningPersistenceAuthorization,
  SigningPersistencePurpose,
} from '../signing/transactionSigningContext';
import type { AvalancheManagementDependencies } from './avalancheManagementAuthorization';

/** Compares exact policy and row primitives without losing bigint amounts. */
const encode = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? { bigint: item.toString() } : item,
  );
/** Projects a loaded entity onto the eight fields owned by signing persistence. */
const projection = (row: TransactionEntity): SigningRowPreimage => ({
  txId: row.txId,
  txJson: row.txJson,
  chain: row.chain,
  type: row.type,
  status: row.status,
  requiredSign: row.requiredSign,
  eventId: row.event?.id ?? null,
  orderId: row.order?.id ?? null,
});

/** Builds RPC-free checks for the Guard's owned queue, result or failure SQL transition. */
export const prepareAvalancheManagementSigningPersistence = (
  ports: AvalancheManagementDependencies & { getDatabase(): DatabaseAction },
  input: SigningRowPreimage,
  purpose: SigningPersistencePurpose,
  signedJson?: string,
): Omit<SigningPersistenceAuthorization, 'assertActive'> => {
  const expected = Object.freeze({ ...input });
  const payment = ports.decode(expected.txJson);
  const intent = Object.freeze({
    network: payment.network,
    txId: payment.txId,
    eventId: payment.eventId,
    txType: payment.txType,
    txBytes: Buffer.from(payment.txBytes).toString('hex'),
  });
  const original = Transaction.from('0x' + intent.txBytes);
  const arbitrary = expected.type === TransactionType.arbitrary;
  const route =
    expected.type === TransactionType.coldStorage
      ? 'cold'
      : expected.type === TransactionType.manual
        ? 'manual'
        : arbitrary
          ? 'arbitrary'
          : undefined;
  if (
    !route ||
    expected.chain !== 'avalanche' ||
    expected.eventId !== null ||
    (arbitrary
      ? expected.orderId !== payment.eventId
      : expected.orderId !== null || payment.eventId !== '') ||
    !['queue', 'result', 'failure'].includes(purpose) ||
    original.isSigned() ||
    (purpose === 'queue'
      ? !['approved', 'sign-failed'].includes(expected.status)
      : expected.status !== 'in-sign')
  )
    throw new Error('Invalid native management signing persistence');
  const chain = ports.getChain();
  if (!(chain instanceof AvalancheChain))
    throw new Error('Native management chain is unavailable');
  const network = chain.network;
  if (!(network instanceof AvalancheRpcNetwork))
    throw new Error('Native management network is unavailable');
  const chainId = chain.CHAIN_ID;
  const nativeOrder = encode(chain.extractTransactionOrder(payment));
  const database = ports.getDatabase();
  const source = database.dataSource;
  const policy = structuredClone(ports.getPolicy(intent));
  const configs = encode(chain.getChainConfigs());
  const readers = Object.freeze({
    policy: ports.getPolicy,
    chain: ports.getChain,
    tokens: ports.assertTokenMapUnchanged,
    decode: ports.decode,
    database: ports.getDatabase,
    envelope: chain.verifyTransactionExtraConditions,
    configs: chain.getChainConfigs,
    order: chain.extractTransactionOrder,
  });
  /** Rechecks synchronous policy and adapter authority after every manager await. */
  const assertStatic = () => {
    if (
      ports.getPolicy !== readers.policy ||
      ports.getChain !== readers.chain ||
      ports.assertTokenMapUnchanged !== readers.tokens ||
      ports.decode !== readers.decode ||
      ports.getDatabase !== readers.database ||
      readers.database() !== database ||
      database.dataSource !== source
    )
      throw new Error('Native management persistence resolver changed');
    readers.tokens();
    const current = readers.policy(intent);
    if (
      !policy ||
      policy.config.routes[route] !== true ||
      policy.config.enabled !== true ||
      (route === 'manual' && policy.manualRequests !== true) ||
      (route === 'arbitrary' && policy.arbitraryRequests !== true) ||
      !Number.isSafeInteger(policy.guardsCount) ||
      expected.requiredSign > policy.guardsCount ||
      expected.requiredSign < 1 ||
      !Number.isSafeInteger(expected.requiredSign) ||
      chain.CHAIN !== 'avalanche' ||
      chain.NATIVE_TOKEN_ID !== 'avax' ||
      chain.CHAIN_ID !== chainId ||
      original.chainId !== chainId ||
      (chainId !== 43113n && chainId !== 43114n) ||
      chain.network !== network ||
      network.expectedChainId !== chainId ||
      network.extractorId !== AVALANCHE_TX_EXTRACTOR ||
      chain.getChainConfigs !== readers.configs ||
      chain.extractTransactionOrder !== readers.order ||
      readers.chain() !== chain ||
      encode(current) !== encode(policy) ||
      encode(chain.getChainConfigs()) !== configs ||
      chain.verifyTransactionExtraConditions !== readers.envelope
    )
      throw new Error(
        'Native management signing persistence authority changed',
      );
  };
  assertStatic();
  let started = false,
    finished = false;
  let owner: EntityManager | undefined;
  let orderSnapshot: string | undefined;
  const afterStatus =
    purpose === 'queue'
      ? 'in-sign'
      : purpose === 'result'
        ? 'signed'
        : 'sign-failed';
  const afterJson = purpose === 'result' ? signedJson : expected.txJson;
  if (!afterJson) throw new Error('Native management signed result is missing');
  if (purpose === 'result') {
    const signed = ports.decode(afterJson);
    const tx = Transaction.from(
      '0x' + Buffer.from(signed.txBytes).toString('hex'),
    );
    if (
      !tx.isSigned() ||
      tx.unsignedSerialized !== original.unsignedSerialized ||
      tx.from?.toLowerCase() !==
        chain.getChainConfigs().addresses.lock.toLowerCase() ||
      signed.network !== payment.network ||
      signed.txId !== payment.txId ||
      signed.eventId !== payment.eventId ||
      signed.txType !== payment.txType ||
      !readers.envelope(signed, SigningStatus.Signed)
    )
      throw new Error('Invalid native management persisted result');
  }
  /** Requires the exact row from this DAO-owned manager, not an outer resolver. */
  const checkRow = async (manager: EntityManager, row: SigningRowPreimage) => {
    /** Requires the captured database and an active rollback-capable transaction. */
    const assertManager = () => {
      assertStatic();
      if (
        manager.connection !== source ||
        manager.queryRunner?.isTransactionActive !== true
      )
        throw new Error(
          'Native management signing requires its owned active SQL manager',
        );
    };
    assertManager();
    const current = await manager.getRepository(TransactionEntity).findOne({
      where: { txId: expected.txId },
      relations: ['event', 'order'],
    });
    assertManager();
    if (!current || encode(projection(current)) !== encode(row))
      throw new Error('Native management signing persistence row changed');
    if (arbitrary) {
      const order = await manager
        .getRepository(ArbitraryEntity)
        .findOneBy({ id: expected.orderId! });
      assertManager();
      if (
        !order ||
        order.chain !== 'avalanche' ||
        !['pending', 'in-process'].includes(order.status)
      )
        throw new Error('Native management persistence order is ineligible');
      if (encode(ChainUtils.decodeOrder(order.orderJson)) !== nativeOrder)
        throw new Error(
          'Native management persistence order differs from native outputs',
        );
      const snapshot = encode(order);
      if (orderSnapshot === undefined) orderSnapshot = snapshot;
      else if (snapshot !== orderSnapshot)
        throw new Error('Native management persistence order changed');
    }
  };
  const checks: Omit<SigningPersistenceAuthorization, 'assertActive'> = {
    /** Admits exactly one unchanged beforeimage on the captured database. */
    assertBefore: async (manager, row) => {
      if (started || finished || encode(row) !== encode(expected))
        throw new Error('Native management persistence beforeimage changed');
      started = true;
      owner = manager;
      await checkRow(manager, row);
    },
    /** Requires the matching afterimage and unchanged order before SQL commit. */
    assertAfter: async (manager, row) => {
      if (
        !started ||
        finished ||
        manager !== owner ||
        encode(row) !==
          encode({ ...expected, status: afterStatus, txJson: afterJson })
      )
        throw new Error('Native management persistence afterimage changed');
      finished = true;
      await checkRow(manager, row);
    },
  };
  return Object.freeze(checks);
};
