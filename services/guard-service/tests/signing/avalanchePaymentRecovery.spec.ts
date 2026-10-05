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
const hold = async () =>
  scannerDb
    .getRepository(AvalancheSafetyState)
    .update({ scanner: 'avalanche' }, { holdReason: 'fixture hold' });

const setupErgoRecovery = async (additional = false, includeData = false) => {
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

/**
 * @target TransactionSigningContext.current 'recovers actual Reduced Ergo body with data inputs=%s and freshly completes'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'recovers actual Reduced Ergo body with data inputs=%s and freshly completes' with the suite's captured inputs and invoke the current path.
 * @expected expect(after.row.status).toBe(TransactionStatus.sent); expect(JSON.parse(after.row.txJson).txBytes).toBe(fixture.signedHex); expect(after.event).toEqual(before.event); expect((await current()).status).toBe(TransactionStatus.completed); expect((await db().getEventById(payment.eventId))!.status).toBe( EventStatus.completed, ); expect(transport).not.toHaveBeenCalled();
 */
it.each([false, true])(
  'recovers actual Reduced Ergo body with data inputs=%s and freshly completes',
  async (data) => {
    const fixture = await setupErgoRecovery(true, data);
    try {
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
      const reduced = wasm.ReducedTransaction.sigma_parse_bytes(
        payment.txBytes,
      );
      const inputs = reduced.unsigned_tx().inputs();
      for (let index = 0; index < inputs.len(); index++) {
        await db().CommitmentRepository.update(
          { identifier: inputs.get(index).box_id().to_str() },
          {
            spendHeight: block.height,
            spendBlock: block.hash,
            spendTxId: payment.txId,
            spendIndex: index,
          },
        );
      }
      fixture.rawNetwork.getBlockInfo.mockResolvedValue(block as never);
      fixture.rawNetwork.getTransaction.mockImplementation(async () =>
        wasm.Transaction.sigma_parse_bytes(
          Buffer.from(fixture.signedHex, 'hex'),
        ),
      );
      vi.spyOn(fixture.ergo, 'getTransaction').mockResolvedValue(
        fixture.signedHex,
      );
      vi.spyOn(fixture.ergo, 'getTxConfirmationStatus').mockResolvedValue(
        ConfirmationStatus.ConfirmedEnough,
      );
      vi.spyOn(fixture.ergo, 'isTxInMempool').mockResolvedValue(false);
      const before = await snapshot();
      await recover();
      const after = await snapshot();
      expect(after.row.status).toBe(TransactionStatus.sent);
      expect(JSON.parse(after.row.txJson).txBytes).toBe(fixture.signedHex);
      expect(after.event).toEqual(before.event);
      await TransactionProcessor.processSentTx(after.row);
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

const seedRecovery = async () => {
  const signed = Transaction.from(
    '0x' + Buffer.from(payment.txBytes).toString('hex'),
  );
  payment.txBytes = Buffer.from(signed.unsignedSerialized.slice(2), 'hex');
  await db().TransactionRepository.update(
    { txId: payment.txId },
    {
      txJson: payment.toJson(),
      status: TransactionStatus.signFailed,
      failedInSign: true,
      signFailedCount: 2,
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
  await db().dataSource.getRepository(AddressTxsEntity).insert({
    address: address.toLowerCase(),
    extractor: AVALANCHE_TX_EXTRACTOR,
    unsignedHash: signed.unsignedHash,
    signedHash: signed.hash!,
    nonce: signed.nonce,
    blockId: block.hash,
    status: 'succeed',
  });
  const evidence = Object.freeze({
    signedBytes: signed.serialized,
    hash: signed.hash!,
    unsignedHash: signed.unsignedHash,
    from: address.toLowerCase(),
    chainId: 43113n,
    nonce: signed.nonce,
    blockHash: block.hash,
    blockNumber: 12,
    index: 0,
    finalizedBlockHash: blockHash(18),
    finalizedBlockNumber: 18,
    confirmations: 7,
    status: 'succeed' as never,
  });
  vi.spyOn(network, 'getSettledTransactionEvidence').mockResolvedValue(
    evidence,
  );
  vi.spyOn(network, 'getBlockInfo').mockResolvedValue(block);
  vi.spyOn(network, 'getTransaction').mockResolvedValue(signed);
  vi.mocked(network.getTransactionStatus).mockResolvedValue('succeed' as never);
  vi.spyOn(chain, 'getHeight').mockResolvedValue(18);
  vi.spyOn(chain, 'getTxConfirmationStatus').mockResolvedValue(
    ConfirmationStatus.ConfirmedEnough,
  );
  vi.spyOn(chain, 'isTxInMempool').mockResolvedValue(false);
  vi.spyOn(NotificationHandler, 'getInstance').mockReturnValue({
    notify: vi.fn(),
  } as never);
  return { signed, evidence, block };
};
const recover = async () =>
  TransactionProcessor.processSignFailedTx(await current());
const directRecover = async (timeout = 1000) => {
  const row = await current();
  const bound = await context.bind(row, [TransactionStatus.signFailed]);
  return bound.withPaymentRecovery(
    db().captureTxCheckPreimage(row),
    timeout,
    (expected, signedJson, authorization) => {
      if (!signedJson || !authorization)
        throw new Error('Qualified recovery required');
      return db().recoverSignedPaymentIfUnchanged(
        expected,
        signedJson,
        authorization,
      );
    },
  );
};

/**
 * @target TransactionSigningContext.current 'rejects mismatched captured recovery %s before binding'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects mismatched captured recovery %s before binding' with the suite's captured inputs and invoke the current path.
 * @expected await expect( bound.withPaymentRecovery( { ...db().captureTxCheckPreimage(row), [field as string]: value }, 1000, action, ), ).rejects.toThrow(); expect(bind).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
 */
it.each([
  ['txId', 'other'],
  ['txJson', '{}'],
  ['chain', 'ergo'],
  ['type', 'reward'],
  ['status', 'sent'],
  ['requiredSign', 99],
  ['eventId', 'other'],
  ['orderId', 'other'],
  ['lastCheck', -1],
  ['lastStatusUpdate', undefined],
  ['failedInSign', 'true'],
  ['signFailedCount', -1],
])(
  'rejects mismatched captured recovery %s before binding',
  async (field, value) => {
    await seedRecovery();
    const row = await current();
    const bound = await context.bind(row, [TransactionStatus.signFailed]);
    const bind = vi.spyOn(context['dependencies'], 'bindPaymentRecovery');
    const action = vi.fn();
    await expect(
      bound.withPaymentRecovery(
        { ...db().captureTxCheckPreimage(row), [field as string]: value },
        1000,
        action,
      ),
    ).rejects.toThrow();
    expect(bind).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'rejects final legacy reclassification %j'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects final legacy reclassification %j' with the suite's captured inputs and invoke the current path.
 * @expected await expect( bound.withPaymentRecovery( db().captureTxCheckPreimage(row), undefined, action, ), ).rejects.toThrow('route changed'); expect(action).not.toHaveBeenCalled();
 */
it.each([null, false, { purpose: 'recovery' }])(
  'rejects final legacy reclassification %j',
  async (invalid) => {
    await seedRecovery();
    context['dependencies'].bindPaymentRecovery = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(invalid);
    const row = await current();
    const bound = await context.bind(row, [TransactionStatus.signFailed]);
    const action = vi.fn();
    await expect(
      bound.withPaymentRecovery(
        db().captureTxCheckPreimage(row),
        undefined,
        action,
      ),
    ).rejects.toThrow('route changed');
    expect(action).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'preserves genuine non-Avalanche legacy found-on-chain behavior'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves genuine non-Avalanche legacy found-on-chain behavior' with the suite's captured inputs and invoke the current path.
 * @expected expect(after.row.status).toBe(TransactionStatus.sent); expect(after.row.txJson).toBe(before.row.txJson); expect(after.event).toEqual(before.event); expect(network.getSettledTransactionEvidence).not.toHaveBeenCalled();
 */
it('preserves genuine non-Avalanche legacy found-on-chain behavior', async () => {
  await seedRecovery();
  payment.network = 'cardano';
  await db().TransactionRepository.update(
    { txId: payment.txId },
    { chain: 'cardano', txJson: payment.toJson() },
  );
  await db().EventRepository.update(
    { eventId: payment.eventId },
    { fromChain: 'ergo', toChain: 'cardano' },
  );
  getChain = () =>
    ({
      getTxConfirmationStatus: async () => ConfirmationStatus.ConfirmedEnough,
    }) as unknown as AbstractChain<unknown>;
  const before = await snapshot();
  await recover();
  const after = await snapshot();
  expect(after.row.status).toBe(TransactionStatus.sent);
  expect(after.row.txJson).toBe(before.row.txJson);
  expect(after.event).toEqual(before.event);
  expect(network.getSettledTransactionEvidence).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'captures caller identity and check metadata before confirmation awaits'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'captures caller identity and check metadata before confirmation awaits' with the suite's captured inputs and invoke the current path.
 * @expected expect(JSON.parse(after.row.txJson).txBytes).toBe(signed.serialized.slice(2)); expect(after.row.lastCheck).toBe(before.row.lastCheck); expect(after.row.signFailedCount).toBe(before.row.signFailedCount); expect(after.row.failedInSign).toBe(before.row.failedInSign); expect(after.event).toEqual(before.event);
 */
it('captures caller identity and check metadata before confirmation awaits', async () => {
  const { signed } = await seedRecovery();
  const caller = await current();
  const before = await snapshot();
  vi.mocked(chain.getTxConfirmationStatus).mockImplementation(async () => {
    caller.txJson = '{}';
    caller.chain = 'cardano';
    caller.type = 'manual';
    caller.lastCheck = 99;
    caller.lastStatusUpdate = 'caller';
    caller.signFailedCount = 99;
    caller.failedInSign = false;
    caller.event!.id = 'caller';
    return ConfirmationStatus.ConfirmedEnough;
  });
  await TransactionProcessor.processSignFailedTx(caller);
  const after = await snapshot();
  expect(JSON.parse(after.row.txJson).txBytes).toBe(signed.serialized.slice(2));
  expect(after.row.lastCheck).toBe(before.row.lastCheck);
  expect(after.row.signFailedCount).toBe(before.row.signFailedCount);
  expect(after.row.failedInSign).toBe(before.row.failedInSign);
  expect(after.event).toEqual(before.event);
});
/**
 * @target TransactionSigningContext.current 'expires while queued behind the scanner lease without invoking persistence'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'expires while queued behind the scanner lease without invoking persistence' with the suite's captured inputs and invoke the current path.
 * @expected expect((await outcome)?.message).toContain('expired'); expect(await snapshot()).toEqual(before);
 */
it('expires while queued behind the scanner lease without invoking persistence', async () => {
  await seedRecovery();
  const before = await snapshot();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  let release!: () => void, acquired!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const owner = scanner.withSafety(async () => {
    acquired();
    await gate;
  });
  await started;
  const bind = context['dependencies'].bindPaymentRecovery!;
  let bound!: () => void;
  const prepared = new Promise<void>((resolve) => {
    bound = resolve;
  });
  context['dependencies'].bindPaymentRecovery = async (...args) => {
    const result = await bind(...args);
    bound();
    return result;
  };
  const pending = directRecover();
  const outcome = pending.then(
    () => undefined,
    (error: Error) => error,
  );
  await prepared;
  clock.mockReturnValue(2000);
  release();
  await owner;
  expect((await outcome)?.message).toContain('expired');
  expect(await snapshot()).toEqual(before);
  await scanner.update();
});

/**
 * @target TransactionSigningContext.current 'recovers actual unsigned Avalanche payment through the real DAO, then freshly completes'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'recovers actual unsigned Avalanche payment through the real DAO, then freshly completes' with the suite's captured inputs and invoke the current path.
 * @expected expect(after.row.status).toBe(TransactionStatus.sent); expect(JSON.parse(after.row.txJson).txBytes).toBe(signed.serialized.slice(2)); expect(after.row.lastCheck).toBe(before.row.lastCheck); expect(after.row.failedInSign).toBe(before.row.failedInSign); expect(after.row.signFailedCount).toBe(before.row.signFailedCount); expect(after.event).toEqual(before.event); expect((await current()).status).toBe(TransactionStatus.completed); expect((await db().getEventById(payment.eventId))!.status).toBe( EventStatus.pendingReward, ); expect(transport).not.toHaveBeenCalled();
 */
it('recovers actual unsigned Avalanche payment through the real DAO, then freshly completes', async () => {
  const { signed } = await seedRecovery();
  const before = await snapshot();
  await recover();
  const after = await snapshot();
  expect(after.row.status).toBe(TransactionStatus.sent);
  expect(JSON.parse(after.row.txJson).txBytes).toBe(signed.serialized.slice(2));
  expect(after.row.lastCheck).toBe(before.row.lastCheck);
  expect(after.row.failedInSign).toBe(before.row.failedInSign);
  expect(after.row.signFailedCount).toBe(before.row.signFailedCount);
  expect(after.event).toEqual(before.event);
  await TransactionProcessor.processSentTx(after.row);
  expect((await current()).status).toBe(TransactionStatus.completed);
  expect((await db().getEventById(payment.eventId))!.status).toBe(
    EventStatus.pendingReward,
  );
  expect(transport).not.toHaveBeenCalled();
});

/**
 * @target TransactionSigningContext.current 'rejects malformed recovery authority %j'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects malformed recovery authority %j' with the suite's captured inputs and invoke the current path.
 * @expected await expect(recover()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled();
 */
it.each([
  null,
  false,
  { purpose: 'submission' },
  { purpose: 'recovery', identity: '' },
])('rejects malformed recovery authority %j', async (value) => {
  await seedRecovery();
  context['dependencies'].bindPaymentRecovery = vi
    .fn()
    .mockResolvedValue(value);
  const before = await snapshot();
  await expect(recover()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(transport).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'rejects missing recovery binder rather than performing status-only observation'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects missing recovery binder rather than performing status-only observation' with the suite's captured inputs and invoke the current path.
 * @expected await expect(recover()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
 */
it('rejects missing recovery binder rather than performing status-only observation', async () => {
  await seedRecovery();
  context['dependencies'].bindPaymentRecovery = undefined;
  const before = await snapshot();
  await expect(recover()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
/**
 * @target TransactionSigningContext.bind 'rejects generic payment recovery before invoking its callback'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects generic payment recovery before invoking its callback' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(bound.withPersistence('recovery', action)).rejects.toThrow( 'explicit authority', ); expect(action).not.toHaveBeenCalled();
 */
it('rejects generic payment recovery before invoking its callback', async () => {
  await seedRecovery();
  const bound = await context.bind(await current(), [
    TransactionStatus.signFailed,
  ]);
  const action = vi.fn();
  await expect(bound.withPersistence('recovery', action)).rejects.toThrow(
    'explicit authority',
  );
  expect(action).not.toHaveBeenCalled();
});
/**
 * @target TransactionSigningContext.current 'does not promote %s evidence'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'does not promote %s evidence' with the suite's captured inputs and invoke the current path.
 * @expected await expect(recover()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(transport).not.toHaveBeenCalled();
 */
it.each(['failed', 'mempool', 'pruned', 'malformed', 'hold'])(
  'does not promote %s evidence',
  async (fault) => {
    const { evidence } = await seedRecovery();
    if (fault === 'failed')
      vi.mocked(network.getSettledTransactionEvidence).mockResolvedValue({
        ...evidence,
        status: 'failed' as never,
      });
    if (fault === 'mempool' || fault === 'pruned') {
      vi.mocked(network.getSettledTransactionEvidence).mockRejectedValue(
        new Error(fault),
      );
      vi.mocked(chain.getTxConfirmationStatus).mockResolvedValue(
        ConfirmationStatus.NotFound,
      );
      vi.mocked(chain.isTxInMempool).mockResolvedValue(true);
    }
    if (fault === 'malformed')
      vi.mocked(network.getSettledTransactionEvidence).mockResolvedValue({
        ...evidence,
        signedBytes: '0xcdef',
      });
    if (fault === 'hold') await hold();
    const before = await snapshot();
    await expect(recover()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(transport).not.toHaveBeenCalled();
  },
);
/**
 * @target TransactionSigningContext.current 'refuses invalid recovery lifetime %s'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'refuses invalid recovery lifetime %s' with the suite's captured inputs and invoke the current path.
 * @expected await expect(directRecover(timeout)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
 */
it.each([0, -1, NaN, Infinity, 1.5, 2147483648])(
  'refuses invalid recovery lifetime %s',
  async (timeout) => {
    await seedRecovery();
    const before = await snapshot();
    await expect(directRecover(timeout)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  },
);
/**
 * @target TransactionSigningContext.current 'counts the initial asynchronous binder wait in its lifetime'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'counts the initial asynchronous binder wait in its lifetime' with the suite's captured inputs and invoke the current path.
 * @expected await expect(directRecover(5)).rejects.toThrow('expired'); expect(await snapshot()).toEqual(before);
 */
it('counts the initial asynchronous binder wait in its lifetime', async () => {
  await seedRecovery();
  const original = context['dependencies'].bindPaymentRecovery!;
  context['dependencies'].bindPaymentRecovery = async (...args) => {
    const bound = await original(...args);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return bound;
  };
  const before = await snapshot();
  await expect(directRecover(5)).rejects.toThrow('expired');
  expect(await snapshot()).toEqual(before);
});
/**
 * @target TransactionSigningContext.current 'closes the persistence authorization after its action returns'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'closes the persistence authorization after its action returns' with the suite's captured inputs and invoke the current path.
 * @expected expect(active).toBeDefined(); expect(() => active!()).toThrow('expired');
 */
it('closes the persistence authorization after its action returns', async () => {
  await seedRecovery();
  const row = await current();
  const bound = await context.bind(row, [TransactionStatus.signFailed]);
  let active: (() => void) | undefined;
  await bound.withPaymentRecovery(
    db().captureTxCheckPreimage(row),
    1000,
    async (_row, _json, authorization) => {
      active = authorization!.assertActive;
    },
  );
  expect(active).toBeDefined();
  expect(() => active!()).toThrow('expired');
});

/**
 * @target TransactionSigningContext.current 'preserves the concurrent twelve-field %s winner'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves the concurrent twelve-field %s winner' with the suite's captured inputs and invoke the current path.
 * @expected await expect(recover()).rejects.toThrow(); expect(winner).toBeDefined(); expect(await snapshot()).toEqual(winner);
 */
it.each([
  'txId',
  'txJson',
  'chain',
  'type',
  'status',
  'requiredSign',
  'eventId',
  'orderId',
  'lastCheck',
  'lastStatusUpdate',
  'failedInSign',
  'signFailedCount',
])('preserves the concurrent twelve-field %s winner', async (field) => {
  const { evidence } = await seedRecovery();
  if (field === 'orderId')
    await db().dataSource.getRepository(ArbitraryEntity).insert({
      id: 'other',
      chain: 'avalanche',
      orderJson: '[]',
      status: 'pending',
    });
  let winner: Awaited<ReturnType<typeof snapshot>> | undefined;
  let changed = false;
  vi.mocked(network.getSettledTransactionEvidence).mockImplementation(
    async () => {
      if (!changed) {
        changed = true;
        const values: Record<string, unknown> = {
          txId: 'winner',
          txJson: payment.toJson() + ' ',
          chain: 'ergo',
          type: 'manual',
          status: TransactionStatus.invalid,
          requiredSign: 99,
          eventId: null,
          orderId: 'other',
          lastCheck: 99,
          lastStatusUpdate: 'winner',
          failedInSign: false,
          signFailedCount: 99,
        };
        await db().dataSource.query(
          `UPDATE transaction_entity SET ${field} = ? WHERE txId = ?`,
          [values[field], payment.txId],
        );
        winner = await snapshot();
      }
      return evidence;
    },
  );
  await expect(recover()).rejects.toThrow();
  expect(winner).toBeDefined();
  expect(await snapshot()).toEqual(winner);
});
/**
 * @target TransactionSigningContext.current 'rolls back recovery SQL %s without public notification'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back recovery SQL %s without public notification' with the suite's captured inputs and invoke the current path.
 * @expected await expect(recover()).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(notify).not.toHaveBeenCalled();
 */
it.each(['ABORT', 'IGNORE', 'row', 'event'])(
  'rolls back recovery SQL %s without public notification',
  async (fault) => {
    await seedRecovery();
    const before = await snapshot();
    const notify = vi.spyOn(
      PublicStatusHandler.getInstance(),
      'updatePublicTxStatus',
    );
    const sql =
      fault === 'row'
        ? "CREATE TRIGGER payment_recovery_failure AFTER UPDATE OF status ON transaction_entity WHEN NEW.status='sent' BEGIN UPDATE transaction_entity SET signFailedCount=99 WHERE txId=NEW.txId; END"
        : fault === 'event'
          ? "CREATE TRIGGER payment_recovery_failure AFTER UPDATE OF status ON transaction_entity WHEN NEW.status='sent' BEGIN UPDATE confirmed_event_entity SET firstTry='changed' WHERE id=NEW.eventId; END"
          : `CREATE TRIGGER payment_recovery_failure BEFORE UPDATE OF status ON transaction_entity WHEN NEW.status='sent' BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'fixture abort'" : ''}); END`;
    await db().dataSource.query(sql);
    try {
      await expect(recover()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await db().dataSource.query('DROP TRIGGER payment_recovery_failure');
    }
  },
);
/**
 * @target TransactionSigningContext.current 'expires at %s and rolls back'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'expires at %s and rolls back' with the suite's captured inputs and invoke the current path.
 * @expected await expect(recover()).rejects.toThrow('expired'); expect(await snapshot()).toEqual(before);
 */
it.each(['prepare', 'after-write'])(
  'expires at %s and rolls back',
  async (stage) => {
    await seedRecovery();
    const before = await snapshot();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const bind = context['dependencies'].bindPaymentRecovery!;
    context['dependencies'].bindPaymentRecovery = async (...args) => {
      const bound = (await bind(...args))!;
      return {
        ...bound,
        prepareUnderScannerLease: async (active) => {
          const prepared = await bound.prepareUnderScannerLease(active);
          if (stage === 'prepare') clock.mockReturnValue(2000);
          return {
            ...prepared,
            assertAfter: async (...after) => {
              await prepared.assertAfter(...after);
              if (stage === 'after-write') clock.mockReturnValue(2000);
            },
          };
        },
      };
    };
    await expect(recover()).rejects.toThrow('expired');
    expect(await snapshot()).toEqual(before);
  },
);
/**
 * @target TransactionSigningContext.current 'cannot commit after %s behind the SQL owner'
 * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'cannot commit after %s behind the SQL owner' with the suite's captured inputs and invoke the current path.
 * @expected await expect(recover()).rejects.toThrow(); expect(after.row).toEqual({ ...before.row, lastCheck: fault === 'winner' ? 99 : before.row.lastCheck, }); expect(after.event).toEqual(before.event);
 */
it.each(['expiry', 'winner'])(
  'cannot commit after %s behind the SQL owner',
  async (fault) => {
    await seedRecovery();
    const before = await snapshot();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const actual = db().recoverSignedPaymentIfUnchanged.bind(db());
    vi.spyOn(db(), 'recoverSignedPaymentIfUnchanged').mockImplementation(
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
    await expect(recover()).rejects.toThrow();
    const after = await snapshot();
    expect(after.row).toEqual({
      ...before.row,
      lastCheck: fault === 'winner' ? 99 : before.row.lastCheck,
    });
    expect(after.event).toEqual(before.event);
    await scanner.update();
  },
);
