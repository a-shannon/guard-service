import { blake2b } from 'blakejs';
import * as wasm from 'ergo-lib-wasm-nodejs';
import { computeAddress, FeeData, SigningKey, Transaction } from 'ethers';
import { performance } from 'node:perf_hooks';

import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations,
  PROCEED,
} from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import {
  AvalancheRpcNetwork as ScannerNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
  AvalancheSafetyState1790769600000,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  AbstractChain,
  PaymentTransaction,
  TransactionType,
  ConfirmationStatus,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import {
  AvalancheRpcNetwork,
  AVALANCHE_TX_EXTRACTOR,
} from '@rosen-chains/avalanche-rpc';
import {
  AbstractErgoNetwork,
  ErgoChain,
  ErgoTransaction,
} from '@rosen-chains/ergo';
import axios from '@rosen-clients/rate-limited-axios';

import GuardsErgoConfigs from '../../src/configs/guardsErgoConfigs';
import { ArbitraryEntity } from '../../src/db/entities/arbitraryEntity';
import EventOrder from '../../src/event/eventOrder';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import { NotificationHandler } from '../../src/handlers/notificationHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import * as scannerStartup from '../../src/jobs/initScanner';
import { createGuardSigningRuntime } from '../../src/signing/signingRuntime';
import { TransactionSigningContext } from '../../src/signing/transactionSigningContext';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';

const db = () => DatabaseActionMock.testDatabase;
const privateKey = '0x' + '11'.repeat(32),
  address = computeAddress(privateKey);
const wid = 'aa'.repeat(32);
let network: AvalancheRpcNetwork, chain: AvalancheChain;
let payment: PaymentTransaction;
let getChain: (name: string) => AbstractChain<unknown>;
const fee = {
  bridgeFee: 0n,
  networkFee: 0n,
  feeRatio: 0n,
  feeRatioDivisor: 10000n,
  rsnRatio: 0n,
  rsnRatioDivisor: 10000n,
};
beforeEach(async () => {
  await DatabaseActionMock.clearTables();
  await db().dataSource.getRepository(AddressTxsEntity).clear();
  await db().dataSource.getRepository(BlockEntity).clear();
  const event = mockEventTrigger().event;
  Object.assign(event, {
    fromChain: 'ergo',
    toChain: 'avalanche',
    toAddress: address.toLowerCase(),
    sourceChainTokenId: 'erg',
    targetChainTokenId: 'avax',
    amount: '1000',
    bridgeFee: '0',
    networkFee: '0',
    WIDsCount: 1,
    WIDsHash: Buffer.from(
      blake2b(Buffer.from(wid, 'hex'), undefined, 32),
    ).toString('hex'),
  });
  const id = EventSerializer.getId(event);
  await DatabaseActionMock.insertEventRecord(
    event,
    EventStatus.inPayment,
    undefined,
    1,
    'first',
    event.height,
  );
  await db().EventRepository.update(
    { eventId: id },
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
    id,
    'YQ==',
    wid,
    event.height - 1,
    '1',
    'event-creation-tx-id',
    0,
  );
  const tx = Transaction.from({
    type: 2,
    chainId: 43113,
    nonce: 0,
    to: address,
    value: 1000n,
    gasLimit: 42000n,
    maxFeePerGas: 20n,
    maxPriorityFeePerGas: 2n,
    data: '0x' + id,
  });
  tx.signature = new SigningKey(privateKey).sign(tx.unsignedHash);
  payment = new PaymentTransaction(
    'avalanche',
    tx.unsignedHash,
    id,
    Buffer.from(tx.serialized.slice(2), 'hex'),
    TransactionType.payment,
  );
  await DatabaseActionMock.insertTxRecord(
    payment,
    TransactionStatus.signed,
    1,
    'first',
    false,
    0,
    3,
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
        name: 'rAVAX',
        decimals: 18,
        type: 'token',
        residency: 'wrapped',
        extra: {},
      },
    },
  ]);
  network = new AvalancheRpcNetwork(
    'http://127.0.0.1:1',
    db().dataSource,
    address,
    43113n,
    AVALANCHE_TX_EXTRACTOR,
    1000,
  );
  vi.spyOn(network, 'assertNetwork').mockResolvedValue();
  vi.spyOn(network, 'getGasRequired').mockResolvedValue(21000n);
  vi.spyOn(network, 'getFeeData').mockResolvedValue(new FeeData(null, 20n, 2n));
  vi.spyOn(network, 'getTransactionStatus').mockResolvedValue(
    'not-found' as never,
  );
  vi.spyOn(network, 'getAddressNextAvailableNonce').mockResolvedValue(0);
  chain = new AvalancheChain(
    network,
    {
      fee: 1n,
      rwtId: 'cd'.repeat(32),
      addresses: { lock: address, cold: address, permit: '', fraud: '' },
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
  getChain = (name) =>
    name === 'avalanche'
      ? (chain as unknown as AbstractChain<unknown>)
      : source;
  vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
    getChain: (name: string) => getChain(name),
  } as never);
  vi.spyOn(TokenHandler, 'getInstance').mockReturnValue({
    getTokenMap: () => tokens,
  } as never);
  vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue({ ...fee });
  const reward = new RewardAuthorization({
    context: {} as TransactionSigningContext,
    getDatabase: db,
    getChain: (name) => getChain(name),
  });
  vi.spyOn(RewardAuthorization, 'getInstance').mockReturnValue(reward);
});
afterEach(() => {
  network?.['provider'].destroy();
  vi.restoreAllMocks();
});
const blockHash = (height: number) =>
  '0x' + height.toString(16).padStart(64, '0');
let scannerDb: DataSource,
  scanner: AvalancheRpcScanner,
  scannerNetwork: ScannerNetwork;
