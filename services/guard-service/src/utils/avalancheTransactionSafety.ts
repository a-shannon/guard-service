import { blake2b } from 'blakejs';

import { AvalancheRpcScanner } from '@rosen-bridge/evm-scanner';
import { EventTrigger, TransactionType } from '@rosen-chains/abstract-chain';

export interface AvalancheTransactionIntent {
  readonly network: string;
  readonly eventId: string;
  readonly txType: TransactionType;
  readonly txId: string;
  readonly txBytes: string;
}

export interface AvalancheTransactionEvent {
  id: string;
  eventData: EventTrigger;
}

/** Live transfer checks are required only before signing or transport starts. */
export type AvalancheManagementPurpose =
  | 'identity'
  | 'queue'
  | 'signing'
  | 'submission';

export interface BoundAvalancheManagementAuthority {
  readonly authorityId: string;
  checkUnderScannerLease(purpose: AvalancheManagementPurpose): Promise<void>;
}

export interface BoundAvalancheTransaction {
  readonly bindingId: string;
  readonly intent: Readonly<AvalancheTransactionIntent>;
  withAction<T>(
    action: (intent: Readonly<AvalancheTransactionIntent>) => T | Promise<T>,
    purpose?: AvalancheManagementPurpose,
  ): Promise<T>;
}

const eventFields = [
  'height',
  'fromChain',
  'toChain',
  'fromAddress',
  'toAddress',
  'amount',
  'bridgeFee',
  'networkFee',
  'sourceChainTokenId',
  'targetChainTokenId',
  'sourceTxId',
  'sourceChainHeight',
  'sourceBlockId',
  'WIDsHash',
  'WIDsCount',
] as const satisfies readonly (keyof EventTrigger)[];

/** Narrows a runtime value to the canonical lowercase chain-name format. */
const chainName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);

/** Computes a 32-byte BLAKE2b identifier from the supplied text. */
const digest = (value: string): string =>
  Buffer.from(blake2b(value, undefined, 32)).toString('hex');

/** Binds short dispatch actions to an event and the local scanner's exclusion. */
export class AvalancheTransactionSafety {
  /** Retains event and scanner resolvers for later dispatch qualification. */
  constructor(
    private readonly getEvent: (
      eventId: string,
    ) => Promise<AvalancheTransactionEvent | null | undefined>,
    private readonly getScanner: () => AvalancheRpcScanner | undefined,
    private readonly bindManagement?: (
      intent: Readonly<AvalancheTransactionIntent>,
    ) => Promise<BoundAvalancheManagementAuthority>,
  ) {}

  /** Captures protocol event fields and verifies their identity and transaction route. */
  private readEvent = async (
    intent: Readonly<AvalancheTransactionIntent>,
  ): Promise<Readonly<AvalancheTransactionEvent>> => {
    const resolved = await this.getEvent(intent.eventId);
    if (!resolved?.eventData)
      throw new Error('Transaction event context is missing');
    // Copy only protocol fields, excluding mutable ORM status and metadata.
    const event = Object.freeze(
      Object.fromEntries(
        eventFields.map((field) => [field, resolved.eventData[field]]),
      ),
    ) as Readonly<EventTrigger>;
    for (const field of eventFields) {
      const value = event[field];
      const numeric = ['height', 'sourceChainHeight', 'WIDsCount'].includes(
        field,
      );
      if (
        numeric
          ? typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < 0
          : typeof value !== 'string'
      )
        throw new Error('Transaction event context is malformed');
    }
    if (
      resolved.id !== intent.eventId ||
      typeof event.sourceTxId !== 'string' ||
      event.sourceTxId.trim().length === 0 ||
      digest(event.sourceTxId) !== intent.eventId
    )
      throw new Error('Transaction event identity mismatch');
    if (!chainName(event.fromChain) || !chainName(event.toChain))
      throw new Error('Transaction event chain identity is invalid');
    if (
      (intent.txType === TransactionType.payment &&
        intent.network !== event.toChain) ||
      (intent.txType === TransactionType.reward && intent.network !== 'ergo')
    )
      throw new Error('Transaction network does not match its event route');
    return Object.freeze({ id: resolved.id, eventData: event });
  };

