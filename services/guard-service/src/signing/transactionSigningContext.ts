import { blake2b } from 'blakejs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { EntityManager } from '@rosen-bridge/extended-typeorm';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import type { TransactionCheckPreimage } from '../db/databaseAction';
import {
  AvalancheManagementPurpose,
  AvalancheTransactionSafety,
} from '../utils/avalancheTransactionSafety';
import type { BoundPaymentRecovery } from '../verification/paymentRecoveryAuthorization';
import type {
  BoundPaymentInvalidation,
  BoundPaymentSubmission,
  PaymentSubmissionPurpose,
  PreparedPaymentSubmission,
} from '../verification/paymentSubmissionAuthorization';
import {
  TssAuthorizationRegistry,
  TssSigningKey,
} from './tssAuthorizationRegistry';

export interface SigningTransactionRow {
  txId: string;
  txJson: string;
  chain: string;
  type: string;
  status: string;
  requiredSign: number;
  event: { id: string } | null;
  order: { id: string } | null;
}

/** Exact database values for a caller-owned compare-and-swap, not a write lock. */
export interface SigningRowPreimage {
  readonly txId: string;
  readonly txJson: string;
  readonly chain: string;
  readonly type: string;
  readonly status: string;
  readonly requiredSign: number;
  readonly eventId: string | null;
  readonly orderId: string | null;
}

export interface BoundTransactionContext {
  readonly bindingId: string;
  readonly unsignedJson: string;
  readonly requiredSign: number;
  readonly preimage: SigningRowPreimage;
  readonly eligibleStatuses: readonly string[];
  payment(): PaymentTransaction;
  prepareSigningAuthorization(): Promise<PreparedSigningAuthorization>;
  prepareRewardSubmission(timeoutMs: number): Promise<PreparedRewardSubmission>;
  preparePaymentSubmission(
    timeoutMs: number | undefined,
  ): Promise<PreparedPaymentHttpSubmission>;
  withPaymentCompletion<T>(
    timeoutMs: number | undefined,
    action: (
      expected: SigningRowPreimage,
      authorization?: SigningPersistenceAuthorization,
    ) => Promise<T>,
  ): Promise<T>;
  withPaymentInvalidation<T>(
    checked: TransactionCheckPreimage,
    timeoutMs: number | undefined,
    action: (
      expected: TransactionCheckPreimage,
      authorization: SigningPersistenceAuthorization | undefined,
      details: Readonly<{ reason: string; unexpected: boolean }> | undefined,
    ) => Promise<T>,
  ): Promise<T>;
  withRewardRecovery<T>(
    action: (
      expected: SigningRowPreimage,
      signedJson: string | undefined,
      authorization: SigningPersistenceAuthorization | undefined,
    ) => Promise<T>,
    assertOwnership?: () => void,
  ): Promise<T>;
  withPaymentRecovery<T>(
    checked: TransactionCheckPreimage,
    timeoutMs: number | undefined,
    action: (
      expected: TransactionCheckPreimage,
      signedJson: string | undefined,
      authorization: SigningPersistenceAuthorization | undefined,
    ) => Promise<T>,
  ): Promise<T>;
  withPersistence<T>(
    purpose: SigningPersistencePurpose,
    action: (
      expected: SigningRowPreimage,
      authorization: SigningPersistenceAuthorization,
    ) => Promise<T>,
    assertOwnership?: () => void,
    signedJson?: string,
  ): Promise<T>;
  withAction<T>(
    action: (expected: SigningRowPreimage) => T | Promise<T>,
    purpose?: AvalancheManagementPurpose,
  ): Promise<T>;
}

export type SigningPersistencePurpose =
  | 'queue'
  | 'result'
  | 'failure'
  | 'completion'
  | 'invalidation'
  | 'submission'
  | 'recovery';

/** RPC-free checks, used only with the DAO's owned transaction manager. */
export interface SigningPersistenceAuthorization {
  assertActive(): void;
  assertBefore(
    manager: EntityManager,
    expected: SigningRowPreimage,
  ): Promise<void>;
  assertAfter(
    manager: EntityManager,
    expected: SigningRowPreimage,
    transition?: { unexpected: boolean },
  ): Promise<void>;
}

export type SigningActionPhase =
  | 'queue'
  | 'commitment'
  | 'sign'
  | 'outbound'
  | 'result';

export interface PreparedSigningAuthorization {
  readonly bindingId: string;
  withAction<T>(phase: SigningActionPhase, action: () => T): Promise<T>;
}

export interface RewardSigningAuthority {
  readonly authorityId: string;
  readonly recoveredSignedJson?: string;
  readonly submission?: {
    readonly kind: 'ready' | 'observed';
    readonly identity: string;
    authorizeUnderScannerLease(start: () => void): Promise<void>;
  };
  checkUnderScannerLease<T>(
    phase: SigningActionPhase,
    action: (expected: SigningRowPreimage) => T,
  ): Promise<T>;
  preparePersistenceUnderScannerLease(
    purpose: SigningPersistencePurpose,
    signedJson?: string,
  ): Promise<Omit<SigningPersistenceAuthorization, 'assertActive'>>;
}

export interface PreparedRewardSubmission {
  readonly kind: 'ready' | 'observed' | 'legacy';
  authorizeSubmit(start: () => void): Promise<void>;
  withResult<T>(
    action: (
      expected: SigningRowPreimage,
      authorization?: SigningPersistenceAuthorization,
    ) => Promise<T>,
  ): Promise<T>;
  withLegacyAction<T>(
    action: (expected: SigningRowPreimage) => Promise<T>,
  ): Promise<T>;
  close(): void;
}

export interface RevocableSigningAttempt extends BoundTransactionContext {
  revoke(): void;
}

