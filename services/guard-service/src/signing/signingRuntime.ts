import { AvalancheRpcScanner } from '@rosen-bridge/evm-scanner';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { DatabaseAction } from '../db/databaseAction';
import EventSerializer from '../event/eventSerializer';
import ChainHandler from '../handlers/chainHandler';
import { AvalancheTransactionSafety } from '../utils/avalancheTransactionSafety';
import {
  AvalancheManagementAuthorization,
  AvalancheManagementDependencies,
} from '../verification/avalancheManagementAuthorization';
import { AvalancheManagementExecutionAuthorization } from '../verification/avalancheManagementExecutionAuthorization';
import { prepareAvalancheManagementSigningPersistence } from '../verification/avalancheManagementSigningPersistence';
import { PaymentRecoveryAuthorization } from '../verification/paymentRecoveryAuthorization';
import { PaymentSubmissionAuthorization } from '../verification/paymentSubmissionAuthorization';
import RewardAuthorization from '../verification/rewardAuthorization';
import {
  SigningRowPreimage,
  TransactionSigningContext,
  isAvalancheManagementRow,
} from './transactionSigningContext';
import { TssAuthorizationRegistry } from './tssAuthorizationRegistry';

interface SignerLimits {
  readonly signingTimeoutMs: number;
  readonly httpTimeoutMs: number;
  readonly maxPending: number;
}

export interface GuardSigningRuntime {
  readonly context: TransactionSigningContext;
  readonly registry: TssAuthorizationRegistry;
  readonly curve: SignerLimits;
  readonly edward: SignerLimits;
  readonly ergo: { readonly timeoutMs: number; readonly maxPending: number };
  readonly processor: {
    readonly timeoutMs: number;
    readonly maxPending: number;
  };
}

interface Dependencies {
  getEvent: DatabaseAction['getEventById'];
  getTx: DatabaseAction['getTxById'];
  decode: (json: string) => PaymentTransaction;
  getScanner: () => AvalancheRpcScanner | undefined;
  curveTimeoutSeconds: number;
  edwardTimeoutSeconds: number;
  ergoTimeoutSeconds: number;
  maxPending: number;
  management?: AvalancheManagementDependencies;
}

