import { blake2b } from 'blakejs';
import {
  computeAddress,
  FeeData,
  Interface,
  SigningKey,
  Transaction,
} from 'ethers';

import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  AbstractChain,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import {
  AVALANCHE_TX_EXTRACTOR,
  AvalancheRpcNetwork,
} from '@rosen-chains/avalanche-rpc';
import { transferABI } from '@rosen-chains/evm';

import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import {
  SigningRowPreimage,
  TransactionSigningContext,
} from '../../src/signing/transactionSigningContext';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import { PaymentRecoveryAuthorization } from '../../src/verification/paymentRecoveryAuthorization';
import {
  PaymentSubmissionAuthorization,
  PaymentSubmissionPurpose,
} from '../../src/verification/paymentSubmissionAuthorization';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';

/** Official source identity; Ergo counterpart and custody identities below are synthetic. */
export const joe = '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd';
const counterpart = 'ef'.repeat(32);
const key = new SigningKey('0x' + '11'.repeat(32));
const sender = computeAddress(key.privateKey);
const recipient = '0x' + '22'.repeat(20);
const amount = 1000n * 10n ** 9n;
const topic =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const fee = {
  bridgeFee: 0n,
  networkFee: 0n,
  feeRatio: 0n,
  feeRatioDivisor: 10000n,
  rsnRatio: 0n,
  rsnRatioDivisor: 10000n,
};

/** Decode the public PaymentTransaction representation without altering caller metadata. */
const decode = (json: string) => {
  const m = JSON.parse(json);
  return new PaymentTransaction(
    m.network,
    m.txId,
    m.eventId,
    Buffer.from(m.txBytes, 'hex'),
    m.txType,
  );
};

/**
 * Build actual mainnet chain/RPC and SQLite DAO authorization consumers over synthetic SDK replies.
 * No RPC socket, signing service, public submission or production identity is used.
 */
