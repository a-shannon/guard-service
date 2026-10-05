// Synthetic fixture construction reused from the accepted payment-submission suite.
import { blake2b } from 'blakejs';
import * as wasm from 'ergo-lib-wasm-nodejs';
import { computeAddress, FeeData, SigningKey, Transaction } from 'ethers';

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
import { EvmTxStatus } from '@rosen-chains/evm';

import GuardsErgoConfigs from '../../src/configs/guardsErgoConfigs';
import { TransactionCheckPreimage } from '../../src/db/databaseAction';
import EventOrder from '../../src/event/eventOrder';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import {
  SigningRowPreimage,
  TransactionSigningContext,
} from '../../src/signing/transactionSigningContext';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import { PaymentRecoveryAuthorization } from '../../src/verification/paymentRecoveryAuthorization';
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
const observeAvalanche = async () => {
  const signed = Transaction.from(
    '0x' + Buffer.from(payment.txBytes).toString('hex'),
  );
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
  const receipt = {
    hash: signed.hash!,
    blockHash: block.hash,
    blockNumber: block.number,
    index: 0,
    status: 1,
  };
  vi.mocked(network.getTransactionStatus).mockRestore();
  vi.mocked(network.assertNetwork).mockRestore();
  const rpc = network['provider'];
  vi.spyOn(rpc, 'send').mockImplementation(async (method) => {
    if (method === 'eth_chainId') return '0xa869';
    throw new Error('Unexpected observation RPC');
  });
  vi.spyOn(rpc, 'getBlock').mockImplementation(async (tag) => {
    if (tag === 'finalized' || tag === frontier.number)
      return frontier as never;
    if (tag === block.hash || tag === block.number) return block as never;
    throw new Error('Unexpected observation block');
  });
  vi.spyOn(rpc, 'getTransaction').mockImplementation(async (id) => {
    if (id !== signed.hash)
      throw new Error('Unsigned hash used as RPC identity');
    return tx as never;
  });
  vi.spyOn(rpc, 'getTransactionReceipt').mockResolvedValue(receipt as never);
  const record = await db().dataSource.getRepository(AddressTxsEntity).save({
    unsignedHash: signed.unsignedHash,
    signedHash: signed.hash!,
    nonce: signed.nonce,
    address: signed.from!.toLowerCase(),
    blockId: block.hash,
    extractor: AVALANCHE_TX_EXTRACTOR,
    status: 'succeed',
  });
  await db().dataSource.getRepository(BlockEntity).insert({
    scanner: 'avalanche',
    height: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    status: PROCEED,
    timestamp: 1000,
  });
  return { signed, block, frontier, tx, receipt, rpc, record };
};
const observeErgo = async (f: Awaited<ReturnType<typeof setupErgo>>) => {
  const event = (await db().getEventById(expected.eventId!))!;
  const block = {
    scanner: 'ergo',
    height: event.eventData.height + 2,
    hash: '83'.repeat(32),
    parentHash: '82'.repeat(32),
    status: PROCEED,
    timestamp: 1000,
  };
  await db().dataSource.getRepository(BlockEntity).insert(block);
  await db().EventRepository.update(
    { eventId: expected.eventId! },
    {
      spendTxId: expected.txId,
      paymentTxId: expected.txId,
      result: 'successful',
      spendHeight: block.height,
      spendBlock: block.hash,
    },
  );
  const p = payment as ErgoTransaction;
  for (const row of await db().CommitmentRepository.findBy({
    eventId: expected.eventId!,
  })) {
    const index = p.inputBoxes.findIndex((bytes) => {
      const b = wasm.ErgoBox.sigma_parse_bytes(bytes);
      const id = b.box_id();
      try {
        return id.to_str() === row.identifier;
      } finally {
        id.free();
        b.free();
      }
    });
    if (index >= 0)
      await db().CommitmentRepository.update(
        { id: row.id },
        {
          spendTxId: expected.txId,
          spendHeight: block.height,
          spendBlock: block.hash,
          spendIndex: index,
        },
      );
  }
  const raw = { bytes: Buffer.from(payment.txBytes).toString('hex') };
  const getTransaction = vi.fn(async (id: string, hash: string) => {
    if (id !== expected.txId || hash !== block.hash)
      throw new Error('Wrong Ergo observation identity');
    return wasm.Transaction.sigma_parse_bytes(Buffer.from(raw.bytes, 'hex'));
  });
  const getBlockInfo = vi.fn(async () => ({
    hash: block.hash,
    height: block.height,
    parentHash: block.parentHash,
  }));
  Object.assign(f.rawNetwork, { getTransaction, getBlockInfo });
  f.rawNetwork.getTxConfirmation.mockResolvedValue(2);
  return { block, raw, getTransaction, getBlockInfo };
};

