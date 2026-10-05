import { TokenMap } from '@rosen-bridge/tokens';
import { AbstractChain, type ChainConfigs } from '@rosen-chains/abstract-chain';
import type {
  SolanaEventContext,
  SolanaEventTransaction,
  SolanaRpcRequest,
} from '@rosen-chains/solana';

import { SolanaRpcNetwork } from '../../lib/solanaRpcNetwork';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  MINT,
  TEST_GENESIS,
  ORIGINAL_SPL_PROGRAM_ID,
  WALLET,
} from '../assetReadTestData';
import {
  balanceResult,
  tokenAccountData,
  tokenAccountItem,
  tokenAccountsResult,
} from '../assetReadTestUtils';
import { startLocalRpcServer } from '../solanaRpcNetworkTestUtils';

export const CONSUMER_TOKEN_ID = `${TEST_GENESIS}:${ORIGINAL_SPL_PROGRAM_ID}:${MINT}`;

/** Concrete balance consumer using the actual AbstractChain implementation. */
class TestAssetConsumerChain extends AbstractChain<SolanaEventTransaction> {
  readonly CHAIN = 'solana';
  readonly NATIVE_TOKEN_ID = 'sol';
  protected extractor = undefined;

  /** Keep unrelated payment, signing and release methods outside this fixture. */
  private unavailable = (): never => {
    throw new Error('ASSET_CONSUMER_UNRELATED_OPERATION');
  };
  generateMultipleTransactions = this.unavailable;
  getTransactionAssets = this.unavailable;
  extractTransactionOrder = this.unavailable;
  verifyTransactionFee = this.unavailable;
  verifyTransactionExtraConditions = this.unavailable;
  isTxValid = this.unavailable;
  signTransaction = this.unavailable;
  isTransactionInSign = this.unavailable;
  submitTransaction = this.unavailable;
  isTxInMempool = this.unavailable;
  getMinimumNativeToken = this.unavailable;
  PaymentTransactionFromJson = this.unavailable;
  rawTxToPaymentTransaction = this.unavailable;
  verifyPaymentTransaction = this.unavailable;
  serializeTx = this.unavailable;
}

/** Start a local default-client provider and a real TokenMap/Guard balance join. */
export const createAssetConsumer = async (
  controls: {
    readonly genesis?: string;
    readonly accounts?: readonly unknown[];
    readonly balance?: string;
  } = {},
) => {
  const requests: SolanaRpcRequest[] = [];
  const accounts = controls.accounts ?? [
    tokenAccountItem(ACCOUNT_A, tokenAccountData({ amount: 12_345n })),
    tokenAccountItem(ACCOUNT_B, tokenAccountData({ amount: 678n })),
  ];
  const server = await startLocalRpcServer((body) => {
    const request = JSON.parse(body) as SolanaRpcRequest;
    requests.push(request);
    let result: string;
    if (request.method === 'getGenesisHash')
      result = JSON.stringify(controls.genesis ?? TEST_GENESIS);
    else if (request.method === 'getBalance')
      result = balanceResult('500', controls.balance ?? '1000000001');
    else if (request.method === 'getTokenAccountsByOwner')
      result = tokenAccountsResult('500', accounts);
    else throw new Error(`UNEXPECTED_ASSET_CONSUMER_REQUEST:${request.method}`);
    return `{"jsonrpc":"2.0","id":${request.id},"result":${result}}`;
  });
  try {
    const network = new SolanaRpcNetwork({
      context: {
        resolvedProfile: { genesisHash: TEST_GENESIS },
      } as unknown as SolanaEventContext,
      locateBlock: async () => undefined,
      url: server.url,
    });
    const tokens = new TokenMap();
    await tokens.updateConfigByJson([
      {
        solana: {
          tokenId: 'sol',
          name: 'SOL',
          decimals: 9,
          type: 'native',
          residency: 'native',
          extra: {},
        },
        ergo: {
          tokenId: 'fixture-wrapped-sol',
          name: 'fixture SOL',
          decimals: 7,
          type: 'ANY',
          residency: 'wrapped',
          extra: {},
        },
      },
      {
        solana: {
          tokenId: CONSUMER_TOKEN_ID,
          name: 'fixture SPL',
          decimals: 6,
          type: 'ANY',
          residency: 'native',
          extra: {},
        },
        ergo: {
          tokenId: 'fixture-wrapped-spl',
          name: 'fixture SPL',
          decimals: 3,
          type: 'ANY',
          residency: 'wrapped',
          extra: {},
        },
      },
    ]);
    const config: ChainConfigs = {
      fee: 0n,
      confirmations: {
        observation: 1,
        payment: 1,
        cold: 1,
        manual: 1,
        arbitrary: 1,
      },
      addresses: { lock: WALLET, cold: WALLET, permit: '', fraud: '' },
      rwtId: 'fixture-rwt',
    };
    const chain = new TestAssetConsumerChain(network, config, tokens);
    return { chain, network, tokens, requests, close: server.close };
  } catch (error) {
    await server.close();
    throw error;
  }
};