  /** Captures immutable intent and binds event routes to a fingerprint and scanner lease. */
  bindTransaction = async (
    transaction: Readonly<AvalancheTransactionIntent>,
  ): Promise<BoundAvalancheTransaction> => {
    // Capture before the resolver can yield to caller mutations.
    const intent = Object.freeze({
      network: transaction.network,
      eventId: transaction.eventId,
      txType: transaction.txType,
      txId: transaction.txId,
      txBytes: transaction.txBytes,
    });
    if (
      !chainName(intent.network) ||
      typeof intent.txId !== 'string' ||
      intent.txId.trim().length === 0 ||
      typeof intent.txBytes !== 'string' ||
      !/^(?:[0-9a-f]{2})+$/.test(intent.txBytes) ||
      !Object.values(TransactionType).includes(intent.txType)
    )
      throw new Error('Invalid transaction intent');

    const eventRoute =
      intent.txType === TransactionType.payment ||
      intent.txType === TransactionType.reward;
    if (!eventRoute) {
      if (intent.network === 'avalanche') {
        if (!this.bindManagement)
          throw new Error(
            'Avalanche management transaction routes are disabled',
          );
        if (
          typeof intent.eventId !== 'string' ||
          ![
            TransactionType.coldStorage,
            TransactionType.manual,
            TransactionType.arbitrary,
          ].includes(intent.txType) ||
          (intent.txType === TransactionType.arbitrary
            ? !/^[0-9a-f]{64}$/.test(intent.eventId)
            : intent.eventId !== '')
        )
          throw new Error('Invalid Avalanche management route identity');
        /** Rejects a missing or malformed management authority from the resolver. */
        const resolve = async () => {
          const authority = await this.bindManagement!(intent);
          if (
            !authority ||
            typeof authority.authorityId !== 'string' ||
            !/^[0-9a-f]{64}$/.test(authority.authorityId) ||
            typeof authority.checkUnderScannerLease !== 'function'
          )
            throw new Error('Invalid Avalanche management authority');
          return authority;
        };
        const authority = await resolve();
        const authorityId = authority.authorityId;
        const check = authority.checkUnderScannerLease;
        return Object.freeze({
          bindingId: digest(
            JSON.stringify({ intent, management: authorityId }),
          ),
          intent,
          /** Revalidates native management policy under the dedicated scanner exclusion. */
          withAction: async <T>(
            action: (
              intent: Readonly<AvalancheTransactionIntent>,
            ) => T | Promise<T>,
            purpose: AvalancheManagementPurpose = 'identity',
          ): Promise<T> => {
            if (
              !['identity', 'queue', 'signing', 'submission'].includes(purpose)
            )
              throw new Error('Invalid Avalanche management action purpose');
            const scanner = this.getScanner();
            if (!(scanner instanceof AvalancheRpcScanner))
              throw new Error(
                'Avalanche transaction requires its dedicated scanner',
              );
            return scanner.withSafety(async () => {
              const current = await resolve();
              const currentCheck = current.checkUnderScannerLease;
              if (
                authority.authorityId !== authorityId ||
                authority.checkUnderScannerLease !== check ||
                current.authorityId !== authorityId
              )
                throw new Error('Bound Avalanche management authority changed');
              await currentCheck.call(current, purpose);
              if (
                authority.authorityId !== authorityId ||
                authority.checkUnderScannerLease !== check ||
                current.authorityId !== authorityId ||
                current.checkUnderScannerLease !== currentCheck
              )
                throw new Error('Bound Avalanche management authority changed');
              return action(intent);
            });
          },
        });
      }
      return Object.freeze({
        bindingId: digest(JSON.stringify({ intent })),
        intent,
        /** Runs a non-event legacy route with its captured intent and no Avalanche lease. */
        withAction: async <T>(
          action: (
            intent: Readonly<AvalancheTransactionIntent>,
          ) => T | Promise<T>,
        ) => action(intent),
      });
    }
    if (
      typeof intent.eventId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(intent.eventId)
    )
      throw new Error('Transaction event identity is missing or invalid');
    const baseline = await this.readEvent(intent);
    const fingerprint = JSON.stringify(baseline);

    return Object.freeze({
      bindingId: digest(JSON.stringify({ intent, event: baseline })),
      intent,
      /** Rechecks the bound event under the applicable Avalanche scanner exclusion. */
      withAction: async <T>(
        action: (
          intent: Readonly<AvalancheTransactionIntent>,
        ) => T | Promise<T>,
      ): Promise<T> => {
        /** Rejects event fingerprint drift immediately before invoking the action. */
        const execute = async () => {
          const current = await this.readEvent(intent);
          if (JSON.stringify(current) !== fingerprint)
            throw new Error('Bound transaction event changed');
          return action(intent);
        };
        const source = baseline.eventData.fromChain === 'avalanche';
        const destination = baseline.eventData.toChain === 'avalanche';
        if (!source && !destination) return execute();
        const scanner = this.getScanner();
        if (!(scanner instanceof AvalancheRpcScanner))
          throw new Error(
            'Avalanche transaction requires its dedicated scanner',
          );
        return source
          ? scanner.withObservation(
              baseline.eventData.sourceChainHeight,
              baseline.eventData.sourceBlockId,
              execute,
            )
          : scanner.withSafety(execute);
      },
    });
  };

  /** Binds the transaction intent and invokes an action through the resulting lease. */
  withTransaction = async <T>(
    intent: Readonly<AvalancheTransactionIntent>,
    action: (intent: Readonly<AvalancheTransactionIntent>) => T | Promise<T>,
  ): Promise<T> => (await this.bindTransaction(intent)).withAction(action);
}