// Same synthetic header context as packages/chains/ergo/tests/transactionTestData.ts.
// P2PK fixture reduction only; these are not network headers or consensus evidence.
const reduceFixture = (signed: ErgoTransaction) => {
  const header = {
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
  };
  const headers = wasm.BlockHeaders.from_json(Array(10).fill(header));
  const first = headers.get(0),
    pre = wasm.PreHeader.from_block_header(first);
  const context = new wasm.ErgoStateContext(pre, headers);
  const tx = wasm.Transaction.sigma_parse_bytes(signed.txBytes);
  const body = JSON.parse(tx.to_json());
  const unsigned = wasm.UnsignedTransaction.from_json(
    JSON.stringify({
      ...body,
      inputs: body.inputs.map(
        (input: { boxId: string; spendingProof: { extension: unknown } }) => ({
          boxId: input.boxId,
          extension: input.spendingProof.extension,
        }),
      ),
    }),
  );
  const inputs = wasm.ErgoBoxes.empty(),
    data = wasm.ErgoBoxes.empty();
  try {
    for (const [list, boxes] of [
      [inputs, signed.inputBoxes],
      [data, signed.dataInputs],
    ] as const) {
      for (const bytes of boxes) {
        const box = wasm.ErgoBox.sigma_parse_bytes(bytes);
        try {
          list.add(box);
        } finally {
          box.free();
        }
      }
    }
    const reduced = wasm.ReducedTransaction.from_unsigned_tx(
      unsigned,
      inputs,
      data,
      context,
    );
    try {
      return reduced.sigma_serialize_bytes();
    } finally {
      reduced.free();
    }
  } finally {
    inputs.free();
    data.free();
    tx.free();
    unsigned.free();
    context.free();
  }
};

const recoveryHelper = () => {
  const rewards = new RewardAuthorization({
    context: {} as TransactionSigningContext,
    getDatabase: db,
    getChain: (name) => getChain(name),
  });
  return new PaymentRecoveryAuthorization({
    getDatabase: db,
    getChain: (name) => getChain(name),
    captureOrderInputs: rewards.captureOrderInputs.bind(rewards),
    decode: (json) => {
      const m = JSON.parse(json);
      return m.network === 'ergo'
        ? ErgoTransaction.fromJson(json)
        : new PaymentTransaction(
            m.network,
            m.txId,
            m.eventId,
            Buffer.from(m.txBytes, 'hex'),
            m.txType,
          );
    },
  });
};
const recoveryRow = async () => {
  if (payment instanceof ErgoTransaction)
    payment.txBytes = reduceFixture(payment);
  else
    payment.txBytes = Buffer.from(
      Transaction.from(
        '0x' + Buffer.from(payment.txBytes).toString('hex'),
      ).unsignedSerialized.slice(2),
      'hex',
    );
  await db().TransactionRepository.update(
    { txId: expected.txId },
    {
      txJson: payment.toJson(),
      status: TransactionStatus.signFailed,
      failedInSign: true,
      signFailedCount: 2,
    },
  );
  return db().captureTxCheckPreimage((await db().getTxById(expected.txId))!);
};
const prepareRecovery = async (
  row: TransactionCheckPreimage,
  active = () => {},
) =>
  (await recoveryHelper().bindRecovery(row)).prepareUnderScannerLease(active);
const persistRecovery = async (
  row: TransactionCheckPreimage,
  checks: Awaited<ReturnType<typeof prepareRecovery>>,
) =>
  db().recoverSignedPaymentIfUnchanged(row, checks.signedJson, {
    assertActive: () => {},
    assertBefore: (m, r) =>
      checks.assertBefore(m, r as TransactionCheckPreimage),
    assertAfter: (m, r) => checks.assertAfter(m, r as TransactionCheckPreimage),
  });

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'recovers through actual Ergo %s adapter and owned SQL'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'recovers through actual Ergo %s adapter and owned SQL' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected expect(id).toBe(o.block.hash); expect(id).toBe(selected === 'node' ? o.block.hash : expected.txId); await expect( persistRecovery(row, await prepareRecovery(row)), ).resolves.toBe(true); expect(blockRead).toHaveBeenCalledTimes(2); expect(transactionRead).toHaveBeenCalled();
 */