export interface PreparedPaymentHttpSubmission
  extends Omit<PreparedRewardSubmission, 'kind'> {
  readonly kind: 'ready' | 'observed' | 'legacy';
  payment(): PaymentTransaction;
}

interface Dependencies {
  safety: AvalancheTransactionSafety;
  getTx: (id: string) => Promise<SigningTransactionRow | null>;
  decode: (json: string) => PaymentTransaction;
  registry: TssAuthorizationRegistry;
  verifyManagementResult?: (
    expected: SigningRowPreimage,
    signedJson: string,
  ) => Promise<void>;
  prepareManagementPersistence?: (
    expected: SigningRowPreimage,
    purpose: SigningPersistencePurpose,
    signedJson?: string,
  ) => Omit<SigningPersistenceAuthorization, 'assertActive'>;
  bindPayment?: (
    expected: SigningRowPreimage,
    purpose: PaymentSubmissionPurpose,
  ) => Promise<BoundPaymentSubmission | undefined>;
  bindPaymentInvalidation?: (
    expected: TransactionCheckPreimage,
  ) => Promise<BoundPaymentInvalidation | undefined>;
  bindPaymentRecovery?: (
    expected: TransactionCheckPreimage,
  ) => Promise<BoundPaymentRecovery | undefined>;
  bindReward?: (
    expected: SigningRowPreimage,
    eligibleStatuses: readonly string[],
    purpose?: 'recovery' | 'invalidation' | 'submission',
  ) => Promise<RewardSigningAuthority | undefined>;
}

/** Narrows a runtime value to nonempty text without surrounding whitespace. */
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;
/** Narrows a runtime value to nonempty lowercase hexadecimal bytes. */
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{2})+$/.test(value);
/** Narrows a runtime value to the canonical lowercase chain-name format. */
const chain = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);

/** Identifies native management rows that always require qualified execution. */
export const isAvalancheManagementRow = (
  row: Pick<SigningRowPreimage, 'chain' | 'type'>,
): boolean =>
  row.chain === 'avalanche' &&
  [
    TransactionType.coldStorage,
    TransactionType.manual,
    TransactionType.arbitrary,
  ].includes(row.type as TransactionType);

/** Reports whether a payment or Avalanche management row requires qualified execution. */
const hasExecutionAuthority = (row: SigningRowPreimage): boolean =>
  row.type === TransactionType.payment || isAvalancheManagementRow(row);

/** Validates an optional payment authority and its declared submission purpose. */
const assertPaymentBinding = (
  value: BoundPaymentSubmission | undefined,
  purpose: PaymentSubmissionPurpose,
): void => {
  if (value === undefined) return;
  if (
    value === null ||
    typeof value !== 'object' ||
    !['ready', 'observed'].includes(value.kind) ||
    value.purpose !== purpose ||
    !text(value.identity) ||
    typeof value.payment !== 'function' ||
    typeof value.prepareUnderScannerLease !== 'function'
  )
    throw new Error('Invalid payment authority binding');
};

/** Serializes JSON recursively with sorted object keys for stable identity checks. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Invalid transaction JSON value');
  return encoded;
};

/** Parses and validates transaction identity, byte encoding and auxiliary box fields. */
const model = (json: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid transaction model');
  const result = value as Record<string, unknown>;
  if (
    !chain(result.network) ||
    !text(result.txId) ||
    typeof result.eventId !== 'string' ||
    !hex(result.txBytes) ||
    !Object.values(TransactionType).includes(result.txType as TransactionType)
  )
    throw new Error('Invalid transaction model');
  if (
    result.network === 'ergo' ||
    'inputBoxes' in result ||
    'dataInputs' in result
  ) {
    for (const field of ['inputBoxes', 'dataInputs']) {
      const boxes = result[field];
      if (!Array.isArray(boxes) || !boxes.every(hex))
        throw new Error('Invalid transaction auxiliary boxes');
    }
  }
  return result;
};

/** Captures validated database identity, quorum, status and relation IDs. */
const snapshot = (row: SigningTransactionRow): SigningRowPreimage => {
  if (
    !row ||
    !text(row.txId) ||
    typeof row.txJson !== 'string' ||
    !chain(row.chain) ||
    !Object.values(TransactionType).includes(row.type as TransactionType) ||
    !text(row.status) ||
    !Number.isSafeInteger(row.requiredSign) ||
    row.requiredSign < 1 ||
    (row.event !== null && !text(row.event?.id)) ||
    (row.order !== null && !text(row.order?.id))
  )
    throw new Error('Invalid signing transaction row');
  return Object.freeze({
    txId: row.txId,
    txJson: row.txJson,
    chain: row.chain,
    type: row.type,
    status: row.status,
    requiredSign: row.requiredSign,
    eventId: row.event?.id ?? null,
    orderId: row.order?.id ?? null,
  });
};

/** Local context carries immutable input; short policy actions own scanner exclusion. */
export class TransactionSigningContext {
  private readonly context = new AsyncLocalStorage<BoundTransactionContext>();
  private readonly owned = new WeakSet<BoundTransactionContext>();

  /** Retains transaction resolvers, safety policy and authorization binders. */
  constructor(private readonly dependencies: Dependencies) {}

