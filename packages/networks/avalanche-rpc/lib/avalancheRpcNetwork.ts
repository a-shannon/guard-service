import {
  Block,
  FeeData,
  Interface,
  Transaction,
  TransactionResponse,
  TransactionReceipt,
  getAddress,
} from 'ethers';

import { AbstractLogger } from '@rosen-bridge/abstract-logger';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { DataSource, Repository } from '@rosen-bridge/extended-typeorm';
import {
  BlockInfo,
  FailedError,
  UnexpectedApiError,
} from '@rosen-chains/abstract-chain';
import {
  EvmTxStatus,
  PartialERC20ABI,
  TransactionHashes,
} from '@rosen-chains/evm';
import EvmRpcNetwork from '@rosen-chains/evm-rpc';

import {
  AuthorizedAvalancheSubmissionError,
  assertSameConnection,
  submitAuthorizedAvalanche,
} from './authorizedSubmission';
import { avalancheGetUrl } from './avalancheTransport';

export const AVALANCHE_TX_EXTRACTOR = 'avalanche-lock-address';

/** Canonical RPC execution evidence; this does not classify a bridge payment. */
export interface SettledAvalancheTransactionEvidence {
  readonly signedBytes: string;
  readonly hash: string;
  readonly unsignedHash: string;
  readonly from: string;
  readonly chainId: bigint;
  readonly nonce: number;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly index: number;
  readonly finalizedBlockHash: string;
  readonly finalizedBlockNumber: number;
  readonly confirmations: number;
  readonly status: EvmTxStatus.succeed | EvmTxStatus.failed;
}

/** Immutable execution log fields captured before subsequent canonical lookups. */
export interface AvalancheReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly removed: boolean;
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly transactionIndex: number;
  readonly index: number;
}

/** Qualified receipt identity and deeply copied logs; token policy is a chain concern. */
export interface AvalancheReceiptEvidence {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly status: 0 | 1;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly index: number;
  readonly logs: readonly Readonly<AvalancheReceiptLog>[];
}

/** Canonical signed execution with its immutable receipt and log snapshot. */
export interface SettledAvalancheTransactionReceiptEvidence
  extends SettledAvalancheTransactionEvidence {
  readonly receipt: Readonly<AvalancheReceiptEvidence>;
}

/** Trusted RPC adapter for C-Chain's explicit settled execution frontier. */
class AvalancheRpcNetwork extends EvmRpcNetwork {
  readonly expectedChainId: bigint;
  private readonly addressTransactions: Repository<AddressTxsEntity>;