it.each(['node', 'explorer'])(
  'recovers through actual Ergo %s adapter and owned SQL',
  async (selected) => {
    const f = await setupErgo(true, true);
    try {
      const o = await observeErgo(f);
      const tx = wasm.Transaction.sigma_parse_bytes(payment.txBytes);
      let json: unknown;
      try {
        json = JSON.parse(tx.to_json());
      } finally {
        tx.free();
      }
      const header = { height: o.block.height, parentId: o.block.parentHash };
      const node = new ErgoNodeNetwork({ nodeBaseUrl: 'http://127.0.0.1:1' });
      const explorer = new ErgoExplorerNetwork({
        explorerBaseUrl: 'http://127.0.0.1:1',
      });
      const blockRead = vi.fn(async (id: string) => {
        expect(id).toBe(o.block.hash);
        return selected === 'node' ? header : { block: { header } };
      });
      const transactionRead = vi.fn(async (id: string) => {
        expect(id).toBe(selected === 'node' ? o.block.hash : expected.txId);
        return selected === 'node'
          ? { transactions: [json] }
          : { ...(json as object), blockId: o.block.hash, numConfirmations: 2 };
      });
      Object.assign(node, {
        client: {
          getBlockHeaderById: blockRead,
          getBlockTransactionsById: transactionRead,
          getTxById: async () => ({ numConfirmations: 2 }),
        },
      });
      Object.assign(explorer, {
        client: {
          v1: {
            getApiV1BlocksP1: blockRead,
            getApiV1TransactionsP1: transactionRead,
          },
        },
      });
      Object.assign(f.ergo, { network: selected === 'node' ? node : explorer });
      const row = await recoveryRow();
      await expect(
        persistRecovery(row, await prepareRecovery(row)),
      ).resolves.toBe(true);
      expect(blockRead).toHaveBeenCalledTimes(2);
      expect(transactionRead).toHaveBeenCalled();
    } finally {
      f.restore();
    }
  },
);

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'checks unused canonical commitment claiming %s execution'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'checks unused canonical commitment claiming %s execution' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow( 'Ambiguous recovery commitment', ); await expect( persistRecovery(row, await prepareRecovery(row)), ).resolves.toBe(true);
 */
it.each(['own', 'foreign'])(
  'checks unused canonical commitment claiming %s execution',
  async (spender) => {
    const f = await setupErgo(true, true);
    try {
      const o = await observeErgo(f),
        row = await recoveryRow();
      const existing = await db().CommitmentRepository.findOneByOrFail({
        WID: 'cc'.repeat(32),
      });
      const original = wasm.ErgoBox.sigma_parse_bytes(
        Buffer.from(existing.serialized, 'base64'),
      );
      let body;
      try {
        body = JSON.parse(original.to_json());
      } finally {
        original.free();
      }
      delete body.boxId;
      body.index = 19;
      const unused = wasm.ErgoBox.from_json(JSON.stringify(body)),
        id = unused.box_id();
      try {
        await db().CommitmentRepository.insert({
          ...existing,
          id: undefined,
          identifier: id.to_str(),
          serialized: Buffer.from(unused.sigma_serialize_bytes()).toString(
            'base64',
          ),
          spendTxId: spender === 'own' ? row.txId : '99'.repeat(32),
          spendIndex: 19,
          spendHeight: o.block.height,
          spendBlock: o.block.hash,
        });
      } finally {
        id.free();
        unused.free();
      }
      if (spender === 'own')
        await expect(prepareRecovery(row)).rejects.toThrow(
          'Ambiguous recovery commitment',
        );
      else
        await expect(
          persistRecovery(row, await prepareRecovery(row)),
        ).resolves.toBe(true);
    } finally {
      f.restore();
    }
  },
);

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects duplicate captured merged WIDs at the recovery boundary'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects duplicate captured merged WIDs at the recovery boundary' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow( 'Duplicate recovery merged WID', );
 */
it('rejects duplicate captured merged WIDs at the recovery boundary', async () => {
  await observeAvalanche();
  const row = await recoveryRow();
  const actual = RewardAuthorization.prototype.captureOrderInputs;
  vi.spyOn(
    RewardAuthorization.prototype,
    'captureOrderInputs',
  ).mockImplementation(async function (this: RewardAuthorization, ...args) {
    const result = await actual.apply(this, args);
    return { ...result, eventWIDs: Object.freeze([wid, wid]) };
  });
  await expect(prepareRecovery(row)).rejects.toThrow(
    'Duplicate recovery merged WID',
  );
});

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects merged trigger provenance %s'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects merged trigger provenance %s' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow('merged provenance');
 */