  /** Captures a row and eligible statuses into an owned transaction context. */
  bind = async (
    row: SigningTransactionRow,
    eligibleStatuses: readonly string[],
  ): Promise<BoundTransactionContext> => {
    const preimage = snapshot(row);
    if (
      !Array.isArray(eligibleStatuses) ||
      !eligibleStatuses.length ||
      !Array.from(eligibleStatuses).every(text)
    )
      throw new Error('Invalid eligible signing statuses');
    const statuses = Object.freeze([...eligibleStatuses]);
    if (!statuses.includes(preimage.status))
      throw new Error('Transaction status is not eligible');
    const original = model(preimage.txJson);
    if (
      original.network !== preimage.chain ||
      original.txId !== preimage.txId ||
      original.txType !== preimage.type ||
      ((preimage.type === TransactionType.payment ||
        preimage.type === TransactionType.reward) &&
        original.eventId !== preimage.eventId) ||
      (preimage.type === TransactionType.arbitrary &&
        (preimage.orderId === null || original.eventId !== preimage.orderId)) ||
      (preimage.eventId !== null && original.eventId !== preimage.eventId)
    )
      throw new Error('Transaction row and model identity mismatch');
    const unsignedJson = canonical(original);
    /** Decodes the captured unsigned model and rejects changed decoder output. */
    const payment = () => {
      const decoded = this.dependencies.decode(unsignedJson);
      if (canonical(model(decoded.toJson())) !== unsignedJson)
        throw new Error('Transaction decoder changed captured input');
      return decoded;
    };
    payment();
    const safety = await this.dependencies.safety.bindTransaction({
      network: original.network as string,
      eventId: original.eventId as string,
      txId: original.txId as string,
      txBytes: original.txBytes as string,
      txType: original.txType as TransactionType,
    });
    const bindingId = Buffer.from(
      blake2b(
        canonical({
          safety: safety.bindingId,
          unsignedJson,
          requiredSign: preimage.requiredSign,
          eventId: preimage.eventId,
          orderId: preimage.orderId,
          eligibleStatuses: statuses,
        }),
        undefined,
        32,
      ),
    ).toString('hex');
    let rewardPreparation:
      | Promise<RewardSigningAuthority | undefined>
      | undefined;
    /** Memoizes the reward authority bound to the captured row and eligible statuses. */
    const prepareReward = () =>
      (rewardPreparation ??= (async () => {
        if (preimage.type !== TransactionType.reward) return undefined;
        if (!this.dependencies.bindReward)
          throw new Error('Reward signing authority is unavailable');
        return this.dependencies.bindReward(preimage, statuses);
      })());
    let signingPreparation: Promise<PreparedSigningAuthorization> | undefined;
    let invalidationPreparation:
      | Promise<RewardSigningAuthority | undefined>
      | undefined;
    let recoveryPreparation:
      | Promise<RewardSigningAuthority | undefined>
      | undefined;
    const bound: BoundTransactionContext = Object.freeze({
      bindingId,
      unsignedJson,
      requiredSign: preimage.requiredSign,
      preimage,
      eligibleStatuses: statuses,
      payment,
      /** Prepares bounded ready, observed or legacy payment submission and result checks. */
      preparePaymentSubmission: async (
        timeoutMs: number | undefined,
      ): Promise<PreparedPaymentHttpSubmission> => {
        const entered = performance.now();
        if (
          !hasExecutionAuthority(preimage) ||
          !['signed', 'sent'].includes(preimage.status) ||
          !this.dependencies.bindPayment
        )
          throw new Error('Payment submission authority is unavailable');
        const initial = await this.dependencies.bindPayment(
          preimage,
          'submission',
        );
        assertPaymentBinding(initial, 'submission');
        if (isAvalancheManagementRow(preimage) && !initial)
          throw new Error(
            'Native management submission authority is unavailable',
          );
        if (
          initial &&
          (typeof timeoutMs !== 'number' ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 2147483647)
        )
          throw new Error('Invalid payment submission timeout');
        const deadline = initial ? entered + timeoutMs! : Infinity;
        let closed = false,
          started = false,
          admitted = false,
          resultUsed = false;
        let startedPermit: PreparedPaymentSubmission | undefined;
        /** Rejects closure or expiration of the captured payment submission authority. */
        const assertLive = () => {
          if (closed || performance.now() >= deadline)
            throw new Error('Payment submission authority expired');
        };
        assertLive();
        /** Rebinds payment submission and rejects changed identity, purpose or observed state. */
        const refresh = async () => {
          assertLive();
          const current = await this.dependencies.bindPayment!(
            preimage,
            'submission',
          );
          assertPaymentBinding(current, 'submission');
          assertLive();
          if (
            initial
              ? !current ||
                current.purpose !== 'submission' ||
                current.identity !== initial.identity ||
                (initial.kind === 'observed' && current.kind !== 'observed')
              : current !== undefined
          )
            throw new Error('Payment submission authority changed');
          return current;
        };
        return Object.freeze({
          kind: initial?.kind ?? ('legacy' as const),
          /** Returns a live submission payment after checking all captured model and auxiliary bytes. */
          payment: () => {
            assertLive();
            const decoded = initial ? initial.payment() : payment();
            if (
              canonical(model(decoded.toJson())) !== unsignedJson ||
              decoded.network !== original.network ||
              decoded.txId !== original.txId ||
              decoded.eventId !== original.eventId ||
              decoded.txType !== original.txType ||
              !(decoded.txBytes instanceof Uint8Array) ||
              Buffer.from(decoded.txBytes).toString('hex') !== original.txBytes
            )
              throw new Error('Payment decoder changed captured submission');
            for (const field of ['inputBoxes', 'dataInputs'] as const) {
              if (!(field in original)) continue;
              const boxes = (
                decoded as PaymentTransaction & {
                  inputBoxes?: Uint8Array[];
                  dataInputs?: Uint8Array[];
                }
              )[field];
              const expected = original[field] as string[];
              if (
                !Array.isArray(boxes) ||
                boxes.length !== expected.length ||
                Array.from(
                  { length: expected.length },
                  (_, index) => index,
                ).some(
                  (index) =>
                    !Object.prototype.hasOwnProperty.call(boxes, index) ||
                    !(boxes[index] instanceof Uint8Array) ||
                    Buffer.from(boxes[index]).toString('hex') !==
                      expected[index],
                )
              )
                throw new Error(
                  'Payment decoder changed captured auxiliary input',
                );
            }
            return decoded;
          },
          /** Closes this payment submission authority against later actions. */
          close: () => {
            closed = true;
          },
          /** Invokes one ready payment submission start under prepared scanner authority. */
          authorizeSubmit: async (start: () => void) => {
            assertLive();
            if (!initial || initial.kind !== 'ready' || started)
              throw new Error('Payment submission cannot start');
            started = true;
            await bound.withAction(async () => {
              assertLive();
              startedPermit =
                await initial.prepareUnderScannerLease(assertLive);
              await startedPermit.authorize(() => {
                assertLive();
                start();
                admitted = true;
              });
              assertLive();
            });
          },
          /** Rechecks payment result authority and supplies manager-owned persistence checks. */
          withResult: async <T>(
            action: (
              expected: SigningRowPreimage,
              authorization?: SigningPersistenceAuthorization,
            ) => Promise<T>,
          ) => {
            assertLive();
            if (
              !initial ||
              resultUsed ||
              (initial.kind === 'ready' && (!admitted || !startedPermit))
            )
              throw new Error('Payment result was not admitted');
            resultUsed = true;
            const current = await refresh();
            return bound.withAction(async (expected) => {
              // Fresh execution or unspent qualification; never a second POST.
              const fresh = await current!.prepareUnderScannerLease(assertLive);
              assertLive();
              const permit =
                current!.kind === 'observed' ? fresh : startedPermit!;
              return action(
                expected,
                Object.freeze({
                  assertActive: assertLive,
                  assertBefore: permit.assertBefore,
                  assertAfter: permit.assertAfter,
                }),
              );
            });
          },
          /** Runs legacy payment submission only while its route remains unqualified. */
          withLegacyAction: async <T>(
            action: (expected: SigningRowPreimage) => Promise<T>,
          ) => {
            if (initial)
              throw new Error('Qualified payment cannot use legacy submission');
            await refresh();
            return bound.withAction(async (expected) => {
              await refresh();
              return action(expected);
            });
          },
        });
      },
      /** Runs observed payment completion with bounded scanner and persistence authority. */
      withPaymentCompletion: async <T>(
        timeoutMs: number | undefined,
        action: (
          expected: SigningRowPreimage,
          authorization?: SigningPersistenceAuthorization,
        ) => Promise<T>,
      ): Promise<T> => {
        const entered = performance.now();
        if (
          !hasExecutionAuthority(preimage) ||
          preimage.status !== 'sent' ||
          !this.dependencies.bindPayment
        )
          throw new Error('Payment completion authority is unavailable');
        const initial = await this.dependencies.bindPayment(
          preimage,
          'completion',
        );
        assertPaymentBinding(initial, 'completion');
        if (isAvalancheManagementRow(preimage) && !initial)
          throw new Error(
            'Native management completion authority is unavailable',
          );
        if (
          initial &&
          (initial.purpose !== 'completion' ||
            initial.kind !== 'observed' ||
            typeof timeoutMs !== 'number' ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 2147483647)
        )
          throw new Error('Invalid observed payment completion authority');
        const deadline = initial ? entered + timeoutMs! : Infinity;
        let closed = false;
        /** Rejects closure or expiration of the captured payment completion authority. */
        const assertLive = () => {
          if (closed || performance.now() >= deadline)
            throw new Error('Payment completion authority expired');
        };
        try {
          assertLive();
          return await bound.withAction(async (expected) => {
            assertLive();
            if (initial === undefined) {
              if (
                (await this.dependencies.bindPayment!(
                  preimage,
                  'completion',
                )) !== undefined
              )
                throw new Error('Payment completion route changed');
              return action(expected);
            }
            const checks = await initial.prepareUnderScannerLease(assertLive);
            assertLive();
            return action(
              expected,
              Object.freeze({ ...checks, assertActive: assertLive }),
            );
          });
        } finally {
          closed = true;
        }
      },
      /** Checks the captured payment row and supplies bounded invalidation evidence. */
      withPaymentInvalidation: async <T>(
        checked: TransactionCheckPreimage,
        timeoutMs: number | undefined,
        action: (
          expected: TransactionCheckPreimage,
          authorization: SigningPersistenceAuthorization | undefined,
          details:
            | Readonly<{ reason: string; unexpected: boolean }>
            | undefined,
        ) => Promise<T>,
      ): Promise<T> => {
        const entered = performance.now();
        const captured = Object.freeze({ ...checked });
        if (
          !hasExecutionAuthority(preimage) ||
          !['sent', 'sign-failed'].includes(preimage.status) ||
          !this.dependencies.bindPaymentInvalidation ||
          Object.entries(preimage).some(
            ([key, value]) =>
              captured[key as keyof TransactionCheckPreimage] !== value,
          ) ||
          !Number.isSafeInteger(captured.lastCheck) ||
          captured.lastCheck < 0 ||
          (captured.lastStatusUpdate !== null &&
            typeof captured.lastStatusUpdate !== 'string') ||
          typeof captured.failedInSign !== 'boolean' ||
          !Number.isSafeInteger(captured.signFailedCount) ||
          captured.signFailedCount < 0
        )
          throw new Error('Invalid payment invalidation preimage or binder');
        const initial =
          await this.dependencies.bindPaymentInvalidation(captured);
        if (isAvalancheManagementRow(preimage) && !initial)
          throw new Error(
            'Native management invalidation authority is unavailable',
          );
        if (
          initial !== undefined &&
          (initial === null ||
            typeof initial !== 'object' ||
            initial.purpose !== 'invalidation' ||
            !text(initial.identity) ||
            typeof initial.prepareUnderScannerLease !== 'function' ||
            typeof initial.payment !== 'function')
        )
          throw new Error('Invalid payment invalidation authority');
        if (
          initial !== undefined &&
          (typeof timeoutMs !== 'number' ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 2147483647)
        )
          throw new Error('Invalid payment invalidation timeout');
        const deadline =
          initial === undefined ? Infinity : entered + timeoutMs!;
        let closed = false;
        /** Rejects closure or expiration of the captured payment invalidation authority. */
        const assertLive = () => {
          if (closed || performance.now() >= deadline)
            throw new Error('Payment invalidation authority expired');
        };
        try {
          assertLive();
          return await bound.withAction(async () => {
            assertLive();
            if (initial === undefined) {
              if (
                (await this.dependencies.bindPaymentInvalidation!(captured)) !==
                undefined
              )
                throw new Error('Payment invalidation route changed');
              return action(captured, undefined, undefined);
            }
            const prepared = await initial.prepareUnderScannerLease(assertLive);
            assertLive();
            if (
              !prepared ||
              !text(prepared.reason) ||
              typeof prepared.unexpected !== 'boolean' ||
              typeof prepared.assertBefore !== 'function' ||
              typeof prepared.assertAfter !== 'function'
            )
              throw new Error('Invalid payment invalidation evidence');
            return action(
              captured,
              Object.freeze({
                assertActive: assertLive,
                /** Passes the captured invalidation metadata into the owned-manager before check. */
                assertBefore: (
                  manager: EntityManager,
                  row: SigningRowPreimage,
                ) => prepared.assertBefore(manager, { ...captured, ...row }),
                /** Checks invalidation counter policy and forwards the actual transition to persistence checks. */
                assertAfter: async (
                  manager: EntityManager,
                  row: SigningRowPreimage,
                  transition?: { unexpected: boolean },
                ) => {
                  if (
                    !transition ||
                    transition.unexpected !== prepared.unexpected
                  )
                    throw new Error(
                      'Payment invalidation counter policy changed',
                    );
                  await prepared.assertAfter(
                    manager,
                    { ...captured, ...row },
                    transition,
                  );
                },
              }),
              Object.freeze({
                reason: prepared.reason,
                unexpected: prepared.unexpected,
              }),
            );
          });
        } finally {
          closed = true;
        }
      },
      /** Prepares bounded ready, observed or legacy reward submission and result checks. */
      prepareRewardSubmission: async (
        timeoutMs: number,
      ): Promise<PreparedRewardSubmission> => {
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 2147483647 ||
          preimage.type !== TransactionType.reward ||
          !['signed', 'sent'].includes(preimage.status) ||
          !this.dependencies.bindReward
        )
          throw new Error('Reward submission authority is unavailable');
        const deadline = performance.now() + timeoutMs;
        let closed = false;
        let started = false;
        let admitted = false;
        let resultUsed = false;
        /** Rejects closure or expiration of the captured reward submission authority. */
        const assertLive = () => {
          if (closed || performance.now() >= deadline)
            throw new Error('Reward submission authority expired');
        };
        const initial = await this.dependencies.bindReward(
          preimage,
          statuses,
          'submission',
        );
        assertLive();
        if (initial && !initial.submission)
          throw new Error('Reward submission authority is missing');
        /** Rebinds reward submission and rejects changed identity or observed state. */
        const refresh = async () => {
          assertLive();
          const current = await this.dependencies.bindReward!(
            preimage,
            statuses,
            'submission',
          );
          assertLive();
          if (
            initial
              ? !current?.submission ||
                current.submission.identity !== initial.submission!.identity ||
                (initial.submission!.kind === 'observed' &&
                  current.submission.kind !== 'observed')
              : current !== undefined
          )
            throw new Error('Reward submission authority changed');
          return current;
        };
        return Object.freeze({
          kind: initial?.submission!.kind ?? 'legacy',
          /** Closes this reward submission authority against later actions. */
          close: () => {
            closed = true;
          },
          /** Invokes one ready reward submission start under prepared scanner authority. */
          authorizeSubmit: async (start: () => void) => {
            assertLive();
            if (started || initial?.submission?.kind !== 'ready')
              throw new Error('Reward submission cannot start');
            started = true;
            // Initial binding happens outside scanner ownership. All subsequent
            // RPC and SQL checks run under the single decisive scanner lease.
            await bound.withAction(async () => {
              assertLive();
              await initial.submission!.authorizeUnderScannerLease(() => {
                assertLive();
                start();
                admitted = true;
              });
              assertLive();
            });
          },
          /** Rechecks reward submission authority and supplies manager-owned persistence checks. */
          withResult: async <T>(
            action: (
              expected: SigningRowPreimage,
              authorization?: SigningPersistenceAuthorization,
            ) => Promise<T>,
          ) => {
            if (!initial)
              throw new Error(
                'Legacy reward has no qualified result authority',
              );
            if (
              resultUsed ||
              (initial.submission!.kind === 'ready' && !admitted)
            )
              throw new Error('Reward result was not admitted');
            resultUsed = true;
            // Submission snapshots are provisional, and are checked again
            // using only the DAO's owned manager before the status transition.
            const current = await refresh();
            return bound.withAction(async (expected) => {
              assertLive();
              const checks =
                await current!.preparePersistenceUnderScannerLease(
                  'submission',
                );
              assertLive();
              return action(
                expected,
                Object.freeze({ ...checks, assertActive: assertLive }),
              );
            });
          },
          /** Runs legacy reward submission only while its route remains unqualified. */
          withLegacyAction: async <T>(
            action: (expected: SigningRowPreimage) => Promise<T>,
          ) => {
            if (initial)
              throw new Error('Qualified reward cannot use legacy submission');
            return bound.withAction(async (expected) => {
              await refresh();
              return action(expected);
            });
          },
        });
      },
      /** Checks failed-payment recovery evidence and forwards actual persistence row images. */
      withPaymentRecovery: async <T>(
        checked: TransactionCheckPreimage,
        timeoutMs: number | undefined,
        action: (
          expected: TransactionCheckPreimage,
          signedJson: string | undefined,
          authorization: SigningPersistenceAuthorization | undefined,
        ) => Promise<T>,
      ): Promise<T> => {
        const entered = performance.now();
        const captured = Object.freeze({ ...checked });
        if (
          !hasExecutionAuthority(preimage) ||
          preimage.status !== 'sign-failed' ||
          !this.dependencies.bindPaymentRecovery ||
          Object.entries(preimage).some(
            ([key, value]) =>
              captured[key as keyof TransactionCheckPreimage] !== value,
          ) ||
          !Number.isSafeInteger(captured.lastCheck) ||
          captured.lastCheck < 0 ||
          (captured.lastStatusUpdate !== null &&
            typeof captured.lastStatusUpdate !== 'string') ||
          typeof captured.failedInSign !== 'boolean' ||
          !Number.isSafeInteger(captured.signFailedCount) ||
          captured.signFailedCount < 0
        )
          throw new Error('Invalid payment recovery preimage or binder');
        const initial = await this.dependencies.bindPaymentRecovery(captured);
        if (isAvalancheManagementRow(preimage) && !initial)
          throw new Error(
            'Native management recovery authority is unavailable',
          );
        if (
          initial !== undefined &&
          (initial === null ||
            typeof initial !== 'object' ||
            initial.purpose !== 'recovery' ||
            !text(initial.identity) ||
            typeof initial.prepareUnderScannerLease !== 'function')
        )
          throw new Error('Invalid payment recovery authority');
        if (
          initial !== undefined &&
          (typeof timeoutMs !== 'number' ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 2147483647)
        )
          throw new Error('Invalid payment recovery timeout');
        const deadline =
          initial === undefined ? Infinity : entered + timeoutMs!;
        let closed = false;
        /** Rejects closure or expiration of the captured payment recovery authority. */
        const assertLive = () => {
          if (closed || performance.now() >= deadline)
            throw new Error('Payment recovery authority expired');
        };
        try {
          assertLive();
          return await bound.withAction(async () => {
            assertLive();
            if (initial === undefined) {
              if (
                (await this.dependencies.bindPaymentRecovery!(captured)) !==
                undefined
              )
                throw new Error('Payment recovery route changed');
              return action(captured, undefined, undefined);
            }
            const prepared = await initial.prepareUnderScannerLease(assertLive);
            assertLive();
            if (
              !prepared ||
              !text(prepared.signedJson) ||
              typeof prepared.assertBefore !== 'function' ||
              typeof prepared.assertAfter !== 'function'
            )
              throw new Error('Invalid payment recovery evidence');
            // Recovery's DAO supplies the actual twelve-field afterimage, including
            // its generated timestamp. Do not replace it with the captured metadata.
            return action(
              captured,
              prepared.signedJson,
              Object.freeze({
                assertActive: assertLive,
                /** Forwards the actual recovery row into the owned-manager before check. */
                assertBefore: (
                  manager: EntityManager,
                  row: SigningRowPreimage,
                ) =>
                  prepared.assertBefore(
                    manager,
                    row as TransactionCheckPreimage,
                  ),
                /** Forwards the actual recovery afterimage into the owned-manager after check. */
                assertAfter: (
                  manager: EntityManager,
                  row: SigningRowPreimage,
                ) =>
                  prepared.assertAfter(
                    manager,
                    row as TransactionCheckPreimage,
                  ),
              }),
            );
          });
        } finally {
          closed = true;
        }
      },
      /** Runs reward recovery with optional signed bytes and persistence checks under captured ownership. */
      withRewardRecovery: async <T>(
        action: (
          expected: SigningRowPreimage,
          signedJson: string | undefined,
          authorization: SigningPersistenceAuthorization | undefined,
        ) => Promise<T>,
        assertOwnership: () => void = () => undefined,
      ): Promise<T> => {
        assertOwnership();
        if (
          preimage.type !== TransactionType.reward ||
          preimage.status !== 'sign-failed'
        )
          throw new Error('Invalid reward recovery phase');
        if (!this.dependencies.bindReward)
          throw new Error('Reward recovery authority is unavailable');
        const reward = await (recoveryPreparation ??=
          this.dependencies.bindReward(preimage, statuses, 'recovery'));
        assertOwnership();
        return bound.withAction(async (expected) => {
          assertOwnership();
          if (!reward) {
            if (
              await this.dependencies.bindReward!(
                preimage,
                statuses,
                'recovery',
              )
            )
              throw new Error('Reward recovery route changed');
            assertOwnership();
            return action(expected, undefined, undefined);
          }
          if (!reward.recoveredSignedJson)
            throw new Error('Recovered signed reward is missing');
          const checks =
            await reward.preparePersistenceUnderScannerLease('recovery');
          assertOwnership();
          return action(
            expected,
            reward.recoveredSignedJson,
            Object.freeze({
              ...checks,
              assertActive: assertOwnership,
            }),
          );
        });
      },
      /** Memoizes signing-phase authority tied to the row and any reward settlement. */
      prepareSigningAuthorization: (): Promise<PreparedSigningAuthorization> =>
        (signingPreparation ??= (async () => {
          const reward = await prepareReward();
          const signingBindingId = Buffer.from(
            blake2b(
              canonical({ bindingId, reward: reward?.authorityId ?? null }),
              undefined,
              32,
            ),
          ).toString('hex');
          /** Runs one known signing phase synchronously against an in-sign row. */
          const execute = <T>(
            phase: SigningActionPhase,
            action: () => T,
            expected: SigningRowPreimage,
          ): T => {
            if (
              !['queue', 'commitment', 'sign', 'outbound', 'result'].includes(
                phase,
              )
            )
              throw new Error('Unknown signing action phase');
            if (expected.status !== 'in-sign')
              throw new Error('Signing action requires an in-sign transaction');
            const result = action();
            if (
              result &&
              typeof (result as unknown as PromiseLike<unknown>).then ===
                'function'
            )
              throw new Error('Signing action must be synchronous');
            return result;
          };
          return Object.freeze({
            bindingId: signingBindingId,
            /** Authorizes a synchronous signing phase through reward or captured row checks. */
            withAction: <T>(
              phase: SigningActionPhase,
              action: () => T,
            ): Promise<T> =>
              reward
                ? safety.withAction(() =>
                    reward.checkUnderScannerLease(phase, (expected) =>
                      execute(phase, action, expected),
                    ),
                  )
                : bound.withAction(async (expected) => {
                    // Reclassify legacy rewards: new durable Avalanche evidence must
                    // not inherit a previously unqualified signing authorization.
                    if (
                      preimage.type === TransactionType.reward &&
                      (await this.dependencies.bindReward!(preimage, statuses))
                    )
                      throw new Error('Reward signing route changed');
                    return execute(phase, action, expected);
                  }, 'signing'),
          });
        })()),
      /** Supplies purpose-specific persistence checks under the captured safety and ownership. */
      withPersistence: async <T>(
        purpose: SigningPersistencePurpose,
        action: (
          expected: SigningRowPreimage,
          authorization: SigningPersistenceAuthorization,
        ) => Promise<T>,
        assertOwnership: () => void = () => undefined,
        signedJson?: string,
      ): Promise<T> => {
        assertOwnership();
        if (
          hasExecutionAuthority(preimage) &&
          ['completion', 'invalidation', 'recovery'].includes(purpose)
        )
          throw new Error(`Payment ${purpose} requires explicit authority`);
        const reward = await (purpose === 'invalidation' &&
        preimage.type === TransactionType.reward
          ? (invalidationPreparation ??= (() => {
              if (!this.dependencies.bindReward)
                throw new Error('Reward invalidation authority is unavailable');
              return this.dependencies.bindReward(
                preimage,
                statuses,
                'invalidation',
              );
            })())
          : prepareReward());
        return bound.withAction(
          async (expected) => {
            assertOwnership();
            if (
              ![
                'queue',
                'result',
                'failure',
                'completion',
                'invalidation',
              ].includes(purpose) ||
              (reward &&
                (purpose === 'invalidation'
                  ? !['sent', 'sign-failed'].includes(expected.status)
                  : purpose === 'completion'
                    ? expected.status !== 'sent'
                    : purpose === 'queue'
                      ? !['approved', 'sign-failed'].includes(expected.status)
                      : expected.status !== 'in-sign'))
            )
              throw new Error('Invalid signing persistence phase');
            if (
              !reward &&
              preimage.type === TransactionType.reward &&
              (await this.dependencies.bindReward!(
                preimage,
                statuses,
                purpose === 'invalidation' ? purpose : undefined,
              ))
            )
              throw new Error('Reward persistence route changed');
            if (isAvalancheManagementRow(preimage) && purpose === 'result') {
              if (!this.dependencies.verifyManagementResult || !signedJson)
                throw new Error(
                  'Avalanche management result authority is unavailable',
                );
              await this.dependencies.verifyManagementResult(
                expected,
                signedJson,
              );
            }
            const checks = reward
              ? await reward.preparePersistenceUnderScannerLease(
                  purpose,
                  signedJson,
                )
              : isAvalancheManagementRow(preimage)
                ? (() => {
                    if (!this.dependencies.prepareManagementPersistence)
                      throw new Error(
                        'Native management persistence authority is unavailable',
                      );
                    return this.dependencies.prepareManagementPersistence(
                      expected,
                      purpose,
                      signedJson,
                    );
                  })()
                : {
                    /** Supplies the no-op persistence before check for an unqualified legacy route. */
                    assertBefore: async () => undefined,
                    /** Supplies the no-op persistence after check for an unqualified legacy route. */
                    assertAfter: async () => undefined,
                  };
            assertOwnership();
            return action(
              expected,
              Object.freeze({ ...checks, assertActive: assertOwnership }),
            );
          },
          isAvalancheManagementRow(preimage)
            ? purpose === 'queue'
              ? 'queue'
              : purpose === 'result'
                ? 'signing'
                : 'identity'
            : 'identity',
        );
      },
      /** Rechecks current row identity and eligible status under captured transaction safety. */
      withAction: async <T>(
        action: (expected: SigningRowPreimage) => T | Promise<T>,
        purpose: AvalancheManagementPurpose = 'identity',
      ): Promise<T> =>
        safety.withAction(async () => {
          const current = await this.dependencies.getTx(preimage.txId);
          if (!current) throw new Error('Signing transaction row is missing');
          const expected = snapshot(current);
          if (
            !statuses.includes(expected.status) ||
            expected.txId !== preimage.txId ||
            expected.chain !== preimage.chain ||
            expected.type !== preimage.type ||
            expected.eventId !== preimage.eventId ||
            expected.orderId !== preimage.orderId ||
            expected.requiredSign !== preimage.requiredSign ||
            canonical(model(expected.txJson)) !== unsignedJson
          )
            throw new Error('Signing transaction row changed');
          return action(expected);
        }, purpose),
    });
    this.owned.add(bound);
    return bound;
  };

  /** The processor owns timers and capacity; every action checks this lease anew. */
  beginAttempt(
    bound: BoundTransactionContext,
    timeoutMs: number,
    isCurrent: () => boolean,
  ): RevocableSigningAttempt {
    if (!this.owned.has(bound))
      throw new Error('Foreign signing transaction context');
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2147483647 ||
      typeof isCurrent !== 'function'
    )
      throw new Error('Invalid signing attempt bounds or ownership predicate');
    const deadline = performance.now() + timeoutMs;
    let revoked = false;
    /** Rejects an expired, revoked or replaced signing attempt. */
    const assertLive = () => {
      if (revoked || performance.now() >= deadline || !isCurrent())
        throw new Error('Signing attempt expired, revoked or replaced');
    };
    const attempt: RevocableSigningAttempt = Object.freeze({
      ...bound,
      /** Refuses HTTP reward submission from a signing-only attempt. */
      prepareRewardSubmission: async () => {
        throw new Error('Signing attempts cannot authorize HTTP submission');
      },
      /** Refuses HTTP payment submission from a signing-only attempt. */
      preparePaymentSubmission: async () => {
        throw new Error('Signing attempts cannot authorize HTTP submission');
      },
      /** Refuses payment completion from a signing-only attempt. */
      withPaymentCompletion: async () => {
        throw new Error('Signing attempts cannot authorize payment completion');
      },
      /** Refuses payment invalidation from a signing-only attempt. */
      withPaymentInvalidation: async () => {
        throw new Error('Signing attempt cannot invalidate a payment');
      },
      /** Refuses payment recovery from a signing-only attempt. */
      withPaymentRecovery: async () => {
        throw new Error('Signing attempt cannot recover a payment');
      },
      bindingId: Buffer.from(
        blake2b(`${bound.bindingId}:${randomUUID()}`, undefined, 32),
      ).toString('hex'),
      /** Permanently revokes this local signing attempt. */
      revoke: () => {
        revoked = true;
      },
      /** Adds attempt-liveness checks to the bound reward recovery action. */
      withRewardRecovery: <T>(
        action: (
          expected: SigningRowPreimage,
          signedJson: string | undefined,
          authorization: SigningPersistenceAuthorization | undefined,
        ) => Promise<T>,
        assertOwnership: () => void = () => undefined,
      ): Promise<T> =>
        bound.withRewardRecovery(action, () => {
          assertLive();
          assertOwnership();
        }),
      /** Adds attempt-liveness and caller-ownership checks to bound persistence. */
      withPersistence: <T>(
        purpose: SigningPersistencePurpose,
        action: (
          expected: SigningRowPreimage,
          authorization: SigningPersistenceAuthorization,
        ) => Promise<T>,
        assertOwnership: () => void = () => undefined,
        signedJson?: string,
      ): Promise<T> =>
        bound.withPersistence(
          purpose,
          action,
          () => {
            assertLive();
            assertOwnership();
          },
          signedJson,
        ),
      /** Binds prepared signing actions to this live, uniquely identified attempt. */
      prepareSigningAuthorization:
        async (): Promise<PreparedSigningAuthorization> => {
          assertLive();
          const prepared = await bound.prepareSigningAuthorization();
          assertLive();
          return Object.freeze({
            bindingId: Buffer.from(
              blake2b(
                `${attempt.bindingId}:${prepared.bindingId}`,
                undefined,
                32,
              ),
            ).toString('hex'),
            /** Rechecks attempt liveness before executing the prepared signing action. */
            withAction: <T>(
              phase: SigningActionPhase,
              action: () => T,
            ): Promise<T> => {
              assertLive();
              return prepared.withAction(phase, () => {
                assertLive();
                return action();
              });
            },
          });
        },
      /** Runs an in-sign action after rechecking the attempt and current bound row. */
      withAction: async <T>(
        action: (expected: SigningRowPreimage) => T | Promise<T>,
        purpose: AvalancheManagementPurpose = 'identity',
      ): Promise<T> => {
        assertLive();
        return bound.withAction((expected) => {
          assertLive();
          if (expected.status !== 'in-sign')
            throw new Error('Signing attempt requires an in-sign transaction');
          return action(expected);
        }, purpose);
      },
    });
    this.owned.add(attempt);
    return attempt;
  }

  /** Runs an action with an owned transaction bound to the local asynchronous context. */
  run<T>(bound: BoundTransactionContext, action: () => T): T {
    if (!this.owned.has(bound))
      throw new Error('Foreign signing transaction context');
    return this.context.run(bound, action);
  }

  /** Returns the active local transaction context or rejects its absence. */
  current(): BoundTransactionContext {
    const bound = this.context.getStore();
    if (!bound) throw new Error('No local signing transaction context');
    return bound;
  }

  /** Supplies the current owned transaction binding to the TSS authorization registry. */
  withTssKey<T>(key: TssSigningKey, action: () => T): T | Promise<T> {
    const current = this.current();
    const management = isAvalancheManagementRow(current.preimage);
    return this.dependencies.registry.withContext(
      key,
      management
        ? Object.freeze({
            bindingId: current.bindingId,
            withAction: <R>(invoke: () => Promise<R>) =>
              current.withAction(invoke, 'signing'),
          })
        : current,
      action,
    );
  }

  /** Rejects changed signed metadata and persists the result through bound authority. */
  persistResult = async (
    bound: BoundTransactionContext,
    signed: PaymentTransaction,
    persist: (
      signedJson: string,
      expected: SigningRowPreimage,
      authorization?: SigningPersistenceAuthorization,
    ) => Promise<void>,
  ): Promise<void> => {
    if (!this.owned.has(bound))
      throw new Error('Foreign signing transaction context');
    // Capture before a database or safety lookup permits caller mutation.
    const signedModel = model(signed.toJson());
    const signedJson = canonical(signedModel);
    const original = model(bound.unsignedJson);
    delete original.txBytes;
    delete signedModel.txBytes;
    if (canonical(original) !== canonical(signedModel))
      throw new Error('Signed transaction metadata or auxiliary input changed');
    await bound.withPersistence(
      'result',
      (expected, authorization) => persist(signedJson, expected, authorization),
      undefined,
      signedJson,
    );
  };
}
