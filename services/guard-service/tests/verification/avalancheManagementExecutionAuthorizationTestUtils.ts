import { SigningKey, Transaction } from 'ethers';

import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { TransactionType } from '@rosen-chains/abstract-chain';
import { AVALANCHE_TX_EXTRACTOR } from '@rosen-chains/avalanche-rpc';
import { EvmTxStatus } from '@rosen-chains/evm';

import type { TransactionCheckPreimage } from '../../src/db/databaseAction';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import type { SigningRowPreimage } from '../../src/signing/transactionSigningContext';
import {
  AvalancheManagementAuthorization,
  AvalancheManagementDependencies,
} from '../../src/verification/avalancheManagementAuthorization';
import { AvalancheManagementExecutionAuthorization } from '../../src/verification/avalancheManagementExecutionAuthorization';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { createManagementAuthorizationFixture } from './avalancheManagementAuthorizationTestUtils';

/**
 * Creates real SQLite transaction, order and scanner fixtures with actual Avalanche adapters.
 * Provider responses and business policy reads are synthetic; no live network or signing service is used.
 * @param type native management transaction route
 * @param unsigned whether the stored payment is an unsigned sign-failed candidate
 */
export const createManagementExecutionFixture = async (
  type = TransactionType.coldStorage,
  unsigned = false,
  token = false,
) => {
  const base = await createManagementAuthorizationFixture(type, token);
  const database = DatabaseActionMock.testDatabase;
  await DatabaseActionMock.clearTables();
  await database.dataSource.getRepository(AddressTxsEntity).clear();
  vi.spyOn(base.network, 'getTransactionStatus').mockResolvedValue(
    EvmTxStatus.notFound,
  );
  if (!unsigned) base.sign();
  const status = unsigned ? 'sign-failed' : 'signed';
  if (type === TransactionType.arbitrary) {
    await database.insertNewOrder(
      base.order.id,
      base.order.chain,
      base.order.orderJson,
    );
    await database.ArbitraryRepository.update(
      { id: base.order.id },
      { status: 'in-process' },
    );
  }
  await DatabaseActionMock.insertTxRecord(
    base.payment(),
    status,
    12,
    '100',
    false,
    2,
    2,
  );
  /** Twelve-field row preimage with fixed check metadata and optional arbitrary-order ownership. */
  const expected: {
    -readonly [K in keyof TransactionCheckPreimage]: TransactionCheckPreimage[K];
  } = {
    txId: base.tx.unsignedHash,
    txJson: base.payment().toJson(),
    chain: 'avalanche',
    type,
    status,
    eventId: null,
    orderId: type === TransactionType.arbitrary ? base.order.id : null,
    requiredSign: 2,
    lastCheck: 12,
    lastStatusUpdate: '100',
    failedInSign: false,
    signFailedCount: 2,
  };
  const policy: AvalancheManagementDependencies = {
    getPolicy: base.getPolicy,
    getChain: () => base.chain,
    decode: (json) => base.chain.PaymentTransactionFromJson(json),
    getTx: (id) => database.getTxById(id),
    getOrder: (id) => database.getOrderById(id),
    getOrderTxIds: async (id) =>
      (await database.getOrderValidTxs(id)).map((row) => row.txId),
    getColdState: base.getColdState,
    assertTokenMapUnchanged: base.unchanged,
  };
  const management = new AvalancheManagementAuthorization(policy);
  /** Returns the fixture-owned database without changing its identity. */
  const getDatabase = () => database;
  const authorization = new AvalancheManagementExecutionAuthorization({
    getDatabase,
    management,
    policy,
  });
  /** Copies the eight signing fields from the current expected SQL row. */
  const preimage = (): SigningRowPreimage => {
    return {
      txId: expected.txId,
      txJson: expected.txJson,
      chain: expected.chain,
      type: expected.type,
      status: expected.status,
      requiredSign: expected.requiredSign,
      eventId: expected.eventId,
      orderId: expected.orderId,
    };
  };
  /** Keeps the expected preimage and persisted transaction status aligned. */
  const updateStatus = async (status: string) => {
    expected.status = status;
    await database.TransactionRepository.update(
      { txId: expected.txId },
      { status },
    );
  };
  /** Creates deterministic own or foreign signed execution, provider spies and matching scanner records. */
  const observe = async (
    mode: 'own' | 'foreign' = 'own',
    status = EvmTxStatus.succeed,
    wrongKey = false,
  ) => {
    const signed = Transaction.from(base.tx.unsignedSerialized);
    if (mode === 'foreign') signed.value += 1n;
    signed.signature = new SigningKey(
      '0x' + (wrongKey ? '22' : '11').repeat(32),
    ).sign(signed.unsignedHash);
    /** Synthetic execution block containing the observed signed transaction. */
    const block = {
      hash: '0x' + '61'.repeat(32),
      number: 10,
      parentHash: '0x' + '60'.repeat(32),
      transactions: [signed.hash!],
    };
    /** Synthetic finalized frontier beyond every route confirmation requirement. */
    const frontier = {
      ...block,
      hash: '0x' + '63'.repeat(32),
      number: 100,
      parentHash: '0x' + '62'.repeat(32),
    };
    /** Provider transaction response with execution-block linkage and exact signed bytes. */
    const tx = {
      ...signed.toJSON(),
      chainId: signed.chainId,
      signature: signed.signature,
      hash: signed.hash!,
      from: signed.from!,
      blockHash: block.hash,
      blockNumber: block.number,
      index: 0,
    };
    /** Provider receipt tied to the execution block with the selected success or failure status. */
    const receipt = {
      hash: signed.hash!,
      blockHash: block.hash,
      blockNumber: block.number,
      index: 0,
      status: status === EvmTxStatus.succeed ? 1 : 0,
      from: signed.from!,
      to: signed.to!,
      logs: token
        ? [
            {
              address: signed.to!.toLowerCase(),
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x' + signed.from!.slice(2).toLowerCase().padStart(64, '0'),
                '0x' +
                  base.chain
                    .extractTransactionOrder(base.payment())[0]
                    .address.slice(2)
                    .toLowerCase()
                    .padStart(64, '0'),
              ],
              data:
                '0x' + (750000n * 1000000000n).toString(16).padStart(64, '0'),
              transactionHash: signed.hash!,
              blockHash: block.hash,
              blockNumber: block.number,
              transactionIndex: 0,
              index: 0,
              removed: false,
            },
          ]
        : [],
    };
    const rpc = base.network['provider'];
    const send = vi.spyOn(rpc, 'send').mockImplementation(async (method) => {
      if (method === 'eth_chainId')
        return '0x' + base.chain.CHAIN_ID.toString(16);
      throw new Error('Unexpected management observation RPC');
    });
    const blocks = vi.spyOn(rpc, 'getBlock').mockImplementation(async (tag) => {
      if (tag === 'finalized' || tag === frontier.number)
        return frontier as never;
      if (tag === block.hash || tag === block.number) return block as never;
      throw new Error('Unexpected management observation block');
    });
    const transactions = vi
      .spyOn(rpc, 'getTransaction')
      .mockImplementation(async (id) => {
        if (id !== signed.hash)
          throw new Error('Unsigned identity was used as a signed RPC hash');
        return tx as never;
      });
    const receipts = vi
      .spyOn(rpc, 'getTransactionReceipt')
      .mockResolvedValue(receipt as never);
    const ownStatus = vi
      .spyOn(base.network, 'getTransactionStatus')
      .mockResolvedValue(EvmTxStatus.notFound);
    const record = await database.dataSource
      .getRepository(AddressTxsEntity)
      .save({
        unsignedHash: signed.unsignedHash,
        signedHash: signed.hash!,
        nonce: signed.nonce,
        address: base.chain.getChainConfigs().addresses.lock.toLowerCase(),
        blockId: block.hash,
        extractor: AVALANCHE_TX_EXTRACTOR,
        status,
      });
    await database.dataSource.getRepository(BlockEntity).insert({
      scanner: 'avalanche',
      height: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      status: PROCEED,
      timestamp: 1000,
    });
    return {
      signed,
      block,
      frontier,
      tx,
      receipt,
      rpc,
      record,
      send,
      blocks,
      transactions,
      receipts,
      ownStatus,
    };
  };
  return {
    ...base,
    database,
    policy,
    management,
    authorization,
    expected,
    preimage,
    updateStatus,
    observe,
    /** Reloads the fixture transaction and its event/order relations from SQLite. */
    current: async () =>
      database.dataSource.getRepository(TransactionEntity).findOneOrFail({
        where: { txId: expected.txId },
        relations: ['event', 'order'],
      }),
  };
};