it.each(['spendIndex', 'spendBlock', 'spendHeight'])(
  'rejects merged trigger provenance %s',
  async (field) => {
    const f = await setupErgo(true, true);
    try {
      await observeErgo(f);
      const row = await recoveryRow();
      await db().CommitmentRepository.update(
        { WID: wid },
        { [field]: field === 'spendBlock' ? '99'.repeat(32) : -1 },
      );
      await expect(prepareRecovery(row)).rejects.toThrow('merged provenance');
    } finally {
      f.restore();
    }
  },
);

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects current %s drift during evidence lookup'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects current %s drift during evidence lookup' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow();
 */
it.each(['fee', 'order'])(
  'rejects current %s drift during evidence lookup',
  async (field) => {
    await observeAvalanche();
    const row = await recoveryRow();
    const actual = network.getSettledTransactionEvidence.bind(network);
    vi.spyOn(network, 'getSettledTransactionEvidence').mockImplementation(
      async (...args) => {
        const value = await actual(...args);
        if (field === 'fee')
          vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
            ...fee,
            networkFee: 1n,
          });
        else vi.spyOn(chain, 'extractTransactionOrder').mockReturnValue([]);
        return value;
      },
    );
    await expect(prepareRecovery(row)).rejects.toThrow();
  },
);

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rolls back actual AFTER recovery %s authority mutation'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back actual AFTER recovery %s authority mutation' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(persistRecovery(row, checks)).rejects.toThrow(); expect(await db().getTxById(row.txId)).toEqual(before); expect(await db().getEventById(row.eventId!)).toEqual(event); expect(await db().CommitmentRepository.find()).toEqual(commitments);
 */
it.each(['event', 'provenance'])(
  'rolls back actual AFTER recovery %s authority mutation',
  async (target) => {
    const f = await setupErgo(true, true);
    try {
      await observeErgo(f);
      const row = await recoveryRow(),
        checks = await prepareRecovery(row);
      const before = await db().getTxById(row.txId),
        event = await db().getEventById(row.eventId!);
      const commitments = await db().CommitmentRepository.find();
      const sql =
        target === 'event'
          ? "UPDATE confirmed_event_entity SET firstTry = 'changed';"
          : 'UPDATE commitment_entity SET spendIndex = spendIndex + 1;';
      await db().dataSource.query(
        `CREATE TRIGGER recovery_drift AFTER UPDATE OF status ON transaction_entity WHEN NEW.status = 'sent' BEGIN ${sql} END`,
      );
      await expect(persistRecovery(row, checks)).rejects.toThrow();
      expect(await db().getTxById(row.txId)).toEqual(before);
      expect(await db().getEventById(row.eventId!)).toEqual(event);
      expect(await db().CommitmentRepository.find()).toEqual(commitments);
    } finally {
      await db().dataSource.query('DROP TRIGGER IF EXISTS recovery_drift');
      f.restore();
    }
  },
);

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects expired recovery lifetime at %s'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects expired recovery lifetime at %s' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row, active)).rejects.toThrow('expired'); await expect( db().recoverSignedPaymentIfUnchanged(row, checks.signedJson, { assertActive: () => {}, assertBefore: async (m, r) => { if (phase === 'before') live = false; await checks.assertBefore(m, r as TransactionCheckPreimage); }, assertAfter: async (m, r) => { if (phase === 'after') live = false; await checks.assertAfter(m, r as TransactionCheckPreimage); }, }), ).rejects.toThrow('expired'); expect((await db().getTxById(row.txId))!.txJson).toBe(row.txJson);
 */
it.each(['prepare', 'before', 'after'])(
  'rejects expired recovery lifetime at %s',
  async (phase) => {
    await observeAvalanche();
    const row = await recoveryRow();
    let live = true;
    const active = () => {
      if (!live) throw new Error('expired recovery');
    };
    if (phase === 'prepare') {
      live = false;
      await expect(prepareRecovery(row, active)).rejects.toThrow('expired');
      return;
    }
    const checks = await prepareRecovery(row, active);
    await expect(
      db().recoverSignedPaymentIfUnchanged(row, checks.signedJson, {
        assertActive: () => {},
        assertBefore: async (m, r) => {
          if (phase === 'before') live = false;
          await checks.assertBefore(m, r as TransactionCheckPreimage);
        },
        assertAfter: async (m, r) => {
          if (phase === 'after') live = false;
          await checks.assertAfter(m, r as TransactionCheckPreimage);
        },
      }),
    ).rejects.toThrow('expired');
    expect((await db().getTxById(row.txId))!.txJson).toBe(row.txJson);
  },
);

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'recovers actual unsigned Avalanche through actual settled RPC and DAO then qualified completion'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'recovers actual unsigned Avalanche through actual settled RPC and DAO then qualified completion' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected expect(JSON.parse(checks.signedJson).txBytes).toBe( observed.signed.serialized.slice(2), ); expect(JSON.parse(row.txJson).txBytes).toBe( observed.signed.unsignedSerialized.slice(2), ); await expect(persistRecovery(row, checks)).resolves.toBe(true); expect(await db().getEventById(row.eventId!)).toEqual(event); expect(recovered.status).toBe(TransactionStatus.sent); expect(recovered.failedInSign).toBe(row.failedInSign); expect(recovered.signFailedCount).toBe(row.signFailedCount); await expect( db().finalizeTxIfUnchanged(completionRow, { ...completion, assertActive: () => {}, }), ).resolves.toBe(true); expect((await db().getEventById(row.eventId!))!.status).toBe( EventStatus.pendingReward, );
 */
