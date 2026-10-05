import { blake2b } from 'blakejs';
import * as wasm from 'ergo-lib-wasm-nodejs';
import { computeAddress, FeeData, SigningKey, Transaction } from 'ethers';

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
import ErgoExplorerNetwork from '@rosen-chains/ergo-explorer-network';
import ErgoNodeNetwork from '@rosen-chains/ergo-node-network';
import axios from '@rosen-clients/rate-limited-axios';

import GuardsErgoConfigs from '../../src/configs/guardsErgoConfigs';
import { ArbitraryEntity } from '../../src/db/entities/arbitraryEntity';
import EventOrder from '../../src/event/eventOrder';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import * as scannerStartup from '../../src/jobs/initScanner';
import { createGuardSigningRuntime } from '../../src/signing/signingRuntime';
import {
  SigningRowPreimage,
  TransactionSigningContext,
} from '../../src/signing/transactionSigningContext';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import { PaymentSubmissionAuthorization } from '../../src/verification/paymentSubmissionAuthorization';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';

const db = () => DatabaseActionMock.testDatabase;
const privateKey = '0x' + '11'.repeat(32),
  address = computeAddress(privateKey);
const wid = 'aa'.repeat(32);
let network: AvalancheRpcNetwork,
  chain: AvalancheChain,
  helper: PaymentSubmissionAuthorization;
