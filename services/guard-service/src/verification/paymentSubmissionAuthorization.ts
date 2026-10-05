import * as wasm from 'ergo-lib-wasm-nodejs';
import { Transaction } from 'ethers';
import { isEqual } from 'lodash-es';

import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { EntityManager, IsNull } from '@rosen-bridge/extended-typeorm';
import JsonBigInt from '@rosen-bridge/json-bigint';
import { EventTriggerEntity } from '@rosen-bridge/watcher-data-extractor';
import {
  AbstractChain,
  ConfirmationStatus,
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import {
  AVALANCHE_TX_EXTRACTOR,
  AvalancheRpcNetwork,
} from '@rosen-chains/avalanche-rpc';
import { ErgoChain, ErgoTransaction } from '@rosen-chains/ergo';
import { EvmTxStatus } from '@rosen-chains/evm';

import { DatabaseAction, TransactionCheckPreimage } from '../db/databaseAction';
import { ConfirmedEventEntity } from '../db/entities/confirmedEventEntity';
import { TransactionEntity } from '../db/entities/transactionEntity';
import EventOrder from '../event/eventOrder';
import EventSerializer from '../event/eventSerializer';
import { SigningRowPreimage } from '../signing/transactionSigningContext';
import { EventStatus, TransactionStatus } from '../utils/constants';
import Utils from '../utils/utils';
import {
  assertCanonicalReducedErgo,
  assertSameSignedErgoSemantics,
} from './ergoSignedSemantics';
import type RewardAuthorization from './rewardAuthorization';

interface Dependencies {
  getDatabase(): DatabaseAction;
  getChain(network: string): AbstractChain<unknown>;
  decode(json: string): PaymentTransaction;
  captureOrderInputs: RewardAuthorization['captureOrderInputs'];
}

export interface PreparedPaymentSubmission {
  /** Single use. Starts transport synchronously with SQL ownership; never awaits HTTP. */
  authorize(start: () => void): Promise<void>;
  assertBefore(
    manager: EntityManager,
    expected: SigningRowPreimage,
  ): Promise<void>;
  assertAfter(
    manager: EntityManager,
    expected: SigningRowPreimage,
  ): Promise<void>;
}
export type PaymentSubmissionPurpose = 'submission' | 'completion';
export interface BoundPaymentSubmission {
  readonly kind: 'ready' | 'observed';
  readonly purpose: PaymentSubmissionPurpose;
  readonly identity: string;
  payment(): PaymentTransaction;
  /** Caller owns one scanner lease throughout preparation and authorize. */
  prepareUnderScannerLease(
    assertActive: () => void,
  ): Promise<PreparedPaymentSubmission>;
}

export interface PreparedPaymentInvalidation {
  readonly reason: string;
  readonly unexpected: boolean;
  assertBefore(
    manager: EntityManager,
    expected: TransactionCheckPreimage,
  ): Promise<void>;
  assertAfter(
    manager: EntityManager,
    expected: TransactionCheckPreimage,
    transition: { unexpected: boolean },
  ): Promise<void>;
}
export interface BoundPaymentInvalidation {
  readonly purpose: 'invalidation';
  readonly identity: string;
  payment(): PaymentTransaction;
  /** Caller retains its scanner lease and lifetime through the SQL transition. */
  prepareUnderScannerLease(
    assertActive: () => void,
  ): Promise<PreparedPaymentInvalidation>;
}
interface InternalPrepared extends PreparedPaymentSubmission {
  readonly invalidation?: {
    readonly reason: string;
    readonly unexpected: boolean;
  };
  assertAfter(
    manager: EntityManager,
    expected: SigningRowPreimage,
    transition?: { unexpected: boolean },
  ): Promise<void>;
}
interface InternalBound
  extends Omit<BoundPaymentSubmission, 'purpose' | 'prepareUnderScannerLease'> {
  readonly purpose: PaymentSubmissionPurpose | 'invalidation';
  prepareUnderScannerLease(assertActive: () => void): Promise<InternalPrepared>;
}

/** Serializes captured values for authority equality checks. */
const fingerprint = (value: unknown) => JsonBigInt.stringify(value);
/** Parses canonical Ergo box bytes and extracts IDs while freeing WASM allocations. */
const canonicalBox = (bytes: Uint8Array) => {
  const box = wasm.ErgoBox.sigma_parse_bytes(bytes);
  try {
    if (!Buffer.from(box.sigma_serialize_bytes()).equals(Buffer.from(bytes)))
      throw new Error('Payment box encoding is not canonical');
    const identifier = box.box_id();
    let id: string;
    try {
      id = identifier.to_str();
    } finally {
      identifier.free();
    }
    const tokens = box.tokens();
    try {
      const tokenIds = Array.from({ length: tokens.len() }, (_, index) => {
        const token = tokens.get(index);
        try {
          const tokenId = token.id();
          try {
            return tokenId.to_str();
          } finally {
            tokenId.free();
          }
        } finally {
          token.free();
        }
      });
      return { id, tokenIds };
    } finally {
      tokens.free();
    }
  } finally {
    box.free();
  }
};
/** Rejects noncanonical signed or unsigned transaction representations. */
const assertRepresentation = (
  model: PaymentTransaction,
  status: SigningStatus,
) => {
  if (model instanceof ErgoTransaction) {
    if (status === SigningStatus.Signed)
      assertSameSignedErgoSemantics(model, model);
    else assertCanonicalReducedErgo(model);
  } else {
    const raw = '0x' + Buffer.from(model.txBytes).toString('hex');
    const tx = Transaction.from(raw);
    if (
      tx.isSigned() !== (status === SigningStatus.Signed) ||
      (tx.isSigned() ? tx.serialized : tx.unsignedSerialized) !== raw ||
      tx.unsignedHash !== model.txId
    )
      throw new Error('Payment representation is not canonical');
  }
};
/** Classifies a model only when exactly one canonical representation matches. */
const representation = (
  model: PaymentTransaction,
  allowUnsigned: boolean,
): SigningStatus => {
  if (!allowUnsigned) {
    assertRepresentation(model, SigningStatus.Signed);
    return SigningStatus.Signed;
  }
  // Both canonical recognizers run independently. Acceptance requires exactly one;
  // a parse error never selects a fallback representation.
  const accepted = [SigningStatus.Signed, SigningStatus.UnSigned].filter(
    (status) => {
      try {
        assertRepresentation(model, status);
        return true;
      } catch {
        return false;
      }
    },
  );
  if (accepted.length !== 1)
    throw new Error('Ambiguous or invalid payment representation');
  return accepted[0];
};
/** Captures the payment model without retaining caller-owned mutable fields. */
const modelSnapshot = (model: PaymentTransaction, status: SigningStatus) => {
  assertRepresentation(model, status);
  return fingerprint({
    json: model.toJson(),
    network: model.network,
    txId: model.txId,
    eventId: model.eventId,
    txType: model.txType,
    bytes: Buffer.from(model.txBytes).toString('hex'),
    inputs:
      model instanceof ErgoTransaction
        ? model.inputBoxes.map((bytes) => Buffer.from(bytes).toString('hex'))
        : null,
    data:
      model instanceof ErgoTransaction
        ? model.dataInputs.map((bytes) => Buffer.from(bytes).toString('hex'))
        : null,
  });
};

/** Signed submission/completion and positive-proof invalidation of stored payments. */
export class PaymentSubmissionAuthorization {
  /** Captures the dependencies used by subsequent authorization checks. */
  constructor(private readonly dependencies: Dependencies) {}

  /** Binds the supplied model to the captured transaction authority. */
  async bind(
    input: SigningRowPreimage,
    purpose: PaymentSubmissionPurpose,
  ): Promise<BoundPaymentSubmission> {
    if (purpose !== 'submission' && purpose !== 'completion')
      throw new Error('Invalid payment purpose');
    const bound = await this.bindAuthority(input, purpose);
    return Object.freeze({ ...bound, purpose });
  }

  /** Binds a payment to the authority required for invalidation. */
  async bindInvalidation(
    input: TransactionCheckPreimage,
  ): Promise<BoundPaymentInvalidation> {
    if (
      !Number.isSafeInteger(input.lastCheck) ||
      input.lastCheck < 0 ||
      (input.lastStatusUpdate !== null &&
        typeof input.lastStatusUpdate !== 'string') ||
      typeof input.failedInSign !== 'boolean' ||
      !Number.isSafeInteger(input.signFailedCount) ||
      input.signFailedCount < 0
    )
      throw new Error('Invalid payment check preimage');
    const bound = await this.bindAuthority(input, 'invalidation');
    return Object.freeze({
      purpose: 'invalidation' as const,
      identity: bound.identity,
      payment: bound.payment,
      prepareUnderScannerLease: async (active: () => void) => {
        const prepared = await bound.prepareUnderScannerLease(active);
        if (!prepared.invalidation)
          throw new Error('Missing payment invalidation proof');
        return Object.freeze({
          ...prepared.invalidation,
          assertBefore: prepared.assertBefore,
          assertAfter: prepared.assertAfter,
        });
      },
    });
  }

  /** Captures payment state and creates the corresponding action authorization. */
  private async bindAuthority(
    input: SigningRowPreimage | TransactionCheckPreimage,
    purpose: PaymentSubmissionPurpose | 'invalidation',
  ): Promise<InternalBound> {
    const invalidating = purpose === 'invalidation';
    const expected = Object.freeze({ ...input });
    const checked = invalidating
      ? (expected as TransactionCheckPreimage)
      : undefined;
    const expectedFingerprint = fingerprint(expected);
    if (
      !['submission', 'completion', 'invalidation'].includes(purpose) ||
      (purpose === 'completion' &&
        expected.status !== TransactionStatus.sent) ||
      expected.type !== TransactionType.payment ||
      !expected.eventId ||
      expected.orderId !== null ||
      !(
        invalidating
          ? [TransactionStatus.sent, TransactionStatus.signFailed]
          : [TransactionStatus.signed, TransactionStatus.sent]
      ).includes(expected.status) ||
      !Number.isSafeInteger(expected.requiredSign) ||
      expected.requiredSign < 1
    )
      throw new Error('Payment submission row is not eligible');
    const database = this.dependencies.getDatabase();
    const storedEvent = await database.getEventById(expected.eventId);
    if (
      !storedEvent?.eventData ||
      storedEvent.status !== EventStatus.inPayment ||
      storedEvent.id !== expected.eventId ||
      storedEvent.eventData.eventId !== expected.eventId
    )
      throw new Error('Payment event is not in payment');
    const event = structuredClone(storedEvent);
    const protocol = Object.freeze(
      EventSerializer.fromConfirmedEntity(storedEvent),
    );
    if (
      EventSerializer.getId(protocol) !== expected.eventId ||
      ![protocol.fromChain, protocol.toChain].includes('avalanche') ||
      !['ergo', 'avalanche'].includes(protocol.toChain) ||
      expected.chain !== protocol.toChain
    )
      throw new Error('Payment route is inconsistent');
    const triggerSpent = [
      event.eventData.spendHeight,
      event.eventData.spendBlock,
      event.eventData.spendTxId,
      event.eventData.result,
      event.eventData.paymentTxId,
    ].some((value) => value != null);
    if (
      triggerSpent &&
      (invalidating ||
        protocol.toChain !== 'ergo' ||
        event.eventData.spendTxId !== expected.txId ||
        event.eventData.paymentTxId !== expected.txId ||
        event.eventData.result !== 'successful' ||
        !Number.isSafeInteger(event.eventData.spendHeight) ||
        event.eventData.spendHeight! < event.eventData.height ||
        typeof event.eventData.spendBlock !== 'string' ||
        !/^[0-9a-f]{64}$/.test(event.eventData.spendBlock))
    )
      throw new Error('Payment route or unspent trigger is inconsistent');
    const eventFingerprint = fingerprint(event);
    const chain = this.dependencies.getChain(protocol.toChain);
    if (!(chain instanceof ErgoChain) && !(chain instanceof AvalancheChain))
      throw new Error('Unsupported payment submission chain');
    const targetNetwork = chain.network;
    const source = this.dependencies.getChain(protocol.fromChain);
    const policy = fingerprint(chain.getChainConfigs());
    const sourcePolicy = fingerprint(source.getChainConfigs());
    const payment = this.dependencies.decode(expected.txJson);
    const signingStatus = representation(
      payment,
      invalidating && expected.status === TransactionStatus.signFailed,
    );
    const snapshot = modelSnapshot(payment, signingStatus);
    const lockAddress = chain.getChainConfigs().addresses.lock.toLowerCase();
    if (
      !isEqual(JSON.parse(payment.toJson()), JSON.parse(expected.txJson)) ||
      payment.network !== expected.chain ||
      payment.txType !== TransactionType.payment ||
      payment.eventId !== expected.eventId ||
      payment.txId !== expected.txId
    )
      throw new Error('Payment model differs from stored metadata');
    // Scanner rows discover a real signed hash; an unsigned model ID is never
    // used as the canonical transaction hash for getTransaction.
    const addressPredicate =
      chain instanceof AvalancheChain
        ? {
            ...(invalidating
              ? {
                  nonce: Transaction.from(
                    '0x' + Buffer.from(payment.txBytes).toString('hex'),
                  ).nonce,
                }
              : { unsignedHash: expected.txId }),
            address: chain.getChainConfigs().addresses.lock.toLowerCase(),
            extractor: AVALANCHE_TX_EXTRACTOR,
          }
        : undefined;
    const records = addressPredicate
      ? await database.dataSource
          .getRepository(AddressTxsEntity)
          .findBy(addressPredicate)
      : [];
    if (records.length > 1)
      throw new Error('Ambiguous observed payment records');
    const record = records[0] ? structuredClone(records[0]) : undefined;
    const kind =
      triggerSpent || record ? ('observed' as const) : ('ready' as const);
    if (purpose === 'completion' && kind !== 'observed')
      throw new Error('Payment completion requires observed execution');
    if (record) {
      const signed = Transaction.from(
        '0x' + Buffer.from(payment.txBytes).toString('hex'),
      );
      if (
        !Number.isSafeInteger(record.id) ||
        record.id < 1 ||
        (!invalidating &&
          (record.signedHash !== signed.hash ||
            record.unsignedHash !== signed.unsignedHash)) ||
        !/^0x[0-9a-f]{64}$/.test(record.signedHash) ||
        !/^0x[0-9a-f]{64}$/.test(record.unsignedHash) ||
        record.nonce !== signed.nonce ||
        record.address !==
          (signingStatus === SigningStatus.Signed
            ? signed.from?.toLowerCase()
            : lockAddress) ||
        !/^0x[0-9a-f]{64}$/.test(record.blockId)
      )
        throw new Error(
          'Observed Avalanche payment record differs from signed model',
        );
    }
    const observedBlocks =
      kind === 'observed'
        ? await database.dataSource
            .getRepository(BlockEntity)
            .findBy(
              protocol.toChain === 'ergo'
                ? { scanner: 'ergo', height: event.eventData.spendHeight! }
                : { scanner: 'avalanche', hash: record!.blockId },
            )
        : [];
    const block = observedBlocks[0]
      ? structuredClone(observedBlocks[0])
      : undefined;
    if (
      kind === 'observed' &&
      (observedBlocks.length !== 1 ||
        !block ||
        block.status !== PROCEED ||
        !Number.isSafeInteger(block.height) ||
        block.height < 0 ||
        block.hash !== (record?.blockId ?? event.eventData.spendBlock))
    )
      throw new Error('Observed payment block is not uniquely scanned');
    const inputs = await this.dependencies.captureOrderInputs(
      protocol,
      event.eventData.txId,
    );
    if (new Set(inputs.eventWIDs).size !== inputs.eventWIDs.length)
      throw new Error('Duplicate merged payment WID');
    const commitments = structuredClone(inputs.commitments);
    const foreignInputs: {
      identifier: string;
      txId: string;
      index: number;
      block: BlockEntity;
    }[] = [];
    let ergoInputIds: string[] = [];
    let additional: { wid: string; boxValue: bigint }[] = [];
    let usedCommitmentIds: string[] = [];
    let rwtCount = 0n,
      permitValue = 0n;
    if (protocol.toChain === 'ergo') {
      if (
        !(payment instanceof ErgoTransaction) ||
        !(chain instanceof ErgoChain)
      )
        throw new Error('Payment requires the Ergo signed model');
      const boxLists = [payment.inputBoxes, payment.dataInputs].map((list) =>
        list.map(canonicalBox),
      );
      // modelSnapshot validated the captured representation and every canonical
      // auxiliary slot before any array mapping.
      const ids = boxLists[0].map((box) => box.id);
      ergoInputIds = ids;
      const triggerBytes = Buffer.from(event.eventData.serialized, 'base64');
      const trigger = canonicalBox(triggerBytes);
      const triggerIndex = ids.indexOf(trigger.id);
      if (
        trigger.id !== event.eventData.identifier ||
        triggerIndex < 0 ||
        !triggerBytes.equals(Buffer.from(payment.inputBoxes[triggerIndex])) ||
        !Number.isSafeInteger(protocol.WIDsCount) ||
        protocol.WIDsCount <= 0
      )
        throw new Error('Payment does not consume the exact trigger');
      const rwtId = source.getRWTToken();
      if (trigger.tokenIds[0] !== rwtId)
        throw new Error('Payment trigger RWT mismatch');
      const triggerHex = triggerBytes.toString('hex');
      rwtCount = chain.getBoxRWT(triggerHex) / BigInt(protocol.WIDsCount);
      permitValue =
        chain.getSerializedBoxInfo(triggerHex).assets.nativeToken /
        BigInt(protocol.WIDsCount);
      if (rwtCount <= 0n || permitValue <= 0n)
        throw new Error('Payment trigger distribution is empty');
      const merged = commitments.filter(
        (row) => row.spendTxId === event.eventData.txId,
      );
      if (
        new Set(merged.map((row) => row.spendIndex)).size !== merged.length ||
        merged.some(
          (row) =>
            !Number.isSafeInteger(row.spendIndex) ||
            row.spendIndex! < 0 ||
            row.spendBlock !== event.eventData.block ||
            row.spendHeight !== event.eventData.height ||
            ids.includes(row.identifier),
        )
      )
        throw new Error(
          'Merged payment commitments have inconsistent provenance',
        );
      const used = commitments.filter((row) => ids.includes(row.identifier));
      usedCommitmentIds = used.map((row) => row.identifier);
      if (
        boxLists[0].some(
          (box, index) =>
            index !== triggerIndex &&
            box.tokenIds.includes(rwtId) &&
            !used.some((row) => row.identifier === ids[index]),
        )
      )
        throw new Error(
          'Payment RWT input has no captured commitment provenance',
        );
      if (
        new Set(used.map((row) => row.identifier)).size !== used.length ||
        new Set(used.map((row) => row.WID)).size !== used.length ||
        commitments.some(
          (row) =>
            row.spendTxId === expected.txId &&
            (invalidating || !ids.includes(row.identifier)),
        )
      )
        throw new Error('Ambiguous additional payment commitments');
      additional = used.map((row) => {
        const bytes = Buffer.from(row.serialized, 'base64');
        const box = canonicalBox(bytes);
        if (
          !bytes.equals(
            Buffer.from(payment.inputBoxes[ids.indexOf(row.identifier)]),
          ) ||
          row.height >= event.eventData.height ||
          (invalidating
            ? [
                row.spendHeight,
                row.spendBlock,
                row.spendTxId,
                row.spendIndex,
              ].some((value) => value != null) &&
              (!Number.isSafeInteger(row.spendHeight) ||
                row.spendHeight! < row.height ||
                typeof row.spendBlock !== 'string' ||
                !/^[0-9a-f]{64}$/.test(row.spendBlock) ||
                typeof row.spendTxId !== 'string' ||
                !/^[0-9a-f]{64}$/.test(row.spendTxId) ||
                row.spendTxId === expected.txId ||
                !Number.isSafeInteger(row.spendIndex) ||
                row.spendIndex! < 0)
            : kind === 'ready'
              ? [
                  row.spendHeight,
                  row.spendBlock,
                  row.spendTxId,
                  row.spendIndex,
                ].some((value) => value != null)
              : row.spendHeight !== event.eventData.spendHeight ||
                row.spendBlock !== event.eventData.spendBlock ||
                row.spendTxId !== expected.txId ||
                row.spendIndex !== ids.indexOf(row.identifier)) ||
          !/^[0-9a-f]{64}$/.test(row.WID) ||
          inputs.eventWIDs.includes(row.WID) ||
          BigInt(row.rwtCount) !== rwtCount ||
          box.tokenIds[0] !== rwtId ||
          chain.getBoxRWT(bytes.toString('hex')) !== rwtCount ||
          chain.getBoxWID(bytes.toString('hex')) !== row.WID ||
          row.commitment !== Utils.commitmentFromEvent(protocol, row.WID)
        )
          throw new Error(
            'Additional payment commitment does not match transaction input',
          );
        return {
          wid: row.WID,
          boxValue: chain.getSerializedBoxInfo(bytes.toString('hex')).assets
            .nativeToken,
        };
      });
      if (invalidating) {
        for (const row of used.filter((row) => row.spendTxId != null)) {
          const blocks = await database.dataSource
            .getRepository(BlockEntity)
            .findBy({ scanner: 'ergo', height: row.spendHeight! });
          if (
            blocks.length !== 1 ||
            blocks[0].status !== PROCEED ||
            blocks[0].hash !== row.spendBlock
          )
            throw new Error(
              'Foreign payment input has no qualified scanned block',
            );
          foreignInputs.push({
            identifier: row.identifier,
            txId: row.spendTxId!,
            index: row.spendIndex!,
            block: structuredClone(blocks[0]),
          });
        }
        if (!foreignInputs.length)
          throw new Error('No proven foreign payment input');
      }
    } else {
      const tx = Transaction.from(
        '0x' + Buffer.from(payment.txBytes).toString('hex'),
      );
      if (
        tx.isSigned() !== (signingStatus === SigningStatus.Signed) ||
        tx.unsignedHash !== expected.txId ||
        (tx.isSigned() ? tx.serialized : tx.unsignedSerialized) !==
          '0x' + Buffer.from(payment.txBytes).toString('hex')
      )
        throw new Error('Avalanche payment representation is not canonical');
    }
    /** Extracts the current event and order data required by this authorization. */
    const extract = () =>
      protocol.toChain === 'ergo'
        ? (chain as ErgoChain).extractTransactionOrder(payment, signingStatus)
        : chain.extractTransactionOrder(payment);
    const actualOrder = fingerprint(extract());
    /** Reads the order required for the current payment or reward authorization. */
    const order = () => {
      const single = EventOrder.eventSinglePayment(
        protocol,
        chain.getMinimumNativeToken(),
        inputs.feeConfig,
      );
      if (protocol.toChain !== 'ergo') return [single];
      const reward = EventOrder.eventRewardOrder(
        protocol,
        additional,
        inputs.feeConfig,
        '',
        source.getRWTToken(),
        rwtCount,
        permitValue,
        [...inputs.eventWIDs],
      );
      return [...reward.watchersOrder, single, ...reward.guardsOrder];
    };
    const verifySettlement =
      chain instanceof AvalancheChain
        ? chain.verifySettledPaymentEvidence
        : undefined;
    const readTokenReceipt =
      targetNetwork instanceof AvalancheRpcNetwork
        ? targetNetwork.getSettledTransactionReceiptEvidence
        : undefined;
    /** Rejects changes to the captured event, order or transaction authority. */
    const assertCurrent = () => {
      inputs.assertFee();
      if (
        fingerprint(input) !== expectedFingerprint ||
        this.dependencies.getDatabase() !== database ||
        this.dependencies.getChain(protocol.toChain) !== chain ||
        this.dependencies.getChain(protocol.fromChain) !== source ||
        chain.network !== targetNetwork ||
        (chain instanceof AvalancheChain &&
          chain.verifySettledPaymentEvidence !== verifySettlement) ||
        (targetNetwork instanceof AvalancheRpcNetwork &&
          targetNetwork.getSettledTransactionReceiptEvidence !==
            readTokenReceipt) ||
        fingerprint(chain.getChainConfigs()) !== policy ||
        fingerprint(source.getChainConfigs()) !== sourcePolicy ||
        modelSnapshot(payment, signingStatus) !== snapshot ||
        fingerprint(extract()) !== actualOrder ||
        fingerprint(order()) !== actualOrder
      )
        throw new Error('Payment model, route, policy or order changed');
    };
    assertCurrent();
    let invalidation:
      | { readonly reason: string; readonly unexpected: boolean }
      | undefined;
    /** Checks that the captured authorization remains valid before the action. */
    const check = async (
      manager: EntityManager,
      after: boolean,
      active: () => void,
    ) => {
      active();
      assertCurrent();
      const current = await manager
        .getRepository(ConfirmedEventEntity)
        .findOne({
          where: { id: expected.eventId! },
          relations: ['eventData'],
        });
      const triggers = await manager
        .getRepository(EventTriggerEntity)
        .findBy({ txId: event.eventData.txId });
      const rows = (
        await manager.getRepository(TransactionEntity).find({
          where: {
            event: { id: expected.eventId! },
            type: TransactionType.payment,
          },
          relations: ['event', 'order'],
        })
      ).filter(
        (row) =>
          row.status !== TransactionStatus.invalid ||
          (invalidating && after && row.txId === expected.txId),
      );
      const row = rows[0];
      const completed = after && purpose === 'completion';
      const eventAfterStatus =
        protocol.toChain === 'ergo'
          ? EventStatus.completed
          : EventStatus.pendingReward;
      const expectedEvent =
        invalidating && after
          ? {
              ...event,
              status: EventStatus.pendingPayment,
              unexpectedFails:
                event.unexpectedFails + (invalidation?.unexpected ? 1 : 0),
            }
          : completed
            ? {
                ...event,
                status: eventAfterStatus,
                ...(protocol.toChain === 'avalanche'
                  ? { firstTry: row?.lastStatusUpdate }
                  : {}),
              }
            : event;
      if (
        !current ||
        fingerprint(current) !==
          (completed || (invalidating && after)
            ? fingerprint(expectedEvent)
            : eventFingerprint) ||
        (completed &&
          protocol.toChain === 'avalanche' &&
          (typeof row?.lastStatusUpdate !== 'string' ||
            !/^(?:0|[1-9][0-9]*)$/.test(row.lastStatusUpdate))) ||
        triggers.length !== 1 ||
        triggers[0].id !== event.eventData.id ||
        rows.length !== 1 ||
        !row ||
        row.txId !== expected.txId ||
        row.txJson !== expected.txJson ||
        row.chain !== expected.chain ||
        row.type !== expected.type ||
        row.requiredSign !== expected.requiredSign ||
        row.event?.id !== expected.eventId ||
        row.order !== null ||
        row.status !==
          (after
            ? invalidating
              ? TransactionStatus.invalid
              : purpose === 'completion'
                ? TransactionStatus.completed
                : TransactionStatus.sent
            : expected.status) ||
        !(await manager
          .getRepository(TransactionEntity)
          .existsBy({ txId: expected.txId, order: IsNull() }))
      )
        throw new Error('Payment submission database authority changed');
      if (
        checked &&
        (row.lastCheck !== checked.lastCheck ||
          row.failedInSign !== checked.failedInSign ||
          row.signFailedCount !== checked.signFailedCount ||
          (after
            ? typeof row.lastStatusUpdate !== 'string' ||
              !/^(?:0|[1-9][0-9]*)$/.test(row.lastStatusUpdate)
            : row.lastStatusUpdate !== checked.lastStatusUpdate))
      )
        throw new Error('Payment invalidation check preimage changed');
      if (addressPredicate) {
        const currentRecords = await manager
          .getRepository(AddressTxsEntity)
          .findBy(addressPredicate);
        if (fingerprint(currentRecords) !== fingerprint(records))
          throw new Error('Observed payment scanner record changed');
      }
      for (const capturedBlock of [
        ...(block ? [block] : []),
        ...foreignInputs.map((input) => input.block),
      ]) {
        const currentBlocks = await manager.getRepository(BlockEntity).findBy({
          scanner: capturedBlock.scanner,
          height: capturedBlock.height,
        });
        if (
          currentBlocks.length !== 1 ||
          fingerprint(currentBlocks[0]) !== fingerprint(capturedBlock)
        )
          throw new Error('Observed payment scanned block changed');
      }
      await inputs.assertInputs(manager);
      active();
      assertCurrent();
    };
    await database.dataSource.transaction((manager) =>
      check(manager, false, () => {}),
    );
    let prepared = false;
    return Object.freeze({
      kind,
      purpose,
      identity: fingerprint({
        purpose,
        signingStatus,
        expected,
        event: {
          ...event,
          eventData: {
            ...event.eventData,
            spendHeight: null,
            spendBlock: null,
            spendTxId: null,
            result: null,
            paymentTxId: null,
          },
        },
        commitments: commitments.map((row) =>
          usedCommitmentIds.includes(row.identifier)
            ? {
                ...row,
                spendHeight: null,
                spendBlock: null,
                spendTxId: null,
                spendIndex: null,
              }
            : row,
        ),
        wids: inputs.eventWIDs,
        fee: inputs.feeConfig,
        policy,
        sourcePolicy,
        actualOrder,
      }),
      payment: () => {
        assertCurrent();
        return this.dependencies.decode(expected.txJson);
      },
      prepareUnderScannerLease: async (
        assertActive: () => void,
      ): Promise<InternalPrepared> => {
        if (prepared)
          throw new Error('Payment admission preparation is single use');
        prepared = true;
        /** Rejects an inactive or expired captured authorization. */
        const active = () => {
          assertActive();
          assertCurrent();
        };
        active();
        const ergo =
          protocol.toChain === 'ergo' ? (chain as ErgoChain) : undefined;
        if (
          !(await (ergo
            ? ergo.verifyPaymentTransaction(payment, signingStatus)
            : chain.verifyPaymentTransaction(payment)))
        )
          throw new Error('Payment model rejected');
        active();
        if (
          !(await (ergo
            ? ergo.verifyTransactionFee(payment, signingStatus)
            : chain.verifyTransactionFee(payment)))
        )
          throw new Error('Payment fee rejected');
        active();
        if (
          !(await (ergo
            ? ergo.verifyNoTokenBurned(payment, signingStatus)
            : chain.verifyNoTokenBurned(payment)))
        )
          throw new Error('Payment burns tokens');
        active();
        if (!chain.verifyTransactionExtraConditions(payment, signingStatus))
          throw new Error('Payment extra conditions rejected');
        if (
          !invalidating &&
          kind === 'ready' &&
          !(await chain.isTxValid(payment, SigningStatus.Signed)).isValid
        )
          throw new Error('Payment inputs unavailable');
        active();
        if (invalidating) {
          const required = chain.getTxRequiredConfirmation(
            TransactionType.payment,
          );
          if (!Number.isSafeInteger(required) || required < 1)
            throw new Error('Invalid payment confirmation policy');
          if (chain instanceof AvalancheChain) {
            if (!record || !block)
              throw new Error('No settled payment nonce evidence');
            if (!(targetNetwork instanceof AvalancheRpcNetwork))
              throw new Error('Unsupported settled payment network');
            const own = Transaction.from(
              '0x' + Buffer.from(payment.txBytes).toString('hex'),
            );
            /** Qualifies the payment model against the current execution evidence. */
            const qualify = async () => {
              const evidence =
                await targetNetwork.getSettledTransactionEvidence(
                  record.signedHash,
                  record.blockId,
                );
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
                evidence.hash !== record.signedHash ||
                evidence.unsignedHash !== record.unsignedHash ||
                evidence.status !== record.status ||
                evidence.from !== record.address ||
                evidence.from !==
                  (signingStatus === SigningStatus.Signed
                    ? own.from?.toLowerCase()
                    : lockAddress) ||
                evidence.chainId !== own.chainId ||
                evidence.nonce !== own.nonce ||
                evidence.blockHash !== block.hash ||
                evidence.blockNumber !== block.height ||
                !Number.isSafeInteger(evidence.index) ||
                evidence.index < 0 ||
                !Number.isSafeInteger(evidence.finalizedBlockNumber) ||
                evidence.finalizedBlockNumber < block.height ||
                !/^0x[0-9a-f]{64}$/.test(evidence.finalizedBlockHash) ||
                !Number.isSafeInteger(evidence.confirmations) ||
                evidence.confirmations !==
                  evidence.finalizedBlockNumber - block.height + 1 ||
                evidence.confirmations < required ||
                ![EvmTxStatus.succeed, EvmTxStatus.failed].includes(
                  evidence.status,
                )
              )
                throw new Error(
                  'Settled payment nonce evidence is inconsistent',
                );
              const sameBody = observed.unsignedHash === own.unsignedHash;
              if (
                sameBody &&
                ((signingStatus === SigningStatus.Signed
                  ? observed.serialized !== own.serialized
                  : observed.unsignedSerialized !== own.unsignedSerialized) ||
                  evidence.status !== EvmTxStatus.failed)
              )
                throw new Error('Own payment requires reconciliation');
              return Object.freeze({ ...evidence });
            };
            const evidence = await qualify();
            const info = await chain.network.getBlockInfo(block.hash);
            active();
            if (
              info.hash !== block.hash ||
              info.height !== block.height ||
              info.parentHash !== block.parentHash
            )
              throw new Error('Settled payment block changed');
            if (
              evidence.unsignedHash !== own.unsignedHash &&
              // Unsigned models have no signed hash to query. The qualified foreign
              // execution already proves this sender's nonce was consumed.
              signingStatus === SigningStatus.Signed &&
              (await chain.network.getTransactionStatus(own.hash!)) !==
                EvmTxStatus.notFound
            )
              throw new Error(
                'Own payment observation contradicts foreign nonce',
              );
            active();
            const current = await qualify();
            if (fingerprint(current) !== fingerprint(evidence))
              throw new Error(
                'Settled payment evidence changed during admission',
              );
            invalidation = Object.freeze(
              evidence.unsignedHash === own.unsignedHash
                ? {
                    reason: 'Own payment failed in settled execution',
                    unexpected: true,
                  }
                : {
                    reason:
                      'Payment nonce consumed by a different settled transaction',
                    unexpected: false,
                  },
            );
          } else {
            /** Qualifies the foreign-chain payment under the captured authority. */
            const qualifyForeign = async (
              foreign: (typeof foreignInputs)[number],
            ) => {
              const info = await chain.network.getBlockInfo(foreign.block.hash);
              active();
              if (
                info.hash !== foreign.block.hash ||
                info.height !== foreign.block.height ||
                info.parentHash !== foreign.block.parentHash
              )
                throw new Error('Foreign payment input block changed');
              const raw = await chain.getTransaction(
                foreign.txId,
                foreign.block.hash,
              );
              active();
              if (!/^(?:[0-9a-f]{2})+$/.test(raw))
                throw new Error('Invalid foreign payment spender encoding');
              const tx = wasm.Transaction.sigma_parse_bytes(
                Buffer.from(raw, 'hex'),
              );
              try {
                const id = tx.id();
                try {
                  if (
                    id.to_str() !== foreign.txId ||
                    Buffer.from(tx.sigma_serialize_bytes()).toString('hex') !==
                      raw
                  )
                    throw new Error('Foreign payment spender is not canonical');
                } finally {
                  id.free();
                }
                const txInputs = tx.inputs();
                try {
                  const ids: string[] = [];
                  for (let i = 0; i < txInputs.len(); i++) {
                    const item = txInputs.get(i);
                    try {
                      const id = item.box_id();
                      try {
                        ids.push(id.to_str());
                      } finally {
                        id.free();
                      }
                    } finally {
                      item.free();
                    }
                  }
                  if (
                    ids[foreign.index] !== foreign.identifier ||
                    ids.includes(event.eventData.identifier) ||
                    new Set(ids).size !== ids.length
                  )
                    throw new Error('Foreign payment spender input mismatch');
                } finally {
                  txInputs.free();
                }
              } finally {
                tx.free();
              }
              return raw;
            };
            const spenderBytes: string[] = [];
            for (const foreign of foreignInputs)
              spenderBytes.push(await qualifyForeign(foreign));
            for (const id of ergoInputIds.filter(
              (id) => !foreignInputs.some((input) => input.identifier === id),
            )) {
              if (
                !(await (chain as ErgoChain).network.isBoxUnspentAndValid(id))
              )
                throw new Error('Unknown payment funding spender');
              active();
            }
            if (
              (await chain.getTxConfirmationStatus(
                payment.txId,
                TransactionType.payment,
              )) !== ConfirmationStatus.NotFound ||
              (await chain.isTxInMempool(payment.txId))
            )
              throw new Error('Own payment requires reconciliation');
            active();
            for (const [index, foreign] of foreignInputs.entries()) {
              if ((await qualifyForeign(foreign)) !== spenderBytes[index])
                throw new Error(
                  'Foreign payment spender changed during admission',
                );
              if (
                (await chain.getTxConfirmationStatus(
                  foreign.txId,
                  TransactionType.payment,
                )) !== ConfirmationStatus.ConfirmedEnough
              )
                throw new Error('Foreign payment input is not confirmed');
              active();
            }
            invalidation = Object.freeze({
              reason:
                'Payment input consumed by a confirmed foreign transaction',
              unexpected: false,
            });
          }
          await database.dataSource.transaction((manager) =>
            check(manager, false, active),
          );
        } else if (kind === 'observed') {
          let tokenEvidence: string | undefined;
          /** Requalify the captured signed token payment's movement at its scanned block. */
          const qualifyToken = async () => {
            if (!(chain instanceof AvalancheChain)) return;
            const tx = Transaction.from(
              '0x' + Buffer.from(payment.txBytes).toString('hex'),
            );
            if (tx.value !== 0n) return;
            const evidence = await readTokenReceipt!.call(
              targetNetwork,
              record!.signedHash,
              record!.blockId,
            );
            active();
            if (
              evidence.blockHash !== block!.hash ||
              evidence.blockNumber !== block!.height ||
              !verifySettlement!.call(chain, payment, evidence)
            )
              throw new Error(
                'Observed Avalanche token payment lacks exact Transfer evidence',
              );
            return fingerprint(evidence);
          };
          const info = await chain.network.getBlockInfo(block!.hash);
          active();
          if (
            info.hash !== block!.hash ||
            info.height !== block!.height ||
            info.parentHash !== block!.parentHash
          )
            throw new Error('Observed payment block identity mismatch');
          if (chain instanceof AvalancheChain) {
            const observed = await chain.network.getTransaction(
              record!.signedHash,
              record!.blockId,
            );
            active();
            if (
              observed.hash !== record!.signedHash ||
              observed.serialized !==
                '0x' + Buffer.from(payment.txBytes).toString('hex')
            )
              throw new Error('Observed Avalanche signed bytes changed');
            tokenEvidence = await qualifyToken();
          } else {
            const raw = await chain.getTransaction(expected.txId, block!.hash);
            active();
            if (!/^(?:[0-9a-f]{2})+$/.test(raw))
              throw new Error('Observed Ergo signed encoding is invalid');
            const observed = ErgoTransaction.fromJson(payment.toJson());
            observed.txBytes = Buffer.from(raw, 'hex');
            assertSameSignedErgoSemantics(payment as ErgoTransaction, observed);
          }
          // Requalify success and confirmations after the other network reads.
          if (
            chain instanceof AvalancheChain &&
            (await chain.network.getTransactionStatus(record!.signedHash)) !==
              EvmTxStatus.succeed
          )
            throw new Error('Observed Avalanche payment is not successful');
          active();
          if (
            (await chain.getTxConfirmationStatus(
              record?.signedHash ?? expected.txId,
              TransactionType.payment,
            )) !== ConfirmationStatus.ConfirmedEnough
          )
            throw new Error('Observed payment is not confirmed');
          active();
          if ((await qualifyToken()) !== tokenEvidence)
            throw new Error(
              'Observed Avalanche token execution changed during admission',
            );
          active();
          await database.dataSource.transaction((manager) =>
            check(manager, false, active),
          );
        } else if (chain instanceof AvalancheChain) {
          const signed = Transaction.from(
            '0x' + Buffer.from(payment.txBytes).toString('hex'),
          );
          // The confirmation abstraction conflates absent, pending and failed;
          // query exact statuses for both the signed body and verified scanner alias.
          for (const id of [signed.hash!, payment.txId]) {
            if (
              (await chain.network.getTransactionStatus(id)) !==
              EvmTxStatus.notFound
            )
              throw new Error(
                'Observed Avalanche payment requires reconciliation',
              );
            active();
          }
        } else {
          if (
            (await chain.getTxConfirmationStatus(
              payment.txId,
              TransactionType.payment,
            )) !== ConfirmationStatus.NotFound ||
            (await chain.isTxInMempool(payment.txId))
          )
            throw new Error('Observed Ergo payment requires reconciliation');
          active();
        }
        let used = false,
          started = false;
        return Object.freeze({
          invalidation,
          authorize: async (start: () => void) => {
            if (kind !== 'ready' || purpose !== 'submission')
              throw new Error('Observed payment cannot be submitted');
            if (used) throw new Error('Payment admission is single use');
            used = true;
            active();
            await database.dataSource.transaction(async (manager) => {
              await check(manager, false, active);
              active();
              start();
              started = true;
            });
          },
          assertBefore: async (
            manager: EntityManager,
            row: SigningRowPreimage,
          ) => {
            if (
              (!invalidating && kind === 'ready' && !started) ||
              fingerprint(row) !== expectedFingerprint
            )
              throw new Error(
                'Payment submission was not started for this row',
              );
            await check(manager, false, active);
          },
          assertAfter: async (
            manager: EntityManager,
            row: SigningRowPreimage,
            transition?: { unexpected: boolean },
          ) => {
            if (
              (invalidating &&
                (!invalidation ||
                  transition?.unexpected !== invalidation.unexpected)) ||
              (!invalidating && kind === 'ready' && !started) ||
              fingerprint(row) !==
                fingerprint({
                  ...expected,
                  status: invalidating
                    ? TransactionStatus.invalid
                    : purpose === 'completion'
                      ? TransactionStatus.completed
                      : TransactionStatus.sent,
                })
            )
              throw new Error(
                'Payment submission was not started for this row',
              );
            await check(manager, true, active);
          },
        });
      },
    });
  }
}