it('recovers actual unsigned Avalanche through actual settled RPC and DAO then qualified completion', async () => {
  const observed = await observeAvalanche(),
    row = await recoveryRow();
  const event = await db().getEventById(row.eventId!);
  const checks = await prepareRecovery(row);
  expect(JSON.parse(checks.signedJson).txBytes).toBe(
    observed.signed.serialized.slice(2),
  );
  expect(JSON.parse(row.txJson).txBytes).toBe(
    observed.signed.unsignedSerialized.slice(2),
  );
  await expect(persistRecovery(row, checks)).resolves.toBe(true);
  expect(await db().getEventById(row.eventId!)).toEqual(event);
  const recovered = (await db().getTxById(row.txId))!;
  expect(recovered.status).toBe(TransactionStatus.sent);
  expect(recovered.failedInSign).toBe(row.failedInSign);
  expect(recovered.signFailedCount).toBe(row.signFailedCount);
  const completionRow = {
    ...expected,
    txJson: checks.signedJson,
    status: TransactionStatus.sent,
  };
  const completion = await (
    await helper.bind(completionRow, 'completion')
  ).prepareUnderScannerLease(() => {});
  await expect(
    db().finalizeTxIfUnchanged(completionRow, {
      ...completion,
      assertActive: () => {},
    }),
  ).resolves.toBe(true);
  expect((await db().getEventById(row.eventId!))!.status).toBe(
    EventStatus.pendingReward,
  );
});
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'recovers genuine Reduced Ergo with complete aux (additional=%s) then qualified completion'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'recovers genuine Reduced Ergo with complete aux (additional=%s) then qualified completion' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected expect(JSON.parse(checks.signedJson).txBytes).toBe(observed.raw.bytes); expect(JSON.parse(row.txJson).txBytes).not.toBe(observed.raw.bytes); await expect(persistRecovery(row, checks)).resolves.toBe(true); expect(await db().getEventById(row.eventId!)).toEqual(event); await expect( db().finalizeTxIfUnchanged(completionRow, { ...completion, assertActive: () => {}, }), ).resolves.toBe(true); expect((await db().getEventById(row.eventId!))!.status).toBe( EventStatus.completed, ); expect((await db().getEventById(row.eventId!))!.firstTry).toBe( event!.firstTry, );
 */
it.each([false, true])(
  'recovers genuine Reduced Ergo with complete aux (additional=%s) then qualified completion',
  async (additional) => {
    const f = await setupErgo(additional, true);
    try {
      const observed = await observeErgo(f),
        row = await recoveryRow();
      const event = await db().getEventById(row.eventId!);
      const checks = await prepareRecovery(row);
      expect(JSON.parse(checks.signedJson).txBytes).toBe(observed.raw.bytes);
      expect(JSON.parse(row.txJson).txBytes).not.toBe(observed.raw.bytes);
      await expect(persistRecovery(row, checks)).resolves.toBe(true);
      expect(await db().getEventById(row.eventId!)).toEqual(event);
      const completionRow = {
        ...expected,
        txJson: checks.signedJson,
        status: TransactionStatus.sent,
      };
      const completion = await (
        await helper.bind(completionRow, 'completion')
      ).prepareUnderScannerLease(() => {});
      await expect(
        db().finalizeTxIfUnchanged(completionRow, {
          ...completion,
          assertActive: () => {},
        }),
      ).resolves.toBe(true);
      expect((await db().getEventById(row.eventId!))!.status).toBe(
        EventStatus.completed,
      );
      expect((await db().getEventById(row.eventId!))!.firstTry).toBe(
        event!.firstTry,
      );
    } finally {
      f.restore();
    }
  },
);

