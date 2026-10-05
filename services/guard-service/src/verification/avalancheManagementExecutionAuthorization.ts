import { Transaction } from 'ethers';

import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { EntityManager } from '@rosen-bridge/extended-typeorm';
import JsonBigInt from '@rosen-bridge/json-bigint';
import { SigningStatus, TransactionType } from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import {
  AVALANCHE_TX_EXTRACTOR,
  AvalancheRpcNetwork,
  type SettledAvalancheTransactionReceiptEvidence,
} from '@rosen-chains/avalanche-rpc';
import { EvmTxStatus } from '@rosen-chains/evm';

import { DatabaseAction, TransactionCheckPreimage } from '../db/databaseAction';
import { ArbitraryEntity } from '../db/entities/arbitraryEntity';
import { TransactionEntity } from '../db/entities/transactionEntity';
import { SigningRowPreimage } from '../signing/transactionSigningContext';
import { OrderStatus, TransactionStatus } from '../utils/constants';
import {
  AvalancheManagementAuthorization,
  AvalancheManagementDependencies,
} from './avalancheManagementAuthorization';
import type { BoundPaymentRecovery } from './paymentRecoveryAuthorization';
import type {
  BoundPaymentInvalidation,
  BoundPaymentSubmission,
  PaymentSubmissionPurpose,
} from './paymentSubmissionAuthorization';

interface Dependencies {
  getDatabase(): DatabaseAction;
  management: AvalancheManagementAuthorization;
  policy: AvalancheManagementDependencies;
}
type Purpose = PaymentSubmissionPurpose | 'recovery' | 'invalidation';
/** Serializes captured values with bigint support for exact identity comparisons. */
const fingerprint = (value: unknown): string => JsonBigInt.stringify(value);
/** Converts transaction bytes to their canonical hexadecimal representation. */
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
/** Checks the persisted non-negative decimal timestamp representation. */
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);
/** Checks that status-check metadata has the required scalar types and bounds. */
const checkPreimage = (
  value: SigningRowPreimage,
): value is TransactionCheckPreimage =>
  'lastCheck' in value &&
  Number.isSafeInteger(value.lastCheck) &&
  Number(value.lastCheck) >= 0 &&
  'lastStatusUpdate' in value &&
  (value.lastStatusUpdate === null ||
    typeof value.lastStatusUpdate === 'string') &&
  'failedInSign' in value &&
  typeof value.failedInSign === 'boolean' &&
  'signFailedCount' in value &&
  Number.isSafeInteger(value.signFailedCount) &&
  Number(value.signFailedCount) >= 0;
/** Snapshots the SQL transaction row and its event and order identities. */
const rowPreimage = (row: TransactionEntity): TransactionCheckPreimage => ({
  txId: row.txId,
  txJson: row.txJson,
  chain: row.chain,
  type: row.type,
  status: row.status,
  requiredSign: row.requiredSign,
  eventId: row.event?.id ?? null,
  orderId: row.order?.id ?? null,
  lastCheck: row.lastCheck,
  lastStatusUpdate: row.lastStatusUpdate ?? null,
  failedInSign: row.failedInSign,
  signFailedCount: row.signFailedCount,
});
/** Selects the signing fields shared by transaction preimages. */
const signingPreimage = (row: SigningRowPreimage): SigningRowPreimage => ({
  txId: row.txId,
  txJson: row.txJson,
  chain: row.chain,
  type: row.type,
  status: row.status,
  requiredSign: row.requiredSign,
  eventId: row.eventId,
  orderId: row.orderId,
});
/** Selects signing fields and status-check metadata for exact comparison. */
const checkedPreimage = (
  row: TransactionCheckPreimage,
): TransactionCheckPreimage => ({
  ...signingPreimage(row),
  lastCheck: row.lastCheck,
  lastStatusUpdate: row.lastStatusUpdate,
  failedInSign: row.failedInSign,
  signFailedCount: row.signFailedCount,
});

/** Qualifies native management execution independently of a consumed balance trigger. */
export class AvalancheManagementExecutionAuthorization {
  /** Captures the database, management authorization and policy ports used by each binding. */
  constructor(private readonly dependencies: Dependencies) {}