/** Builds one policy context without constructing chains or starting services. */
export const createGuardSigningRuntime = (
  dependencies: Dependencies,
): GuardSigningRuntime => {
  /** Converts configured signing seconds into a bounded millisecond timeout. */
  const milliseconds = (seconds: number) => {
    if (typeof seconds !== 'number')
      throw new Error('Invalid guard signing timeout');
    const value = seconds * 1000;
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
      throw new Error('Invalid guard signing timeout');
    return value;
  };
  const curve = milliseconds(dependencies.curveTimeoutSeconds);
  const edward = milliseconds(dependencies.edwardTimeoutSeconds);
  const ergo = milliseconds(dependencies.ergoTimeoutSeconds);
  const maxPending = dependencies.maxPending;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1024)
    throw new Error('Invalid guard signing capacity');
  const registry = new TssAuthorizationRegistry(
    Math.max(curve, edward),
    maxPending,
  );
  /** Captures signing, HTTP timeout and queue-capacity limits for one signer. */
  const limits = (signingTimeoutMs: number): SignerLimits =>
    Object.freeze({
      signingTimeoutMs,
      httpTimeoutMs: signingTimeoutMs,
      maxPending,
    });
  const knownPaymentEvents = new Set<string>();
  const paymentSubmission = new PaymentSubmissionAuthorization({
    /** Resolves the current DAO for the payment authorization consumer. */
    getDatabase: () => DatabaseAction.getInstance(),
    /** Resolves the registered chain for the requested payment network. */
    getChain: (network) => ChainHandler.getInstance().getChain(network),
    decode: dependencies.decode,
    /** Captures fee and event order inputs through the current reward authority. */
    captureOrderInputs: (event, txId) =>
      RewardAuthorization.getInstance().captureOrderInputs(event, txId),
  });
  /** Classifies the exact payment route and rejects loss of remembered Avalanche evidence. */
  const isAvalanchePayment = async (expected: SigningRowPreimage) => {
    if (expected.type !== TransactionType.payment || !expected.eventId)
      throw new Error('Payment event context is missing');
    const event = await dependencies.getEvent(expected.eventId);
    if (
      !event?.eventData ||
      event.id !== expected.eventId ||
      event.eventData.eventId !== expected.eventId
    )
      throw new Error('Payment event identity is inconsistent');
    const protocol = EventSerializer.fromConfirmedEntity(event);
    if (
      EventSerializer.getId(protocol) !== expected.eventId ||
      protocol.toChain !== expected.chain
    )
      throw new Error('Payment route identity is inconsistent');
    const applies = [protocol.fromChain, protocol.toChain].includes(
      'avalanche',
    );
    const sourceEvidence =
      event.eventData.extractor === 'avalancheEventTrigger';
    if (applies) knownPaymentEvents.add(expected.eventId);
    const rows = await DatabaseAction.getInstance().TransactionRepository.find({
      where: { event: { id: expected.eventId }, type: TransactionType.payment },
    });
    const evidence =
      expected.chain === 'avalanche' ||
      sourceEvidence ||
      rows.some((row) => row.chain.toLowerCase() === 'avalanche') ||
      knownPaymentEvents.has(expected.eventId) ||
      RewardAuthorization.remembersEvent(expected.eventId);
    if (!applies && evidence)
      throw new Error('Stored Avalanche payment route changed');
    return applies;
  };
  const paymentRecovery = new PaymentRecoveryAuthorization({
    /** Resolves the current DAO for the payment authorization consumer. */
    getDatabase: () => DatabaseAction.getInstance(),
    /** Resolves the registered chain for the requested payment network. */
    getChain: (network) => ChainHandler.getInstance().getChain(network),
    decode: dependencies.decode,
    /** Captures fee and event order inputs through the current reward authority. */
    captureOrderInputs: (event, txId) =>
      RewardAuthorization.getInstance().captureOrderInputs(event, txId),
  });
  const management = dependencies.management
    ? new AvalancheManagementAuthorization(dependencies.management)
    : undefined;
  const managementExecution =
    management && dependencies.management
      ? new AvalancheManagementExecutionAuthorization({
          getDatabase: () => DatabaseAction.getInstance(),
          management,
          policy: dependencies.management,
        })
      : undefined;
  return Object.freeze({
    context: new TransactionSigningContext({
      safety: new AvalancheTransactionSafety(
        dependencies.getEvent,
        dependencies.getScanner,
        management?.bind,
      ),
      getTx: dependencies.getTx,
      decode: dependencies.decode,
      registry,
      prepareManagementPersistence: dependencies.management
        ? (expected, purpose, signedJson) =>
            prepareAvalancheManagementSigningPersistence(
              {
                ...dependencies.management!,
                getDatabase: () => DatabaseAction.getInstance(),
              },
              expected,
              purpose,
              signedJson,
            )
        : undefined,
      verifyManagementResult: management
        ? async (expected, signedJson) => {
            const payment = dependencies.decode(expected.txJson);
            await management.checkSignedResult(
              {
                network: payment.network,
                eventId: payment.eventId,
                txId: payment.txId,
                txType: payment.txType,
                txBytes: Buffer.from(payment.txBytes).toString('hex'),
              },
              signedJson,
            );
          }
        : undefined,
      /** Binds applicable Avalanche payment submission or completion authority. */
      bindPayment: async (expected, purpose) => {
        if (isAvalancheManagementRow(expected)) {
          if (!managementExecution)
            throw new Error(
              'Native management execution authority is unavailable',
            );
          return managementExecution.bind(expected, purpose);
        }
        if (!(await isAvalanchePayment(expected))) return undefined;
        return paymentSubmission.bind(expected, purpose);
      },
      /** Binds applicable Avalanche payment invalidation authority. */
      bindPaymentInvalidation: async (expected) => {
        if (isAvalancheManagementRow(expected)) {
          if (!managementExecution)
            throw new Error(
              'Native management invalidation authority is unavailable',
            );
          return managementExecution.bindInvalidation(expected);
        }
        if (!(await isAvalanchePayment(expected))) return undefined;
        return paymentSubmission.bindInvalidation(expected);
      },
      /** Binds applicable Avalanche failed-payment recovery authority. */
      bindPaymentRecovery: async (expected) => {
        if (isAvalancheManagementRow(expected)) {
          if (!managementExecution)
            throw new Error(
              'Native management recovery authority is unavailable',
            );
          return managementExecution.bindRecovery(expected);
        }
        if (!(await isAvalanchePayment(expected))) return undefined;
        return paymentRecovery.bindRecovery(expected);
      },
      /** Binds existing reward authority for the captured row, statuses and purpose. */
      bindReward: (expected, statuses, purpose) =>
        RewardAuthorization.getInstance().bindExistingReward(
          expected,
          statuses,
          purpose,
        ),
    }),
    registry,
    curve: limits(curve),
    edward: limits(edward),
    ergo: Object.freeze({ timeoutMs: ergo, maxPending }),
    processor: Object.freeze({
      timeoutMs: Math.max(curve, edward, ergo),
      maxPending,
    }),
  });
};