/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects isolated recovery preimage %s'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated recovery preimage %s' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect( prepareRecovery(changed as TransactionCheckPreimage), ).rejects.toThrow();
 */
it.each([
  'status',
  'txId',
  'txJson',
  'chain',
  'type',
  'requiredSign',
  'eventId',
  'orderId',
  'lastCheck',
  'lastStatusUpdate',
  'failedInSign',
  'signFailedCount',
])('rejects isolated recovery preimage %s', async (field) => {
  await observeAvalanche();
  const row = await recoveryRow();
  const changed = {
    ...row,
    [field]:
      field === 'lastCheck' ||
      field === 'requiredSign' ||
      field === 'signFailedCount'
        ? -1
        : field === 'failedInSign'
          ? 'true'
          : field === 'lastStatusUpdate'
            ? undefined
            : 'changed',
  };
  await expect(
    prepareRecovery(changed as TransactionCheckPreimage),
  ).rejects.toThrow();
});
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects isolated settled recovery evidence %s'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated settled recovery evidence %s' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow();
 */
it.each([
  'hash',
  'unsignedHash',
  'signedBytes',
  'from',
  'chainId',
  'nonce',
  'blockHash',
  'blockNumber',
  'index',
  'status',
  'confirmations',
  'finalizedBlockHash',
  'finalizedBlockNumber',
])('rejects isolated settled recovery evidence %s', async (field) => {
  const o = await observeAvalanche(),
    row = await recoveryRow();
  const evidence = await network.getSettledTransactionEvidence(
    o.signed.hash!,
    o.block.hash,
  );
  const wrong: Record<string, unknown> = {
    hash: '0x' + '99'.repeat(32),
    unsignedHash: '0x' + '99'.repeat(32),
    signedBytes: o.signed.unsignedSerialized,
    from: '0x' + '99'.repeat(20),
    chainId: 43114n,
    nonce: 1,
    blockHash: '0x' + '99'.repeat(32),
    blockNumber: 1,
    index: -1,
    status: EvmTxStatus.failed,
    confirmations: 0,
    finalizedBlockHash: 'bad',
    finalizedBlockNumber: 299,
  };
  vi.spyOn(network, 'getSettledTransactionEvidence').mockResolvedValue({
    ...evidence,
    [field]: wrong[field],
  });
  await expect(prepareRecovery(row)).rejects.toThrow();
});
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'defers actual RPC %s recovery'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers actual RPC %s recovery' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow();
 */
it.each(['missing', 'failed', 'mempool', 'unsettled', 'error'])(
  'defers actual RPC %s recovery',
  async (fault) => {
    const o = await observeAvalanche(),
      row = await recoveryRow();
    if (fault === 'missing')
      vi.mocked(o.rpc.getTransaction).mockResolvedValue(null);
    if (fault === 'failed') o.receipt.status = 0;
    if (fault === 'mempool')
      Object.assign(o.tx, { blockHash: null, blockNumber: null });
    if (fault === 'unsettled') o.frontier.number = o.block.number - 1;
    if (fault === 'error')
      vi.mocked(o.rpc.getTransactionReceipt).mockRejectedValue(
        new Error('unavailable'),
      );
    await expect(prepareRecovery(row)).rejects.toThrow();
  },
);
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects isolated recovery scanner record %s'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated recovery scanner record %s' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow();
 */
it.each(['extractor', 'address', 'unsignedHash', 'nonce', 'status'])(
  'rejects isolated recovery scanner record %s',
  async (field) => {
    const o = await observeAvalanche(),
      row = await recoveryRow();
    await db()
      .dataSource.getRepository(AddressTxsEntity)
      .update(
        { id: o.record.id },
        { [field]: field === 'nonce' ? 4 : 'changed' },
      );
    await expect(prepareRecovery(row)).rejects.toThrow();
  },
);
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects recovery block %s'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects recovery block %s' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow();
 */
it.each(['missing', 'status', 'height', 'parentHash'])(
  'rejects recovery block %s',
  async (field) => {
    const o = await observeAvalanche(),
      row = await recoveryRow();
    if (field === 'missing')
      await db().dataSource.getRepository(BlockEntity).clear();
    else
      await db()
        .dataSource.getRepository(BlockEntity)
        .update(
          { hash: o.block.hash },
          { [field]: field === 'height' ? 7 : 'changed' },
        );
    await expect(prepareRecovery(row)).rejects.toThrow();
  },
);
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'requires unspent Avalanche trigger %s'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'requires unspent Avalanche trigger %s' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow('trigger evidence');
 */
