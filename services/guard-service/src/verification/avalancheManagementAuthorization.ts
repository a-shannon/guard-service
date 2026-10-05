import { blake2b } from 'blakejs';
import { Transaction } from 'ethers';

import {
  AssetBalance,
  ChainUtils,
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';

import type { GuardsAvalancheConfig } from '../configs/guardsAvalancheConfigs';
import type { SigningTransactionRow } from '../signing/transactionSigningContext';
import type {
  AvalancheManagementPurpose,
  AvalancheTransactionIntent,
  BoundAvalancheManagementAuthority,
} from '../utils/avalancheTransactionSafety';

export interface AvalancheManagementPolicy {
  readonly config: GuardsAvalancheConfig;
  readonly manualRequests: boolean;
  readonly arbitraryRequests: boolean;
  readonly guardsCount: number;
  readonly cold?: AvalancheColdPolicy;
}

export interface AvalancheColdPolicy {
  readonly low: bigint;
  readonly high: bigint;
  readonly tokenId?: string;
  readonly nativeLow?: bigint;
}

export interface AvalancheManagementOrder {
  readonly id: string;
  readonly chain: string;
  readonly status: string;
  readonly orderJson: string;
}

export interface AvalancheManagementColdState {
  readonly locked: AssetBalance;
  readonly required: AssetBalance;
  readonly forbiddenTokens: readonly string[];
  readonly activeTxIds: readonly string[];
}

export interface AvalancheManagementDependencies {
  getPolicy(
    intent: Readonly<AvalancheTransactionIntent>,
  ): AvalancheManagementPolicy | undefined;
  getChain(): AvalancheChain;
  getTx(id: string): Promise<SigningTransactionRow | null>;
  decode(json: string): PaymentTransaction;
  getOrder(id: string): Promise<AvalancheManagementOrder | null>;
  getOrderTxIds(id: string): Promise<readonly string[]>;
  getColdState(
    payment: PaymentTransaction,
  ): Promise<AvalancheManagementColdState>;
  assertTokenMapUnchanged(): void;
}

/** Enforces the selected asset trigger and separate AVAX reserve for exact inputs. */
export const assertAvalancheColdReserve = (
  state: AvalancheManagementColdState,
  threshold: AvalancheColdPolicy,
  txId: string,
): void => {
  if (
    !state ||
    !threshold ||
    typeof threshold.low !== 'bigint' ||
    typeof threshold.high !== 'bigint' ||
    threshold.low < 0n ||
    threshold.high <= threshold.low ||
    typeof state.locked?.nativeToken !== 'bigint' ||
    typeof state.required?.nativeToken !== 'bigint' ||
    !Array.isArray(state.locked.tokens) ||
    !Array.isArray(state.required.tokens) ||
    state.locked.nativeToken < 0n ||
    [...state.locked.tokens, ...state.required.tokens].some(
      (token) =>
        !token ||
        typeof token.id !== 'string' ||
        !/^0x[0-9a-f]{40}$/.test(token.id) ||
        typeof token.value !== 'bigint' ||
        token.value < 0n,
    ) ||
    new Set(state.locked.tokens.map((token) => token.id)).size !==
      state.locked.tokens.length ||
    !Array.isArray(state.forbiddenTokens) ||
    state.forbiddenTokens.some((id) => typeof id !== 'string') ||
    !Array.isArray(state.activeTxIds) ||
    state.required.nativeToken <= 0n ||
    state.forbiddenTokens.includes('avax') ||
    state.activeTxIds.some((id) => typeof id !== 'string' || id !== txId)
  )
    throw new Error('Avalanche cold transfer reserve is not authorized');
  let locked = state.locked.nativeToken;
  let required = state.required.nativeToken;
  if (threshold.tokenId !== undefined) {
    if (
      typeof threshold.tokenId !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(threshold.tokenId) ||
      typeof threshold.nativeLow !== 'bigint' ||
      threshold.nativeLow < 0n ||
      state.locked.nativeToken - state.required.nativeToken <
        threshold.nativeLow ||
      state.required.tokens.length !== 1 ||
      state.required.tokens[0].id !== threshold.tokenId ||
      state.required.tokens[0].value <= 0n ||
      state.forbiddenTokens.includes(threshold.tokenId)
    )
      throw new Error('Avalanche cold transfer reserve is not authorized');
    const selected = state.locked.tokens.find(
      (token) => token.id === threshold.tokenId,
    );
    if (!selected)
      throw new Error('Avalanche cold transfer reserve is not authorized');
    locked = selected.value;
    required = state.required.tokens[0].value;
  } else if (state.required.tokens.length !== 0) {
    throw new Error('Avalanche cold transfer reserve is not authorized');
  }
  if (
    locked <= threshold.high ||
    locked - required < threshold.low ||
    locked - required > threshold.high
  )
    throw new Error('Avalanche cold transfer reserve is not authorized');
};

/** Encodes public policy inputs and bigint amounts without losing integer precision. */
const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? { bigint: item.toString() } : item,
  );

