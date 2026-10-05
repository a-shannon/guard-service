import { Interface, SigningKey, Transaction } from 'ethers';

import type { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  ChainUtils,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import {
  AVALANCHE_TX_EXTRACTOR,
  AvalancheRpcNetwork,
} from '@rosen-chains/avalanche-rpc';
import { transferABI } from '@rosen-chains/evm';

import { GuardsAvalancheConfigs } from '../../src/configs/guardsAvalancheConfigs';
import type { SigningTransactionRow } from '../../src/signing/transactionSigningContext';
import {
  AvalancheManagementAuthorization,
  AvalancheManagementColdState,
  AvalancheManagementOrder,
  AvalancheManagementPolicy,
} from '../../src/verification/avalancheManagementAuthorization';
import {
  config,
  contracts,
  mapping,
  tokenMapping,
} from '../utils/avalancheChainTestUtils';

/** Builds native envelope and admitted-row fixtures for the isolated policy layer. */
export const createManagementAuthorizationFixture = async (
  type: TransactionType = TransactionType.coldStorage,
  token = false,
) => {
  const cfg = config();
  if (token) cfg.chainId = 43114;
  cfg.routes = { cold: true, manual: true, arbitrary: true };
  cfg.gasLimitMultiplier = 2n;
  const originalContract = structuredClone(contracts());
  const contract = {
    ...originalContract,
    addresses: {
      ...originalContract.addresses,
      lock: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
    },
  };
  const key = new SigningKey('0x' + '11'.repeat(32));
  const tokens = new TokenMap();
  await tokens.updateConfigByJson(token ? tokenMapping() : mapping());
  const network = new AvalancheRpcNetwork(
    'http://127.0.0.1:1',
    { getRepository: () => ({ find: vi.fn() }) } as unknown as DataSource,
    contract.addresses.lock,
    BigInt(cfg.chainId),
    AVALANCHE_TX_EXTRACTOR,
    1000,
  );
  const chain = new AvalancheChain(
    network,
    GuardsAvalancheConfigs.createChainConfigs(cfg, contract),
    tokens,
    { sign: vi.fn(), isInSign: vi.fn() },
  );
  // Retain the actual envelope verifier: accounting binds its function identity.
  // Fee acquisition is the explicit provider boundary isolated by this fixture.
  const fee = vi.spyOn(chain, 'verifyTransactionFee').mockResolvedValue(true);
  const eventId = type === TransactionType.arbitrary ? 'cd'.repeat(32) : '';
  const tx = Transaction.from({
    type: 2,
    chainId: cfg.chainId,
    nonce: 3,
    to: token
      ? '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd'
      : type === TransactionType.coldStorage
        ? contract.addresses.cold
        : '0x' + '56'.repeat(20),
    value: token ? 0n : 750000n * 1000000000n,
    gasLimit: 42000n,
    maxFeePerGas: 20000000000n,
    maxPriorityFeePerGas: 2000000000n,
    data: token
      ? new Interface(transferABI).encodeFunctionData('transfer', [
          type === TransactionType.coldStorage
            ? contract.addresses.cold
            : '0x' + '56'.repeat(20),
          750000n * 1000000000n,
        ]) + eventId
      : '0x' + eventId,
  });
  const payment = () =>
    new PaymentTransaction(
      'avalanche',
      tx.unsignedHash,
      eventId,
      Buffer.from(
        (tx.isSigned() ? tx.serialized : tx.unsignedSerialized).slice(2),
        'hex',
      ),
      type,
    );
  const row: SigningTransactionRow = {
    txId: tx.unsignedHash,
    txJson: payment().toJson(),
    chain: 'avalanche',
    type,
    status: 'in-sign',
    requiredSign: 2,
    event: null,
    order: type === TransactionType.arbitrary ? { id: eventId } : null,
  };
  const order: AvalancheManagementOrder = {
    id: eventId,
    chain: 'avalanche',
    status: 'in-process',
    orderJson: ChainUtils.encodeOrder(chain.extractTransactionOrder(payment())),
  };
  const policy: AvalancheManagementPolicy = {
    config: cfg,
    manualRequests: true,
    arbitraryRequests: true,
    guardsCount: 3,
    cold: token
      ? {
          low: 1250000n,
          high: 1500000n,
          tokenId: tx.to!.toLowerCase(),
          nativeLow: 100000n,
        }
      : { low: 100000n, high: 1000000n },
  };
  const cold: AvalancheManagementColdState = {
    locked: {
      nativeToken: 2000000n,
      tokens: token ? [{ id: tx.to!.toLowerCase(), value: 2000000n }] : [],
    },
    required: await chain
      .getTransactionAssets(payment())
      .then((a) => a.inputAssets),
    forbiddenTokens: [],
    activeTxIds: [row.txId],
  };
  const getPolicy = vi.fn(() => policy);
  const getTx = vi.fn(async () => row as SigningTransactionRow | null);
  const getOrder = vi.fn(async () => order as AvalancheManagementOrder | null);
  const getOrderTxIds = vi.fn(async () => [row.txId]);
  const getColdState = vi.fn(async () => cold);
  const unchanged = vi.fn();
  const decode = (json: string) => chain.PaymentTransactionFromJson(json);
  const authorization = new AvalancheManagementAuthorization({
    getPolicy,
    getChain: () => chain,
    getTx,
    decode,
    getOrder,
    getOrderTxIds,
    getColdState,
    assertTokenMapUnchanged: unchanged,
  });
  const intent = () => {
    const p = payment();
    return {
      network: p.network,
      eventId: p.eventId,
      txType: p.txType,
      txId: p.txId,
      txBytes: Buffer.from(p.txBytes).toString('hex'),
    };
  };
  return {
    chain,
    tokens,
    network,
    tx,
    key,
    payment,
    intent,
    row,
    order,
    policy,
    cold,
    fee,
    getPolicy,
    getTx,
    getOrder,
    getOrderTxIds,
    getColdState,
    unchanged,
    authorization,
    /** Keeps the admitted model and synthetic signed result byte-identical. */
    sign: () => {
      tx.signature = key.sign(tx.unsignedHash);
      row.txJson = payment().toJson();
      row.status = 'signed';
    },
    /** Closes the inert provider without any network request. */
    close: () => network['provider'].destroy(),
  };
};