it.each(['spendHeight', 'spendBlock', 'spendTxId', 'paymentTxId', 'result'])(
  'requires unspent Avalanche trigger %s',
  async (field) => {
    await observeAvalanche();
    const row = await recoveryRow();
    await db().EventRepository.update(
      { eventId: row.eventId! },
      { [field]: field === 'spendHeight' ? 7 : 'changed' },
    );
    await expect(prepareRecovery(row)).rejects.toThrow('trigger evidence');
  },
);
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'requires complete successful own Ergo trigger %s'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'requires complete successful own Ergo trigger %s' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow('trigger evidence');
 */
it.each(['spendHeight', 'spendBlock', 'spendTxId', 'paymentTxId', 'result'])(
  'requires complete successful own Ergo trigger %s',
  async (field) => {
    const f = await setupErgo(true, true);
    try {
      await observeErgo(f);
      const row = await recoveryRow();
      await db().EventRepository.update(
        { eventId: row.eventId! },
        { [field]: null },
      );
      await expect(prepareRecovery(row)).rejects.toThrow('trigger evidence');
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'requires exact own additional commitment %s provenance'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'requires exact own additional commitment %s provenance' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow();
 */
it.each([
  'spendHeight',
  'spendBlock',
  'spendTxId',
  'spendIndex',
  'serialized',
  'commitment',
  'WID',
  'rwtCount',
])('requires exact own additional commitment %s provenance', async (field) => {
  const f = await setupErgo(true, true);
  try {
    await observeErgo(f);
    const row = await recoveryRow();
    const extra = await db().CommitmentRepository.findOneByOrFail({
      WID: 'cc'.repeat(32),
    });
    await db().CommitmentRepository.update(
      { id: extra.id },
      {
        [field]:
          field === 'spendHeight' || field === 'spendIndex' ? 0 : 'changed',
      },
    );
    await expect(prepareRecovery(row)).rejects.toThrow();
  } finally {
    f.restore();
  }
});
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects provider header %s mutation during Ergo transaction lookup'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects provider header %s mutation during Ergo transaction lookup' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow('header mutated');
 */
it.each(['height', 'parentHash', 'hash'])(
  'rejects provider header %s mutation during Ergo transaction lookup',
  async (field) => {
    const f = await setupErgo(true, true);
    try {
      const o = await observeErgo(f),
        row = await recoveryRow();
      const info = {
        hash: o.block.hash,
        height: o.block.height,
        parentHash: o.block.parentHash,
      };
      o.getBlockInfo.mockImplementation(async () => {
        Object.assign(info, {
          hash: o.block.hash,
          height: o.block.height,
          parentHash: o.block.parentHash,
        });
        return info;
      });
      o.getTransaction.mockImplementation(async () => {
        Object.assign(info, {
          [field]: field === 'height' ? 1 : '99'.repeat(32),
        });
        return wasm.Transaction.sigma_parse_bytes(
          Buffer.from(o.raw.bytes, 'hex'),
        );
      });
      await expect(prepareRecovery(row)).rejects.toThrow('header mutated');
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects inherited recovered %s slot mutation inside async verifier'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects inherited recovered %s slot mutation inside async verifier' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow('slot');
 */
it.each(['inputBoxes', 'dataInputs'] as const)(
  'rejects inherited recovered %s slot mutation inside async verifier',
  async (field) => {
    const f = await setupErgo(true, true);
    try {
      await observeErgo(f);
      const row = await recoveryRow();
      const actual = f.ergo.verifyTransactionFee.bind(f.ergo);
      vi.spyOn(f.ergo, 'verifyTransactionFee').mockImplementation(
        async (model, status) => {
          const result = await actual(model, status),
            boxes = (model as ErgoTransaction)[field],
            original = boxes[0];
          delete boxes[0];
          const proto = Object.create(Object.getPrototypeOf(boxes));
          Object.defineProperty(proto, '0', { value: original });
          Object.setPrototypeOf(boxes, proto);
          return result;
        },
      );
      await expect(prepareRecovery(row)).rejects.toThrow('slot');
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects a second active payment before recovery'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects a second active payment before recovery' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow('SQL authority');
 */
it('rejects a second active payment before recovery', async () => {
  await observeAvalanche();
  const row = await recoveryRow();
  await db().TransactionRepository.save({
    ...(await db().getTxById(row.txId))!,
    txId: 'other',
  });
  await expect(prepareRecovery(row)).rejects.toThrow('SQL authority');
});
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'is single-use and returns immutable signed JSON without HTTP authority'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'is single-use and returns immutable signed JSON without HTTP authority' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected expect(Object.isFrozen(bound)).toBe(true); expect(Object.isFrozen(prepared)).toBe(true); expect('authorize' in prepared).toBe(false); await expect(bound.prepareUnderScannerLease(() => {})).rejects.toThrow( 'single use', );
 */
it('is single-use and returns immutable signed JSON without HTTP authority', async () => {
  await observeAvalanche();
  const row = await recoveryRow(),
    bound = await recoveryHelper().bindRecovery(row);
  const prepared = await bound.prepareUnderScannerLease(() => {});
  expect(Object.isFrozen(bound)).toBe(true);
  expect(Object.isFrozen(prepared)).toBe(true);
  expect('authorize' in prepared).toBe(false);
  await expect(bound.prepareUnderScannerLease(() => {})).rejects.toThrow(
    'single use',
  );
});
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects late %s mutation during recovery proof'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects late %s mutation during recovery proof' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(prepareRecovery(row)).rejects.toThrow();
 */
it.each(['input', 'policy', 'model', 'frontier'])(
  'rejects late %s mutation during recovery proof',
  async (field) => {
    const o = await observeAvalanche(),
      row = { ...(await recoveryRow()) },
      actual = network.getSettledTransactionEvidence.bind(network);
    vi.spyOn(network, 'getSettledTransactionEvidence').mockImplementation(
      async (...args) => {
        const result = await actual(...args);
        if (field === 'input') row.lastCheck++;
        if (field === 'policy') chain.getChainConfigs().confirmations.payment++;
        if (field === 'frontier') o.frontier.number++;
        if (field === 'model')
          await db().TransactionRepository.update(
            { txId: row.txId },
            { txJson: row.txJson + ' ' },
          );
        return result;
      },
    );
    await expect(prepareRecovery(row)).rejects.toThrow();
  },
);
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'preserves a concurrent %s winner before persistence'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves a concurrent %s winner before persistence' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect(persistRecovery(row, checks)).resolves.toBe(false); expect(await db().getTxById(row.txId)).toEqual(winner);
 */
it.each([
  'status',
  'txJson',
  'chain',
  'requiredSign',
  'lastCheck',
  'lastStatusUpdate',
  'failedInSign',
  'signFailedCount',
])('preserves a concurrent %s winner before persistence', async (field) => {
  await observeAvalanche();
  const row = await recoveryRow(),
    checks = await prepareRecovery(row);
  await db().TransactionRepository.update(
    { txId: row.txId },
    {
      [field]:
        field === 'failedInSign'
          ? false
          : ['requiredSign', 'lastCheck', 'signFailedCount'].includes(field)
            ? 99
            : 'changed',
    },
  );
  const winner = await db().getTxById(row.txId);
  await expect(persistRecovery(row, checks)).resolves.toBe(false);
  expect(await db().getTxById(row.txId)).toEqual(winner);
});
/**
 * @target PaymentRecoveryAuthorization.bindRecovery 'rejects isolated actual after-callback %s substitution'
 * @dependencies Actual PaymentRecoveryAuthorization from verification/paymentRecoveryAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated actual after-callback %s substitution' with the suite's captured inputs and invoke the bindRecovery path.
 * @expected await expect( db().recoverSignedPaymentIfUnchanged(row, checks.signedJson, { assertActive: () => {}, assertBefore: (m, r) => checks.assertBefore(m, r as TransactionCheckPreimage), assertAfter: (m, r) => checks.assertAfter(m, { ...r, [field]: field === 'failedInSign' ? false : ['lastCheck', 'requiredSign', 'signFailedCount'].includes(field) ? 99 : 'changed', } as TransactionCheckPreimage), }), ).rejects.toThrow(); expect((await db().getTxById(row.txId))!.txJson).toBe(row.txJson);
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
])('rejects isolated actual after-callback %s substitution', async (field) => {
  await observeAvalanche();
  const row = await recoveryRow(),
    checks = await prepareRecovery(row);
  await expect(
    db().recoverSignedPaymentIfUnchanged(row, checks.signedJson, {
      assertActive: () => {},
      assertBefore: (m, r) =>
        checks.assertBefore(m, r as TransactionCheckPreimage),
      assertAfter: (m, r) =>
        checks.assertAfter(m, {
          ...r,
          [field]:
            field === 'failedInSign'
              ? false
              : ['lastCheck', 'requiredSign', 'signFailedCount'].includes(field)
                ? 99
                : 'changed',
        } as TransactionCheckPreimage),
    }),
  ).rejects.toThrow();
  expect((await db().getTxById(row.txId))!.txJson).toBe(row.txJson);
});