let context: TransactionSigningContext;
let mutateDecode: ((value: PaymentTransaction) => void) | undefined;
const transport = vi.fn();
const originalAdapter = axios.defaults.adapter;
const originalTimeout = GuardsErgoConfigs.node.timeout;
const originalExplorerTimeout = GuardsErgoConfigs.explorer.timeout;
const originalNetwork = GuardsErgoConfigs.chainNetworkName;
beforeEach(async () => {
  scannerDb = await new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [BlockEntity, ExtractorStatusEntity, AvalancheSafetyState],
    migrations: [...migrations.sqlite, AvalancheSafetyState1790769600000],
  }).initialize();
  await scannerDb.runMigrations();
  scannerNetwork = new ScannerNetwork('http://127.0.0.1:1', 43113n);
  vi.spyOn(scannerNetwork, 'getCurrentHeight').mockResolvedValue(2);
  vi.spyOn(scannerNetwork, 'getBlockAtHeight').mockImplementation(
    async (height) => ({
      hash: blockHash(height),
      parentHash: blockHash(height - 1),
      height,
      timestamp: 100 + height,
      txCount: 0,
    }),
  );
  vi.spyOn(scannerNetwork, 'getBlockTxs').mockResolvedValue([]);
  scanner = new AvalancheRpcScanner({
    network: scannerNetwork,
    dataSource: scannerDb,
    sourceId: 'payment-source',
    initialHeight: 0,
    blockCleanupConfig: {
      blockCleanupThresholdDuration: 86400,
      blockTrimCountInRound: 0,
    },
  });
  await scanner.update();
  vi.spyOn(scannerStartup, 'getPreparedAvalancheInputs').mockReturnValue({
    config: { rpc: { timeout: 1 } },
  } as never);
  vi.spyOn(chain, 'hasLockAddressEnoughAssets').mockResolvedValue(true);
  transport.mockReset().mockImplementation(async () => ({
    statusCode: 200,
    statusMessage: 'OK',
    headers: {},
    body: Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        ).hash,
      }),
    ),
  }));
  const connection = network['provider']._getConnection();
  connection.getUrlFunc = transport;
  vi.spyOn(network['provider'], '_getConnection').mockImplementation(() =>
    connection.clone(),
  );
  mutateDecode = undefined;
  context = createGuardSigningRuntime({
    getEvent: (id) => db().getEventById(id),
    getTx: (id) => db().getTxById(id),
    decode: (json) => {
      const decoded =
        JSON.parse(json).network === 'ergo'
          ? ErgoTransaction.fromJson(json)
          : (() => {
              const m = JSON.parse(json);
              return new PaymentTransaction(
                m.network,
                m.txId,
                m.eventId,
                Buffer.from(m.txBytes, 'hex'),
                m.txType,
              );
            })();
      mutateDecode?.(decoded);
      return decoded;
    },
    getScanner: () => scanner,
    curveTimeoutSeconds: 1,
    edwardTimeoutSeconds: 1,
    ergoTimeoutSeconds: 1,
    maxPending: 4,
  }).context;
  TransactionProcessor.initSigning(context, { timeoutMs: 1000, maxPending: 4 });
});
afterEach(async () => {
  if (scannerDb?.isInitialized) await scannerDb.destroy();
  axios.defaults.adapter = originalAdapter;
  GuardsErgoConfigs.node.timeout = originalTimeout;
  GuardsErgoConfigs.explorer.timeout = originalExplorerTimeout;
  GuardsErgoConfigs.chainNetworkName = originalNetwork;
});
const current = async () => (await db().getTxById(payment.txId))!;
const snapshot = async () => ({
  row: await current(),
  event: await db().getEventById(payment.eventId),
});
const persistedFields = (row: Awaited<ReturnType<typeof current>>) => ({
  txId: row.txId,
  txJson: row.txJson,
  chain: row.chain,
  type: row.type,
  status: row.status,
  requiredSign: row.requiredSign,
  eventId: row.event?.id ?? null,
  orderId: row.order?.id ?? null,
  lastCheck: row.lastCheck,
  lastStatusUpdate: row.lastStatusUpdate,
  failedInSign: row.failedInSign,
  signFailedCount: row.signFailedCount,
});
const hold = async () =>
  scannerDb
    .getRepository(AvalancheSafetyState)
    .update({ scanner: 'avalanche' }, { holdReason: 'fixture hold' });