let expected: SigningRowPreimage, payment: PaymentTransaction;
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
  helper = new PaymentSubmissionAuthorization({
    getDatabase: db,
    getChain: (name) => getChain(name),
    captureOrderInputs: reward.captureOrderInputs.bind(reward),
    decode: (json) => {
      const m = JSON.parse(json);
      return new PaymentTransaction(
        m.network,
        m.txId,
        m.eventId,
        Buffer.from(m.txBytes, 'hex'),
        m.txType,
      );
    },
  });
  expected = {
    txId: payment.txId,
    txJson: payment.toJson(),
    eventId: id,
    orderId: null,
    chain: 'avalanche',
    type: TransactionType.payment,
    status: TransactionStatus.signed,
    requiredSign: 3,
  };
});
afterEach(() => {
  network?.['provider'].destroy();
  vi.restoreAllMocks();
});
const setupErgo = async (additional = false, includeData = false) => {
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
  const signed = wasm.Transaction.from_unsigned_tx(
    unsigned,
    boxes.map(() => new Uint8Array()),
  );
  payment = new ErgoTransaction(
    signed.id().to_str(),
    id,
    signed.sigma_serialize_bytes(),
    TransactionType.payment,
    boxes.map((b) => b.sigma_serialize_bytes()),
    dataBox ? [dataBox.sigma_serialize_bytes()] : [],
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
  expected = {
    txId: payment.txId,
    txJson: payment.toJson(),
    eventId: id,
    orderId: null,
    chain: 'ergo',
    type: TransactionType.payment,
    status: TransactionStatus.signed,
    requiredSign: 3,
  };
  const rewards = new RewardAuthorization({
    context: {} as TransactionSigningContext,
    getDatabase: db,
    getChain: (name) => getChain(name),
  });
  vi.mocked(RewardAuthorization.getInstance).mockReturnValue(rewards);
  helper = new PaymentSubmissionAuthorization({
    getDatabase: db,
    getChain: (name) => getChain(name),
    captureOrderInputs: rewards.captureOrderInputs.bind(rewards),
    decode: ErgoTransaction.fromJson,
  });
  return {
    ergo,
    rawNetwork,
    restore: () => {
      GuardsErgoConfigs.chainBridgeFeeDistribution = oldDistribution;
    },
  };
};

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
const submit = async () =>
  TransactionProcessor.processSignedTx(await current());
const snapshot = async () => ({
  row: await current(),
  event: await db().getEventById(payment.eventId),
});
const hold = async () =>
  scannerDb
    .getRepository(AvalancheSafetyState)
    .update({ scanner: 'avalanche' }, { holdReason: 'fixture hold' });
const observeAvalanche = async () => {
  const signed = Transaction.from(
    '0x' + Buffer.from(payment.txBytes).toString('hex'),
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
  await db().dataSource.getRepository(AddressTxsEntity).insert({
    address: signed.from!.toLowerCase(),
    extractor: AVALANCHE_TX_EXTRACTOR,
    unsignedHash: signed.unsignedHash,
    signedHash: signed.hash!,
    blockId: block.hash,
    nonce: signed.nonce,
    status: 'succeed',
  });
  vi.spyOn(network, 'getBlockInfo').mockResolvedValue(block);
  vi.spyOn(network, 'getTransaction').mockResolvedValue(signed);
  vi.mocked(network.getTransactionStatus).mockResolvedValue('succeed' as never);
  vi.spyOn(chain, 'getTxConfirmationStatus').mockResolvedValue(
    ConfirmationStatus.ConfirmedEnough,
  );
  return { signed, block };
};
/**
 * @target TransactionSigningContext.bind 'denies payment completion through the old generic persistence API'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'denies payment completion through the old generic persistence API' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(bound.withPersistence('completion', action)).rejects.toThrow( 'explicit authority', ); expect(action).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
 */
it('denies payment completion through the old generic persistence API', async () => {
  await db().TransactionRepository.update(
    { txId: payment.txId },
    { status: TransactionStatus.sent },
  );
  const bound = await context.bind(await current(), [TransactionStatus.sent]);
  const action = vi.fn();
  await expect(bound.withPersistence('completion', action)).rejects.toThrow(
    'explicit authority',
  );
  expect(action).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
const observeErgo = async (ergo: ErgoChain) => {
  const event = (await db().getEventById(payment.eventId))!;
  const block = {
    scanner: 'ergo',
    height: event.eventData.height + 10,
    hash: 'ab'.repeat(32),
    parentHash: 'ac'.repeat(32),
    status: PROCEED,
    timestamp: 12,
  };
  await db().dataSource.getRepository(BlockEntity).save(block);
  await db().EventRepository.update(
    { eventId: payment.eventId },
    {
      spendHeight: block.height,
      spendBlock: block.hash,
      spendTxId: payment.txId,
      result: 'successful',
      paymentTxId: payment.txId,
    },
  );
  vi.spyOn(ergo['network'], 'getBlockInfo').mockResolvedValue(block);
  vi.spyOn(ergo, 'getTransaction').mockResolvedValue(
    Buffer.from(payment.txBytes).toString('hex'),
  );
  vi.spyOn(ergo, 'getTxConfirmationStatus').mockResolvedValue(
    ConfirmationStatus.ConfirmedEnough,
  );
  return block;
};
/**
 * @target TransactionSigningContext.bind 'rejects invalid %s binder outputs without an action'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects invalid %s binder outputs without an action' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( purpose === 'submission' ? bound.preparePaymentSubmission(1000) : bound.withPaymentCompletion(1000, action), ).rejects.toThrow('Invalid payment authority binding'); expect(action).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
 */
it.each(['submission', 'completion'] as const)(
  'rejects invalid %s binder outputs without an action',
  async (purpose) => {
    if (purpose === 'completion')
      await db().TransactionRepository.update(
        { txId: payment.txId },
        { status: TransactionStatus.sent },
      );
    const bound = await context.bind(await current(), [
      purpose === 'completion'
        ? TransactionStatus.sent
        : TransactionStatus.signed,
    ]);
    for (const invalid of [null, false, { kind: 'legacy', purpose }]) {
      context['dependencies'].bindPayment = vi.fn().mockResolvedValue(invalid);
      const action = vi.fn();
      await expect(
        purpose === 'submission'
          ? bound.preparePaymentSubmission(1000)
          : bound.withPaymentCompletion(1000, action),
      ).rejects.toThrow('Invalid payment authority binding');
      expect(action).not.toHaveBeenCalled();
    }
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.bind 'requires explicit undefined at the final legacy %s check'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'requires explicit undefined at the final legacy %s check' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepared.withLegacyAction(action)).rejects.toThrow(); await expect( bound.withPaymentCompletion(undefined, action), ).rejects.toThrow(); expect(action).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
 */
it.each(['submission', 'completion'] as const)(
  'requires explicit undefined at the final legacy %s check',
  async (purpose) => {
    await legacyRoute();
    if (purpose === 'completion')
      await db().TransactionRepository.update(
        { txId: payment.txId },
        { status: TransactionStatus.sent },
      );
    const bound = await context.bind(await current(), [
      purpose === 'completion'
        ? TransactionStatus.sent
        : TransactionStatus.signed,
    ]);
    for (const invalid of [null, false, { kind: 'legacy', purpose }]) {
      context['dependencies'].bindPayment = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(invalid);
      const action = vi.fn();
      if (purpose === 'submission') {
        const prepared = await bound.preparePaymentSubmission(undefined);
        await expect(prepared.withLegacyAction(action)).rejects.toThrow();
      } else {
        await expect(
          bound.withPaymentCompletion(undefined, action),
        ).rejects.toThrow();
      }
      expect(action).not.toHaveBeenCalled();
    }
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'reconciles exact observed Avalanche execution to sent without HTTP'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'reconciles exact observed Avalanche execution to sent without HTTP' with the suite's captured inputs and invoke the current path.
 * @expected expect(transport).not.toHaveBeenCalled(); expect((await current()).status).toBe(TransactionStatus.sent); expect(network.getTransaction).toHaveBeenCalledWith( signed.hash, blockHash(12), );
 */
it('reconciles exact observed Avalanche execution to sent without HTTP', async () => {
  const { signed } = await observeAvalanche();
  await submit();
  expect(transport).not.toHaveBeenCalled();
  expect((await current()).status).toBe(TransactionStatus.sent);
  expect(network.getTransaction).toHaveBeenCalledWith(
    signed.hash,
    blockHash(12),
  );
});
/**
 * @target TransactionSigningContext.current 'allows ready-to-observed Avalanche reconciliation after the HTTP response'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'allows ready-to-observed Avalanche reconciliation after the HTTP response' with the suite's captured inputs and invoke the current path.
 * @expected expect(transport).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it('allows ready-to-observed Avalanche reconciliation after the HTTP response', async () => {
  const response = transport.getMockImplementation()!;
  transport.mockImplementation(async (...args) => {
    await observeAvalanche();
    return response(...args);
  });
  await submit();
  expect(transport).toHaveBeenCalledOnce();
  expect((await current()).status).toBe(TransactionStatus.sent);
});
/**
 * @target TransactionSigningContext.bind 'allows ready-to-observed Ergo reconciliation after its only HTTP request'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'allows ready-to-observed Ergo reconciliation after its only HTTP request' with the suite's captured inputs and invoke the bind path.
 * @expected expect(transport).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it('allows ready-to-observed Ergo reconciliation after its only HTTP request', async () => {
  const fixture = await setupErgo();
  try {
    const node = new ErgoNodeNetwork({ nodeBaseUrl: 'http://127.0.0.1:1' });
    Object.assign(fixture.ergo, { network: node });
    vi.spyOn(node, 'isBoxUnspentAndValid').mockResolvedValue(true);
    vi.spyOn(node, 'getTxConfirmation').mockResolvedValue(-1);
    vi.spyOn(node, 'getMempoolTransactions').mockResolvedValue([]);
    GuardsErgoConfigs.chainNetworkName = 'node';
    GuardsErgoConfigs.node.timeout = 1;
    axios.defaults.adapter = transport;
    transport.mockImplementation(async (config) => {
      await observeErgo(fixture.ergo);
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: 'accepted',
      };
    });
    await submit();
    expect(transport).toHaveBeenCalledOnce();
    expect((await current()).status).toBe(TransactionStatus.sent);
  } finally {
    fixture.restore();
  }
});
/**
 * @target TransactionSigningContext.current 'completes exact observed Avalanche payment and event atomically without HTTP'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'completes exact observed Avalanche payment and event atomically without HTTP' with the suite's captured inputs and invoke the current path.
 * @expected expect(after.row.status).toBe(TransactionStatus.completed); expect(after.event!.status).toBe(EventStatus.pendingReward); expect(after.event!.firstTry).toBe(after.row.lastStatusUpdate); expect(transport).not.toHaveBeenCalled();
 */
it('completes exact observed Avalanche payment and event atomically without HTTP', async () => {
  await observeAvalanche();
  await db().TransactionRepository.update(
    { txId: payment.txId },
    { status: TransactionStatus.sent },
  );
  await TransactionProcessor.processSentTx(await current());
  const after = await snapshot();
  expect(after.row.status).toBe(TransactionStatus.completed);
  expect(after.event!.status).toBe(EventStatus.pendingReward);
  expect(after.event!.firstTry).toBe(after.row.lastStatusUpdate);
  expect(transport).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.bind 'reconciles and completes observed Ergo payment, preserving event firstTry'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'reconciles and completes observed Ergo payment, preserving event firstTry' with the suite's captured inputs and invoke the bind path.
 * @expected expect((await current()).status).toBe(TransactionStatus.sent); expect(after.row.status).toBe(TransactionStatus.completed); expect(after.event!.status).toBe(EventStatus.completed); expect(after.event!.firstTry).toBe(before.event!.firstTry); expect(transport).not.toHaveBeenCalled();
 */
it('reconciles and completes observed Ergo payment, preserving event firstTry', async () => {
  const fixture = await setupErgo();
  try {
    await db().EventRepository.update(
      { eventId: payment.eventId },
      { sourceChainHeight: 1, sourceBlockId: blockHash(1) },
    );
    await observeErgo(fixture.ergo);
    const before = await snapshot();
    await submit();
    expect((await current()).status).toBe(TransactionStatus.sent);
    await TransactionProcessor.processSentTx(await current());
    const after = await snapshot();
    expect(after.row.status).toBe(TransactionStatus.completed);
    expect(after.event!.status).toBe(EventStatus.completed);
    expect(after.event!.firstTry).toBe(before.event!.firstTry);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    fixture.restore();
  }
});
/**
 * @target TransactionSigningContext.bind 'refuses observed-to-ready %s evidence regression with zero HTTP or status mutation'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses observed-to-ready %s evidence regression with zero HTTP or status mutation' with the suite's captured inputs and invoke the bind path.
 * @expected expect(prepared.kind).toBe('observed'); await expect(prepared.authorizeSubmit(vi.fn())).rejects.toThrow( 'cannot start', ); await expect( prepared.withResult((row, permit) => db().setTxStatusIfUnchanged(row, TransactionStatus.sent, permit), ), ).rejects.toThrow('authority changed'); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled();
 */
it.each(['avalanche', 'ergo'])(
  'refuses observed-to-ready %s evidence regression with zero HTTP or status mutation',
  async (target) => {
    const fixture = target === 'ergo' ? await setupErgo() : undefined;
    try {
      if (fixture) {
        await db().EventRepository.update(
          { eventId: payment.eventId },
          { sourceChainHeight: 1, sourceBlockId: blockHash(1) },
        );
        await observeErgo(fixture.ergo);
      } else await observeAvalanche();
      const bound = await context.bind(await current(), [
        TransactionStatus.signed,
      ]);
      const prepared = await bound.preparePaymentSubmission(1000);
      expect(prepared.kind).toBe('observed');
      await expect(prepared.authorizeSubmit(vi.fn())).rejects.toThrow(
        'cannot start',
      );
      if (fixture) {
        await db().EventRepository.update(
          { eventId: payment.eventId },
          {
            result: null,
            spendHeight: null,
            spendTxId: null,
            spendBlock: null,
            paymentTxId: null,
          },
        );
        vi.mocked(fixture.ergo.getTxConfirmationStatus).mockResolvedValue(
          ConfirmationStatus.NotFound,
        );
      } else {
        await db().dataSource.getRepository(AddressTxsEntity).clear();
        vi.mocked(network.getTransactionStatus).mockResolvedValue(
          'not-found' as never,
        );
        vi.mocked(chain.getTxConfirmationStatus).mockResolvedValue(
          ConfirmationStatus.NotFound,
        );
      }
      const before = await snapshot();
      await expect(
        prepared.withResult((row, permit) =>
          db().setTxStatusIfUnchanged(row, TransactionStatus.sent, permit),
        ),
      ).rejects.toThrow('authority changed');
      expect(await snapshot()).toEqual(before);
      expect(transport).not.toHaveBeenCalled();
      prepared.close();
    } finally {
      fixture?.restore();
    }
  },
);
/**
 * @target TransactionSigningContext.bind 'defers completion on %s without HTTP or partial state'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers completion on %s without HTTP or partial state' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( TransactionProcessor.processSentTx(await current()), ).rejects.toThrow(); expect(after.row.status).toBe(TransactionStatus.sent); expect(after.event!.status).toBe(EventStatus.inPayment); expect(after).toEqual(before); expect(transport).not.toHaveBeenCalled();
 */
it.each([
  'hold',
  'missing-binder',
  'ready',
  'purpose',
  'lost-confirmation',
  'changed-proof',
  'pruned',
  'block',
  'row',
  'event',
])('defers completion on %s without HTTP or partial state', async (fault) => {
  await observeAvalanche();
  await db().TransactionRepository.update(
    { txId: payment.txId },
    { status: TransactionStatus.sent },
  );
  if (fault === 'hold') await hold();
  if (fault === 'missing-binder')
    context['dependencies'].bindPayment = undefined;
  if (fault === 'ready')
    await db().dataSource.getRepository(AddressTxsEntity).clear();
  if (fault === 'purpose') {
    const bind = context['dependencies'].bindPayment!;
    context['dependencies'].bindPayment = async (...args) => {
      const value = await bind(...args);
      return value ? { ...value, purpose: 'submission' } : value;
    };
  }
  if (fault === 'lost-confirmation')
    vi.mocked(chain.getTxConfirmationStatus)
      .mockResolvedValueOnce(ConfirmationStatus.ConfirmedEnough)
      .mockResolvedValue(ConfirmationStatus.NotConfirmedEnough);
  if (fault === 'changed-proof')
    vi.mocked(network.getTransaction).mockImplementation(async () => {
      const changed = Transaction.from(
        '0x' + Buffer.from(payment.txBytes).toString('hex'),
      );
      changed.signature = new SigningKey('0x' + '22'.repeat(32)).sign(
        changed.unsignedHash,
      );
      return changed;
    });
  if (fault === 'pruned')
    vi.mocked(network.getTransaction).mockRejectedValue(new Error('pruned'));
  if (fault === 'block')
    vi.mocked(network.getBlockInfo).mockResolvedValue({
      hash: blockHash(99),
      height: 12,
      parentHash: blockHash(11),
    });
  if (fault === 'row' || fault === 'event')
    vi.mocked(network.getTransaction).mockImplementation(async () => {
      if (fault === 'row')
        await db().TransactionRepository.update(
          { txId: payment.txId },
          { requiredSign: 9 },
        );
      else
        await db().ConfirmedEventRepository.update(
          { id: payment.eventId },
          { unexpectedFails: 9 },
        );
      return Transaction.from(
        '0x' + Buffer.from(payment.txBytes).toString('hex'),
      );
    });
  const before = await snapshot();
  await expect(
    TransactionProcessor.processSentTx(await current()),
  ).rejects.toThrow();
  const after = await snapshot();
  expect(after.row.status).toBe(TransactionStatus.sent);
  expect(after.event!.status).toBe(EventStatus.inPayment);
  if (!['row', 'event'].includes(fault)) expect(after).toEqual(before);
  expect(transport).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'rolls back observed completion on SQL %s and emits no notifications'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back observed completion on SQL %s and emits no notifications' with the suite's captured inputs and invoke the current path.
 * @expected await expect( TransactionProcessor.processSentTx(await current()), ).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
 */
it.each(['ABORT', 'IGNORE', 'after-row', 'after-event'])(
  'rolls back observed completion on SQL %s and emits no notifications',
  async (fault) => {
    await observeAvalanche();
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { status: TransactionStatus.sent },
    );
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
        ? "CREATE TRIGGER payment_completion_failure AFTER UPDATE OF status ON transaction_entity WHEN NEW.status = 'completed' BEGIN UPDATE transaction_entity SET requiredSign = 99 WHERE txId = NEW.txId; END"
        : fault === 'after-event'
          ? "CREATE TRIGGER payment_completion_failure AFTER UPDATE OF status ON confirmed_event_entity WHEN NEW.status = 'pending-reward' BEGIN UPDATE confirmed_event_entity SET unexpectedFails = 99 WHERE id = NEW.id; END"
          : `CREATE TRIGGER payment_completion_failure BEFORE UPDATE OF status ON confirmed_event_entity BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'fixture abort'" : ''}); END`;
    await db().dataSource.query(sql);
    try {
      await expect(
        TransactionProcessor.processSentTx(await current()),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(txNotify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await db().dataSource.query('DROP TRIGGER payment_completion_failure');
    }
  },
);
/**
 * @target TransactionSigningContext.bind 'refuses observed completion %s queued behind a foreign SQL owner'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses observed completion %s queued behind a foreign SQL owner' with the suite's captured inputs and invoke the bind path.
 * @expected expect(await operation).toBeInstanceOf(Error); expect((await current()).status).toBe(TransactionStatus.sent); expect((await current()).requiredSign).toBe(fault === 'row' ? 9 : 3); expect((await db().getEventById(payment.eventId))!.status).toBe( EventStatus.inPayment, ); expect(transport).not.toHaveBeenCalled();
 */
it.each(['expiry', 'row'])(
  'refuses observed completion %s queued behind a foreign SQL owner',
  async (fault) => {
    await observeAvalanche();
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { status: TransactionStatus.sent },
    );
    let acquired!: () => void, queued!: () => void, release!: () => void;
    const owned = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let owner: Promise<void> | undefined;
    vi.mocked(network.getTransaction).mockImplementationOnce(async () => {
      owner = db().dataSource.transaction(async (manager) => {
        if (fault === 'row')
          await manager
            .getRepository(db().TransactionRepository.target)
            .update({ txId: payment.txId }, { requiredSign: 9 });
        acquired();
        await gate;
      });
      await owned;
      const create = db().dataSource.createQueryRunner.bind(db().dataSource);
      vi.spyOn(db().dataSource, 'createQueryRunner').mockImplementationOnce(
        () => {
          const runner = create();
          const start = runner.startTransaction.bind(runner);
          vi.spyOn(runner, 'startTransaction').mockImplementation(async () => {
            queued();
            await start();
          });
          return runner;
        },
      );
      return Transaction.from(
        '0x' + Buffer.from(payment.txBytes).toString('hex'),
      );
    });
    const operation = TransactionProcessor.processSentTx(await current()).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waiting;
      if (fault === 'expiry')
        vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1001);
      release();
      await owner;
      expect(await operation).toBeInstanceOf(Error);
      expect((await current()).status).toBe(TransactionStatus.sent);
      expect((await current()).requiredSign).toBe(fault === 'row' ? 9 : 3);
      expect((await db().getEventById(payment.eventId))!.status).toBe(
        EventStatus.inPayment,
      );
      expect(transport).not.toHaveBeenCalled();
    } finally {
      release();
      await owner;
    }
  },
);
/**
 * @target TransactionSigningContext.current 'rolls back both completion writes when lifetime expires after post-write validation'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back both completion writes when lifetime expires after post-write validation' with the suite's captured inputs and invoke the current path.
 * @expected await expect( bound.withPaymentCompletion(1000, (expected, permit) => db().finalizeTxIfUnchanged(expected, { ...permit!, assertAfter: async (...args) => { await permit!.assertAfter(...args); vi.spyOn(performance, 'now').mockReturnValue( performance.now() + 1001, ); }, }), ), ).rejects.toThrow('expired'); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled();
 */
it('rolls back both completion writes when lifetime expires after post-write validation', async () => {
  await observeAvalanche();
  await db().TransactionRepository.update(
    { txId: payment.txId },
    { status: TransactionStatus.sent },
  );
  const before = await snapshot();
  const bound = await context.bind(await current(), [TransactionStatus.sent]);
  await expect(
    bound.withPaymentCompletion(1000, (expected, permit) =>
      db().finalizeTxIfUnchanged(expected, {
        ...permit!,
        assertAfter: async (...args) => {
          await permit!.assertAfter(...args);
          vi.spyOn(performance, 'now').mockReturnValue(
            performance.now() + 1001,
          );
        },
      }),
    ),
  ).rejects.toThrow('expired');
  expect(await snapshot()).toEqual(before);
  expect(transport).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.bind 'refuses completion from %s authority'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses completion from %s authority' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( selected.withPaymentCompletion(1000, action), ).rejects.toThrow(); expect(action).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
 */
it.each(['signed', 'signing-attempt'])(
  'refuses completion from %s authority',
  async (fault) => {
    await observeAvalanche();
    const bound = await context.bind(await current(), [
      TransactionStatus.signed,
    ]);
    const selected =
      fault === 'signing-attempt'
        ? context.beginAttempt(bound, 1000, () => true)
        : bound;
    const action = vi.fn();
    await expect(
      selected.withPaymentCompletion(1000, action),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.bind 'completes observed Ergo with used commitment and %s canonical proof bytes'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'completes observed Ergo with used commitment and %s canonical proof bytes' with the suite's captured inputs and invoke the bind path.
 * @expected expect((await current()).status).toBe(TransactionStatus.completed); expect((await db().getEventById(payment.eventId))!.status).toBe( EventStatus.completed, ); expect(transport).not.toHaveBeenCalled();
 */
it.each(['exact', 'different-proof'])(
  'completes observed Ergo with used commitment and %s canonical proof bytes',
  async (proof) => {
    const fixture = await setupErgo(true, true);
    try {
      await db().EventRepository.update(
        { eventId: payment.eventId },
        { sourceChainHeight: 1, sourceBlockId: blockHash(1) },
      );
      const block = await observeErgo(fixture.ergo);
      await db().CommitmentRepository.update(
        { eventId: payment.eventId, WID: 'cc'.repeat(32) },
        {
          spendTxId: payment.txId,
          spendHeight: block.height,
          spendBlock: block.hash,
          spendIndex: 2,
        },
      );
      if (proof === 'different-proof') {
        const original = wasm.Transaction.sigma_parse_bytes(payment.txBytes);
        const body = JSON.parse(original.to_json());
        body.inputs = body.inputs.map(
          (input: {
            boxId: string;
            spendingProof: { extension: unknown };
          }) => ({
            boxId: input.boxId,
            extension: input.spendingProof.extension,
          }),
        );
        const unsigned = wasm.UnsignedTransaction.from_json(
          JSON.stringify(body),
        );
        const alternate = wasm.Transaction.from_unsigned_tx(
          unsigned,
          Array.from(
            { length: unsigned.inputs().len() },
            () => new Uint8Array([1]),
          ),
        );
        vi.mocked(fixture.ergo.getTransaction).mockResolvedValue(
          Buffer.from(alternate.sigma_serialize_bytes()).toString('hex'),
        );
      }
      await db().TransactionRepository.update(
        { txId: payment.txId },
        { status: TransactionStatus.sent },
      );
      await TransactionProcessor.processSentTx(await current());
      expect((await current()).status).toBe(TransactionStatus.completed);
      expect((await db().getEventById(payment.eventId))!.status).toBe(
        EventStatus.completed,
      );
      expect(transport).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  },
);
/**
 * @target TransactionSigningContext.current 'joins actual runtime, Avalanche qualified adapter and DAO signed-to-sent CAS'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'joins actual runtime, Avalanche qualified adapter and DAO signed-to-sent CAS' with the suite's captured inputs and invoke the current path.
 * @expected expect(helper).toBeInstanceOf(PaymentSubmissionAuthorization); expect(transport).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it('joins actual runtime, Avalanche qualified adapter and DAO signed-to-sent CAS', async () => {
  expect(helper).toBeInstanceOf(PaymentSubmissionAuthorization);
  await submit();
  expect(transport).toHaveBeenCalledOnce();
  expect((await current()).status).toBe(TransactionStatus.sent);
});
/**
 * @target TransactionSigningContext.current 'public processing dispatches a genuinely qualified signed payment'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'public processing dispatches a genuinely qualified signed payment' with the suite's captured inputs and invoke the current path.
 * @expected expect(transport).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it('public processing dispatches a genuinely qualified signed payment', async () => {
  await TransactionProcessor.processTransactions();
  expect(transport).toHaveBeenCalledOnce();
  expect((await current()).status).toBe(TransactionStatus.sent);
});
/**
 * @target TransactionSigningContext.bind 'joins Avalanche-source Ergo %s qualified adapter and real sent persistence'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'joins Avalanche-source Ergo %s qualified adapter and real sent persistence' with the suite's captured inputs and invoke the bind path.
 * @expected expect(transport).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it.each(['node', 'explorer'])(
  'joins Avalanche-source Ergo %s qualified adapter and real sent persistence',
  async (selected) => {
    const fixture = await setupErgo();
    try {
      await db().EventRepository.update(
        { eventId: payment.eventId },
        { sourceChainHeight: 1, sourceBlockId: blockHash(1) },
      );
      const node =
        selected === 'node'
          ? new ErgoNodeNetwork({ nodeBaseUrl: 'http://127.0.0.1:1' })
          : new ErgoExplorerNetwork({ explorerBaseUrl: 'http://127.0.0.1:1' });
      Object.assign(fixture.ergo, { network: node });
      vi.spyOn(node, 'isBoxUnspentAndValid').mockResolvedValue(true);
      vi.spyOn(node, 'getTxConfirmation').mockResolvedValue(-1);
      vi.spyOn(node, 'getMempoolTransactions').mockResolvedValue([]);
      GuardsErgoConfigs.chainNetworkName = selected;
      GuardsErgoConfigs.node.timeout = selected === 'node' ? 1 : NaN;
      GuardsErgoConfigs.explorer.timeout = selected === 'explorer' ? 1 : NaN;
      axios.defaults.adapter = transport;
      transport.mockImplementation(async (config) => ({
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: 'accepted',
      }));
      await submit();
      expect(transport).toHaveBeenCalledOnce();
      expect((await current()).status).toBe(TransactionStatus.sent);
    } finally {
      fixture.restore();
    }
  },
);
/**
 * @target TransactionSigningContext.current 'holds deny transport and preserve the exact payment/event state'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'holds deny transport and preserve the exact payment/event state' with the suite's captured inputs and invoke the current path.
 * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled();
 */
it('holds deny transport and preserve the exact payment/event state', async () => {
  await hold();
  const before = await snapshot();
  await expect(submit()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(transport).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'fails closed before dispatch with %s'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'fails closed before dispatch with %s' with the suite's captured inputs and invoke the current path.
 * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
 */
it.each([
  'binder',
  'capability',
  'source-evidence',
  'row-event',
  'order',
  'unsupported-target',
])('fails closed before dispatch with %s', async (fault) => {
  const legacy = vi.spyOn(chain, 'submitTransaction');
  if (fault === 'binder') context['dependencies'].bindPayment = undefined;
  if (fault === 'capability')
    Object.defineProperty(chain, 'submitAuthorizedTransaction', {
      value: undefined,
    });
  if (fault === 'source-evidence')
    await db().EventRepository.update(
      { eventId: payment.eventId },
      {
        fromChain: 'ethereum',
        toChain: 'ethereum',
        extractor: 'avalancheEventTrigger',
      },
    );
  if (fault === 'row-event')
    await db().dataSource.query(
      'UPDATE transaction_entity SET eventId = NULL WHERE txId = ?',
      [payment.txId],
    );
  if (fault === 'order') {
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
  }
  if (fault === 'unsupported-target')
    await db().EventRepository.update(
      { eventId: payment.eventId },
      { fromChain: 'avalanche', toChain: 'ethereum' },
    );
  const before = await snapshot();
  await expect(submit()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(transport).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'rejects %s drift after package preflight before actual adapter dispatch'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects %s drift after package preflight before actual adapter dispatch' with the suite's captured inputs and invoke the current path.
 * @expected await expect(submit()).rejects.toThrow(); expect(transport).not.toHaveBeenCalled(); expect((await current()).status).toBe(TransactionStatus.signed);
 */
it.each(['hold', 'fee', 'row', 'event', 'commitment'])(
  'rejects %s drift after package preflight before actual adapter dispatch',
  async (fault) => {
    vi.mocked(network.getGasRequired).mockImplementationOnce(async () => {
      if (fault === 'hold') await hold();
      if (fault === 'fee')
        vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
          ...fee,
          networkFee: 1n,
        });
      if (fault === 'row')
        await db().TransactionRepository.update(
          { txId: payment.txId },
          { requiredSign: 4 },
        );
      if (fault === 'event')
        await db().EventRepository.update(
          { eventId: payment.eventId },
          { amount: '1001' },
        );
      if (fault === 'commitment')
        await db().CommitmentRepository.update(
          { eventId: payment.eventId },
          { WID: 'bb'.repeat(32) },
        );
      return 21000n;
    });
    await expect(submit()).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect((await current()).status).toBe(TransactionStatus.signed);
  },
);
/**
 * @target TransactionSigningContext.current 'defers post-response %s without overwriting status'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers post-response %s without overwriting status' with the suite's captured inputs and invoke the current path.
 * @expected await expect(submit()).rejects.toThrow(); expect(transport).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.signed);
 */
it.each([
  'hold',
  'fee',
  'row',
  'event',
  'commitment',
  'mempool',
  'executed',
  'partial-spend',
])('defers post-response %s without overwriting status', async (fault) => {
  const response = transport.getMockImplementation()!;
  transport.mockImplementation(async (...args) => {
    if (fault === 'hold') await hold();
    if (fault === 'fee')
      vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
        ...fee,
        networkFee: 1n,
      });
    if (fault === 'row')
      await db().TransactionRepository.update(
        { txId: payment.txId },
        { requiredSign: 4 },
      );
    if (fault === 'event')
      await db().EventRepository.update(
        { eventId: payment.eventId },
        { amount: '1001' },
      );
    if (fault === 'commitment')
      await db().CommitmentRepository.update(
        { eventId: payment.eventId },
        { WID: 'bb'.repeat(32) },
      );
    if (fault === 'mempool')
      vi.mocked(network.getTransactionStatus).mockResolvedValue(
        'mempool' as never,
      );
    if (fault === 'executed')
      vi.mocked(network.getTransactionStatus).mockResolvedValue(
        'succeed' as never,
      );
    if (fault === 'partial-spend')
      await db().EventRepository.update(
        { eventId: payment.eventId },
        { spendHeight: 12 },
      );
    return response(...args);
  });
  await expect(submit()).rejects.toThrow();
  expect(transport).toHaveBeenCalledOnce();
  expect((await current()).status).toBe(TransactionStatus.signed);
});
/**
 * @target TransactionSigningContext.current 'resends a ready sent payment through the explicit qualified adapter'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'resends a ready sent payment through the explicit qualified adapter' with the suite's captured inputs and invoke the current path.
 * @expected expect(transport).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it('resends a ready sent payment through the explicit qualified adapter', async () => {
  await db().TransactionRepository.update(
    { txId: payment.txId },
    { status: TransactionStatus.sent },
  );
  vi.spyOn(chain, 'getTxConfirmationStatus').mockResolvedValue(
    ConfirmationStatus.NotFound,
  );
  vi.spyOn(chain, 'isTxInMempool').mockResolvedValue(false);
  await TransactionProcessor.processSentTx(await current());
  expect(transport).toHaveBeenCalledOnce();
  expect((await current()).status).toBe(TransactionStatus.sent);
});
/**
 * @target TransactionSigningContext.current 'rejects invalid selected Avalanche timeout %s'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects invalid selected Avalanche timeout %s' with the suite's captured inputs and invoke the current path.
 * @expected await expect(submit()).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
 */
it.each([0, -1, NaN, Infinity, 2147484, true, '1'])(
  'rejects invalid selected Avalanche timeout %s',
  async (timeout) => {
    vi.mocked(scannerStartup.getPreparedAvalancheInputs).mockReturnValue({
      config: { rpc: { timeout } },
    } as never);
    await expect(submit()).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'does not keep scanner or SQLite ownership while awaiting the HTTP response'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'does not keep scanner or SQLite ownership while awaiting the HTTP response' with the suite's captured inputs and invoke the current path.
 * @expected expect((await current()).status).toBe(TransactionStatus.signed); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it('does not keep scanner or SQLite ownership while awaiting the HTTP response', async () => {
  let admitted!: () => void, release!: () => void;
  const admittedGate = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = chain.submitAuthorizedTransaction;
  vi.spyOn(chain, 'submitAuthorizedTransaction').mockImplementation(
    async (tx, authorize) =>
      original(tx, async (start) => {
        await authorize(start);
        admitted();
      }),
  );
  const response = transport.getMockImplementation()!;
  transport.mockImplementation(async (...args) => {
    await responseGate;
    return response(...args);
  });
  const operation = submit();
  try {
    await admittedGate;
    await scanner.update();
    await db().dataSource.query('SELECT 1');
    expect((await current()).status).toBe(TransactionStatus.signed);
  } finally {
    release();
  }
  await operation;
  expect((await current()).status).toBe(TransactionStatus.sent);
});
/**
 * @target TransactionSigningContext.bind 'prepared lifetime is closed, one-use, and separate from signing attempts'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'prepared lifetime is closed, one-use, and separate from signing attempts' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepared.authorizeSubmit(start)).rejects.toThrow(); await expect(prepared.withResult(async () => undefined)).rejects.toThrow(); await expect(prepared.authorizeSubmit(start)).rejects.toThrow(); await expect(attempt.preparePaymentSubmission(1000)).rejects.toThrow( 'Signing attempts', ); expect(start).toHaveBeenCalledOnce();
 */
it('prepared lifetime is closed, one-use, and separate from signing attempts', async () => {
  const bound = await context.bind(await current(), [TransactionStatus.signed]);
  const prepared = await bound.preparePaymentSubmission(1000);
  const start = vi.fn();
  await prepared.authorizeSubmit(start);
  await expect(prepared.authorizeSubmit(start)).rejects.toThrow();
  await prepared.withResult((row, permit) =>
    db().setTxStatusIfUnchanged(row, TransactionStatus.sent, permit),
  );
  await expect(prepared.withResult(async () => undefined)).rejects.toThrow();
  prepared.close();
  await expect(prepared.authorizeSubmit(start)).rejects.toThrow();
  const attempt = context.beginAttempt(bound, 1000, () => true);
  await expect(attempt.preparePaymentSubmission(1000)).rejects.toThrow(
    'Signing attempts',
  );
  expect(start).toHaveBeenCalledOnce();
});
/**
 * @target TransactionSigningContext.bind 'expired preparation cannot start HTTP'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'expired preparation cannot start HTTP' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepared.authorizeSubmit(vi.fn())).rejects.toThrow('expired'); expect(transport).not.toHaveBeenCalled();
 */
it('expired preparation cannot start HTTP', async () => {
  const bound = await context.bind(await current(), [TransactionStatus.signed]);
  const prepared = await bound.preparePaymentSubmission(1000);
  vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1001);
  await expect(prepared.authorizeSubmit(vi.fn())).rejects.toThrow('expired');
  expect(transport).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.bind 'rejects a changed fresh decoder copy after authority binding'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects a changed fresh decoder copy after authority binding' with the suite's captured inputs and invoke the bind path.
 * @expected expect(() => prepared.payment()).toThrow( 'decoder changed captured submission', ); expect(transport).not.toHaveBeenCalled();
 */
it('rejects a changed fresh decoder copy after authority binding', async () => {
  const bound = await context.bind(await current(), [TransactionStatus.signed]);
  const prepared = await bound.preparePaymentSubmission(1000);
  mutateDecode = (decoded) => {
    decoded.eventId = 'changed';
  };
  expect(() => prepared.payment()).toThrow(
    'decoder changed captured submission',
  );
  expect(transport).not.toHaveBeenCalled();
  prepared.close();
});
/**
 * @target TransactionSigningContext.bind 'rejects hidden direct %s mutation in a fresh decoder copy'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects hidden direct %s mutation in a fresh decoder copy' with the suite's captured inputs and invoke the bind path.
 * @expected expect(() => prepared.payment()).toThrow( 'decoder changed captured submission', ); expect(transport).not.toHaveBeenCalled();
 */
it.each(['network', 'txId', 'eventId', 'txType', 'txBytes'])(
  'rejects hidden direct %s mutation in a fresh decoder copy',
  async (field) => {
    const bound = await context.bind(await current(), [
      TransactionStatus.signed,
    ]);
    const prepared = await bound.preparePaymentSubmission(1000);
    mutateDecode = (decoded) => {
      const json = decoded.toJson();
      Object.assign(decoded, {
        [field]: field === 'txBytes' ? new Uint8Array([0]) : 'changed',
      });
      decoded.toJson = () => json;
    };
    expect(() => prepared.payment()).toThrow(
      'decoder changed captured submission',
    );
    expect(transport).not.toHaveBeenCalled();
    prepared.close();
  },
);
/**
 * @target TransactionSigningContext.bind 'rejects hidden fresh Ergo auxiliary mutation %s'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects hidden fresh Ergo auxiliary mutation %s' with the suite's captured inputs and invoke the bind path.
 * @expected expect(() => prepared.payment()).toThrow( 'decoder changed captured auxiliary input', ); expect(transport).not.toHaveBeenCalled();
 */
it.each(['input-bytes', 'input-hole', 'input-inherited', 'data-bytes'])(
  'rejects hidden fresh Ergo auxiliary mutation %s',
  async (fault) => {
    const fixture = await setupErgo(false, true);
    try {
      await db().EventRepository.update(
        { eventId: payment.eventId },
        { sourceChainHeight: 1, sourceBlockId: blockHash(1) },
      );
      const bound = await context.bind(await current(), [
        TransactionStatus.signed,
      ]);
      const prepared = await bound.preparePaymentSubmission(1000);
      mutateDecode = (decoded) => {
        const json = decoded.toJson();
        const ergo = decoded as ErgoTransaction;
        if (fault === 'input-bytes') ergo.inputBoxes[0] = new Uint8Array([0]);
        if (fault === 'input-hole') delete ergo.inputBoxes[0];
        if (fault === 'input-inherited') {
          const value = ergo.inputBoxes[0];
          delete ergo.inputBoxes[0];
          Object.setPrototypeOf(ergo.inputBoxes, { 0: value });
        }
        if (fault === 'data-bytes') ergo.dataInputs[0] = new Uint8Array([0]);
        decoded.toJson = () => json;
      };
      expect(() => prepared.payment()).toThrow(
        'decoder changed captured auxiliary input',
      );
      expect(transport).not.toHaveBeenCalled();
      prepared.close();
    } finally {
      fixture.restore();
    }
  },
);
/**
 * @target TransactionSigningContext.current 'resends captured original bytes after the preliminary validity check mutates its copy'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'resends captured original bytes after the preliminary validity check mutates its copy' with the suite's captured inputs and invoke the current path.
 * @expected expect(JSON.parse(Buffer.from(request.body).toString()).params[0]).toBe( '0x' + Buffer.from(payment.txBytes).toString('hex'), ); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it('resends captured original bytes after the preliminary validity check mutates its copy', async () => {
  await db().TransactionRepository.update(
    { txId: payment.txId },
    { status: TransactionStatus.sent },
  );
  vi.spyOn(chain, 'getTxConfirmationStatus').mockResolvedValue(
    ConfirmationStatus.NotFound,
  );
  vi.spyOn(chain, 'isTxInMempool').mockResolvedValue(false);
  vi.spyOn(chain, 'isTxValid').mockImplementationOnce(async (input) => {
    input.txBytes.fill(0);
    return { isValid: true, details: undefined };
  });
  await TransactionProcessor.processSentTx(await current());
  const request = transport.mock.calls[0][0];
  expect(JSON.parse(Buffer.from(request.body).toString()).params[0]).toBe(
    '0x' + Buffer.from(payment.txBytes).toString('hex'),
  );
  expect((await current()).status).toBe(TransactionStatus.sent);
});
/**
 * @target TransactionSigningContext.current 'submits the captured chain and body after the caller row changes during binding'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'submits the captured chain and body after the caller row changes during binding' with the suite's captured inputs and invoke the current path.
 * @expected expect(transport).toHaveBeenCalledOnce(); expect(JSON.parse(Buffer.from(request.body).toString()).params[0]).toBe( '0x' + Buffer.from(payment.txBytes).toString('hex'), ); expect((await current()).status).toBe(TransactionStatus.sent);
 */
it('submits the captured chain and body after the caller row changes during binding', async () => {
  const input = await current();
  const bind = context.bind;
  vi.spyOn(context, 'bind').mockImplementationOnce(async (...args) => {
    const bound = await bind(...args);
    input.chain = 'ethereum';
    input.txJson = JSON.stringify({
      ...JSON.parse(input.txJson),
      txBytes: '00',
    });
    return bound;
  });
  await TransactionProcessor.processSignedTx(input);
  expect(transport).toHaveBeenCalledOnce();
  const request = transport.mock.calls[0][0];
  expect(JSON.parse(Buffer.from(request.body).toString()).params[0]).toBe(
    '0x' + Buffer.from(payment.txBytes).toString('hex'),
  );
  expect((await current()).status).toBe(TransactionStatus.sent);
});
/**
 * @target TransactionSigningContext.current 'preserves a concurrent invalid row winner after HTTP instead of marking it sent'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves a concurrent invalid row winner after HTTP instead of marking it sent' with the suite's captured inputs and invoke the current path.
 * @expected await expect(submit()).rejects.toThrow(); expect(transport).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.invalid);
 */
it('preserves a concurrent invalid row winner after HTTP instead of marking it sent', async () => {
  const response = transport.getMockImplementation()!;
  transport.mockImplementation(async (...args) => {
    await db().TransactionRepository.update(
      { txId: payment.txId },
      { status: TransactionStatus.invalid },
    );
    return response(...args);
  });
  await expect(submit()).rejects.toThrow();
  expect(transport).toHaveBeenCalledOnce();
  expect((await current()).status).toBe(TransactionStatus.invalid);
});
const legacyRoute = async () => {
  payment.network = 'ethereum';
  await db().EventRepository.update(
    { eventId: payment.eventId },
    { fromChain: 'ergo', toChain: 'ethereum' },
  );
  await db().TransactionRepository.update(
    { txId: payment.txId },
    { chain: 'ethereum', txJson: payment.toJson() },
  );
  const legacy = {
    submitTransaction: vi.fn(async () => {}),
  } as unknown as AbstractChain<unknown>;
  const previous = getChain;
  getChain = (name) => (name === 'ethereum' ? legacy : previous(name));
  return legacy;
};
/**
 * @target TransactionSigningContext.current 'preserves explicitly classified unrelated legacy payment behavior'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves explicitly classified unrelated legacy payment behavior' with the suite's captured inputs and invoke the current path.
 * @expected expect(legacy.submitTransaction).toHaveBeenCalledOnce(); expect((await current()).status).toBe(TransactionStatus.sent); expect(transport).not.toHaveBeenCalled();
 */
it('preserves explicitly classified unrelated legacy payment behavior', async () => {
  const legacy = await legacyRoute();
  await submit();
  expect(legacy.submitTransaction).toHaveBeenCalledOnce();
  expect((await current()).status).toBe(TransactionStatus.sent);
  expect(transport).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'never downgrades %s Avalanche evidence to legacy submission'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'never downgrades %s Avalanche evidence to legacy submission' with the suite's captured inputs and invoke the current path.
 * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(legacy.submitTransaction).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
 */
it.each(['remembered', 'extractor', 'stored-chain'])(
  'never downgrades %s Avalanche evidence to legacy submission',
  async (fault) => {
    if (fault === 'remembered')
      await context['dependencies'].bindPayment!(expected, 'submission');
    const legacy = await legacyRoute();
    if (fault === 'extractor')
      await db().EventRepository.update(
        { eventId: payment.eventId },
        { extractor: 'avalancheEventTrigger' },
      );
    if (fault === 'stored-chain')
      await DatabaseActionMock.insertTxRecord(
        new PaymentTransaction(
          'avalanche',
          'other-tx',
          payment.eventId,
          payment.txBytes,
          TransactionType.payment,
        ),
        TransactionStatus.invalid,
        1,
        'first',
        false,
        0,
        3,
      );
    const before = await snapshot();
    await expect(submit()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(legacy.submitTransaction).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.bind 'rechecks legacy classification immediately before its action'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rechecks legacy classification immediately before its action' with the suite's captured inputs and invoke the bind path.
 * @expected expect(prepared.kind).toBe('legacy'); await expect( prepared.withLegacyAction(async () => legacy.submitTransaction(payment)), ).rejects.toThrow(); expect(legacy.submitTransaction).not.toHaveBeenCalled();
 */
it('rechecks legacy classification immediately before its action', async () => {
  const legacy = await legacyRoute();
  const bound = await context.bind(await current(), [TransactionStatus.signed]);
  const prepared = await bound.preparePaymentSubmission(undefined);
  expect(prepared.kind).toBe('legacy');
  await db().EventRepository.update(
    { eventId: payment.eventId },
    { extractor: 'avalancheEventTrigger' },
  );
  await expect(
    prepared.withLegacyAction(async () => legacy.submitTransaction(payment)),
  ).rejects.toThrow();
  expect(legacy.submitTransaction).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'rolls back sent persistence on SQL %s with no partial payment/event mutation'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back sent persistence on SQL %s with no partial payment/event mutation' with the suite's captured inputs and invoke the current path.
 * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).toHaveBeenCalledOnce();
 */
it.each(['ABORT', 'IGNORE', 'after-row'])(
  'rolls back sent persistence on SQL %s with no partial payment/event mutation',
  async (fault) => {
    const before = await snapshot();
    const sql =
      fault === 'after-row'
        ? "CREATE TRIGGER payment_submission_failure AFTER UPDATE OF status ON transaction_entity WHEN NEW.status = 'sent' BEGIN UPDATE transaction_entity SET requiredSign = 99 WHERE txId = NEW.txId; END"
        : `CREATE TRIGGER payment_submission_failure BEFORE UPDATE OF status ON transaction_entity WHEN NEW.status = 'sent' BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'fixture abort'" : ''}); END`;
    await db().dataSource.query(sql);
    try {
      await expect(submit()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      await db().dataSource.query('DROP TRIGGER payment_submission_failure');
    }
  },
);
/**
 * @target TransactionSigningContext.bind 'refuses %s while queued for final SQL ownership before POST'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses %s while queued for final SQL ownership before POST' with the suite's captured inputs and invoke the bind path.
 * @expected expect(await operation).toBeInstanceOf(Error); expect(start).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled(); expect((await current()).status).toBe(TransactionStatus.signed); expect((await current()).requiredSign).toBe(fault === 'row' ? 9 : 3);
 */
it.each(['expiry', 'fee', 'row'])(
  'refuses %s while queued for final SQL ownership before POST',
  async (fault) => {
    const bound = await context.bind(await current(), [
      TransactionStatus.signed,
    ]);
    const prepared = await bound.preparePaymentSubmission(1000);
    let acquired!: () => void, queued!: () => void, release!: () => void;
    const owned = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let owner: Promise<void> | undefined;
    vi.mocked(network.getFeeData).mockImplementationOnce(async () => {
      owner = db().dataSource.transaction(async (manager) => {
        if (fault === 'row')
          await manager
            .getRepository(db().TransactionRepository.target)
            .update({ txId: payment.txId }, { requiredSign: 9 });
        acquired();
        await gate;
      });
      await owned;
      const create = db().dataSource.createQueryRunner.bind(db().dataSource);
      vi.spyOn(db().dataSource, 'createQueryRunner').mockImplementationOnce(
        () => {
          const runner = create();
          const start = runner.startTransaction.bind(runner);
          vi.spyOn(runner, 'startTransaction').mockImplementation(async () => {
            queued();
            await start();
          });
          return runner;
        },
      );
      return new FeeData(null, 20n, 2n);
    });
    const start = vi.fn();
    const operation = prepared.authorizeSubmit(start).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waiting;
      if (fault === 'expiry')
        vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1001);
      if (fault === 'fee')
        vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
          ...fee,
          networkFee: 1n,
        });
      release();
      await owner;
      expect(await operation).toBeInstanceOf(Error);
      expect(start).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect((await current()).status).toBe(TransactionStatus.signed);
      expect((await current()).requiredSign).toBe(fault === 'row' ? 9 : 3);
    } finally {
      release();
      await owner;
      prepared.close();
    }
  },
);
/**
 * @target TransactionSigningContext.bind 'rejects Avalanche-source Ergo %s before submission'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects Avalanche-source Ergo %s before submission' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(submit()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(legacy).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
 */
it.each(['missing-binder', 'wrong-source', 'sparse-input', 'partial-spend'])(
  'rejects Avalanche-source Ergo %s before submission',
  async (fault) => {
    const fixture = await setupErgo();
    try {
      await db().EventRepository.update(
        { eventId: payment.eventId },
        {
          sourceChainHeight: 1,
          sourceBlockId: blockHash(fault === 'wrong-source' ? 99 : 1),
        },
      );
      if (fault === 'missing-binder')
        context['dependencies'].bindPayment = undefined;
      if (fault === 'sparse-input') {
        const m = JSON.parse(payment.toJson());
        delete m.inputBoxes[0];
        await db().TransactionRepository.update(
          { txId: payment.txId },
          { txJson: JSON.stringify(m) },
        );
      }
      if (fault === 'partial-spend')
        await db().EventRepository.update(
          { eventId: payment.eventId },
          { spendTxId: payment.txId },
        );
      const legacy = vi.spyOn(fixture.ergo, 'submitTransaction');
      const before = await snapshot();
      await expect(submit()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(legacy).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  },
);