export const tokenExecutionFixture = async (
  status = TransactionStatus.sent,
) => {
  const db = DatabaseActionMock.testDatabase;
  await DatabaseActionMock.clearTables();
  await db.dataSource.getRepository(AddressTxsEntity).clear();
  const event = mockEventTrigger().event;
  const wid = 'aa'.repeat(32);
  Object.assign(event, {
    fromChain: 'ergo',
    toChain: 'avalanche',
    toAddress: recipient,
    sourceChainTokenId: counterpart,
    targetChainTokenId: joe,
    amount: '1000',
    bridgeFee: '0',
    networkFee: '0',
    WIDsCount: 1,
    WIDsHash: Buffer.from(
      blake2b(Buffer.from(wid, 'hex'), undefined, 32),
    ).toString('hex'),
  });
  const eventId = EventSerializer.getId(event);
  await DatabaseActionMock.insertEventRecord(
    event,
    EventStatus.inPayment,
    undefined,
    1,
    'first',
    event.height,
  );
  await db.EventRepository.update(
    { eventId },
    {
      spendHeight: null,
      spendBlock: null,
      spendTxId: null,
      result: null,
      paymentTxId: null,
    },
  );
  await DatabaseActionMock.insertCommitmentBoxRecord(
    event,
    eventId,
    'YQ==',
    wid,
    event.height - 1,
    '1',
    'event-creation-tx-id',
    0,
  );
  const tokens = new TokenMap();
  await tokens.updateConfigByJson([
    {
      avalanche: {
        tokenId: 'avax',
        name: 'AVAX',
        decimals: 18,
        type: 'native',
        residency: 'native',
        extra: {},
      },
      ergo: {
        tokenId: 'ab'.repeat(32),
        name: 'synthetic rsAVAX',
        decimals: 9,
        type: 'EIP-004',
        residency: 'wrapped',
        extra: {},
      },
    },
    {
      avalanche: {
        tokenId: joe,
        name: 'JOE',
        decimals: 18,
        type: 'ERC-20',
        residency: 'native',
        extra: {},
      },
      ergo: {
        tokenId: counterpart,
        name: 'synthetic rsJOE',
        decimals: 9,
        type: 'EIP-004',
        residency: 'wrapped',
        extra: {},
      },
    },
  ]);
  const signed = Transaction.from({
    type: 2,
    chainId: 43114,
    nonce: 0,
    to: joe,
    value: 0n,
    gasLimit: 80000n,
    maxFeePerGas: 20n,
    maxPriorityFeePerGas: 2n,
    data:
      new Interface(transferABI).encodeFunctionData('transfer', [
        recipient,
        amount,
      ]) + eventId,
  });
  signed.signature = key.sign(signed.unsignedHash);
  const payment = new PaymentTransaction(
    'avalanche',
    signed.unsignedHash,
    eventId,
    Buffer.from(signed.serialized.slice(2), 'hex'),
    TransactionType.payment,
  );
  await DatabaseActionMock.insertTxRecord(
    payment,
    status,
    1,
    'first',
    false,
    0,
    3,
  );
  const expected: SigningRowPreimage = {
    txId: payment.txId,
    txJson: payment.toJson(),
    eventId,
    orderId: null,
    chain: 'avalanche',
    type: TransactionType.payment,
    status,
    requiredSign: 3,
  };
  const network = new AvalancheRpcNetwork(
    'http://127.0.0.1:1',
    db.dataSource,
    sender,
    43114n,
    AVALANCHE_TX_EXTRACTOR,
    1000,
  );
  vi.spyOn(network, 'getGasRequired').mockResolvedValue(40000n);
  vi.spyOn(network, 'getFeeData').mockResolvedValue(new FeeData(null, 20n, 2n));
  const chain = new AvalancheChain(
    network,
    {
      fee: 1n,
      rwtId: 'cd'.repeat(32),
      addresses: {
        lock: sender,
        cold: '0x' + '33'.repeat(20),
        permit: '',
        fraud: '',
      },
      confirmations: {
        observation: 1,
        payment: 1,
        cold: 1,
        manual: 1,
        arbitrary: 1,
      },
      maxParallelTx: 1,
      gasPriceSlippage: 10n,
      gasLimitSlippage: 10n,
      gasLimitMultiplier: 2n,
      gasLimitCap: 100000n,
    },
    tokens,
    { sign: vi.fn(), isInSign: vi.fn() },
  );
  const source = {
    getChainConfigs: () => ({ rwtId: 'cd'.repeat(32) }),
    getRWTToken: () => 'cd'.repeat(32),
  } as unknown as AbstractChain<unknown>;
  const getChain = (name: string) =>
    name === 'avalanche'
      ? (chain as unknown as AbstractChain<unknown>)
      : source;
  vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({ getChain } as never);
  vi.spyOn(TokenHandler, 'getInstance').mockReturnValue({
    getTokenMap: () => tokens,
  } as never);
  vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue({ ...fee });
  const rewards = new RewardAuthorization({
    context: {} as TransactionSigningContext,
    getDatabase: () => db,
    getChain,
  });
  const dependencies = {
    getDatabase: () => db,
    getChain,
    captureOrderInputs: rewards.captureOrderInputs.bind(rewards),
    decode,
  };
  const submission = new PaymentSubmissionAuthorization(dependencies);
  const recovery = new PaymentRecoveryAuthorization(dependencies);
  const block = {
    hash: '0x' + '81'.repeat(32),
    parentHash: '0x' + '80'.repeat(32),
    number: 300,
    transactions: [signed.hash!],
  };
  const frontier = {
    hash: '0x' + '82'.repeat(32),
    parentHash: block.hash,
    number: 301,
    transactions: [] as string[],
  };
  const tx = {
    ...signed.toJSON(),
    chainId: signed.chainId,
    signature: signed.signature,
    hash: signed.hash!,
    from: signed.from!,
    blockHash: block.hash,
    blockNumber: block.number,
    index: 0,
  };
  const log = {
    address: joe,
    topics: [
      topic,
      '0x' + sender.slice(2).toLowerCase().padStart(64, '0'),
      '0x' + recipient.slice(2).padStart(64, '0'),
    ],
    data: '0x' + amount.toString(16).padStart(64, '0'),
    removed: false,
    transactionHash: signed.hash!,
    blockHash: block.hash,
    blockNumber: block.number,
    transactionIndex: 0,
    index: 0,
  };
  const receipt = {
    hash: signed.hash!,
    from: sender,
    to: signed.to,
    blockHash: block.hash,
    blockNumber: block.number,
    index: 0,
    status: 1,
    logs: [log],
  };
  const rpc = network['provider'];
  vi.spyOn(rpc, 'send').mockImplementation(async (method) => {
    if (method === 'eth_chainId') return '0xa86a';
    throw new Error('Unexpected token execution RPC');
  });
  vi.spyOn(rpc, 'getBlock').mockImplementation(async (tag) => {
    if (tag === 'finalized' || tag === frontier.number)
      return frontier as never;
    if (tag === block.hash || tag === block.number) return block as never;
    throw new Error('Unexpected token execution block');
  });
  vi.spyOn(rpc, 'getTransaction').mockImplementation(async (id) => {
    if (id !== signed.hash)
      throw new Error('Unsigned hash used as RPC identity');
    return tx as never;
  });
  vi.spyOn(rpc, 'getTransactionReceipt').mockResolvedValue(receipt as never);
  const record = await db.dataSource
    .getRepository(AddressTxsEntity)
    .save({
      unsignedHash: signed.unsignedHash,
      signedHash: signed.hash!,
      nonce: signed.nonce,
      address: sender.toLowerCase(),
      blockId: block.hash,
      extractor: AVALANCHE_TX_EXTRACTOR,
      status: 'succeed',
    });
  await db.dataSource
    .getRepository(BlockEntity)
    .insert({
      scanner: 'avalanche',
      height: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      status: PROCEED,
      timestamp: 1000,
    });
  /** Prepare observed completion/submission under the actual authority lease API. */
  const prepare = async (
    purpose: PaymentSubmissionPurpose = 'completion',
    active = () => {},
  ) =>
    (await submission.bind(expected, purpose)).prepareUnderScannerLease(active);
  /** Replace the persisted signed fixture with its exact unsigned sign-failed representation. */
  const recoveryRow = async () => {
    const unsigned = decode(payment.toJson());
    unsigned.txBytes = Buffer.from(signed.unsignedSerialized.slice(2), 'hex');
    await db.TransactionRepository.update(
      { txId: expected.txId },
      {
        txJson: unsigned.toJson(),
        status: TransactionStatus.signFailed,
        failedInSign: true,
        signFailedCount: 2,
      },
    );
    return db.captureTxCheckPreimage((await db.getTxById(expected.txId))!);
  };
  return {
    db,
    network,
    chain,
    tokens,
    signed,
    payment,
    expected,
    tx,
    receipt,
    log,
    rpc,
    block,
    frontier,
    record,
    prepare,
    recoveryRow,
    recovery,
  };
};

