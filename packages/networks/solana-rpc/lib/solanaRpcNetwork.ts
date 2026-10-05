import type { AbstractLogger } from '@rosen-bridge/abstract-logger';
import {
  type AssetBalance,
  type BlockInfo,
  type TokenDetail,
} from '@rosen-chains/abstract-chain';
import {
  AbstractSolanaNetwork,
  type SolanaEventContext,
  type SolanaEventReadSessionOptions,
  type SolanaEventTransaction,
  type SolanaRpcRequest,
  validateSolanaRpcResponse,
} from '@rosen-chains/solana';
import RateLimitedAxios from '@rosen-clients/rate-limited-axios';

import {
  createSolanaAssetReadApi,
  type SolanaAssetReadApi,
} from './solanaAssetReadApi';

const MAX_RESPONSE_BYTES = 1_048_576;

type SolanaRpcJsonNode = ReturnType<typeof validateSolanaRpcResponse>['result'];

/** Read an object member from the protocol parser's exact JSON tree. */
const jsonMember = (node: SolanaRpcJsonNode | undefined, key: string) =>
  node?.kind === 'object' ? node.members.get(key) : undefined;

/** Materialize a validated JSON node without assigning meaning to its value. */
const jsonValue = (node: SolanaRpcJsonNode): unknown => {
  switch (node.kind) {
    case 'object':
      return Object.fromEntries(
        [...node.members].map(([key, value]) => [key, jsonValue(value)]),
      );
    case 'array':
      return node.items.map(jsonValue);
    case 'string':
      return node.value;
    case 'number':
      return Number(node.lexeme);
    case 'atom':
      return node.value;
  }
};

/** Validate an integer token before JavaScript can round its numeric value. */
const safeIntegerToken = (
  node: SolanaRpcJsonNode | undefined,
): number | undefined => {
  if (node?.kind !== 'number' || !/^(?:0|[1-9][0-9]*)$/.test(node.lexeme))
    return undefined;
  const value = BigInt(node.lexeme);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
};

/** Create an HTTP client that returns bounded RPC responses as untouched text. */
const createHttpClient = (url: string) => {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error('INVALID_SOLANA_RPC_ENDPOINT');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0
  )
    throw new Error('INVALID_SOLANA_RPC_ENDPOINT');
  return RateLimitedAxios.create({
    baseURL: endpoint.toString(),
    headers: { 'Content-Type': 'application/json' },
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    responseType: 'text',
    transformResponse: [(data: unknown) => data],
  });
};

export interface SolanaRpcNetworkOptions
  extends Omit<SolanaEventReadSessionOptions, 'context' | 'transport'> {
  readonly context: SolanaEventContext;
  readonly url?: string;
  readonly transport?: (request: SolanaRpcRequest) => Promise<string>;
}

export interface SolanaRpcStatus {
  readonly slot: number;
  readonly confirmations: number | null;
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  readonly err: unknown;
}

/** Concrete read provider for the finalized Solana event session. */
export class SolanaRpcNetwork extends AbstractSolanaNetwork<SolanaEventTransaction> {
  private readonly rpcTransport: (request: SolanaRpcRequest) => Promise<string>;
  private readonly context: SolanaEventContext;
  private readonly assetGenesisHash: string | undefined;
  private assetReadApi: SolanaAssetReadApi | undefined;
  private nextRpcId = 0;

  /** Configure the provider with either an injected transport or validated URL. */
  constructor(options: SolanaRpcNetworkOptions, logger?: AbstractLogger) {
    const client = options.url ? createHttpClient(options.url) : undefined;
    const transport =
      options.transport ??
      (client
        ? async (request: SolanaRpcRequest): Promise<string> => {
            const response = await client.post('', request);
            if (typeof response.data !== 'string')
              throw new Error('SOLANA_RPC_INVALID_RAW_RESPONSE');
            return response.data;
          }
        : undefined);
    if (!transport) throw new Error('SOLANA_RPC_TRANSPORT_MISSING');
    super(
      {
        transport,
        locateBlock: options.locateBlock,
        getHistory: options.getHistory,
      },
      logger,
    );
    this.rpcTransport = transport;
    this.context = options.context;
    this.assetGenesisHash = options.context.resolvedProfile?.genesisHash;
  }

  /** Send one correlated request and return its exact parsed result tree. */
  private callRpc = async (
    method: string,
    params: readonly unknown[],
  ): Promise<SolanaRpcJsonNode> => {
    if (this.nextRpcId >= Number.MAX_SAFE_INTEGER)
      throw new Error('SOLANA_RPC_REQUEST_ID_EXHAUSTED');
    const id = ++this.nextRpcId;
    const request: SolanaRpcRequest = Object.freeze({
      jsonrpc: '2.0',
      id,
      method,
      params: Object.freeze([...params]),
    });
    const raw = await this.rpcTransport(request);
    const envelope = validateSolanaRpcResponse(raw, id);
    return envelope.result;
  };

  /** Return the finalized block height after exact safe-integer validation. */
  getHeight = async (): Promise<number> => {
    const result = await this.callRpc('getBlockHeight', [
      { commitment: 'finalized' },
    ]);
    const height = safeIntegerToken(result);
    if (height === undefined)
      throw new Error('SOLANA_RPC_INVALID_BLOCK_HEIGHT');
    return height;
  };

  /** Create a read session tied to this provider's event context and block. */
  private session = (blockhash: string) =>
    this.createEventReadSession(this.context, blockhash);

  /** Return transaction IDs from the request-bound block read session. */
  getBlockTransactionIds = async (blockId: string): Promise<Array<string>> =>
    (await this.session(blockId)).getBlockTransactionIds(blockId);