  /** Binds single-use native submission or completion authority to the captured row and scanner lease. */
  bind = async (
    input: SigningRowPreimage,
    purpose: PaymentSubmissionPurpose,
  ): Promise<BoundPaymentSubmission> => {
    if (purpose !== 'submission' && purpose !== 'completion')
      throw new Error('Invalid management submission purpose');
    const bound = await this.capture(input, purpose);
    let prepared = false;
    return Object.freeze({
      kind: bound.kind,
      purpose,
      identity: bound.identity,
      payment: bound.payment,
      prepareUnderScannerLease: async (assertActive: () => void) => {
        if (prepared) throw new Error('Management preparation is single use');
        prepared = true;
        const proof = await bound.prepare(assertActive);
        let used = false,
          started = false;
        return Object.freeze({
          authorize: async (start: () => void) => {
            if (
              bound.kind !== 'ready' ||
              purpose !== 'submission' ||
              used ||
              typeof start !== 'function'
            )
              throw new Error('Management transport is not authorized');
            used = true;
            proof.active();
            await bound.management.checkUnderScannerLease('submission');
            proof.active();
            await bound.database.dataSource.transaction(async (manager) => {
              await bound.checkSql(manager, 'before', input, proof.active);
              proof.active();
              start();
              started = true;
              proof.active();
            });
          },
          assertBefore: async (
            manager: EntityManager,
            row: SigningRowPreimage,
          ) => {
            if (bound.kind === 'ready' && !started)
              throw new Error('Management transport has not started');
            await bound.checkSql(manager, 'before', row, proof.active);
          },
          assertAfter: async (
            manager: EntityManager,
            row: SigningRowPreimage,
          ) => {
            if (bound.kind === 'ready' && !started)
              throw new Error('Management transport has not started');
            await bound.checkSql(manager, 'after', row, proof.active);
          },
        });
      },
    });
  };

  /** Binds recovery of exact observed signed bytes to the checked SQL row and scanner lease. */
  bindRecovery = async (
    input: TransactionCheckPreimage,
  ): Promise<BoundPaymentRecovery> => {
    const bound = await this.capture(input, 'recovery');
    let prepared = false;
    return Object.freeze({
      purpose: 'recovery' as const,
      identity: bound.identity,
      prepareUnderScannerLease: async (assertActive: () => void) => {
        if (prepared)
          throw new Error('Management recovery preparation is single use');
        prepared = true;
        const proof = await bound.prepare(assertActive);
        if (!proof.signedJson)
          throw new Error('Missing management signed execution');
        const signedJson = proof.signedJson;
        return Object.freeze({
          signedJson,
          assertBefore: async (
            manager: EntityManager,
            row: TransactionCheckPreimage,
          ) => bound.checkSql(manager, 'before', row, proof.active),
          assertAfter: async (
            manager: EntityManager,
            row: TransactionCheckPreimage,
          ) => bound.checkSql(manager, 'after', row, proof.active, signedJson),
        });
      },
    });
  };

  /** Binds settled failure or foreign-nonce invalidation to the checked row and order transition. */
  bindInvalidation = async (
    input: TransactionCheckPreimage,
  ): Promise<BoundPaymentInvalidation> => {
    const bound = await this.capture(input, 'invalidation');
    let prepared = false;
    return Object.freeze({
      purpose: 'invalidation' as const,
      identity: bound.identity,
      payment: bound.payment,
      prepareUnderScannerLease: async (assertActive: () => void) => {
        if (prepared)
          throw new Error('Management invalidation preparation is single use');
        prepared = true;
        const proof = await bound.prepare(assertActive);
        if (!proof.invalidation)
          throw new Error('Missing management invalidation proof');
        const invalidation = proof.invalidation;
        return Object.freeze({
          ...invalidation,
          assertBefore: async (
            manager: EntityManager,
            row: TransactionCheckPreimage,
          ) => bound.checkSql(manager, 'before', row, proof.active),
          assertAfter: async (
            manager: EntityManager,
            row: TransactionCheckPreimage,
            transition: { unexpected: boolean },
          ) => {
            if (transition?.unexpected !== invalidation.unexpected)
              throw new Error('Management invalidation result changed');
            await bound.checkSql(
              manager,
              'after',
              row,
              proof.active,
              undefined,
              invalidation.unexpected,
            );
          },
        });
      },
    });
  };