/** Captures the same admission primitives for full DAO entities and narrow ports. */
const captureRow = (row: SigningTransactionRow) =>
  Object.freeze({
    txId: row.txId,
    txJson: row.txJson,
    chain: row.chain,
    type: row.type,
    status: row.status,
    requiredSign: row.requiredSign,
    event: row.event ? Object.freeze({ id: row.event.id }) : null,
    order: row.order ? Object.freeze({ id: row.order.id }) : null,
  });

/** Captures mapped management authority independently of a pre-transfer balance. */
export class AvalancheManagementAuthorization {
  /** Captures the dependencies used by subsequent authorization checks. */
  constructor(private readonly dependencies: AvalancheManagementDependencies) {}

  /** Refuses a result whose mapped signed body or recovered lock signer changed. */
  checkSignedResult = async (
    intent: Readonly<AvalancheTransactionIntent>,
    signedJson: string,
  ): Promise<void> => {
    const captured = Object.freeze({ ...intent });
    const current = await this.read(captured);
    const original = Transaction.from('0x' + captured.txBytes);
    const signed = this.dependencies.decode(signedJson);
    const raw = Transaction.from(
      '0x' + Buffer.from(signed.txBytes).toString('hex'),
    );
    if (
      current.row.status !== 'in-sign' ||
      original.isSigned() ||
      !raw.isSigned() ||
      raw.unsignedSerialized !== original.unsignedSerialized ||
      raw.from?.toLowerCase() !==
        current.chain.getChainConfigs().addresses.lock.toLowerCase() ||
      signed.network !== captured.network ||
      signed.txId !== captured.txId ||
      signed.eventId !== captured.eventId ||
      signed.txType !== captured.txType ||
      raw.serialized.slice(2) !== Buffer.from(signed.txBytes).toString('hex') ||
      !current.chain.verifyTransactionExtraConditions(
        signed,
        SigningStatus.Signed,
      )
    )
      throw new Error('Invalid Avalanche management signed result');
    const fresh = await this.read(captured);
    if (
      fresh.chain !== current.chain ||
      fresh.staticAuthority !== current.staticAuthority ||
      fresh.row.status !== 'in-sign'
    )
      throw new Error('Avalanche management result authority changed');
  };