/** Each case changes one successful receipt Transfer predicate. */
export const managementTransferFaults = [
  'missing',
  'amount',
  'sender',
  'recipient',
  'token',
  'removed',
  'duplicate',
  'transaction',
  'block',
] as const;

/** Corrupts only the chosen field in the synthetic provider receipt, before a fresh immutable read. */
export const corruptManagementTransfer = (
  seen: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof createManagementExecutionFixture>>['observe']
    >
  >,
  fault: (typeof managementTransferFaults)[number],
) => {
  const log = seen.receipt.logs[0];
  if (fault === 'missing') seen.receipt.logs = [];
  if (fault === 'amount')
    log.data =
      '0x' + (750000n * 1000000000n + 1n).toString(16).padStart(64, '0');
  if (fault === 'sender')
    log.topics[1] = '0x' + '00'.repeat(12) + '78'.repeat(20);
  if (fault === 'recipient')
    log.topics[2] = '0x' + '00'.repeat(12) + '78'.repeat(20);
  if (fault === 'token') log.address = '0x' + '78'.repeat(20);
  if (fault === 'removed') log.removed = true;
  if (fault === 'duplicate')
    seen.receipt.logs.push({ ...log, topics: [...log.topics], index: 1 });
  if (fault === 'transaction') log.transactionHash = '0x' + '78'.repeat(32);
  if (fault === 'block') log.blockHash = '0x' + '78'.repeat(32);
};