/** Apply exactly one proof fault while leaving the successful receipt and signed payment otherwise intact. */
export const corruptTokenProof = (
  fixture: Awaited<ReturnType<typeof tokenExecutionFixture>>,
  fault: string,
) => {
  if (fault === 'missing Transfer') fixture.receipt.logs = [];
  if (fault === 'wrong amount')
    fixture.log.data = '0x' + (amount - 1n).toString(16).padStart(64, '0');
  if (fault === 'wrong sender')
    fixture.log.topics[1] = '0x' + '00'.repeat(12) + '44'.repeat(20);
  if (fault === 'wrong recipient')
    fixture.log.topics[2] = '0x' + '00'.repeat(12) + '44'.repeat(20);
  if (fault === 'wrong token') fixture.log.address = '0x' + '44'.repeat(20);
  if (fault === 'removed Transfer') fixture.log.removed = true;
  if (fault === 'duplicate Transfer')
    fixture.receipt.logs.push({ ...fixture.log, index: 1 });
  if (fault === 'wrong log transaction')
    fixture.log.transactionHash = '0x' + '44'.repeat(32);
  if (fault === 'wrong log block')
    fixture.log.blockHash = '0x' + '44'.repeat(32);
};

/** Single-fault negative fixtures reused by the two independent authorization consumers. */
export const proofFaults = [
  'missing Transfer',
  'wrong amount',
  'wrong sender',
  'wrong recipient',
  'wrong token',
  'removed Transfer',
  'duplicate Transfer',
  'wrong log transaction',
  'wrong log block',
];