  /** Checks the exact mapped envelope and existing authenticated database admission. */
  private read = async (intent: Readonly<AvalancheTransactionIntent>) => {
    const inputPolicy = this.dependencies.getPolicy(intent);
    const policy = inputPolicy ? structuredClone(inputPolicy) : undefined;
    const route =
      intent.txType === TransactionType.coldStorage
        ? 'cold'
        : intent.txType === TransactionType.manual
          ? 'manual'
          : intent.txType === TransactionType.arbitrary
            ? 'arbitrary'
            : undefined;
    if (
      !policy ||
      !route ||
      policy.config.enabled !== true ||
      policy.config.routes[route] !== true ||
      (route === 'manual' && policy.manualRequests !== true) ||
      (route === 'arbitrary' && policy.arbitraryRequests !== true)
    )
      throw new Error('Avalanche management route is not authorized');
    this.dependencies.assertTokenMapUnchanged();
    const chain = this.dependencies.getChain();
    if (
      !(chain instanceof AvalancheChain) ||
      chain.CHAIN_ID !== BigInt(policy.config.chainId)
    )
      throw new Error('Avalanche management chain identity changed');
    const configs = chain.getChainConfigs();
    const tx = Transaction.from('0x' + intent.txBytes);
    const payment = new PaymentTransaction(
      intent.network,
      intent.txId,
      intent.eventId,
      Buffer.from(intent.txBytes, 'hex'),
      intent.txType,
    );
    const status = tx.isSigned()
      ? SigningStatus.Signed
      : SigningStatus.UnSigned;
    if (
      intent.network !== 'avalanche' ||
      typeof intent.eventId !== 'string' ||
      (route === 'arbitrary'
        ? !/^[0-9a-f]{64}$/.test(intent.eventId)
        : intent.eventId !== '') ||
      tx.chainId !== chain.CHAIN_ID ||
      tx.type !== 2 ||
      tx.unsignedHash !== intent.txId ||
      !tx.to ||
      /^0x0{40}$/i.test(tx.to) ||
      tx.value < 0n ||
      (tx.value > 0n && tx.data !== '0x' + intent.eventId) ||
      (tx.accessList?.length ?? 0) !== 0 ||
      tx.gasLimit <= 0n ||
      tx.maxFeePerGas === null ||
      tx.maxFeePerGas <= 0n ||
      tx.maxPriorityFeePerGas === null ||
      tx.maxPriorityFeePerGas < 0n ||
      tx.maxPriorityFeePerGas > tx.maxFeePerGas ||
      (tx.isSigned() &&
        tx.from?.toLowerCase() !== configs.addresses.lock.toLowerCase()) ||
      !chain.verifyTransactionExtraConditions(payment, status)
    )
      throw new Error('Invalid Avalanche management envelope');
    const liveRow = await this.dependencies.getTx(intent.txId);
    // Capture primitives before subsequent asynchronous order and policy reads.
    const row = liveRow ? captureRow(liveRow) : null;
    if (
      !row ||
      row.txId !== intent.txId ||
      row.chain !== intent.network ||
      row.type !== intent.txType ||
      row.event !== null ||
      !Number.isSafeInteger(row.requiredSign) ||
      row.requiredSign < 1 ||
      !Number.isSafeInteger(policy.guardsCount) ||
      policy.guardsCount < 1 ||
      row.requiredSign > policy.guardsCount ||
      !['approved', 'in-sign', 'sign-failed', 'signed', 'sent'].includes(
        row.status,
      ) ||
      (route === 'arbitrary'
        ? row.order?.id !== intent.eventId
        : row.order !== null)
    )
      throw new Error('Avalanche management database admission changed');
    const stored = this.dependencies.decode(row.txJson);
    if (
      stored.network !== intent.network ||
      stored.txId !== intent.txId ||
      stored.eventId !== intent.eventId ||
      stored.txType !== intent.txType ||
      Buffer.from(stored.txBytes).toString('hex') !== intent.txBytes
    )
      throw new Error('Avalanche management database bytes changed');
    const nativeOrder = chain.extractTransactionOrder(payment);
    if (
      nativeOrder.length !== 1 ||
      !(tx.value > 0n
        ? nativeOrder[0].assets.nativeToken > 0n &&
          nativeOrder[0].assets.tokens.length === 0 &&
          nativeOrder[0].address.toLowerCase() === tx.to.toLowerCase()
        : nativeOrder[0].assets.nativeToken === 0n &&
          nativeOrder[0].assets.tokens.length === 1 &&
          nativeOrder[0].assets.tokens[0].id === tx.to.toLowerCase() &&
          nativeOrder[0].assets.tokens[0].value > 0n)
    )
      throw new Error('Invalid Avalanche management order');
    let orderJson: string | undefined;
    /** Rejects an order that differs from the captured management request. */
    let assertOrderUnchanged = () => undefined as void;
    if (route === 'arbitrary') {
      const liveOrder = await this.dependencies.getOrder(intent.eventId);
      const order = liveOrder ? Object.freeze({ ...liveOrder }) : null;
      const active = await this.dependencies.getOrderTxIds(intent.eventId);
      if (
        !order ||
        order.id !== intent.eventId ||
        order.chain !== intent.network ||
        !['pending', 'in-process'].includes(order.status) ||
        !Array.isArray(active) ||
        active.some((id) => id !== intent.txId) ||
        (active.length === 0 && order.status !== 'pending')
      )
        throw new Error('Avalanche management approved order changed');
      const expected = ChainUtils.decodeOrder(order.orderJson);
      orderJson = ChainUtils.encodeOrder(expected);
      if (
        expected.length !== 1 ||
        orderJson !== ChainUtils.encodeOrder(nativeOrder)
      )
        throw new Error('Avalanche management approved order does not match');
      assertOrderUnchanged = () => {
        if (encode(liveOrder) !== encode(order))
          throw new Error(
            'Avalanche management approved order changed during preflight',
          );
      };
    }
    if (route === 'cold') {
      const threshold = policy.cold;
      if (
        !threshold ||
        (nativeOrder[0].assets.tokens.length === 0
          ? threshold.tokenId !== undefined
          : threshold.tokenId !== nativeOrder[0].assets.tokens[0].id ||
            typeof threshold.nativeLow !== 'bigint' ||
            threshold.nativeLow < 0n) ||
        typeof threshold.low !== 'bigint' ||
        typeof threshold.high !== 'bigint' ||
        threshold.low < 0n ||
        threshold.high <= threshold.low ||
        nativeOrder[0].address.toLowerCase() !==
          configs.addresses.cold.toLowerCase()
      )
        throw new Error('Avalanche cold policy is invalid');
    }
    const staticAuthority = encode({
      intent,
      config: policy.config,
      addresses: configs.addresses,
      manualRequests: policy.manualRequests,
      arbitraryRequests: policy.arbitraryRequests,
      guardsCount: policy.guardsCount,
      cold: route === 'cold' ? policy.cold : undefined,
      orderJson,
      requiredSign: row.requiredSign,
    });
    // Policy ports are synchronous. Check their live values after every earlier
    // await, and reject mutation of retained entity aliases before returning.
    this.dependencies.assertTokenMapUnchanged();
    if (
      this.dependencies.getChain() !== chain ||
      encode(this.dependencies.getPolicy(intent)) !== encode(policy) ||
      encode(captureRow(liveRow!)) !== encode(row)
    )
      throw new Error(
        'Avalanche management authority changed during preflight',
      );
    assertOrderUnchanged();
    return {
      chain,
      payment,
      row,
      policy,
      route,
      staticAuthority,
      signingStatus: status,
    };
  };

