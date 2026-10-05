import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';

import type { ThresholdConfig } from '../coldStorage/types';
import type { PreparedAvalancheInputs } from '../jobs/avalancheScannerStartup';
import type {
  AvalancheColdPolicy,
  AvalancheManagementDependencies,
} from './avalancheManagementAuthorization';

/** Resolves the selected wrapped asset thresholds and AVAX gas floor from the existing configuration. */
export const resolveAvalancheColdPolicy = (
  chain: AvalancheChain,
  payment: PaymentTransaction,
  thresholds: ThresholdConfig['avalanche'] | undefined,
): AvalancheColdPolicy => {
  if (
    !thresholds?.tokens ||
    !Object.hasOwn(thresholds.tokens, 'avax') ||
    Object.entries(thresholds.tokens).some(
      ([id, threshold]) =>
        (id !== 'avax' && !chain.supportedTokens.includes(id)) ||
        !threshold ||
        typeof threshold.low !== 'bigint' ||
        typeof threshold.high !== 'bigint' ||
        threshold.low < 0n ||
        threshold.high <= threshold.low,
    )
  )
    throw new Error('Invalid Avalanche cold thresholds');
  const order = chain.extractTransactionOrder(payment);
  if (order.length !== 1)
    throw new Error('Invalid Avalanche cold asset selection');
  const assets = order[0].assets;
  const id =
    assets.tokens.length === 1 && assets.nativeToken === 0n
      ? assets.tokens[0].id
      : assets.tokens.length === 0 && assets.nativeToken > 0n
        ? 'avax'
        : undefined;
  if (!id || !Object.hasOwn(thresholds.tokens, id))
    throw new Error('Missing Avalanche selected cold threshold');
  const selected = { ...thresholds.tokens[id] };
  return id === 'avax'
    ? selected
    : { ...selected, tokenId: id, nativeLow: thresholds.tokens.avax.low };
};

interface Dependencies {
  getInputs(): PreparedAvalancheInputs | undefined;
  getChain(): unknown;
  getDatabase(): {
    getTxById: AvalancheManagementDependencies['getTx'];
    getOrderById: AvalancheManagementDependencies['getOrder'];
    getOrderValidTxs(id: string): Promise<readonly { txId: string }[]>;
    getActiveColdStorageTxsInChain(
      chain: string,
    ): Promise<readonly { txId: string }[]>;
  };
  decode: AvalancheManagementDependencies['decode'];
  getThresholds(): ThresholdConfig;
  getWaitingTokens(): Promise<string[]>;
  manualRequests(): boolean;
  arbitraryRequests(): boolean;
  guardsCount(): number;
}

/** Connects captured startup policy to the current Guard DAO and native chain. */
export const createAvalancheManagementDependencies = (
  input: Dependencies,
): AvalancheManagementDependencies => {
  const ports = Object.freeze({ ...input });
  /** Resolves the registered native adapter, including its sealed token-map check. */
  const chain = () => {
    const current = ports.getChain();
    if (!(current instanceof AvalancheChain))
      throw new Error('Avalanche management adapter is unavailable');
    return current;
  };
  const dependencies: AvalancheManagementDependencies = {
    getPolicy: (intent) => {
      const prepared = ports.getInputs();
      const route =
        intent.txType === TransactionType.coldStorage
          ? 'cold'
          : intent.txType === TransactionType.manual
            ? 'manual'
            : intent.txType === TransactionType.arbitrary
              ? 'arbitrary'
              : undefined;
      if (
        !prepared ||
        !route ||
        prepared.config.enabled !== true ||
        prepared.config.routes[route] !== true
      )
        return undefined;
      let cold;
      if (route === 'cold') {
        const payment = new PaymentTransaction(
          intent.network,
          intent.txId,
          intent.eventId,
          Buffer.from(intent.txBytes, 'hex'),
          intent.txType,
        );
        cold = resolveAvalancheColdPolicy(
          chain(),
          payment,
          ports.getThresholds().avalanche,
        );
      }
      return {
        config: structuredClone(prepared.config),
        manualRequests: ports.manualRequests(),
        arbitraryRequests: ports.arbitraryRequests(),
        guardsCount: ports.guardsCount(),
        cold,
      };
    },
    getChain: chain,
    getTx: (id) => ports.getDatabase().getTxById(id),
    decode: ports.decode,
    getOrder: (id) => ports.getDatabase().getOrderById(id),
    getOrderTxIds: async (id) =>
      (await ports.getDatabase().getOrderValidTxs(id)).map((row) => row.txId),
    getColdState: async (payment) => {
      const current = chain();
      const database = ports.getDatabase();
      const [locked, assets, forbiddenTokens, active] = await Promise.all([
        current.getLockAddressAssets(),
        current.getTransactionAssets(payment),
        ports.getWaitingTokens(),
        database.getActiveColdStorageTxsInChain('avalanche'),
      ]);
      if (chain() !== current || ports.getDatabase() !== database)
        throw new Error('Avalanche cold dependency changed during preflight');
      return structuredClone({
        locked,
        required: assets.inputAssets,
        forbiddenTokens,
        activeTxIds: active.map((row) => row.txId),
      });
    },
    assertTokenMapUnchanged: () => {
      chain();
    },
  };
  return Object.freeze(dependencies);
};