const setupReducedErgo = async (additional = false, includeData = false) => {
  await DatabaseActionMock.clearTables();
  const lock = wasm.Address.from_public_key(
    Buffer.from(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      'hex',
    ),
  ).to_base58(0);
  const recipient = wasm.Address.from_public_key(
    Buffer.from(
      '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
      'hex',
    ),
  ).to_base58(0);
  const event = mockEventTrigger().event;
  Object.assign(event, {
    fromChain: 'avalanche',
    toChain: 'ergo',
    sourceChainHeight: 1,
    sourceBlockId: blockHash(1),
    toAddress: recipient,
    sourceChainTokenId: 'avax',
    targetChainTokenId: 'erg',
    amount: '1000000',
    bridgeFee: '0',
    networkFee: '0',
    WIDsCount: 1,
    WIDsHash: Buffer.from(
      blake2b(Buffer.from(wid, 'hex'), undefined, 32),
    ).toString('hex'),
  });
  const id = EventSerializer.getId(event);
  await DatabaseActionMock.insertEventRecord(
    event,
    EventStatus.inPayment,
    undefined,
    1,
    'first',
    event.height,
  );
  await DatabaseActionMock.insertCommitmentBoxRecord(
    event,
    id,
    'YQ==',
    wid,
    event.height - 1,
    '10',
    'event-creation-tx-id',
    0,
  );
  const captured = (await db().getEventById(id))!;
  await db().CommitmentRepository.update(
    { eventId: id },
    {
      spendHeight: captured.eventData.height,
      spendBlock: captured.eventData.block,
    },
  );
  const rawNetwork = {
    getBlockInfo: vi.fn(),
    getTransaction: vi.fn(),
    isBoxUnspentAndValid: vi.fn(async () => true),
    getTxConfirmation: vi.fn(async () => -1),
    getMempoolTransactions: vi.fn(async () => []),
  };
  const tokens = new TokenMap();
  await tokens.updateConfigByJson([]);
  const ergo = new ErgoChain(
    rawNetwork as unknown as AbstractErgoNetwork,
    {
      fee: 1000000n,
      rwtId: 'cd'.repeat(32),
      addresses: { lock, cold: lock, permit: recipient, fraud: recipient },
      confirmations: {
        observation: 1,
        payment: 1,
        cold: 1,
        manual: 1,
        arbitrary: 1,
      },
      minBoxValue: 1000000n,
      eventTxConfirmation: 1,
    },
    tokens,
    { isInSign: vi.fn(), sign: vi.fn() },
  );
  chain.getChainConfigs().addresses.permit = recipient;
  getChain = (name) =>
    (name === 'ergo' ? ergo : chain) as unknown as AbstractChain<unknown>;
  vi.mocked(TokenHandler.getInstance).mockReturnValue({
    getTokenMap: () => ({
      search: () => [{ ergo: { type: 'native' } }],
      getID: () => 'erg',
      wrapAmount: (_id: string, amount: bigint) => ({ amount }),
    }),
  } as never);
  const oldDistribution = GuardsErgoConfigs.chainBridgeFeeDistribution;
  GuardsErgoConfigs.chainBridgeFeeDistribution = {
    ...oldDistribution,
    avalanche: [],
  };
  const box = (
    value: bigint,
    index: number,
    withRwt = false,
    boxWid?: string,
  ) => {
    const b = new wasm.ErgoBoxCandidateBuilder(
      wasm.BoxValue.from_i64(wasm.I64.from_str(String(value))),
      wasm.Contract.pay_to_address(wasm.Address.from_base58(lock)),
      10,
    );
    if (withRwt)
      b.add_token(
        wasm.TokenId.from_str('cd'.repeat(32)),
        wasm.TokenAmount.from_i64(wasm.I64.from_str('10')),
      );
    if (boxWid)
      b.set_register_value(
        4,
        wasm.Constant.from_byte_array(Buffer.from(boxWid, 'hex')),
      );
    return wasm.ErgoBox.from_box_candidate(b.build(), wasm.TxId.zero(), index);
  };
  const trigger = box(1000000n, 0, true),
    funding = box(10000000000n, 1);
  const boxes = [trigger, funding];
  const extraWid = 'cc'.repeat(32);
  if (additional) {
    const extra = box(1000000n, 2, true, extraWid);
    boxes.push(extra);
    await db().CommitmentRepository.insert({
      eventId: id,
      identifier: extra.box_id().to_str(),
      serialized: Buffer.from(extra.sigma_serialize_bytes()).toString('base64'),
      extractor: 'avalancheCommitment',
      block: '11'.repeat(32),
      height: 10,
      txId: 'ee'.repeat(32),
      WID: extraWid,
      commitment: Utils.commitmentFromEvent(
        EventSerializer.fromConfirmedEntity(captured),
        extraWid,
      ),
      rwtCount: '10',
      spendTxId: null,
      spendHeight: null,
      spendBlock: null,
      spendIndex: null,
    });
  }
  await db().EventRepository.update(
    { eventId: id },
    {
      identifier: trigger.box_id().to_str(),
      serialized: Buffer.from(trigger.sigma_serialize_bytes()).toString(
        'base64',
      ),
      spendHeight: null,
      spendBlock: null,
      spendTxId: null,
      result: null,
      paymentTxId: null,
    },
  );
  const reward = EventOrder.eventRewardOrder(
    event,
    additional ? [{ wid: extraWid, boxValue: 1000000n }] : [],
    fee,
    '',
    'cd'.repeat(32),
    10n,
    1000000n,
    [wid],
  );
  const order = [
    ...reward.watchersOrder,
    EventOrder.eventSinglePayment(event, ergo.getMinimumNativeToken(), fee),
    ...reward.guardsOrder,
  ];
  const outputs = wasm.ErgoBoxCandidates.empty();
  let total = 0n;
  for (const out of order) {
    total += out.assets.nativeToken;
    const b = new wasm.ErgoBoxCandidateBuilder(
      wasm.BoxValue.from_i64(wasm.I64.from_str(String(out.assets.nativeToken))),
      wasm.Contract.pay_to_address(wasm.Address.from_base58(out.address)),
      200,
    );
    for (const token of out.assets.tokens)
      b.add_token(
        wasm.TokenId.from_str(token.id),
        wasm.TokenAmount.from_i64(wasm.I64.from_str(String(token.value))),
      );
    if (out.extra !== undefined)
      b.set_register_value(
        4,
        wasm.Constant.from_byte_array(Buffer.from(out.extra, 'hex')),
      );
    outputs.add(b.build());
  }
  outputs.add(
    new wasm.ErgoBoxCandidateBuilder(
      wasm.BoxValue.from_i64(wasm.I64.from_str('1000000')),
      wasm.Contract.new(
        wasm.ErgoTree.from_base16_bytes(ErgoChain.feeBoxErgoTree),
      ),
      200,
    ).build(),
  );
  const inputTotal = boxes.reduce(
    (sum, b) => sum + BigInt(b.value().as_i64().to_str()),
    0n,
  );
  outputs.add(
    new wasm.ErgoBoxCandidateBuilder(
      wasm.BoxValue.from_i64(
        wasm.I64.from_str(String(inputTotal - total - 1000000n)),
      ),
      wasm.Contract.pay_to_address(wasm.Address.from_base58(lock)),
      200,
    ).build(),
  );
  const unsignedInputs = new wasm.UnsignedInputs();
  for (const b of boxes)
    unsignedInputs.add(wasm.UnsignedInput.from_box_id(b.box_id()));
  const dataBox = includeData ? box(1000000n, 3) : undefined;
  const dataInputs = new wasm.DataInputs();
  if (dataBox) dataInputs.add(new wasm.DataInput(dataBox.box_id()));
  const unsigned = new wasm.UnsignedTransaction(
    unsignedInputs,
    dataInputs,
    outputs,
  );
  // Synthetic state mirrors the pinned Ergo package fixture; no live header/proof claim.
  const headers = wasm.BlockHeaders.from_json(
    Array(10).fill({
      extensionId: '00'.repeat(32),
      difficulty: '5275058176',
      votes: '000000',
      timestamp: 0,
      size: 220,
      stateRoot: '00'.repeat(33),
      height: 100000,
      nBits: 0,
      version: 2,
      id: '00'.repeat(32),
      adProofsRoot: '00'.repeat(32),
      transactionsRoot: '00'.repeat(32),
      extensionHash: '00'.repeat(32),
      powSolutions: {
        pk: '03702266cae8daf75b7f09d4c23ad9cdc954849ee280eefae0d67bd97db4a68f6a',
        w: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        n: '000000019cdfb631',
        d: 0,
      },
      adProofsId: '00'.repeat(32),
      transactionsId: '00'.repeat(32),
      parentId: '00'.repeat(32),
    }),
  );
  const state = new wasm.ErgoStateContext(
    wasm.PreHeader.from_block_header(headers.get(0)),
    headers,
  );
  const reduced = wasm.ReducedTransaction.from_unsigned_tx(
    unsigned,
    (() => {
      const list = wasm.ErgoBoxes.empty();
      for (const b of boxes) list.add(b);
      return list;
    })(),
    (() => {
      const list = wasm.ErgoBoxes.empty();
      if (dataBox) list.add(dataBox);
      return list;
    })(),
    state,
  );
  const signed = wasm.Transaction.from_unsigned_tx(
    unsigned,
    boxes.map(() => new Uint8Array()),
  );
  payment = new ErgoTransaction(
    signed.id().to_str(),
    id,
    reduced.sigma_serialize_bytes(),
    TransactionType.payment,
    boxes.map((b) => b.sigma_serialize_bytes()),
    dataBox ? [dataBox.sigma_serialize_bytes()] : [],
  );
  await DatabaseActionMock.insertTxRecord(
    payment,
    TransactionStatus.signFailed,
    1,
    'first',
    false,
    0,
    3,
  );
  const rewards = new RewardAuthorization({
    context: {} as TransactionSigningContext,
    getDatabase: db,
    getChain: (name) => getChain(name),
  });
  vi.mocked(RewardAuthorization.getInstance).mockReturnValue(rewards);
  return {
    ergo,
    rawNetwork,
    signedHex: Buffer.from(signed.sigma_serialize_bytes()).toString('hex'),
    restore: () => {
      GuardsErgoConfigs.chainBridgeFeeDistribution = oldDistribution;
    },
  };
};