  /** Binds static policy; new effects additionally require current fee and reserve checks. */
  bind = async (
    intent: Readonly<AvalancheTransactionIntent>,
  ): Promise<BoundAvalancheManagementAuthority> => {
    const captured = Object.freeze({ ...intent });
    const initial = await this.read(captured);
    const chain = initial.chain;
    const fingerprint = initial.staticAuthority;
    const authorityId = Buffer.from(
      blake2b(fingerprint, undefined, 32),
    ).toString('hex');
    return Object.freeze({
      authorityId,
      /** Rechecks policy and the admitted row without replaying a consumed cold trigger. */
      checkUnderScannerLease: async (purpose: AvalancheManagementPurpose) => {
        if (!['identity', 'queue', 'signing', 'submission'].includes(purpose))
          throw new Error('Invalid Avalanche management action purpose');
        const current = await this.read(captured);
        if (current.chain !== chain || current.staticAuthority !== fingerprint)
          throw new Error('Avalanche management static authority changed');
        if (purpose === 'identity') return;
        if (
          purpose === 'queue'
            ? !['approved', 'sign-failed'].includes(current.row.status) ||
              current.signingStatus !== SigningStatus.UnSigned
            : purpose === 'signing'
              ? current.row.status !== 'in-sign' ||
                current.signingStatus !== SigningStatus.UnSigned
              : !['signed', 'sent'].includes(current.row.status) ||
                current.signingStatus !== SigningStatus.Signed
        )
          throw new Error('Avalanche management effect status is ineligible');
        if (!(await chain.verifyTransactionFee(current.payment)))
          throw new Error('Avalanche management fee is not authorized');
        if (current.route === 'cold') {
          const state = structuredClone(
            await this.dependencies.getColdState(current.payment),
          );
          const actual = (await chain.getTransactionAssets(current.payment))
            .inputAssets;
          const threshold = current.policy.cold!;
          if (
            typeof actual.nativeToken !== 'bigint' ||
            actual.nativeToken !== state.required.nativeToken ||
            !Array.isArray(actual.tokens) ||
            encode(actual.tokens) !== encode(state.required.tokens)
          )
            throw new Error(
              'Avalanche cold transfer reserve differs from actual transaction assets',
            );
          assertAvalancheColdReserve(state, threshold, captured.txId);
        }
        const fresh = await this.read(captured);
        if (
          fresh.chain !== chain ||
          fresh.staticAuthority !== fingerprint ||
          fresh.row.status !== current.row.status
        )
          throw new Error(
            'Avalanche management authority changed during preflight',
          );
      },
    });
  };
}