  /** Binds RPC requests to an explicit C-Chain, extractor and bounded transport. */
  constructor(
    url: string,
    dataSource: DataSource,
    lockAddress: string,
    expectedChainId: bigint,
    readonly extractorId: string,
    timeoutMs: number,
    authToken?: string,
    logger?: AbstractLogger,
  ) {
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2147483647
    )
      throw new Error('Invalid Avalanche RPC timeout');
    if (expectedChainId !== 43113n && expectedChainId !== 43114n)
      throw new Error('Avalanche requires explicit Fuji or mainnet chain ID');
    if (
      typeof extractorId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(extractorId)
    )
      throw new Error('Avalanche requires an explicit stable extractor ID');
    super(
      'avalanche',
      url,
      dataSource,
      lockAddress,
      authToken,
      logger,
      timeoutMs,
      avalancheGetUrl,
    );
    this.expectedChainId = expectedChainId;
    this.addressTransactions = dataSource.getRepository(AddressTxsEntity);
  }

  /** Validates a 32-byte RPC hash and returns its lowercase representation. */
  private hash = (value: unknown): string => {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
      throw new UnexpectedApiError('Malformed Avalanche hash');
    return value.toLowerCase();
  };

  /** Accepts only nonnegative integers that can be represented exactly. */
  private integer = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new UnexpectedApiError('Malformed Avalanche block number or index');
    return value;
  };

  /** Checks the endpoint's current chain identity without the SDK network cache. */
  assertNetwork = async (): Promise<void> => {
    // send avoids treating the provider's cached network as current identity.
    const chainId: unknown = await this.provider.send('eth_chainId', []);
    if (
      typeof chainId !== 'string' ||
      !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(chainId) ||
      BigInt(chainId) !== this.expectedChainId
    )
      throw new UnexpectedApiError('Avalanche RPC chain ID mismatch');
  };

  /** Requires a block with valid height, hash and parent identity. */
  private checkBlock = (block: Block | null): Block => {
    if (!block) throw new UnexpectedApiError('Avalanche block unavailable');
    this.integer(block.number);
    this.hash(block.hash);
    this.hash(block.parentHash);
    return block;
  };

  /** Captures the finalized frontier and verifies its numeric canonical lookup. */
  private finalized = async (): Promise<
    Readonly<{ number: number; hash: string }>
  > => {
    const observed = this.checkBlock(await this.provider.getBlock('finalized'));
    // Capture before numeric lookup: a provider may reuse its mutable Block.
    const frontier = Object.freeze({
      number: observed.number,
      hash: this.hash(observed.hash),
    });
    const canonical = this.checkBlock(
      await this.provider.getBlock(frontier.number),
    );
    if (
      canonical.number !== frontier.number ||
      this.hash(canonical.hash) !== this.hash(frontier.hash)
    )
      throw new UnexpectedApiError(
        'Avalanche finalized block is not canonical',
      );
    return frontier;
  };

  /** Checks an inclusion block against its expected identity and frontier. */
  private canonicalBlock = async (
    blockHash: string,
    blockNumber: number,
    frontier: Pick<Block, 'number' | 'hash'>,
  ): Promise<Block> => {
    const canonical = this.checkBlock(
      await this.provider.getBlock(blockNumber),
    );
    if (
      canonical.number !== blockNumber ||
      this.hash(canonical.hash) !== this.hash(blockHash) ||
      (blockNumber === frontier.number &&
        this.hash(canonical.hash) !== this.hash(frontier.hash))
    )
      throw new UnexpectedApiError('Avalanche block is not canonical');
    return canonical;
  };

  /** Resolves a canonical block at or below the finalized execution frontier. */
  private settledBlock = async (blockId: string): Promise<Block> => {
    await this.assertNetwork();
    this.hash(blockId);
    const frontier = await this.finalized();
    const block = this.checkBlock(await this.provider.getBlock(blockId));
    if (this.hash(block.hash) !== this.hash(blockId))
      throw new UnexpectedApiError('Avalanche requested block hash mismatch');
    if (block.number > frontier.number)
      throw new FailedError('Avalanche block execution is not settled');
    return this.canonicalBlock(blockId, block.number, frontier);
  };

  /** Returns the canonical finalized height for the configured C-Chain. */
  getHeight = async (): Promise<number> => {
    await this.assertNetwork();
    return (await this.finalized()).number;
  };

  /** State reads share a settled height and recheck its identity after the RPC. */
  private settledState = async (
    method: string,
    params: unknown[],
  ): Promise<unknown> => {
    await this.assertNetwork();
    const frontier = await this.finalized();
    const number = frontier.number;
    const hash = this.hash(frontier.hash);
    const result: unknown = await this.provider.send(method, [
      ...params,
      `0x${number.toString(16)}`,
    ]);
    // Capture primitive identity before the asynchronous state read.
    // Raw send bypasses ethers' short-lived getBlock cache for this recheck.
    const canonical: unknown = await this.provider.send(
      'eth_getBlockByNumber',
      [`0x${number.toString(16)}`, false],
    );
    if (
      !canonical ||
      typeof canonical !== 'object' ||
      !('number' in canonical) ||
      !('hash' in canonical) ||
      this.stateQuantity(canonical.number) !== BigInt(number) ||
      this.hash(canonical.hash) !== hash
    )
      throw new UnexpectedApiError('Avalanche state block is not canonical');
    await this.assertNetwork();
    return result;
  };

  /** Parses a canonical JSON-RPC quantity within the uint256 range. */
  private stateQuantity = (value: unknown): bigint => {
    if (
      typeof value !== 'string' ||
      !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
    )
      throw new UnexpectedApiError('Malformed Avalanche state quantity');
    return BigInt(value);
  };

  /** Reads an exact native balance at a revalidated settled block. */
  getAddressBalanceForNativeToken = async (address: string): Promise<bigint> =>
    this.stateQuantity(
      await this.settledState('eth_getBalance', [getAddress(address)]),
    );

  /** Decodes one uint256 balanceOf word at a revalidated settled block. */
  getAddressBalanceForERC20Asset = async (
    address: string,
    tokenId: string,
  ): Promise<bigint> => {
    const abi = new Interface(PartialERC20ABI);
    const call = {
      to: getAddress(tokenId),
      data: abi.encodeFunctionData('balanceOf', [getAddress(address)]),
    };
    const result = await this.settledState('eth_call', [call]);
    // balanceOf returns exactly one uint256 ABI word, not a JSON-RPC quantity.
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result))
      throw new UnexpectedApiError('Malformed Avalanche ERC-20 balance');
    return BigInt(result);
  };

  /**
   * Reads raw ERC20 totalSupply units at a canonical finalized block.
   * @param tokenId ERC20 contract address.
   * @returns Exact uint256 supply; malformed words, reorgs and wrong networks throw.
   */
  getERC20AssetTotalSupply = async (tokenId: string): Promise<bigint> => {
    const result = await this.settledState('eth_call', [
      { to: getAddress(tokenId), data: '0x18160ddd' },
    ]);
    if (
      typeof result !== 'string' ||
      result.length !== 66 ||
      !/^0x[0-9a-fA-F]{64}$/.test(result)
    )
      throw new UnexpectedApiError('Malformed Avalanche ERC-20 total supply');
    return BigInt(result);
  };

  /** Reads the settled nonce and rejects values outside the safe integer range. */
  getAddressNextAvailableNonce = async (address: string): Promise<number> => {
    const nonce = this.stateQuantity(
      await this.settledState('eth_getTransactionCount', [getAddress(address)]),
    );
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new UnexpectedApiError(
        'Avalanche nonce exceeds safe integer range',
      );
    return Number(nonce);
  };

  /** Returns the canonical identity and height of a settled block. */
  getBlockInfo = async (blockId: string): Promise<BlockInfo> => {
    const block = await this.settledBlock(blockId);
    return {
      hash: this.hash(block.hash),
      parentHash: this.hash(block.parentHash),
      height: block.number,
    };
  };

  /** Returns validated transaction hashes from a settled canonical block. */
  getBlockTransactionIds = async (blockId: string): Promise<string[]> => {
    const block = await this.settledBlock(blockId);
    return block.transactions.map(this.hash);
  };

  /** Captures primitive receipt fields and nested arrays without retaining SDK views. */
  private captureReceipt = (
    receipt: TransactionReceipt,
  ): Readonly<AvalancheReceiptEvidence> => {
    if (!Array.isArray(receipt.logs))
      throw new UnexpectedApiError('Malformed Avalanche receipt logs');
    const logs = receipt.logs.map((log) => {
      if (
        typeof log.removed !== 'boolean' ||
        !Array.isArray(log.topics) ||
        typeof log.data !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)
      )
        throw new UnexpectedApiError('Malformed Avalanche receipt log');
      return Object.freeze({
        address: getAddress(log.address).toLowerCase(),
        topics: Object.freeze(log.topics.map(this.hash)),
        data: log.data.toLowerCase(),
        removed: log.removed,
        transactionHash: this.hash(log.transactionHash),
        blockHash: this.hash(log.blockHash),
        blockNumber: this.integer(log.blockNumber),
        transactionIndex: this.integer(log.transactionIndex),
        index: this.integer(log.index),
      });
    });
    if (receipt.status !== 0 && receipt.status !== 1)
      throw new UnexpectedApiError('Malformed Avalanche receipt status');
    return Object.freeze({
      hash: this.hash(receipt.hash),
      from: getAddress(receipt.from).toLowerCase(),
      to: receipt.to === null ? null : getAddress(receipt.to).toLowerCase(),
      status: receipt.status,
      blockHash: this.hash(receipt.blockHash),
      blockNumber: this.integer(receipt.blockNumber),
      index: this.integer(receipt.index),
      logs: Object.freeze(logs),
    });
  };

  /** A receipt can exist before SAE execution is settled. */
  private observation = async (
    transactionId: string,
    expectedBlock?: string,
    withReceipt = false,
  ): Promise<{
    tx: TransactionResponse | null;
    status: EvmTxStatus;
    confirmations: number;
    receipt?: Readonly<AvalancheReceiptEvidence>;
    inclusion?: Readonly<{
      blockHash: string;
      blockNumber: number;
      index: number;
      finalizedBlockHash: string;
      finalizedBlockNumber: number;
      confirmations: number;
    }>;
  }> => {
    await this.assertNetwork();
    const id = this.hash(transactionId);
    if (expectedBlock !== undefined) this.hash(expectedBlock);
    const tx = await this.provider.getTransaction(transactionId);
    if (!tx) return { tx, status: EvmTxStatus.notFound, confirmations: -1 };
    if (this.hash(tx.hash) !== id || tx.chainId !== this.expectedChainId)
      throw new UnexpectedApiError('Avalanche transaction identity mismatch');
    // Ethers 6.16 normalizes a null pending transactionIndex to undefined.
    if (
      tx.blockHash === null &&
      tx.blockNumber === null &&
      (tx.index === null || tx.index === undefined)
    )
      return { tx, status: EvmTxStatus.mempool, confirmations: -1 };
    const blockHash = this.hash(tx.blockHash);
    const blockNumber = this.integer(tx.blockNumber);
    const index = this.integer(tx.index);
    if (expectedBlock !== undefined && blockHash !== this.hash(expectedBlock))
      throw new UnexpectedApiError('Avalanche transaction block mismatch');
    const observedFrontier = await this.finalized();
    const frontier = Object.freeze({
      number: this.integer(observedFrontier.number),
      hash: this.hash(observedFrontier.hash),
    });
    const receipt = await this.provider.getTransactionReceipt(transactionId);
    if (!receipt)
      throw new UnexpectedApiError('Avalanche transaction receipt unavailable');
    if (
      this.hash(receipt.hash) !== id ||
      this.hash(receipt.blockHash) !== blockHash ||
      this.integer(receipt.blockNumber) !== blockNumber ||
      this.integer(receipt.index) !== index ||
      (receipt.status !== 0 && receipt.status !== 1)
    )
      throw new UnexpectedApiError(
        'Avalanche receipt identity or status mismatch',
      );
    const receiptStatus = receipt.status;
    const snapshot = withReceipt ? this.captureReceipt(receipt) : undefined;
    const block = await this.canonicalBlock(blockHash, blockNumber, frontier);
    if (this.hash(block.transactions[index]) !== id)
      throw new UnexpectedApiError('Avalanche transaction inclusion mismatch');
    if (blockNumber > frontier.number)
      return { tx, status: EvmTxStatus.mempool, confirmations: -1 };
    const status =
      receiptStatus === 1 ? EvmTxStatus.succeed : EvmTxStatus.failed;
    const confirmations = frontier.number - blockNumber + 1;
    if (!Number.isSafeInteger(confirmations))
      throw new UnexpectedApiError('Avalanche confirmation count overflow');
    if (withReceipt) await this.assertNetwork();
    return {
      tx,
      status,
      confirmations: status === EvmTxStatus.succeed ? confirmations : -1,
      ...(snapshot ? { receipt: snapshot } : {}),
      inclusion: Object.freeze({
        blockHash,
        blockNumber,
        index,
        finalizedBlockHash: frontier.hash,
        finalizedBlockNumber: frontier.number,
        confirmations,
      }),
    };
  };

  /**
   * Reads one exact signed hash, never a local unsigned alias. Both successful
   * and reverted executions must be included below the finalized frontier.
   * Transaction types supported by ethers are decoded; payment policy remains
   * the caller's responsibility. The returned hex strings have no mutable views.
   */
  private settledTransactionEvidence = async (
    transactionId: string,
    requiredBlock?: string,
    withReceipt = false,
  ): Promise<
    Readonly<SettledAvalancheTransactionEvidence> & {
      readonly receipt?: Readonly<AvalancheReceiptEvidence>;
    }
  > => {
    const id = this.hash(transactionId);
    const expectedBlock =
      requiredBlock === undefined ? undefined : this.hash(requiredBlock);
    const { tx, status, inclusion, receipt } = await this.observation(
      id,
      expectedBlock,
      withReceipt,
    );
    if (
      !tx ||
      !inclusion ||
      (status !== EvmTxStatus.succeed && status !== EvmTxStatus.failed)
    )
      throw new FailedError('Avalanche transaction execution is not settled');
    const transaction = Transaction.from(tx);
    if (
      !transaction.isSigned() ||
      this.hash(transaction.hash) !== id ||
      transaction.chainId !== this.expectedChainId ||
      this.hash(tx.hash) !== id ||
      this.hash(tx.blockHash) !== inclusion.blockHash ||
      this.integer(tx.blockNumber) !== inclusion.blockNumber ||
      this.integer(tx.index) !== inclusion.index ||
      getAddress(tx.from) !== getAddress(transaction.from!) ||
      (receipt !== undefined &&
        (receipt.from !== transaction.from!.toLowerCase() ||
          receipt.to !== (transaction.to?.toLowerCase() ?? null)))
    )
      throw new UnexpectedApiError(
        'Avalanche settled transaction body mismatch',
      );
    return Object.freeze({
      signedBytes: transaction.serialized,
      hash: id,
      unsignedHash: transaction.unsignedHash,
      from: getAddress(transaction.from!).toLowerCase(),
      chainId: transaction.chainId,
      nonce: this.integer(transaction.nonce),
      ...inclusion,
      status,
      ...(receipt ? { receipt } : {}),
    });
  };

  /**
   * Reads exact signed execution without requiring token logs.
   * @param transactionId Signed transaction hash; unsigned aliases are not resolved.
   * @param requiredBlock Optional required canonical inclusion block.
   * @returns Immutable settled core evidence for successful or failed execution.
   */
  getSettledTransactionEvidence = async (
    transactionId: string,
    requiredBlock?: string,
  ): Promise<Readonly<SettledAvalancheTransactionEvidence>> =>
    this.settledTransactionEvidence(transactionId, requiredBlock);

  /**
   * Reads canonical signed execution with a deeply frozen receipt and log snapshot.
   * @param transactionId Exact signed transaction hash.
   * @param requiredBlock Optional required canonical inclusion block.
   * @returns Qualified execution and receipt evidence; asset policy is applied by the chain.
   */
  getSettledTransactionReceiptEvidence = async (
    transactionId: string,
    requiredBlock?: string,
  ): Promise<Readonly<SettledAvalancheTransactionReceiptEvidence>> => {
    const evidence = await this.settledTransactionEvidence(
      transactionId,
      requiredBlock,
      true,
    );
    if (!evidence.receipt)
      throw new UnexpectedApiError('Avalanche qualified receipt unavailable');
    return Object.freeze({ ...evidence, receipt: evidence.receipt });
  };

  /** Decodes a successful settled transaction bound to its requested block. */
  getTransaction = async (
    transactionId: string,
    blockId: string,
  ): Promise<Transaction> => {
    const { tx, status } = await this.observation(transactionId, blockId);
    if (!tx || status !== EvmTxStatus.succeed)
      throw new FailedError(
        'Avalanche transaction execution is not settled success',
      );
    const transaction = Transaction.from(tx);
    if (this.hash(transaction.hash) !== this.hash(transactionId))
      throw new UnexpectedApiError(
        'Avalanche serialized transaction hash mismatch',
      );
    return transaction;
  };

  /** Finds one lock/extractor-scoped record and rejects ambiguous matches. */
  private transactionRecord = async (
    identity: { unsignedHash: string } | { nonce: number },
  ): Promise<AddressTxsEntity | undefined> => {
    const records = await this.addressTransactions.find({
      where: {
        address: this.lockAddress.toLowerCase(),
        extractor: this.extractorId,
        ...identity,
      },
      take: 2,
    });
    if (records.length > 1)
      throw new UnexpectedApiError('Ambiguous Avalanche transaction records');
    return records[0];
  };

  /** Revalidates stored inclusion, sender, nonce and unsigned transaction identity. */
  private observeRecord = async (record: AddressTxsEntity) => {
    const result = await this.observation(record.signedHash, record.blockId);
    if (
      !result.tx ||
      result.tx.blockHash === null ||
      this.hash(result.tx.blockHash) !== this.hash(record.blockId) ||
      result.tx.nonce !== record.nonce ||
      result.tx.from.toLowerCase() !== this.lockAddress.toLowerCase() ||
      Transaction.from(result.tx).unsignedHash !==
        this.hash(record.unsignedHash)
    )
      throw new UnexpectedApiError(
        'Avalanche stored transaction identity mismatch',
      );
    return result;
  };

  /** Resolves a scoped unsigned alias or observes an exact signed hash. */
  private observeHash = async (hash: string) => {
    const id = this.hash(hash);
    const record = await this.transactionRecord({ unsignedHash: id });
    return record ? this.observeRecord(record) : this.observation(id);
  };

  /** Returns confirmations only for a successful settled observation. */
  getTxConfirmation = async (hash: string): Promise<number> =>
    (await this.observeHash(hash)).confirmations;

  /** Classifies execution against the canonical finalized frontier. */
  getTransactionStatus = async (hash: string): Promise<EvmTxStatus> =>
    (await this.observeHash(hash)).status;

  /** Returns the stored hashes of a settled execution at the lock nonce. */
  getTransactionByNonce = async (nonce: number): Promise<TransactionHashes> => {
    this.integer(nonce);
    const record = await this.transactionRecord({ nonce });
    if (!record) throw new FailedError('Avalanche transaction nonce not found');
    const { status } = await this.observeRecord(record);
    if (status !== EvmTxStatus.succeed && status !== EvmTxStatus.failed)
      throw new FailedError('Avalanche transaction execution is not settled');
    return {
      unsignedHash: this.hash(record.unsignedHash),
      txId: this.hash(record.signedHash),
    };
  };

  /** Resolves a signed transaction hash from a direct or scoped alias observation. */
  getActualTxId = async (hash: string): Promise<string> => {
    const { tx } = await this.observeHash(hash);
    if (!tx) throw new FailedError('Avalanche transaction not found');
    return this.hash(tx.hash);
  };

  /** Estimates gas only after checking endpoint and transaction chain identity. */
  getGasRequired = async (transaction: Transaction): Promise<bigint> => {
    await this.assertNetwork();
    if (transaction.chainId !== this.expectedChainId)
      throw new UnexpectedApiError('Avalanche estimate chain ID mismatch');
    return this.provider.estimateGas({
      from: this.lockAddress,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      nonce: transaction.nonce,
      chainId: transaction.chainId,
    });
  };

  /** Broadcasts a signed protected transaction after a fresh endpoint identity check. */
  submitTransaction = async (transaction: Transaction): Promise<void> => {
    await this.assertNetwork();
    if (!transaction.isSigned() || transaction.chainId !== this.expectedChainId)
      throw new UnexpectedApiError(
        'Avalanche submission requires a protected transaction for this chain',
      );
    await this.provider.broadcastTransaction(transaction.serialized);
  };

  /** Qualified adapter start only; the caller supplies fresh local authority. */
  submitAuthorizedTransaction = async (
    transaction: Transaction,
    authorizeSubmit: (start: () => void) => Promise<void>,
  ): Promise<void> => {
    const chainId = this.expectedChainId,
      provider = this.provider,
      assertNetwork = this.assertNetwork;
    const serialized = transaction.serialized,
      connection = provider._getConnection();
    // A null SDK override otherwise resolves the mutable global default getter.
    const capturedGetUrl = connection.getUrlFunc;
    connection.getUrlFunc = capturedGetUrl;
    if (!transaction.isSigned() || transaction.chainId !== chainId)
      throw new AuthorizedAvalancheSubmissionError('invalid');
    /** Rejects mutation of the transaction, adapter or captured connection. */
    const assertFresh = () => {
      if (
        this.expectedChainId !== chainId ||
        this.provider !== provider ||
        this.assertNetwork !== assertNetwork ||
        transaction.serialized !== serialized
      )
        throw new AuthorizedAvalancheSubmissionError('invalid');
      assertSameConnection(connection, provider._getConnection());
    };
    await submitAuthorizedAvalanche(
      connection,
      serialized,
      chainId,
      authorizeSubmit,
      assertNetwork,
      assertFresh,
    );
  };

  /** Parses a canonical fee quantity within the uint256 range. */
  private feeQuantity = (value: unknown): bigint => {
    if (
      typeof value !== 'string' ||
      !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
    )
      throw new UnexpectedApiError('Malformed Avalanche fee quantity');
    return BigInt(value);
  };

  /** Reads current base fee and tip, then bounds the derived maximum fee. */
  getFeeData = async (): Promise<FeeData> => {
    await this.assertNetwork();
    const baseFee = this.feeQuantity(
      await this.provider.send('eth_baseFee', []),
    );
    const tip = this.feeQuantity(
      await this.provider.send('eth_maxPriorityFeePerGas', []),
    );
    const maxFee = 2n * baseFee + tip;
    if (maxFee >= 1n << 256n)
      throw new UnexpectedApiError('Avalanche maximum fee overflow');
    return new FeeData(null, maxFee, tip);
  };

  /** Returns the priority fee from the qualified fee-data query. */
  getMaxPriorityFeePerGas = async (): Promise<bigint> =>
    (await this.getFeeData()).maxPriorityFeePerGas!;

  /** Returns the derived maximum fee from the qualified fee-data query. */
  getMaxFeePerGas = async (): Promise<bigint> =>
    (await this.getFeeData()).maxFeePerGas!;
}

export default AvalancheRpcNetwork;