const seedEvidence = async (
  foreign = false,
  signFailed = false,
  unsigned = false,
) => {
  const original = Transaction.from(
    '0x' + Buffer.from(payment.txBytes).toString('hex'),
  );
  const observed = Transaction.from(original.serialized);
  if (foreign) {
    observed.signature = null;
    observed.value += 1n;
    observed.signature = new SigningKey(privateKey).sign(observed.unsignedHash);
  }
  if (unsigned)
    payment.txBytes = Buffer.from(original.unsignedSerialized.slice(2), 'hex');
  await db().TransactionRepository.update(
    { txId: payment.txId },
    {
      status: signFailed
        ? TransactionStatus.signFailed
        : TransactionStatus.sent,
      txJson: payment.toJson(),
      failedInSign: signFailed,
      signFailedCount: signFailed ? 1 : 0,
    },
  );
  const block = {
    scanner: 'avalanche',
    height: 12,
    hash: blockHash(12),
    parentHash: blockHash(11),
    status: PROCEED,
    timestamp: 12,
  };
  await db().dataSource.getRepository(BlockEntity).save(block);
  await db()
    .dataSource.getRepository(AddressTxsEntity)
    .insert({
      address: address.toLowerCase(),
      extractor: AVALANCHE_TX_EXTRACTOR,
      unsignedHash: observed.unsignedHash,
      signedHash: observed.hash!,
      nonce: observed.nonce,
      blockId: block.hash,
      status: foreign ? 'succeed' : 'failed',
    });
  const evidence = Object.freeze({
    signedBytes: observed.serialized,
    hash: observed.hash!,
    unsignedHash: observed.unsignedHash,
    from: address.toLowerCase(),
    chainId: 43113n,
    nonce: 0,
    blockHash: block.hash,
    blockNumber: 12,
    index: 0,
    finalizedBlockHash: blockHash(18),
    finalizedBlockNumber: 18,
    confirmations: 7,
    status: (foreign ? 'succeed' : 'failed') as never,
  });
  vi.spyOn(network, 'getSettledTransactionEvidence').mockResolvedValue(
    evidence,
  );
  vi.spyOn(network, 'getBlockInfo').mockResolvedValue(block);
  vi.spyOn(network, 'getTransactionByNonce').mockResolvedValue({
    unsignedHash: observed.unsignedHash,
    txId: observed.hash!,
  });
  vi.mocked(network.getTransactionStatus).mockResolvedValue(
    (foreign ? 'not-found' : 'failed') as never,
  );
  vi.mocked(network.getAddressNextAvailableNonce).mockResolvedValue(1);
  vi.spyOn(chain, 'getHeight').mockResolvedValue(18);
  vi.spyOn(chain, 'getTxConfirmationStatus').mockResolvedValue(
    ConfirmationStatus.NotFound,
  );
  vi.spyOn(chain, 'isTxInMempool').mockResolvedValue(false);
  vi.spyOn(NotificationHandler, 'getInstance').mockReturnValue({
    notify: vi.fn(),
  } as never);
  return evidence;
};

const seedReducedForeignSpend = async () => {
  // Same real P2PK reduction fixture as the accepted recovery integration suite.
  const f = await setupReducedErgo(true, true);
  const commitment = await db().CommitmentRepository.findOneByOrFail({
    WID: 'cc'.repeat(32),
  });
  const own = wasm.Transaction.sigma_parse_bytes(
    Buffer.from(f.signedHex, 'hex'),
  );
  let body;
  try {
    body = JSON.parse(own.to_json());
  } finally {
    own.free();
  }
  const unsigned = wasm.UnsignedTransaction.from_json(
    JSON.stringify({
      inputs: [{ boxId: commitment.identifier, extension: {} }],
      dataInputs: [],
      outputs: [body.outputs.at(-1)],
    }),
  );
  const spender = wasm.Transaction.from_unsigned_tx(unsigned, [
    new Uint8Array(),
  ]);
  const id = spender.id();
  let txId: string, bytes: Uint8Array;
  try {
    txId = id.to_str();
    bytes = spender.sigma_serialize_bytes();
  } finally {
    id.free();
    spender.free();
  }
  const event = (await db().getEventById(payment.eventId))!;
  const block = {
    scanner: 'ergo',
    height: event.eventData.height + 2,
    hash: '83'.repeat(32),
    parentHash: '82'.repeat(32),
    status: PROCEED,
    timestamp: 1000,
  };
  await db().dataSource.getRepository(BlockEntity).insert(block);
  await db().CommitmentRepository.update(
    { id: commitment.id },
    {
      spendTxId: txId,
      spendIndex: 0,
      spendBlock: block.hash,
      spendHeight: block.height,
    },
  );
  f.rawNetwork.getTransaction.mockImplementation(async (...args: unknown[]) => {
    expect(args).toEqual([txId, block.hash]);
    return wasm.Transaction.sigma_parse_bytes(bytes);
  });
  f.rawNetwork.getBlockInfo.mockResolvedValue({
    hash: block.hash,
    height: block.height,
    parentHash: block.parentHash,
  });
  f.rawNetwork.getTxConfirmation.mockImplementation(
    async (...args: unknown[]) => (args[0] === txId ? 2 : -1),
  );
  f.rawNetwork.isBoxUnspentAndValid.mockImplementation(
    async (...args: unknown[]) => args[0] !== commitment.identifier,
  );
  vi.spyOn(f.ergo, 'getHeight').mockResolvedValue(block.height + 2);
  vi.spyOn(NotificationHandler, 'getInstance').mockReturnValue({
    notify: vi.fn(),
  } as never);
  return { ...f, commitment, block, txId };
};

/**
 * @target TransactionSigningContext.current 'processes genuine Reduced signFailed foreign input proof through actual chain/helper/DAO'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'processes genuine Reduced signFailed foreign input proof through actual chain/helper/DAO' with the suite's captured inputs and invoke the current path.
 * @expected expect(validity).toHaveBeenCalled(); expect(dao).toHaveBeenCalledOnce(); expect(dao.mock.calls[0][0]).toEqual(original); expect(persistedFields(after.row)).toEqual({ ...original, status: TransactionStatus.invalid, lastStatusUpdate: after.row.lastStatusUpdate, }); expect(after.event!.status).toBe(EventStatus.pendingPayment); expect(after.event!.unexpectedFails).toBe(before.event!.unexpectedFails); expect(after.event!.firstTry).toBe(before.event!.firstTry); expect(after.event!.eventData).toEqual(before.event!.eventData); expect(transport).not.toHaveBeenCalled();
 */
it('processes genuine Reduced signFailed foreign input proof through actual chain/helper/DAO', async () => {
  const f = await seedReducedForeignSpend();
  try {
    const before = await snapshot(),
      original = db().captureTxCheckPreimage(before.row);
    const dao = vi.spyOn(db(), 'invalidateTxIfUnchanged');
    const validity = vi.spyOn(f.ergo, 'isTxValid');
    await TransactionProcessor.processSignFailedTx(before.row);
    const after = await snapshot();
    expect(validity).toHaveBeenCalled();
    expect(dao).toHaveBeenCalledOnce();
    expect(dao.mock.calls[0][0]).toEqual(original);
    expect(persistedFields(after.row)).toEqual({
      ...original,
      status: TransactionStatus.invalid,
      lastStatusUpdate: after.row.lastStatusUpdate,
    });
    expect(after.event!.status).toBe(EventStatus.pendingPayment);
    expect(after.event!.unexpectedFails).toBe(before.event!.unexpectedFails);
    expect(after.event!.firstTry).toBe(before.event!.firstTry);
    expect(after.event!.eventData).toEqual(before.event!.eventData);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    f.restore();
  }
});