  /** Return block metadata from the request-bound block read session. */
  getBlockInfo = async (blockId: string): Promise<BlockInfo> =>
    (await this.session(blockId)).getBlockInfo(blockId);

  /** Return a transaction from the request-bound block read session. */
  getTransaction = async (
    transactionId: string,
    blockId: string,
  ): Promise<SolanaEventTransaction> =>
    (await this.session(blockId)).getTransaction(transactionId, blockId);

  /** Return one validated RPC signature status, or null when it is absent. */
  getSignatureStatus = async (
    transactionId: string,
  ): Promise<SolanaRpcStatus | null> => {
    const result = await this.callRpc('getSignatureStatuses', [
      [transactionId],
      { searchTransactionHistory: true },
    ]);
    const context = jsonMember(result, 'context');
    const contextSlot = jsonMember(context, 'slot');
    const statuses = jsonMember(result, 'value');
    if (
      result.kind !== 'object' ||
      context?.kind !== 'object' ||
      safeIntegerToken(contextSlot) === undefined ||
      statuses?.kind !== 'array' ||
      statuses.items.length !== 1
    )
      throw new Error('SOLANA_RPC_INVALID_SIGNATURE_STATUS');
    const status = statuses.items[0];
    if (status.kind === 'atom' && status.value === null) return null;
    if (status.kind !== 'object')
      throw new Error('SOLANA_RPC_INVALID_SIGNATURE_STATUS');

    const slot = safeIntegerToken(jsonMember(status, 'slot'));
    const confirmationsNode = jsonMember(status, 'confirmations');
    const confirmationStatusNode = jsonMember(status, 'confirmationStatus');
    const errNode = jsonMember(status, 'err');
    if (
      slot === undefined ||
      !confirmationsNode ||
      !confirmationStatusNode ||
      !errNode
    )
      throw new Error('SOLANA_RPC_INVALID_SIGNATURE_STATUS');

    // Solana TransactionError supports object and unit-variant string encodings.
    if (
      errNode.kind !== 'object' &&
      errNode.kind !== 'string' &&
      !(errNode.kind === 'atom' && errNode.value === null)
    )
      throw new Error('SOLANA_RPC_INVALID_SIGNATURE_STATUS');

    const confirmations =
      confirmationsNode.kind === 'atom' && confirmationsNode.value === null
        ? null
        : safeIntegerToken(confirmationsNode);
    if (confirmations === undefined)
      throw new Error('SOLANA_RPC_INVALID_SIGNATURE_STATUS');

    const confirmationStatus =
      confirmationStatusNode.kind === 'atom' &&
      confirmationStatusNode.value === null
        ? null
        : confirmationStatusNode.kind === 'string'
          ? confirmationStatusNode.value
          : undefined;
    if (
      confirmationStatus === undefined ||
      (confirmationStatus !== null &&
        confirmationStatus !== 'processed' &&
        confirmationStatus !== 'confirmed' &&
        confirmationStatus !== 'finalized')
    )
      throw new Error('SOLANA_RPC_INVALID_SIGNATURE_STATUS');

    return {
      slot,
      confirmations,
      confirmationStatus,
      err: jsonValue(errNode),
    };
  };

  /** Return the current RPC confirmation count or the conservative sentinel. */
  getTxConfirmation = async (transactionId: string): Promise<number> => {
    const status = await this.getSignatureStatus(transactionId);
    if (status === null) return -1;
    if (status.err !== null) return -1;
    if (typeof status.confirmations === 'number') return status.confirmations;
    // Rosen's numeric confirmation policy remains unresolved; keep finalized mapped to one.
    return status.confirmationStatus === 'finalized' ? 1 : -1;
  };

  /** Reject provider operations that this read-only RPC integration lacks. */
  private unsupported = async (): Promise<never> => {
    throw new Error('SOLANA_RPC_OPERATION_UNSUPPORTED');
  };

  /** Initialize asset reads with the captured network profile on first use. */
  private assets = (): SolanaAssetReadApi => {
    try {
      if (!this.assetReadApi) {
        if (typeof this.assetGenesisHash !== 'string')
          throw new Error('SOLANA_ASSET_EXPECTED_GENESIS_INVALID');
        this.assetReadApi = createSolanaAssetReadApi({
          expectedGenesisHash: this.assetGenesisHash,
          callRpc: this.callRpc,
        });
      }
      return this.assetReadApi;
    } catch (error) {
      throw new Error('SOLANA_REQUEST_UNAVAILABLE', { cause: error });
    }
  };

  /** Read raw SOL and bridge-eligible, non-frozen original-SPL inventory. */
  getAddressAssets = async (address: string): Promise<AssetBalance> =>
    this.assets().getAddressAssets(address);

  /** Reject transaction submission through this read-only provider. */
  submitTransaction = async (): Promise<void> => this.unsupported();

  /** Reject mempool queries that this provider does not implement. */
  getMempoolTransactions = async (): Promise<Array<SolanaEventTransaction>> =>
    this.unsupported();

  /** Read SOL precision or original-mint decimals with its address as a name. */
  getTokenDetail = async (tokenId: string): Promise<TokenDetail> =>
    this.assets().getTokenDetail(tokenId);

  /** Return the supplied signature as the transaction ID after validation. */
  getActualTxId = async (hash: string): Promise<string> => {
    if (typeof hash !== 'string' || hash.length === 0)
      throw new Error('SOLANA_RPC_TRANSACTION_ID_MISSING');
    return hash;
  };
}

export default SolanaRpcNetwork;