  /** Captures row, policy, adapter and settled-execution identities and checks their SQL transitions. */
  private capture = async (
    input: SigningRowPreimage | TransactionCheckPreimage,
    purpose: Purpose,
  ) => {
    const expected = Object.freeze({ ...input });
    const originalInput = fingerprint(input);
    const checked = purpose === 'recovery' || purpose === 'invalidation';
    const arbitrary = expected.type === TransactionType.arbitrary;
    if (
      expected.chain !== 'avalanche' ||
      ![
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].includes(expected.type as TransactionType) ||
      expected.eventId !== null ||
      (arbitrary
        ? typeof expected.orderId !== 'string' ||
          !/^[0-9a-f]{64}$/.test(expected.orderId)
        : expected.orderId !== null) ||
      !Number.isSafeInteger(expected.requiredSign) ||
      expected.requiredSign < 1 ||
      (checked && !checkPreimage(expected)) ||
      !(
        purpose === 'recovery'
          ? [TransactionStatus.signFailed]
          : purpose === 'invalidation'
            ? [TransactionStatus.sent, TransactionStatus.signFailed]
            : purpose === 'completion'
              ? [TransactionStatus.sent]
              : [TransactionStatus.signed, TransactionStatus.sent]
      ).includes(expected.status)
    )
      throw new Error('Management execution row is not eligible');

    const ports = this.dependencies.policy;
    const portMethods = [
      ports.getPolicy,
      ports.getChain,
      ports.getTx,
      ports.decode,
      ports.getOrder,
      ports.getOrderTxIds,
      ports.getColdState,
      ports.assertTokenMapUnchanged,
    ];
    const getDatabase = this.dependencies.getDatabase;
    const management = this.dependencies.management;
    const bind = management.bind;
    const database = getDatabase();
    const source = database.dataSource;
    const sqlMethods = [source.getRepository, source.transaction];
    const chain = ports.getChain();
    const network = chain.network;
    if (
      !(chain instanceof AvalancheChain) ||
      !(network instanceof AvalancheRpcNetwork) ||
      network.extractorId !== AVALANCHE_TX_EXTRACTOR
    )
      throw new Error('Management execution requires Avalanche adapters');
    const chainMethods = [
      chain.getChainConfigs,
      chain.extractTransactionOrder,
      chain.verifyTransactionExtraConditions,
      chain.getTxRequiredConfirmation,
    ];
    const verifyToken = chain.verifySettledTokenEvidence;
    const networkMethods = {
      evidence: network.getSettledTransactionEvidence,
      receipt: network.getSettledTransactionReceiptEvidence,
      block: network.getBlockInfo,
      status: network.getTransactionStatus,
    };
    const payment = ports.decode(expected.txJson);
    const raw = '0x' + hex(payment.txBytes);
    const own = Transaction.from(raw);
    const signingStatus = own.isSigned()
      ? SigningStatus.Signed
      : SigningStatus.UnSigned;
    if (
      (purpose === 'recovery'
        ? own.isSigned()
        : purpose !== 'invalidation' && !own.isSigned()) ||
      raw !== (own.isSigned() ? own.serialized : own.unsignedSerialized) ||
      payment.toJson() !== expected.txJson ||
      payment.network !== expected.chain ||
      payment.txId !== expected.txId ||
      payment.txType !== expected.type ||
      payment.eventId !== (expected.orderId ?? '') ||
      own.unsignedHash !== expected.txId ||
      !chain.verifyTransactionExtraConditions(payment, signingStatus)
    )
      throw new Error('Management execution model differs from its row');
    const intent = Object.freeze({
      network: payment.network,
      txId: payment.txId,
      eventId: payment.eventId,
      txType: payment.txType,
      txBytes: hex(payment.txBytes),
    });
    const policy = structuredClone(ports.getPolicy(intent));
    const config = fingerprint(chain.getChainConfigs());
    const policyFingerprint = fingerprint(policy);
    const modelFingerprint = fingerprint({ json: payment.toJson(), raw });
    const orderFingerprint = fingerprint(
      chain.extractTransactionOrder(payment),
    );
    const lock = chain.getChainConfigs().addresses.lock.toLowerCase();
    const selectedChain = chain.CHAIN_ID;
    const required = chain.getTxRequiredConfirmation(payment.txType);
    if (
      !Number.isSafeInteger(required) ||
      required < 1 ||
      own.chainId !== selectedChain ||
      (own.isSigned() && own.from?.toLowerCase() !== lock)
    )
      throw new Error('Invalid management execution policy');
    /** Rejects changes to captured input, dependency, adapter, policy and payment identities. */
    const assertCurrent = () => {
      ports.assertTokenMapUnchanged();
      if (
        fingerprint(input) !== originalInput ||
        this.dependencies.policy !== ports ||
        this.dependencies.management !== management ||
        this.dependencies.getDatabase !== getDatabase ||
        getDatabase() !== database ||
        database.dataSource !== source ||
        source.getRepository !== sqlMethods[0] ||
        source.transaction !== sqlMethods[1] ||
        management.bind !== bind ||
        [
          ports.getPolicy,
          ports.getChain,
          ports.getTx,
          ports.decode,
          ports.getOrder,
          ports.getOrderTxIds,
          ports.getColdState,
          ports.assertTokenMapUnchanged,
        ].some((method, i) => method !== portMethods[i]) ||
        ports.getChain() !== chain ||
        chain.network !== network ||
        chain.CHAIN_ID !== selectedChain ||
        network.expectedChainId !== selectedChain ||
        network.extractorId !== AVALANCHE_TX_EXTRACTOR ||
        [
          chain.getChainConfigs,
          chain.extractTransactionOrder,
          chain.verifyTransactionExtraConditions,
          chain.getTxRequiredConfirmation,
        ].some((method, i) => method !== chainMethods[i]) ||
        chain.verifySettledTokenEvidence !== verifyToken ||
        network.getSettledTransactionEvidence !== networkMethods.evidence ||
        network.getSettledTransactionReceiptEvidence !==
          networkMethods.receipt ||
        network.getBlockInfo !== networkMethods.block ||
        network.getTransactionStatus !== networkMethods.status ||
        fingerprint(chain.getChainConfigs()) !== config ||
        fingerprint(ports.getPolicy(intent)) !== policyFingerprint ||
        fingerprint({
          json: payment.toJson(),
          raw: '0x' + hex(payment.txBytes),
        }) !== modelFingerprint ||
        fingerprint(chain.extractTransactionOrder(payment)) !==
          orderFingerprint ||
        chain.getTxRequiredConfirmation(payment.txType) !== required
      )
        throw new Error('Management execution authority changed');
    };
    assertCurrent();
    const business = await bind(intent);
    const businessCheck = business.checkUnderScannerLease;
    const businessId = business.authorityId;
    assertCurrent();
    const addressPredicate = {
      nonce: own.nonce,
      address: lock,
      extractor: AVALANCHE_TX_EXTRACTOR,
    };
    const records = await source
      .getRepository(AddressTxsEntity)
      .findBy(addressPredicate);
    const recordsFingerprint = fingerprint(records);
    const record = records[0] ? structuredClone(records[0]) : undefined;
    if (
      records.length > 1 ||
      (record &&
        (!Number.isSafeInteger(record.id) ||
          record.id < 1 ||
          !/^0x[0-9a-f]{64}$/.test(record.signedHash) ||
          !/^0x[0-9a-f]{64}$/.test(record.unsignedHash) ||
          !/^0x[0-9a-f]{64}$/.test(record.blockId) ||
          record.address !== lock ||
          record.nonce !== own.nonce ||
          record.extractor !== AVALANCHE_TX_EXTRACTOR ||
          (purpose !== 'invalidation' &&
            (record.status !== EvmTxStatus.succeed ||
              record.unsignedHash !== expected.txId ||
              (own.isSigned() && record.signedHash !== own.hash)))))
    )
      throw new Error('Management execution scanner record is inconsistent');
    const kind = record ? ('observed' as const) : ('ready' as const);
    if (purpose !== 'submission' && !record)
      throw new Error('Management execution requires observed evidence');
    const blocks = record
      ? await source
          .getRepository(BlockEntity)
          .findBy({ scanner: 'avalanche', hash: record.blockId })
      : [];
    const block = blocks[0] ? structuredClone(blocks[0]) : undefined;
    if (
      record &&
      (blocks.length !== 1 ||
        !block ||
        block.status !== PROCEED ||
        !Number.isSafeInteger(block.height) ||
        block.height < 0 ||
        !/^0x[0-9a-f]{64}$/.test(block.parentHash))
    )
      throw new Error('Management execution block is not qualified');
    const entity = await source.getRepository(TransactionEntity).findOne({
      where: { txId: expected.txId },
      relations: ['event', 'order'],
    });
    if (!entity) throw new Error('Management execution row disappeared');
    const baseline = Object.freeze(rowPreimage(entity));
    const orderEntity = arbitrary
      ? await source
          .getRepository(ArbitraryEntity)
          .findOneBy({ id: expected.orderId! })
      : null;
    const order = orderEntity ? structuredClone(orderEntity) : null;
    if (
      arbitrary &&
      (!order ||
        order.status !== OrderStatus.inProcess ||
        order.chain !== 'avalanche')
    )
      throw new Error('Management execution order is not active');
    assertCurrent();
    /** Checks row, order and scanner evidence before or after an owned SQL transition. */
    const checkSql = async (
      manager: EntityManager,
      phase: 'before' | 'after',
      row: SigningRowPreimage,
      active: () => void,
      signedJson?: string,
      unexpected?: boolean,
    ) => {
      active();
      assertCurrent();
      if (
        manager.connection !== source ||
        !manager.queryRunner?.isTransactionActive
      )
        throw new Error(
          'Management SQL authorization requires its active transaction',
        );
      const after = phase === 'after';
      const status = !after
        ? expected.status
        : purpose === 'completion'
          ? TransactionStatus.completed
          : purpose === 'invalidation'
            ? TransactionStatus.invalid
            : TransactionStatus.sent;
      const expectedModel =
        after && purpose === 'recovery' ? signedJson : expected.txJson;
      if (typeof expectedModel !== 'string')
        throw new Error('Management afterimage has no signed model');
      const provided = { ...expected, status, txJson: expectedModel };
      if (checked && after && purpose === 'recovery') {
        if (!checkPreimage(row) || !timestamp(row.lastStatusUpdate))
          throw new Error('Management recovery afterimage is malformed');
        Object.assign(provided, { lastStatusUpdate: row.lastStatusUpdate });
      }
      if (fingerprint(row) !== fingerprint(provided))
        throw new Error('Management execution preimage changed');
      const current = await manager.getRepository(TransactionEntity).findOne({
        where: { txId: expected.txId },
        relations: ['event', 'order'],
      });
      const actual = current ? rowPreimage(current) : null;
      if (
        !actual ||
        fingerprint(signingPreimage(actual)) !==
          fingerprint(signingPreimage(provided)) ||
        (!after &&
          (fingerprint(actual) !== fingerprint(baseline) ||
            (checked &&
              fingerprint(actual) !==
                fingerprint(
                  checkedPreimage(expected as TransactionCheckPreimage),
                )))) ||
        (after &&
          (actual.lastCheck !== baseline.lastCheck ||
            actual.failedInSign !== baseline.failedInSign ||
            actual.signFailedCount !== baseline.signFailedCount ||
            !timestamp(actual.lastStatusUpdate) ||
            (purpose === 'recovery' &&
              actual.lastStatusUpdate !==
                (row as TransactionCheckPreimage).lastStatusUpdate)))
      )
        throw new Error('Management SQL row authority changed');
      if (arbitrary) {
        const currentOrder = await manager
          .getRepository(ArbitraryEntity)
          .findOneBy({ id: expected.orderId! });
        const expectedOrder =
          !after || (purpose !== 'completion' && purpose !== 'invalidation')
            ? order
            : {
                ...order,
                status:
                  purpose === 'completion'
                    ? OrderStatus.completed
                    : OrderStatus.pending,
                ...(purpose === 'invalidation'
                  ? {
                      unexpectedFails:
                        order!.unexpectedFails + (unexpected ? 1 : 0),
                    }
                  : {}),
              };
        const activeRows = (
          await manager.getRepository(TransactionEntity).find({
            where: { order: { id: expected.orderId! } },
            relations: ['event', 'order'],
          })
        ).filter(
          (value) =>
            value.status !== TransactionStatus.invalid ||
            (after && value.txId === expected.txId),
        );
        if (
          fingerprint(currentOrder) !== fingerprint(expectedOrder) ||
          activeRows.length !== 1 ||
          activeRows[0].txId !== expected.txId
        )
          throw new Error('Management SQL order authority changed');
      }
      if (
        fingerprint(
          await manager
            .getRepository(AddressTxsEntity)
            .findBy(addressPredicate),
        ) !== recordsFingerprint
      )
        throw new Error('Management scanner execution changed');
      if (block) {
        const currentBlocks = await manager
          .getRepository(BlockEntity)
          .findBy({ scanner: 'avalanche', height: block.height });
        if (
          currentBlocks.length !== 1 ||
          fingerprint(currentBlocks[0]) !== fingerprint(block)
        )
          throw new Error('Management scanner block changed');
      }
      active();
      assertCurrent();
    };
    await source.transaction((manager) =>
      checkSql(manager, 'before', input, assertCurrent),
    );
    /** Decodes a fresh payment and verifies its captured JSON and bytes. */
    const paymentCopy = () => {
      assertCurrent();
      const copy = ports.decode(expected.txJson);
      if (
        copy.toJson() !== expected.txJson ||
        hex(copy.txBytes) !== hex(payment.txBytes)
      )
        throw new Error('Management payment decoder changed');
      return copy;
    };
    /** Qualifies business and settled execution evidence under an active scanner lease. */
    const prepare = async (assertActive: () => void) => {
      /** Checks the lease and captured business authority before continuing. */
      const active = () => {
        assertActive();
        assertCurrent();
        if (
          business.checkUnderScannerLease !== businessCheck ||
          business.authorityId !== businessId
        )
          throw new Error('Management business authority changed');
      };
      active();
      await businessCheck('identity');
      active();
      let signedJson: string | undefined;
      let invalidation: { reason: string; unexpected: boolean } | undefined;
      if (kind === 'ready') {
        await businessCheck('submission');
        active();
      } else {
        /** Checks settled signed execution and scanner block identity against canonical evidence. */
        const qualify = async () => {
          const requiresTransfer =
            own.value === 0n && purpose !== 'invalidation';
          const read = requiresTransfer
            ? networkMethods.receipt
            : networkMethods.evidence;
          const returned = await read.call(
            network,
            record!.signedHash,
            record!.blockId,
          );
          const evidence = Object.freeze({ ...returned });
          const evidenceFingerprint = fingerprint(evidence);
          active();
          const observed = Transaction.from(evidence.signedBytes);
          if (
            !observed.isSigned() ||
            observed.serialized !== evidence.signedBytes ||
            observed.hash !== evidence.hash ||
            observed.unsignedHash !== evidence.unsignedHash ||
            observed.from?.toLowerCase() !== evidence.from ||
            observed.chainId !== evidence.chainId ||
            observed.nonce !== evidence.nonce ||
            evidence.hash !== record!.signedHash ||
            evidence.unsignedHash !== record!.unsignedHash ||
            evidence.status !== record!.status ||
            evidence.from !== lock ||
            evidence.chainId !== selectedChain ||
            evidence.nonce !== own.nonce ||
            evidence.blockHash !== block!.hash ||
            evidence.blockNumber !== block!.height ||
            !Number.isSafeInteger(evidence.index) ||
            evidence.index < 0 ||
            !Number.isSafeInteger(evidence.finalizedBlockNumber) ||
            evidence.finalizedBlockNumber < block!.height ||
            !/^0x[0-9a-f]{64}$/.test(evidence.finalizedBlockHash) ||
            !Number.isSafeInteger(evidence.confirmations) ||
            evidence.confirmations !==
              evidence.finalizedBlockNumber - block!.height + 1 ||
            evidence.confirmations < required ||
            ![EvmTxStatus.succeed, EvmTxStatus.failed].includes(evidence.status)
          )
            throw new Error('Management settled execution is inconsistent');
          const info = await networkMethods.block.call(network, block!.hash);
          const header = Object.freeze({
            hash: info.hash,
            height: info.height,
            parentHash: info.parentHash,
          });
          active();
          if (
            info.hash !== block!.hash ||
            info.height !== block!.height ||
            info.parentHash !== block!.parentHash
          )
            throw new Error('Management settled block differs from scanner');
          const same = observed.unsignedSerialized === own.unsignedSerialized;
          if (purpose === 'invalidation') {
            if (
              same &&
              (evidence.status !== EvmTxStatus.failed ||
                (own.isSigned() && observed.serialized !== own.serialized))
            )
              throw new Error(
                'Own management execution requires reconciliation',
              );
            if (!same && own.isSigned()) {
              const status = await networkMethods.status.call(
                network,
                own.hash!,
              );
              active();
              if (status !== EvmTxStatus.notFound)
                throw new Error(
                  'Own management observation contradicts foreign nonce',
                );
            }
          } else if (
            !same ||
            (own.isSigned() && observed.serialized !== own.serialized) ||
            evidence.status !== EvmTxStatus.succeed
          )
            throw new Error(
              'Management execution does not prove successful own bytes',
            );
          if (requiresTransfer) {
            const executed = paymentCopy();
            executed.txBytes = Buffer.from(
              evidence.signedBytes.slice(2),
              'hex',
            );
            if (
              !verifyToken.call(
                chain,
                executed,
                evidence as SettledAvalancheTransactionReceiptEvidence,
              )
            )
              throw new Error(
                'Management token execution lacks exact Transfer evidence',
              );
          }
          if (fingerprint(returned) !== evidenceFingerprint)
            throw new Error(
              'Management RPC evidence mutated during preparation',
            );
          if (
            info.hash !== header.hash ||
            info.height !== header.height ||
            info.parentHash !== header.parentHash
          )
            throw new Error('Management RPC block mutated during preparation');
          return evidence;
        };
        const first = await qualify();
        const firstFingerprint = fingerprint(first);
        const second = await qualify();
        active();
        if (fingerprint(second) !== firstFingerprint)
          throw new Error(
            'Management settled evidence changed during preparation',
          );
        if (purpose === 'recovery') {
          const recovered = paymentCopy();
          recovered.txBytes = Buffer.from(first.signedBytes.slice(2), 'hex');
          if (
            !chain.verifyTransactionExtraConditions(
              recovered,
              SigningStatus.Signed,
            ) ||
            fingerprint(chain.extractTransactionOrder(recovered)) !==
              orderFingerprint
          )
            throw new Error('Recovered management semantics changed');
          signedJson = recovered.toJson();
        } else if (purpose === 'invalidation') {
          invalidation = Object.freeze(
            first.unsignedHash === own.unsignedHash
              ? {
                  reason:
                    'Own management transaction failed in settled execution',
                  unexpected: true,
                }
              : {
                  reason:
                    'Management nonce consumed by a different settled transaction',
                  unexpected: false,
                },
          );
        }
      }
      await source.transaction((manager) =>
        checkSql(manager, 'before', input, active),
      );
      active();
      return Object.freeze({ active, signedJson, invalidation });
    };
    return Object.freeze({
      kind,
      identity: fingerprint({
        expected,
        purpose,
        businessId,
        baseline,
        order,
        record,
        block,
        config,
        policy,
      }),
      database,
      management: business,
      payment: paymentCopy,
      checkSql,
      prepare,
    });
  };
}