/**
 * @target TransactionSigningContext.current 'preserves Reduced signFailed on %s through the actual processor'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves Reduced signFailed on %s through the actual processor' with the suite's captured inputs and invoke the current path.
 * @expected await expect( TransactionProcessor.processSignFailedTx(before.row), ).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(await db().CommitmentRepository.find()).toEqual(rows); expect(transport).not.toHaveBeenCalled();
 */
it.each([
  'no-proof',
  'weak-confirmation',
  'wrong-index',
  'trigger-spent',
  'funding-unknown',
  'deadline',
  'sql-provenance',
])(
  'preserves Reduced signFailed on %s through the actual processor',
  async (fault) => {
    const f = await seedReducedForeignSpend();
    try {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      if (fault === 'no-proof')
        f.rawNetwork.getTransaction.mockRejectedValue(new Error('pruned'));
      if (fault === 'weak-confirmation')
        f.rawNetwork.getTxConfirmation.mockImplementation(
          async (...args: unknown[]) => (args[0] === f.txId ? 0 : -1),
        );
      if (fault === 'wrong-index')
        await db().CommitmentRepository.update(
          { id: f.commitment.id },
          { spendIndex: 1 },
        );
      if (fault === 'trigger-spent')
        await db().EventRepository.update(
          { eventId: payment.eventId },
          { spendTxId: f.txId },
        );
      if (fault === 'funding-unknown') {
        const box = wasm.ErgoBox.sigma_parse_bytes(
            (payment as ErgoTransaction).inputBoxes[1],
          ),
          id = box.box_id();
        let funding: string;
        try {
          funding = id.to_str();
        } finally {
          id.free();
          box.free();
        }
        f.rawNetwork.isBoxUnspentAndValid.mockImplementation(
          async (...args: unknown[]) =>
            args[0] !== funding && args[0] !== f.commitment.identifier,
        );
      }
      if (fault === 'deadline') {
        GuardsErgoConfigs.node.timeout = 1;
        GuardsErgoConfigs.explorer.timeout = 1;
        const actual = f.rawNetwork.getTransaction.getMockImplementation()!;
        f.rawNetwork.getTransaction.mockImplementation(
          async (...args: unknown[]) => {
            const result = await actual(...args);
            clock.mockReturnValue(2000);
            return result;
          },
        );
      }
      if (fault === 'sql-provenance')
        await db().dataSource.query(
          `CREATE TRIGGER reduced_invalidation_drift AFTER UPDATE OF status ON transaction_entity WHEN NEW.status = 'invalid' BEGIN UPDATE commitment_entity SET spendIndex = spendIndex + 1 WHERE id = ${f.commitment.id}; END`,
        );
      const before = await snapshot(),
        rows = await db().CommitmentRepository.find();
      await expect(
        TransactionProcessor.processSignFailedTx(before.row),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await db().CommitmentRepository.find()).toEqual(rows);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await db().dataSource.query(
        'DROP TRIGGER IF EXISTS reduced_invalidation_drift',
      );
      f.restore();
    }
  },
);
const invalidate = async (
  details = { reason: 'untrusted old reason', unexpected: false },
) =>
  TransactionProcessor.setTransactionAsInvalid(
    await current(),
    chain as unknown as AbstractChain<unknown>,
    details,
  );

/**
 * @target TransactionSigningContext.current 'joins failed own execution with real invalidation DAO (signFailed=%s)'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'joins failed own execution with real invalidation DAO (signFailed=%s)' with the suite's captured inputs and invoke the current path.
 * @expected expect(after.row.status).toBe(TransactionStatus.invalid); expect(after.event!.status).toBe(EventStatus.pendingPayment); expect(after.event!.unexpectedFails).toBe( before.event!.unexpectedFails + 1, ); expect(after.row.lastCheck).toBe(before.row.lastCheck); expect(after.row.signFailedCount).toBe(before.row.signFailedCount); expect(after.row.failedInSign).toBe(before.row.failedInSign); expect(after.event!.firstTry).toBe(before.event!.firstTry); expect(transport).not.toHaveBeenCalled();
 */
it.each([false, true])(
  'joins failed own execution with real invalidation DAO (signFailed=%s)',
  async (signFailed) => {
    await seedEvidence(false, signFailed);
    const before = await snapshot();
    await invalidate();
    const after = await snapshot();
    expect(after.row.status).toBe(TransactionStatus.invalid);
    expect(after.event!.status).toBe(EventStatus.pendingPayment);
    expect(after.event!.unexpectedFails).toBe(
      before.event!.unexpectedFails + 1,
    );
    expect(after.row.lastCheck).toBe(before.row.lastCheck);
    expect(after.row.signFailedCount).toBe(before.row.signFailedCount);
    expect(after.row.failedInSign).toBe(before.row.failedInSign);
    expect(after.event!.firstTry).toBe(before.event!.firstTry);
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'joins foreign nonce consumption without caller counter policy (signFailed=%s)'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'joins foreign nonce consumption without caller counter policy (signFailed=%s)' with the suite's captured inputs and invoke the current path.
 * @expected expect(after.row.status).toBe(TransactionStatus.invalid); expect(after.event!.status).toBe(EventStatus.pendingPayment); expect(after.event!.unexpectedFails).toBe(before.event!.unexpectedFails); expect(NotificationHandler.getInstance().notify).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
 */
it.each([false, true])(
  'joins foreign nonce consumption without caller counter policy (signFailed=%s)',
  async (signFailed) => {
    await seedEvidence(true, signFailed);
    const before = await snapshot();
    await invalidate({
      reason: 'caller asks counter increment',
      unexpected: true,
    });
    const after = await snapshot();
    expect(after.row.status).toBe(TransactionStatus.invalid);
    expect(after.event!.status).toBe(EventStatus.pendingPayment);
    expect(after.event!.unexpectedFails).toBe(before.event!.unexpectedFails);
    expect(NotificationHandler.getInstance().notify).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'refuses %s instead of reopening the payment'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses %s instead of reopening the payment' with the suite's captured inputs and invoke the current path.
 * @expected await expect(invalidate()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled();
 */
it.each([
  'succeed',
  'mempool',
  'missing',
  'malformed',
  'hold',
  'caller-bytes',
  'binder',
])('refuses %s instead of reopening the payment', async (fault) => {
  const evidence = await seedEvidence();
  if (fault === 'succeed')
    vi.mocked(network.getSettledTransactionEvidence).mockResolvedValue({
      ...evidence,
      status: 'succeed' as never,
    });
  if (fault === 'mempool')
    vi.mocked(network.getSettledTransactionEvidence).mockRejectedValue(
      new Error('unsettled mempool'),
    );
  if (fault === 'missing')
    vi.mocked(network.getSettledTransactionEvidence).mockRejectedValue(
      new Error('pruned'),
    );
  if (fault === 'malformed')
    vi.mocked(network.getSettledTransactionEvidence).mockResolvedValue({
      ...evidence,
      signedBytes: '0xcdef',
    });
  if (fault === 'hold') await hold();
  if (fault === 'caller-bytes') {
    payment.txBytes = Buffer.from('cdef', 'hex');
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { txJson: payment.toJson() },
    );
  }
  if (fault === 'binder')
    context['dependencies'].bindPaymentInvalidation = undefined;
  const before = await snapshot();
  await expect(invalidate()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(transport).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.bind 'rejects the generic invalidation bypass before its action'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects the generic invalidation bypass before its action' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(bound.withPersistence('invalidation', action)).rejects.toThrow( 'explicit authority', ); expect(action).not.toHaveBeenCalled();
 */
it('rejects the generic invalidation bypass before its action', async () => {
  await seedEvidence();
  const bound = await context.bind(await current(), [TransactionStatus.sent]);
  const action = vi.fn();
  await expect(bound.withPersistence('invalidation', action)).rejects.toThrow(
    'explicit authority',
  );
  expect(action).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'denies invalid binder result %j without action'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'denies invalid binder result %j without action' with the suite's captured inputs and invoke the current path.
 * @expected await expect( bound.withPaymentInvalidation(checked, 1000, action), ).rejects.toThrow(); expect(action).not.toHaveBeenCalled();
 */
it.each([null, false, { purpose: 'submission' }])(
  'denies invalid binder result %j without action',
  async (invalid) => {
    await seedEvidence();
    const row = await current();
    const checked = db().captureTxCheckPreimage(row);
    const bound = await context.bind(row, [TransactionStatus.sent]);
    context['dependencies'].bindPaymentInvalidation = vi
      .fn()
      .mockResolvedValue(invalid);
    const action = vi.fn();
    await expect(
      bound.withPaymentInvalidation(checked, 1000, action),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'preserves a concurrent %s winner after evidence RPC'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves a concurrent %s winner after evidence RPC' with the suite's captured inputs and invoke the current path.
 * @expected await expect(invalidate()).rejects.toThrow(); expect(winner).toBeDefined(); expect(await snapshot()).toEqual(winner);
 */
it.each([
  'lastCheck',
  'lastStatusUpdate',
  'failedInSign',
  'signFailedCount',
  'txJson',
  'status',
  'requiredSign',
  'orderId',
])('preserves a concurrent %s winner after evidence RPC', async (field) => {
  const evidence = await seedEvidence();
  let winner: Awaited<ReturnType<typeof snapshot>> | undefined;
  vi.mocked(network.getSettledTransactionEvidence).mockImplementation(
    async () => {
      const patch =
        field === 'lastCheck'
          ? { lastCheck: 99 }
          : field === 'lastStatusUpdate'
            ? { lastStatusUpdate: 'winner' }
            : field === 'failedInSign'
              ? { failedInSign: true }
              : field === 'signFailedCount'
                ? { signFailedCount: 99 }
                : field === 'txJson'
                  ? { txJson: payment.toJson() + ' ' }
                  : field === 'status'
                    ? { status: TransactionStatus.sent }
                    : field === 'requiredSign'
                      ? { requiredSign: 99 }
                      : {};
      if (field === 'status')
        await db().TransactionRepository.update(
          { txId: payment.txId },
          { status: TransactionStatus.completed },
        );
      else if (field === 'orderId') {
        await db().dataSource.getRepository(ArbitraryEntity).insert({
          id: 'other',
          chain: 'avalanche',
          orderJson: '[]',
          status: 'pending',
        });
        await db().dataSource.query(
          'UPDATE transaction_entity SET orderId = ? WHERE txId = ?',
          ['other', payment.txId],
        );
      } else
        await db().TransactionRepository.update({ txId: payment.txId }, patch);
      winner = await snapshot();
      return evidence;
    },
  );
  await expect(invalidate()).rejects.toThrow();
  expect(winner).toBeDefined();
  expect(await snapshot()).toEqual(winner);
});
/**
 * @target TransactionSigningContext.current 'rolls back invalidation on SQL %s with no notification'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back invalidation on SQL %s with no notification' with the suite's captured inputs and invoke the current path.
 * @expected await expect(invalidate()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled(); expect(NotificationHandler.getInstance().notify).not.toHaveBeenCalled();
 */
it.each(['ABORT', 'IGNORE', 'after-row', 'after-event'])(
  'rolls back invalidation on SQL %s with no notification',
  async (fault) => {
    await seedEvidence();
    const before = await snapshot();
    const txNotify = vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    );
    const eventNotify = vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicEventStatus',
    );
    const sql =
      fault === 'after-row'
        ? "CREATE TRIGGER payment_invalidation_failure AFTER UPDATE OF status ON transaction_entity WHEN NEW.status='invalid' BEGIN UPDATE transaction_entity SET signFailedCount=99 WHERE txId=NEW.txId; END"
        : fault === 'after-event'
          ? "CREATE TRIGGER payment_invalidation_failure AFTER UPDATE OF status ON confirmed_event_entity WHEN NEW.status='pending-payment' BEGIN UPDATE confirmed_event_entity SET firstTry='changed' WHERE id=NEW.id; END"
          : `CREATE TRIGGER payment_invalidation_failure BEFORE UPDATE OF status ON confirmed_event_entity BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'fixture abort'" : ''}); END`;
    await db().dataSource.query(sql);
    try {
      await expect(invalidate()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
      expect(NotificationHandler.getInstance().notify).not.toHaveBeenCalled();
    } finally {
      await db().dataSource.query('DROP TRIGGER payment_invalidation_failure');
    }
  },
);
/**
 * @target TransactionSigningContext.current 'expires invalidation at %s without committing'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'expires invalidation at %s without committing' with the suite's captured inputs and invoke the current path.
 * @expected await expect(invalidate()).rejects.toThrow('expired'); expect(await snapshot()).toEqual(before);
 */
it.each(['bind', 'prepare', 'after-write'])(
  'expires invalidation at %s without committing',
  async (stage) => {
    await seedEvidence();
    const before = await snapshot();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const bind = context['dependencies'].bindPaymentInvalidation!;
    context['dependencies'].bindPaymentInvalidation = async (...args) => {
      const bound = (await bind(...args))!;
      if (stage === 'bind') clock.mockReturnValue(2000);
      return {
        ...bound,
        prepareUnderScannerLease: async (assertActive) => {
          const permit = await bound.prepareUnderScannerLease(assertActive);
          if (stage === 'prepare') clock.mockReturnValue(2000);
          return {
            ...permit,
            assertAfter: async (...args) => {
              await permit.assertAfter(...args);
              if (stage === 'after-write') clock.mockReturnValue(2000);
            },
          };
        },
      };
    };
    await expect(invalidate()).rejects.toThrow('expired');
    expect(await snapshot()).toEqual(before);
  },
);
/**
 * @target TransactionSigningContext.current 'captures the complete caller row before waiting on height'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'captures the complete caller row before waiting on height' with the suite's captured inputs and invoke the current path.
 * @expected expect(persisted.status).toBe(TransactionStatus.invalid); expect(persisted.lastCheck).not.toBe(99); expect(persisted.signFailedCount).not.toBe(99); expect(persisted.failedInSign).toBe(false);
 */
it('captures the complete caller row before waiting on height', async () => {
  await seedEvidence();
  const row = await current();
  vi.mocked(chain.getHeight).mockImplementation(async () => {
    row.chain = 'cardano';
    row.event!.id = 'caller-event';
    row.lastCheck = 99;
    row.lastStatusUpdate = 'caller';
    row.signFailedCount = 99;
    row.failedInSign = true;
    row.txJson = '{}';
    row.status = TransactionStatus.completed;
    return 18;
  });
  await TransactionProcessor.setTransactionAsInvalid(
    row,
    chain as unknown as AbstractChain<unknown>,
    { reason: 'stale', unexpected: false },
  );
  const persisted = await current();
  expect(persisted.status).toBe(TransactionStatus.invalid);
  expect(persisted.lastCheck).not.toBe(99);
  expect(persisted.signFailedCount).not.toBe(99);
  expect(persisted.failedInSign).toBe(false);
});
/**
 * @target TransactionSigningContext.current 'invalidates proven failed unsigned sign-failed payment without manufacturing signed bytes'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'invalidates proven failed unsigned sign-failed payment without manufacturing signed bytes' with the suite's captured inputs and invoke the current path.
 * @expected expect(after.row.status).toBe(TransactionStatus.invalid); expect(after.row.txJson).toBe(before.row.txJson); expect(after.event!.unexpectedFails).toBe(before.event!.unexpectedFails + 1); expect(network.getSettledTransactionEvidence).toHaveBeenCalled();
 */
it('invalidates proven failed unsigned sign-failed payment without manufacturing signed bytes', async () => {
  await seedEvidence(false, true, true);
  const before = await snapshot();
  await invalidate();
  const after = await snapshot();
  expect(after.row.status).toBe(TransactionStatus.invalid);
  expect(after.row.txJson).toBe(before.row.txJson);
  expect(after.event!.unexpectedFails).toBe(before.event!.unexpectedFails + 1);
  expect(network.getSettledTransactionEvidence).toHaveBeenCalled();
});

/**
 * @target TransactionSigningContext.current 'processes original unsigned signFailed through actual chain/helper/DAO: %s'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'processes original unsigned signFailed through actual chain/helper/DAO: %s' with the suite's captured inputs and invoke the current path.
 * @expected expect(dao).toHaveBeenCalledOnce(); expect(dao.mock.calls[0][0]).toEqual(original); expect(after.row.txJson).toBe(original.txJson); expect(persistedFields(after.row)).toEqual({ ...original, status: TransactionStatus.invalid, lastStatusUpdate: after.row.lastStatusUpdate, }); expect(after.event!.status).toBe(EventStatus.pendingPayment); expect(after.event!.firstTry).toBe(before.event!.firstTry); expect(after.event!.unexpectedFails).toBe( before.event!.unexpectedFails + (foreign ? 0 : 1), ); expect(transport).not.toHaveBeenCalled();
 */
it.each(['own-failed', 'foreign-succeed', 'foreign-failed'])(
  'processes original unsigned signFailed through actual chain/helper/DAO: %s',
  async (mode) => {
    const foreign = mode !== 'own-failed';
    const evidence = await seedEvidence(foreign, true, true);
    if (mode === 'foreign-failed') {
      vi.mocked(network.getSettledTransactionEvidence).mockResolvedValue({
        ...evidence,
        status: 'failed' as never,
      });
      await db()
        .dataSource.getRepository(AddressTxsEntity)
        .update({ signedHash: evidence.hash }, { status: 'failed' });
    }
    const before = await snapshot(),
      original = db().captureTxCheckPreimage(before.row);
    const dao = vi.spyOn(db(), 'invalidateTxIfUnchanged');
    await TransactionProcessor.processSignFailedTx(before.row);
    const after = await snapshot();
    expect(dao).toHaveBeenCalledOnce();
    expect(dao.mock.calls[0][0]).toEqual(original);
    expect(after.row.txJson).toBe(original.txJson);
    expect(persistedFields(after.row)).toEqual({
      ...original,
      status: TransactionStatus.invalid,
      lastStatusUpdate: after.row.lastStatusUpdate,
    });
    expect(after.event!.status).toBe(EventStatus.pendingPayment);
    expect(after.event!.firstTry).toBe(before.event!.firstTry);
    expect(after.event!.unexpectedFails).toBe(
      before.event!.unexpectedFails + (foreign ? 0 : 1),
    );
    expect(transport).not.toHaveBeenCalled();
  },
);

/**
 * @target TransactionSigningContext.current 'refuses unsigned sent payment even with a settled failed receipt'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses unsigned sent payment even with a settled failed receipt' with the suite's captured inputs and invoke the current path.
 * @expected await expect(invalidate()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
 */
it('refuses unsigned sent payment even with a settled failed receipt', async () => {
  await seedEvidence(false, false, true);
  const before = await snapshot();
  await expect(invalidate()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});

/**
 * @target TransactionSigningContext.current 'keeps original unsigned signFailed state on %s at actual processor boundary'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'keeps original unsigned signFailed state on %s at actual processor boundary' with the suite's captured inputs and invoke the current path.
 * @expected await expect( TransactionProcessor.processSignFailedTx(before.row), ).rejects.toThrow(); expect(after.row).toEqual({ ...before.row, lastCheck: fault === 'winner' ? 99 : before.row.lastCheck, }); expect(after.event).toEqual(before.event); expect(transport).not.toHaveBeenCalled();
 */
it.each(['no-proof', 'insufficient', 'hold', 'deadline', 'winner'])(
  'keeps original unsigned signFailed state on %s at actual processor boundary',
  async (fault) => {
    const evidence = await seedEvidence(false, true, true);
    const before = await snapshot();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    if (fault === 'no-proof')
      vi.mocked(network.getSettledTransactionEvidence).mockRejectedValue(
        new Error('missing finalized proof'),
      );
    if (fault === 'insufficient')
      vi.mocked(network.getSettledTransactionEvidence).mockResolvedValue({
        ...evidence,
        confirmations: 0,
      });
    if (fault === 'hold') await hold();
    if (fault === 'deadline')
      vi.mocked(network.getSettledTransactionEvidence).mockImplementation(
        async () => {
          clock.mockReturnValue(2000);
          return evidence;
        },
      );
    if (fault === 'winner') {
      const actual = db().invalidateTxIfUnchanged.bind(db());
      vi.spyOn(db(), 'invalidateTxIfUnchanged').mockImplementation(
        async (...args) => {
          await db().TransactionRepository.update(
            { txId: payment.txId },
            { lastCheck: 99 },
          );
          return actual(...args);
        },
      );
    }
    await expect(
      TransactionProcessor.processSignFailedTx(before.row),
    ).rejects.toThrow();
    const after = await snapshot();
    expect(after.row).toEqual({
      ...before.row,
      lastCheck: fault === 'winner' ? 99 : before.row.lastCheck,
    });
    expect(after.event).toEqual(before.event);
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'preserves state when %s arises behind a foreign SQL owner'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves state when %s arises behind a foreign SQL owner' with the suite's captured inputs and invoke the current path.
 * @expected await expect(invalidate()).rejects.toThrow(); expect(after.row).toEqual({ ...before.row, lastCheck: fault === 'winner' ? 99 : before.row.lastCheck, }); expect(after.event).toEqual(before.event);
 */
it.each(['expiry', 'winner'])(
  'preserves state when %s arises behind a foreign SQL owner',
  async (fault) => {
    await seedEvidence();
    const before = await snapshot();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const actual = db().invalidateTxIfUnchanged.bind(db());
    vi.spyOn(db(), 'invalidateTxIfUnchanged').mockImplementation(
      async (...args) => {
        let acquired!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          acquired = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const owner = db().dataSource.transaction(async (manager) => {
          if (fault === 'winner')
            await manager
              .getRepository(db().TransactionRepository.target)
              .update({ txId: payment.txId }, { lastCheck: 99 });
          acquired();
          await gate;
        });
        await started;
        const pending = actual(...args);
        if (fault === 'expiry') clock.mockReturnValue(2000);
        release();
        await owner;
        return pending;
      },
    );
    await expect(invalidate()).rejects.toThrow();
    const after = await snapshot();
    expect(after.row).toEqual({
      ...before.row,
      lastCheck: fault === 'winner' ? 99 : before.row.lastCheck,
    });
    expect(after.event).toEqual(before.event);
    await scanner.update();
  },
);
/**
 * @target TransactionSigningContext.current 'refuses invalid lifetime %s before action'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses invalid lifetime %s before action' with the suite's captured inputs and invoke the current path.
 * @expected await expect( bound.withPaymentInvalidation( db().captureTxCheckPreimage(row), timeout, action, ), ).rejects.toThrow(); expect(action).not.toHaveBeenCalled();
 */
it.each([0, -1, NaN, Infinity, 1.5, 2147483648, undefined])(
  'refuses invalid lifetime %s before action',
  async (timeout) => {
    await seedEvidence();
    const row = await current();
    const bound = await context.bind(row, [TransactionStatus.sent]);
    const action = vi.fn();
    await expect(
      bound.withPaymentInvalidation(
        db().captureTxCheckPreimage(row),
        timeout,
        action,
      ),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'rejects invalid or mismatched captured field %s before binding'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects invalid or mismatched captured field %s before binding' with the suite's captured inputs and invoke the current path.
 * @expected await expect( bound.withPaymentInvalidation(captured, 1000, action), ).rejects.toThrow(); expect(bind).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
 */
it.each([
  ['txId', 'other'],
  ['txJson', '{}'],
  ['chain', 'ergo'],
  ['type', 'reward'],
  ['status', 'signed'],
  ['requiredSign', 99],
  ['eventId', 'other'],
  ['orderId', 'other'],
  ['lastCheck', -1],
  ['lastStatusUpdate', undefined],
  ['failedInSign', 'true'],
  ['signFailedCount', -1],
])(
  'rejects invalid or mismatched captured field %s before binding',
  async (field, value) => {
    await seedEvidence();
    const row = await current();
    const bound = await context.bind(row, [TransactionStatus.sent]);
    const captured = {
      ...db().captureTxCheckPreimage(row),
      [field as string]: value,
    };
    const bind = vi.spyOn(context['dependencies'], 'bindPaymentInvalidation');
    const action = vi.fn();
    await expect(
      bound.withPaymentInvalidation(captured, 1000, action),
    ).rejects.toThrow();
    expect(bind).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'refuses invalid legacy reclassification %j'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses invalid legacy reclassification %j' with the suite's captured inputs and invoke the current path.
 * @expected await expect( bound.withPaymentInvalidation( db().captureTxCheckPreimage(row), undefined, action, ), ).rejects.toThrow('route changed'); expect(action).not.toHaveBeenCalled();
 */
it.each([null, false, { purpose: 'invalidation' }])(
  'refuses invalid legacy reclassification %j',
  async (invalid) => {
    await seedEvidence();
    const row = await current();
    const bound = await context.bind(row, [TransactionStatus.sent]);
    context['dependencies'].bindPaymentInvalidation = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(invalid);
    const action = vi.fn();
    await expect(
      bound.withPaymentInvalidation(
        db().captureTxCheckPreimage(row),
        undefined,
        action,
      ),
    ).rejects.toThrow('route changed');
    expect(action).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'keeps a genuinely unrelated payment on the explicit legacy path (required=%s)'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'keeps a genuinely unrelated payment on the explicit legacy path (required=%s)' with the suite's captured inputs and invoke the current path.
 * @expected expect(after.row.status).toBe(TransactionStatus.invalid); expect(after.event!.status).toBe(EventStatus.pendingPayment); expect(after.event!.unexpectedFails).toBe(before.event!.unexpectedFails); expect(network.getSettledTransactionEvidence).not.toHaveBeenCalled();
 */
it.each([0, 1])(
  'keeps a genuinely unrelated payment on the explicit legacy path (required=%s)',
  async (required) => {
    await seedEvidence();
    payment.network = 'cardano';
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { chain: 'cardano', txJson: payment.toJson() },
    );
    await db().EventRepository.update(
      { eventId: payment.eventId },
      { fromChain: 'ergo', toChain: 'cardano' },
    );
    const legacy = {
      getHeight: vi.fn(async () =>
        required === 0 ? (await current()).lastCheck : 18,
      ),
      getTxRequiredConfirmation: () => required,
    } as unknown as AbstractChain<unknown>;
    getChain = () => legacy;
    const before = await snapshot();
    await TransactionProcessor.setTransactionAsInvalid(
      await current(),
      legacy,
      {
        reason: 'legacy explicit reason',
        unexpected: false,
      },
    );
    const after = await snapshot();
    expect(after.row.status).toBe(TransactionStatus.invalid);
    expect(after.event!.status).toBe(EventStatus.pendingPayment);
    expect(after.event!.unexpectedFails).toBe(before.event!.unexpectedFails);
    expect(network.getSettledTransactionEvidence).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'rechecks affirmative evidence after a stale processSentTx invalidity result'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rechecks affirmative evidence after a stale processSentTx invalidity result' with the suite's captured inputs and invoke the current path.
 * @expected await expect( TransactionProcessor.processSentTx(await current()), ).rejects.toThrow(); expect(chain.isTxValid).toHaveBeenCalledOnce(); expect(network.getSettledTransactionEvidence).toHaveBeenCalled(); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled();
 */
it('rechecks affirmative evidence after a stale processSentTx invalidity result', async () => {
  const evidence = await seedEvidence();
  const before = await snapshot();
  vi.spyOn(chain, 'isTxValid').mockImplementation(async () => {
    vi.mocked(chain.getTxConfirmationStatus).mockResolvedValue(
      ConfirmationStatus.ConfirmedEnough,
    );
    vi.mocked(network.getSettledTransactionEvidence).mockResolvedValue({
      ...evidence,
      status: 'succeed' as never,
    });
    return {
      isValid: false,
      details: { reason: 'stale failed observation', unexpected: false },
    };
  });
  await expect(
    TransactionProcessor.processSentTx(await current()),
  ).rejects.toThrow();
  expect(chain.isTxValid).toHaveBeenCalledOnce();
  expect(network.getSettledTransactionEvidence).toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
  expect(transport).not.toHaveBeenCalled();
});
