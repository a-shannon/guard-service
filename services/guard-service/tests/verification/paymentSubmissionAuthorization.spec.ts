import { secp256k1 } from '@noble/curves/secp256k1';
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
  SigningStatus,
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
import { ArbitraryEntity } from '../../src/db/entities/arbitraryEntity';
import EventOrder from '../../src/event/eventOrder';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import {
  SigningRowPreimage,
  TransactionSigningContext,
} from '../../src/signing/transactionSigningContext';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import * as semantics from '../../src/verification/ergoSignedSemantics';
import {
  PaymentSubmissionAuthorization,
  PaymentSubmissionPurpose,
} from '../../src/verification/paymentSubmissionAuthorization';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';
import reducedPaymentFixture from '../signing/fixtures/recoveryMultiInput';

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
const prepare = async (active = () => {}) =>
  (await helper.bind(expected, 'submission')).prepareUnderScannerLease(active);
/**
 * @target PaymentSubmissionAuthorization.bind 'authorizes real signed Avalanche model and pure event order with real SQLite before/after sent predicates'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'authorizes real signed Avalanche model and pure event order with real SQLite before/after sent predicates' with the suite's captured inputs and invoke the bind path.
 * @expected expect(bound.kind).toBe('ready'); expect(bound.payment().toJson()).toBe(payment.toJson()); expect(start).toHaveBeenCalledOnce(); await expect( db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, { assertActive: () => {}, assertBefore: checks.assertBefore, assertAfter: checks.assertAfter, }), ).resolves.toBe(true); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.sent, );
 */
it('authorizes real signed Avalanche model and pure event order with real SQLite before/after sent predicates', async () => {
  const bound = await helper.bind(expected, 'submission');
  expect(bound.kind).toBe('ready');
  expect(bound.payment().toJson()).toBe(payment.toJson());
  const checks = await bound.prepareUnderScannerLease(() => {}),
    start = vi.fn();
  await checks.authorize(start);
  expect(start).toHaveBeenCalledOnce();
  await expect(
    db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, {
      assertActive: () => {},
      assertBefore: checks.assertBefore,
      assertAfter: checks.assertAfter,
    }),
  ).resolves.toBe(true);
  expect((await db().getTxById(expected.txId))!.status).toBe(
    TransactionStatus.sent,
  );
});
/**
 * @target PaymentSubmissionAuthorization.bind 'supports a captured sent row without changing its initial status'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'supports a captured sent row without changing its initial status' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, { assertActive: () => {}, assertBefore: checks.assertBefore, assertAfter: checks.assertAfter, }), ).resolves.toBe(true); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.sent, );
 */
it('supports a captured sent row without changing its initial status', async () => {
  expected = { ...expected, status: TransactionStatus.sent };
  await db().TransactionRepository.update(
    { txId: expected.txId },
    { status: TransactionStatus.sent },
  );
  const checks = await prepare();
  await checks.authorize(() => {});
  await expect(
    db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, {
      assertActive: () => {},
      assertBefore: checks.assertBefore,
      assertAfter: checks.assertAfter,
    }),
  ).resolves.toBe(true);
  expect((await db().getTxById(expected.txId))!.status).toBe(
    TransactionStatus.sent,
  );
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects isolated after-preimage %s drift through the actual DAO'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated after-preimage %s drift through the actual DAO' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, { assertActive: () => {}, assertBefore: checks.assertBefore, assertAfter: (manager, row) => checks.assertAfter(manager, { ...row, [field]: value }), }), ).rejects.toThrow('not started for this row'); expect(await db().getTxById(expected.txId)).toEqual(before); expect(notify).not.toHaveBeenCalled();
 */
it.each([
  ['status', TransactionStatus.signed],
  ['txJson', '{}'],
  ['chain', 'ergo'],
  ['type', TransactionType.reward],
  ['requiredSign', 4],
  ['eventId', null],
  ['orderId', 'foreign-order'],
  ['txId', 'foreign-transaction'],
] as const)(
  'rejects isolated after-preimage %s drift through the actual DAO',
  async (field, value) => {
    const checks = await prepare();
    await checks.authorize(() => {});
    const before = await db().getTxById(expected.txId);
    const notify = vi
      .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
      .mockResolvedValue(undefined);
    await expect(
      db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, {
        assertActive: () => {},
        assertBefore: checks.assertBefore,
        assertAfter: (manager, row) =>
          checks.assertAfter(manager, { ...row, [field]: value }),
      }),
    ).rejects.toThrow('not started for this row');
    expect(await db().getTxById(expected.txId)).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rolls back actual DAO sent persistence and counters when an AFTER trigger changes authority'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back actual DAO sent persistence and counters when an AFTER trigger changes authority' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, { assertActive: () => {}, assertBefore: checks.assertBefore, assertAfter: checks.assertAfter, }), ).rejects.toThrow('database authority changed'); expect(await db().getTxById(expected.txId)).toEqual(before); expect( await db().ConfirmedEventRepository.findOneByOrFail({ id: expected.eventId!, }), ).toEqual(eventBefore); expect(notify).not.toHaveBeenCalled();
 */
it('rolls back actual DAO sent persistence and counters when an AFTER trigger changes authority', async () => {
  const checks = await prepare();
  await checks.authorize(() => {});
  const before = await db().getTxById(expected.txId);
  const eventBefore = await db().ConfirmedEventRepository.findOneByOrFail({
    id: expected.eventId!,
  });
  const notify = vi
    .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
    .mockResolvedValue(undefined);
  await db().dataSource
    .query(`CREATE TRIGGER payment_authority_drift AFTER UPDATE OF status ON transaction_entity
    WHEN NEW.status = 'sent' BEGIN
      UPDATE confirmed_event_entity SET unexpectedFails = unexpectedFails + 1 WHERE id = NEW.eventId;
      UPDATE transaction_entity SET signFailedCount = signFailedCount + 1, lastCheck = lastCheck + 1 WHERE txId = NEW.txId;
    END`);
  try {
    await expect(
      db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, {
        assertActive: () => {},
        assertBefore: checks.assertBefore,
        assertAfter: checks.assertAfter,
      }),
    ).rejects.toThrow('database authority changed');
    expect(await db().getTxById(expected.txId)).toEqual(before);
    expect(
      await db().ConfirmedEventRepository.findOneByOrFail({
        id: expected.eventId!,
      }),
    ).toEqual(eventBefore);
    expect(notify).not.toHaveBeenCalled();
  } finally {
    await db().dataSource.query('DROP TRIGGER payment_authority_drift');
  }
});
/**
 * @target PaymentSubmissionAuthorization.bind 'defers isolated trigger %s marker'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers isolated trigger %s marker' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow('unspent trigger');
 */
it.each(['spendHeight', 'spendBlock', 'spendTxId', 'result', 'paymentTxId'])(
  'defers isolated trigger %s marker',
  async (field) => {
    await db().EventRepository.update(
      { eventId: expected.eventId! },
      { [field]: field === 'spendHeight' ? 1 : 'observed' },
    );
    await expect(prepare()).rejects.toThrow('unspent trigger');
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects model %s metadata independently of signed body'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects model %s metadata independently of signed body' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow();
 */
it.each(['eventId', 'txType', 'txId', 'network'])(
  'rejects model %s metadata independently of signed body',
  async (field) => {
    const m = JSON.parse(expected.txJson);
    m[field] = 'wrong';
    expected = { ...expected, txJson: JSON.stringify(m) };
    await db().TransactionRepository.update(
      { txId: expected.txId },
      { txJson: expected.txJson },
    );
    await expect(prepare()).rejects.toThrow();
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects owned-row %s drift after RPC preparation'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects owned-row %s drift after RPC preparation' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(checks.authorize(start)).rejects.toThrow(); expect(start).not.toHaveBeenCalled();
 */
it.each([
  'txJson',
  'chain',
  'type',
  'status',
  'requiredSign',
  'event',
  'order',
])('rejects owned-row %s drift after RPC preparation', async (field) => {
  const checks = await prepare(),
    start = vi.fn();
  if (field === 'order') {
    await db().dataSource.getRepository(ArbitraryEntity).insert({
      id: 'other-order',
      chain: 'avalanche',
      orderJson: '[]',
      status: 'pending',
    });
    await db().dataSource.query(
      'UPDATE transaction_entity SET orderId = ? WHERE txId = ?',
      ['other-order', expected.txId],
    );
  } else if (field === 'event')
    await db().dataSource.query(
      'UPDATE transaction_entity SET eventId = NULL WHERE txId = ?',
      [expected.txId],
    );
  else
    await db().TransactionRepository.update(
      { txId: expected.txId },
      { [field]: field === 'requiredSign' ? 4 : 'changed' },
    );
  await expect(checks.authorize(start)).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects %s drift at final SQL gate'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects %s drift at final SQL gate' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(checks.authorize(start)).rejects.toThrow(); expect(start).not.toHaveBeenCalled();
 */
it.each([
  'phase',
  'counter',
  'trigger',
  'commitment',
  'fee',
  'policy',
  'instance',
  'caller',
])('rejects %s drift at final SQL gate', async (fault) => {
  const checks = await prepare(),
    start = vi.fn();
  if (fault === 'phase')
    await db().ConfirmedEventRepository.update(
      { id: expected.eventId! },
      { status: EventStatus.pendingPayment },
    );
  if (fault === 'counter')
    await db().ConfirmedEventRepository.update(
      { id: expected.eventId! },
      { unexpectedFails: 99 },
    );
  if (fault === 'trigger')
    await db().EventRepository.update(
      { eventId: expected.eventId! },
      { serialized: 'changed' },
    );
  if (fault === 'commitment')
    await db().CommitmentRepository.update(
      { eventId: expected.eventId! },
      { WID: 'bb'.repeat(32) },
    );
  if (fault === 'fee')
    vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
      ...fee,
      networkFee: 1n,
    });
  if (fault === 'policy') chain.getChainConfigs().fee = 2n;
  if (fault === 'instance') getChain = () => ({}) as AbstractChain<unknown>;
  if (fault === 'caller') Reflect.set(expected, 'requiredSign', 4);
  await expect(checks.authorize(start)).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects actual payment %s checks before start'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects actual payment %s checks before start' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow();
 */
it.each(['gas', 'fee', 'extra', 'validity'])(
  'rejects actual payment %s checks before start',
  async (fault) => {
    if (fault === 'gas')
      vi.mocked(network.getGasRequired).mockResolvedValue(100001n);
    if (fault === 'fee')
      vi.mocked(network.getFeeData).mockResolvedValue(
        new FeeData(null, 1000n, 2n),
      );
    if (fault === 'extra')
      chain.getChainConfigs().addresses.lock = '0x' + '22'.repeat(20);
    if (fault === 'validity')
      vi.mocked(network.getTransactionStatus).mockResolvedValue(
        'failed' as never,
      );
    await expect(prepare()).rejects.toThrow();
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'single-use preparation and action cannot reuse a prior network snapshot'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'single-use preparation and action cannot reuse a prior network snapshot' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(bound.prepareUnderScannerLease(() => {})).rejects.toThrow( 'single use', ); await expect(checks.authorize(() => {})).rejects.toThrow('single use');
 */
it('single-use preparation and action cannot reuse a prior network snapshot', async () => {
  const bound = await helper.bind(expected, 'submission'),
    checks = await bound.prepareUnderScannerLease(() => {});
  await expect(bound.prepareUnderScannerLease(() => {})).rejects.toThrow(
    'single use',
  );
  await checks.authorize(() => {});
  await expect(checks.authorize(() => {})).rejects.toThrow('single use');
});
/**
 * @target PaymentSubmissionAuthorization.bind 'checks lifetime after waiting for SQL ownership and never starts stale transport'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'checks lifetime after waiting for SQL ownership and never starts stale transport' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(pending).rejects.toThrow('expired'); expect(start).not.toHaveBeenCalled();
 */
it('checks lifetime after waiting for SQL ownership and never starts stale transport', async () => {
  let active = true;
  const checks = await prepare(() => {
    if (!active) throw Error('expired');
  });
  const runner = db().dataSource.createQueryRunner();
  await runner.startTransaction();
  const start = vi.fn(),
    pending = checks.authorize(start);
  active = false;
  await runner.rollbackTransaction();
  await runner.release();
  await expect(pending).rejects.toThrow('expired');
  expect(start).not.toHaveBeenCalled();
});
/**
 * @target PaymentSubmissionAuthorization.bind 'does not authorize sent persistence when no dispatch happened'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'does not authorize sent persistence when no dispatch happened' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().dataSource.transaction((manager) => checks.assertBefore(manager, expected), ), ).rejects.toThrow('not started');
 */
it('does not authorize sent persistence when no dispatch happened', async () => {
  const checks = await prepare();
  await expect(
    db().dataSource.transaction((manager) =>
      checks.assertBefore(manager, expected),
    ),
  ).rejects.toThrow('not started');
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rolls back a sent status when the after-predicate detects concurrent event mutation'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back a sent status when the after-predicate detects concurrent event mutation' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().dataSource.transaction(async (manager) => { await checks.assertBefore(manager, expected); await manager .getRepository(db().TransactionRepository.target) .update({ txId: expected.txId }, { status: TransactionStatus.sent }); await manager .getRepository(db().ConfirmedEventRepository.target) .update({ id: expected.eventId! }, { unexpectedFails: 99 }); await checks.assertAfter(manager, { ...expected, status: TransactionStatus.sent, }); }), ).rejects.toThrow(); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.signed, );
 */
it('rolls back a sent status when the after-predicate detects concurrent event mutation', async () => {
  const checks = await prepare();
  await checks.authorize(() => {});
  await expect(
    db().dataSource.transaction(async (manager) => {
      await checks.assertBefore(manager, expected);
      await manager
        .getRepository(db().TransactionRepository.target)
        .update({ txId: expected.txId }, { status: TransactionStatus.sent });
      await manager
        .getRepository(db().ConfirmedEventRepository.target)
        .update({ id: expected.eventId! }, { unexpectedFails: 99 });
      await checks.assertAfter(manager, {
        ...expected,
        status: TransactionStatus.sent,
      });
    }),
  ).rejects.toThrow();
  expect((await db().getTxById(expected.txId))!.status).toBe(
    TransactionStatus.signed,
  );
});
/**
 * @target PaymentSubmissionAuthorization.bind 'defers signed-hash observation %s even with an otherwise valid payment'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers signed-hash observation %s even with an otherwise valid payment' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow();
 */
it.each(['succeed', 'failed', 'mempool', 'unknown', 'RPC error'])(
  'defers signed-hash observation %s even with an otherwise valid payment',
  async (status) => {
    const signedHash = Transaction.from(
      '0x' + Buffer.from(payment.txBytes).toString('hex'),
    ).hash;
    vi.mocked(network.getTransactionStatus).mockImplementation(async (id) => {
      if (id !== signedHash) return 'not-found' as never;
      if (status === 'RPC error') throw Error('RPC failure');
      return status as never;
    });
    await expect(prepare()).rejects.toThrow();
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'defers an executed alias even when inherited validity accepts same unsignedHash with advanced nonce'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers an executed alias even when inherited validity accepts same unsignedHash with advanced nonce' with the suite's captured inputs and invoke the bind path.
 * @expected expect((await chain.isTxValid(payment, 1)).isValid).toBe(true); await expect(prepare()).rejects.toThrow('requires reconciliation');
 */
it('defers an executed alias even when inherited validity accepts same unsignedHash with advanced nonce', async () => {
  vi.mocked(network.getAddressNextAvailableNonce).mockResolvedValue(1);
  vi.spyOn(network, 'getTransactionByNonce').mockResolvedValue({
    unsignedHash: payment.txId,
    txId: Transaction.from('0x' + Buffer.from(payment.txBytes).toString('hex'))
      .hash!,
  });
  vi.mocked(network.getTransactionStatus).mockImplementation(async (id) =>
    id === payment.txId ? ('succeed' as never) : ('not-found' as never),
  );
  expect((await chain.isTxValid(payment, 1)).isValid).toBe(true);
  await expect(prepare()).rejects.toThrow('requires reconciliation');
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
/**
 * @target PaymentSubmissionAuthorization.bind 'real Signed Ergo and pure payment/reward orders conserve assets (additional commitment %s)'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'real Signed Ergo and pure payment/reward orders conserve assets (additional commitment %s)' with the suite's captured inputs and invoke the bind path.
 * @expected expect(start).toHaveBeenCalledOnce();
 */
it.each([false, true])(
  'real Signed Ergo and pure payment/reward orders conserve assets (additional commitment %s)',
  async (additional) => {
    const f = await setupErgo(additional);
    try {
      const checks = await prepare(),
        start = vi.fn();
      await checks.authorize(start);
      expect(start).toHaveBeenCalledOnce();
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'Ergo rejects isolated %s'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'Ergo rejects isolated %s' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow();
 */
it.each([
  'trigger bytes',
  'aux suffix',
  'signed suffix',
  'aux order',
  'RWT',
  'merged block',
  'merged index',
  'missing additional row',
  'additional WID',
  'additional amount',
  'additional spent',
  'additional block',
  'additional spend height',
  'additional index',
  'additional commitment',
  'additional serialized',
  'additional height',
  'observed',
  'mempool',
  'unspent failure',
])('Ergo rejects isolated %s', async (fault) => {
  const f = await setupErgo(true);
  try {
    if (fault === 'trigger bytes')
      await db().EventRepository.update(
        { eventId: expected.eventId! },
        {
          serialized: Buffer.from(
            (payment as ErgoTransaction).inputBoxes[1],
          ).toString('base64'),
        },
      );
    if (fault === 'RWT') chain.getChainConfigs().rwtId = 'ff'.repeat(32);
    if (fault === 'merged block')
      await db().CommitmentRepository.update(
        { eventId: expected.eventId!, WID: wid },
        { spendBlock: 'wrong' },
      );
    if (fault === 'merged index')
      await db().CommitmentRepository.update(
        { eventId: expected.eventId!, WID: wid },
        { spendIndex: -1 },
      );
    if (fault === 'missing additional row')
      await db().CommitmentRepository.delete({
        eventId: expected.eventId!,
        WID: 'cc'.repeat(32),
      });
    const changes: Record<string, object> = {
      'additional WID': { WID: wid },
      'additional amount': { rwtCount: '11' },
      'additional spent': { spendTxId: 'ff'.repeat(32) },
      'additional block': { spendBlock: 'ff'.repeat(32) },
      'additional spend height': { spendHeight: 201 },
      'additional index': { spendIndex: 0 },
      'additional commitment': { commitment: 'wrong' },
      'additional serialized': { serialized: 'YQ==' },
      'additional height': { height: 200 },
    };
    if (changes[fault])
      await db().CommitmentRepository.update(
        { eventId: expected.eventId!, WID: 'cc'.repeat(32) },
        changes[fault],
      );
    if (fault === 'observed')
      f.rawNetwork.getTxConfirmation.mockResolvedValue(1);
    if (fault === 'mempool')
      f.rawNetwork.getMempoolTransactions.mockResolvedValue([
        { id: payment.txId },
      ] as never);
    if (fault === 'unspent failure')
      f.rawNetwork.isBoxUnspentAndValid.mockResolvedValue(false);
    if (fault === 'aux suffix')
      (payment as ErgoTransaction).inputBoxes[0] = Buffer.concat([
        (payment as ErgoTransaction).inputBoxes[0],
        Buffer.from([0]),
      ]);
    if (fault === 'signed suffix')
      payment.txBytes = Buffer.concat([payment.txBytes, Buffer.from([0])]);
    if (fault === 'aux order')
      (payment as ErgoTransaction).inputBoxes.reverse();
    expected = { ...expected, txJson: payment.toJson() };
    await db().TransactionRepository.update(
      { txId: expected.txId },
      { txJson: expected.txJson },
    );
    await expect(prepare()).rejects.toThrow();
  } finally {
    f.restore();
  }
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects a second active payment instead of choosing a row'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects a second active payment instead of choosing a row' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow('database authority');
 */
it('rejects a second active payment instead of choosing a row', async () => {
  const other = new PaymentTransaction(
    payment.network,
    'other',
    payment.eventId,
    payment.txBytes,
    TransactionType.payment,
  );
  await DatabaseActionMock.insertTxRecord(
    other,
    TransactionStatus.signed,
    1,
    'first',
    false,
    0,
    3,
  );
  await expect(prepare()).rejects.toThrow('database authority');
});
/**
 * @target PaymentSubmissionAuthorization.bind 'detects mutation of the model passed to an asynchronous verifier'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'detects mutation of the model passed to an asynchronous verifier' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow('model, route');
 */
it('detects mutation of the model passed to an asynchronous verifier', async () => {
  const verify = chain.verifyTransactionFee;
  vi.spyOn(chain, 'verifyTransactionFee').mockImplementation(async (model) => {
    const result = await verify(model);
    model.eventId = 'changed';
    return result;
  });
  await expect(prepare()).rejects.toThrow('model, route');
});
/**
 * @target PaymentSubmissionAuthorization.bind 'does not use the global event reader inside final SQL ownership'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'does not use the global event reader inside final SQL ownership' with the suite's captured inputs and invoke the bind path.
 * @expected expect(read).not.toHaveBeenCalled();
 */
it('does not use the global event reader inside final SQL ownership', async () => {
  const checks = await prepare();
  const read = vi
    .spyOn(db(), 'getEventById')
    .mockRejectedValue(Error('global read forbidden'));
  await checks.authorize(() => {});
  expect(read).not.toHaveBeenCalled();
});

/**
 * @target PaymentSubmissionAuthorization.bind 'real Signed Ergo isolates the %s rejection after order checks'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'real Signed Ergo isolates the %s rejection after order checks' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow( fault === 'fee' ? 'fee rejected' : fault === 'burn' ? 'burns tokens' : 'extra conditions', );
 */
it.each(['fee', 'burn', 'extra'])(
  'real Signed Ergo isolates the %s rejection after order checks',
  async (fault) => {
    const f = await setupErgo(false);
    try {
      const body = JSON.parse(
        wasm.Transaction.sigma_parse_bytes(payment.txBytes).to_json(),
      );
      const change = body.outputs.at(-1);
      const feeBox = body.outputs.find(
        (box: { ergoTree: string }) =>
          box.ergoTree === ErgoChain.feeBoxErgoTree,
      );
      if (fault === 'fee') {
        feeBox.value = String(BigInt(feeBox.value) + 1n);
        change.value = String(BigInt(change.value) - 1n);
      }
      if (fault === 'burn') change.value = String(BigInt(change.value) - 1n);
      if (fault === 'extra') change.creationHeight = 1;
      // Reconstruct an unsigned body with the same input extensions, then real signed encoding.
      body.inputs = body.inputs.map(
        (input: { boxId: string; spendingProof: { extension: object } }) => ({
          boxId: input.boxId,
          extension: input.spendingProof.extension,
        }),
      );
      const unsigned = wasm.UnsignedTransaction.from_json(JSON.stringify(body));
      const signed = wasm.Transaction.from_unsigned_tx(
        unsigned,
        Array.from({ length: unsigned.inputs().len() }, () => new Uint8Array()),
      );
      const oldId = payment.txId;
      payment.txBytes = signed.sigma_serialize_bytes();
      payment.txId = signed.id().to_str();
      expected = { ...expected, txId: payment.txId, txJson: payment.toJson() };
      await db().TransactionRepository.update(
        { txId: oldId },
        { txId: expected.txId, txJson: expected.txJson },
      );
      await expect(prepare()).rejects.toThrow(
        fault === 'fee'
          ? 'fee rejected'
          : fault === 'burn'
            ? 'burns tokens'
            : 'extra conditions',
      );
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects an unsupported Avalanche-related destination'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects an unsupported Avalanche-related destination' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow('route');
 */
it('rejects an unsupported Avalanche-related destination', async () => {
  await db().EventRepository.update(
    { eventId: expected.eventId! },
    { toChain: 'doge' },
  );
  await expect(prepare()).rejects.toThrow('route');
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects missing own %s slot (inherited=%s) returned directly by decoder'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects missing own %s slot (inherited=%s) returned directly by decoder' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow('auxiliary slot is missing');
 */
it.each([
  ['inputBoxes', false],
  ['inputBoxes', true],
  ['dataInputs', false],
  ['dataInputs', true],
] as const)(
  'rejects missing own %s slot (inherited=%s) returned directly by decoder',
  async (field, inherited) => {
    const f = await setupErgo(false, true);
    try {
      const decoded = ErgoTransaction.fromJson(expected.txJson);
      const value = decoded[field][0];
      delete decoded[field][0];
      if (inherited)
        Object.setPrototypeOf(
          decoded[field],
          Object.assign(Object.create(Array.prototype), { '0': value }),
        );
      helper['dependencies'].decode = () => decoded;
      await expect(prepare()).rejects.toThrow('auxiliary slot is missing');
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'frees every locally parsed box on rejected noncanonical trigger bytes'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'frees every locally parsed box on rejected noncanonical trigger bytes' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow('box encoding is not canonical'); expect(frees.length).toBeGreaterThan(0); expect(free).toHaveBeenCalledOnce();
 */
it('frees every locally parsed box on rejected noncanonical trigger bytes', async () => {
  const f = await setupErgo();
  try {
    const current = (await db().getEventById(expected.eventId!))!;
    await db().EventRepository.update(
      { eventId: expected.eventId! },
      {
        serialized: Buffer.concat([
          Buffer.from(current.eventData.serialized, 'base64'),
          Buffer.from([0]),
        ]).toString('base64'),
      },
    );
    const original = wasm.ErgoBox.sigma_parse_bytes;
    const frees: ReturnType<typeof vi.spyOn>[] = [];
    vi.spyOn(wasm.ErgoBox, 'sigma_parse_bytes').mockImplementation((bytes) => {
      const box = original(bytes);
      frees.push(vi.spyOn(box, 'free'));
      return box;
    });
    await expect(prepare()).rejects.toThrow('box encoding is not canonical');
    expect(frees.length).toBeGreaterThan(0);
    for (const free of frees) expect(free).toHaveBeenCalledOnce();
  } finally {
    f.restore();
  }
});

// Only the remote RPC responses are synthetic. The installed Avalanche adapter
// performs its actual chain/finalized/canonical transaction/receipt binding.
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
const sent = async () => {
  await db().TransactionRepository.update(
    { txId: expected.txId },
    { status: TransactionStatus.sent },
  );
  expected = { ...expected, status: TransactionStatus.sent };
};
const observedChecks = async (purpose: PaymentSubmissionPurpose) => {
  const bound = await helper.bind(expected, purpose);
  expect(bound.kind).toBe('observed');
  expect(bound.purpose).toBe(purpose);
  return bound.prepareUnderScannerLease(() => {});
};

const invalidationRow = async (status = TransactionStatus.sent) => {
  await db().TransactionRepository.update({ txId: expected.txId }, { status });
  return db().captureTxCheckPreimage((await db().getTxById(expected.txId))!);
};
const invalidationChecks = async (
  row: TransactionCheckPreimage,
  active = () => {},
) => (await helper.bindInvalidation(row)).prepareUnderScannerLease(active);
const invalidate = async (
  row: TransactionCheckPreimage,
  checks: Awaited<ReturnType<typeof invalidationChecks>>,
) =>
  db().invalidateTxIfUnchanged(row, row.lastCheck, checks.unexpected, {
    assertActive: () => {},
    assertBefore: (manager, current) =>
      checks.assertBefore(manager, current as TransactionCheckPreimage),
    assertAfter: (manager, current, transition) =>
      checks.assertAfter(
        manager,
        current as TransactionCheckPreimage,
        transition!,
      ),
  });

/** Real installed RPC decoder, synthetic provider replies; never sends HTTP. */
const invalidAvalanche = async (foreign = false, status = 0) => {
  const o = await observeAvalanche();
  o.receipt.status = status;
  await db()
    .dataSource.getRepository(AddressTxsEntity)
    .update({ id: o.record.id }, { status: status ? 'succeed' : 'failed' });
  if (foreign) {
    const other = Transaction.from(o.signed.unsignedSerialized);
    other.value += 1n;
    other.signature = new SigningKey(privateKey).sign(other.unsignedHash);
    Object.assign(o.tx, other.toJSON(), {
      chainId: other.chainId,
      signature: other.signature,
      from: other.from!,
      hash: other.hash!,
    });
    o.receipt.hash = other.hash!;
    o.block.transactions = [other.hash!];
    await db()
      .dataSource.getRepository(AddressTxsEntity)
      .update(
        { id: o.record.id },
        { signedHash: other.hash!, unsignedHash: other.unsignedHash },
      );
    vi.mocked(o.rpc.getTransaction).mockImplementation(async (id) =>
      id === other.hash ? (o.tx as never) : null,
    );
    vi.mocked(o.rpc.getTransactionReceipt).mockImplementation(async (id) =>
      id === other.hash ? (o.receipt as never) : null,
    );
  }
  return o;
};

const invalidErgo = async (includeData = false) => {
  const f = await setupErgo(true, includeData);
  const commitment = (
    await db().CommitmentRepository.findBy({ eventId: expected.eventId! })
  ).find((row) => row.WID === 'cc'.repeat(32))!;
  const own = wasm.Transaction.sigma_parse_bytes(payment.txBytes);
  let body: { outputs: unknown[] };
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
  const txId = spender.id();
  const raw = {
    bytes: Buffer.from(spender.sigma_serialize_bytes()).toString('hex'),
    txId: txId.to_str(),
  };
  txId.free();
  spender.free();
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
  await db().CommitmentRepository.update(
    { id: commitment.id },
    {
      spendTxId: raw.txId,
      spendIndex: 0,
      spendBlock: block.hash,
      spendHeight: block.height,
    },
  );
  const getTransaction = vi.fn(async (id: string, hash: string) => {
    if (id !== raw.txId || hash !== block.hash)
      throw new Error('Wrong foreign spender query');
    return wasm.Transaction.sigma_parse_bytes(Buffer.from(raw.bytes, 'hex'));
  });
  const getBlockInfo = vi.fn(async () => ({
    hash: block.hash,
    height: block.height,
    parentHash: block.parentHash,
  }));
  Object.assign(f.rawNetwork, { getTransaction, getBlockInfo });
  f.rawNetwork.getTxConfirmation.mockImplementation(
    async (...args: unknown[]) => (args[0] === raw.txId ? 2 : -1),
  );
  return { ...f, commitment, block, raw, getTransaction, getBlockInfo };
};

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

const storeUnsigned = async () => {
  payment.txBytes =
    payment instanceof ErgoTransaction
      ? reduceFixture(payment)
      : Buffer.from(
          Transaction.from(
            '0x' + Buffer.from(payment.txBytes).toString('hex'),
          ).unsignedSerialized.slice(2),
          'hex',
        );
  await db().TransactionRepository.update(
    { txId: expected.txId },
    { txJson: payment.toJson() },
  );
};
describe('positive-proof payment invalidation', () => {
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'qualifies unsigned signFailed with actual settled foreign=%s status=%s'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'qualifies unsigned signFailed with actual settled foreign=%s status=%s' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected expect(checks.unexpected).toBe(!foreign); expect(status).not.toHaveBeenCalled(); await expect(invalidate(row, checks)).resolves.toBe(true); expect(after.txJson).toBe(row.txJson); expect(after.lastCheck).toBe(row.lastCheck); expect(after.failedInSign).toBe(row.failedInSign); expect(after.signFailedCount).toBe(row.signFailedCount); expect(after.status).toBe(TransactionStatus.invalid); expect(event.status).toBe(EventStatus.pendingPayment); expect(event.unexpectedFails).toBe( before!.unexpectedFails + (foreign ? 0 : 1), );
   */
  it.each([
    [false, 0],
    [true, 0],
    [true, 1],
  ] as const)(
    'qualifies unsigned signFailed with actual settled foreign=%s status=%s',
    async (foreign, receipt) => {
      await invalidAvalanche(foreign, receipt);
      await storeUnsigned();
      const row = await invalidationRow(TransactionStatus.signFailed);
      const before = await db().getEventById(row.eventId!);
      const status = vi.spyOn(network, 'getTransactionStatus');
      const checks = await invalidationChecks(row);
      expect(checks.unexpected).toBe(!foreign);
      expect(status).not.toHaveBeenCalled();
      await expect(invalidate(row, checks)).resolves.toBe(true);
      const after = (await db().getTxById(row.txId))!;
      expect(after.txJson).toBe(row.txJson);
      expect(after.lastCheck).toBe(row.lastCheck);
      expect(after.failedInSign).toBe(row.failedInSign);
      expect(after.signFailedCount).toBe(row.signFailedCount);
      expect(after.status).toBe(TransactionStatus.invalid);
      const event = (await db().getEventById(row.eventId!))!;
      expect(event.status).toBe(EventStatus.pendingPayment);
      expect(event.unexpectedFails).toBe(
        before!.unexpectedFails + (foreign ? 0 : 1),
      );
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'defers own successful unsigned execution for recovery'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers own successful unsigned execution for recovery' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(invalidationChecks(row)).rejects.toThrow('reconciliation'); expect((await db().getTxById(row.txId))!.txJson).toBe(row.txJson);
   */
  it('defers own successful unsigned execution for recovery', async () => {
    await invalidAvalanche(false, 1);
    await storeUnsigned();
    const row = await invalidationRow(TransactionStatus.signFailed);
    await expect(invalidationChecks(row)).rejects.toThrow('reconciliation');
    expect((await db().getTxById(row.txId))!.txJson).toBe(row.txJson);
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'never accepts unsigned Avalanche in %s phase'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'never accepts unsigned Avalanche in %s phase' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect( phase === 'sent' ? helper.bindInvalidation(row) : helper.bind(row, phase as 'submission' | 'completion'), ).rejects.toThrow();
   */
  it.each(['sent', 'submission', 'completion'])(
    'never accepts unsigned Avalanche in %s phase',
    async (phase) => {
      await invalidAvalanche();
      await storeUnsigned();
      const row = await invalidationRow();
      await expect(
        phase === 'sent'
          ? helper.bindInvalidation(row)
          : helper.bind(row, phase as 'submission' | 'completion'),
      ).rejects.toThrow();
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'rejects isolated unsigned Avalanche %s mismatch'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects isolated unsigned Avalanche %s mismatch' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(row)).rejects.toThrow( fault === 'nonce' || fault === 'chain' ? 'Settled payment nonce evidence is inconsistent' : fault === 'lock-scope' ? 'Invalid Avalanche accounting envelope' : 'representation', ); expect(await db().getTxById(row.txId)).toEqual(before);
   */
  it.each(['lock-scope', 'nonce', 'chain', 'suffix'])(
    'rejects isolated unsigned Avalanche %s mismatch',
    async (fault) => {
      await invalidAvalanche();
      await storeUnsigned();
      if (fault === 'lock-scope')
        chain.getChainConfigs().addresses.lock = computeAddress(
          '0x' + '22'.repeat(32),
        );
      else if (fault === 'suffix') {
        payment.txBytes = Buffer.concat([
          payment.txBytes,
          Buffer.from('00', 'hex'),
        ]);
        await db().TransactionRepository.update(
          { txId: expected.txId },
          { txJson: payment.toJson() },
        );
      } else {
        // Preserve consistent original body/model/SQL identity and corrupt only
        // the named proof field after the real adapter has decoded it.
        const qualify = network.getSettledTransactionEvidence.bind(network);
        vi.spyOn(network, 'getSettledTransactionEvidence').mockImplementation(
          async (...args) => {
            const evidence = await qualify(...args);
            return fault === 'nonce'
              ? { ...evidence, nonce: evidence.nonce + 1 }
              : { ...evidence, chainId: 43114n };
          },
        );
      }
      const row = await invalidationRow(TransactionStatus.signFailed);
      const before = await db().getTxById(row.txId);
      await expect(invalidationChecks(row)).rejects.toThrow(
        fault === 'nonce' || fault === 'chain'
          ? 'Settled payment nonce evidence is inconsistent'
          : fault === 'lock-scope'
            ? 'Invalid Avalanche accounting envelope'
            : 'representation',
      );
      expect(await db().getTxById(row.txId)).toEqual(before);
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'invalidates canonical Reduced actual foreign input (data=%s) without a signed surrogate'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'invalidates canonical Reduced actual foreign input (data=%s) without a signed surrogate' with the suite's captured inputs and invoke the bind path.
   * @expected expect(spy).toHaveBeenCalled(); expect(args[1]).toBe(SigningStatus.UnSigned); expect(checks.unexpected).toBe(false); await expect(invalidate(row, checks)).resolves.toBe(true); expect((await db().getTxById(row.txId))!.txJson).toBe(row.txJson);
   */
  it.each([false, true])(
    'invalidates canonical Reduced actual foreign input (data=%s) without a signed surrogate',
    async (data) => {
      const f = await invalidErgo(data);
      try {
        await storeUnsigned();
        const row = await invalidationRow(TransactionStatus.signFailed);
        const methods = [
          'verifyPaymentTransaction',
          'verifyTransactionFee',
          'verifyNoTokenBurned',
          'verifyTransactionExtraConditions',
          'extractTransactionOrder',
        ] as const;
        const spies = methods.map((name) => vi.spyOn(f.ergo, name));
        const checks = await invalidationChecks(row);
        for (const spy of spies) {
          expect(spy).toHaveBeenCalled();
          for (const args of spy.mock.calls)
            expect(args[1]).toBe(SigningStatus.UnSigned);
        }
        expect(checks.unexpected).toBe(false);
        await expect(invalidate(row, checks)).resolves.toBe(true);
        expect((await db().getTxById(row.txId))!.txJson).toBe(row.txJson);
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'rejects %s canonical Ergo recognizers'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s canonical Ergo recognizers' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks( await invalidationRow(TransactionStatus.signFailed), ), ).rejects.toThrow('Ambiguous or invalid'); expect(f.getTransaction).not.toHaveBeenCalled();
   */
  it.each(['zero', 'both'])(
    'rejects %s canonical Ergo recognizers',
    async (cardinality) => {
      const f = await invalidErgo();
      try {
        await storeUnsigned();
        vi.spyOn(semantics, 'assertSameSignedErgoSemantics').mockImplementation(
          () => {
            if (cardinality === 'zero') throw new Error('not signed');
          },
        );
        if (cardinality === 'zero')
          vi.spyOn(semantics, 'assertCanonicalReducedErgo').mockImplementation(
            () => {
              throw new Error('not reduced');
            },
          );
        await expect(
          invalidationChecks(
            await invalidationRow(TransactionStatus.signFailed),
          ),
        ).rejects.toThrow('Ambiguous or invalid');
        expect(f.getTransaction).not.toHaveBeenCalled();
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'rejects invalid Reduced %s at representation capture'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects invalid Reduced %s at representation capture' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks( await invalidationRow( fault === 'sent' ? TransactionStatus.sent : TransactionStatus.signFailed, ), ), ).rejects.toThrow(); expect(f.getTransaction).not.toHaveBeenCalled();
   */
  it.each(['suffix', 'input-hole', 'data-hole', 'reordered', 'sent'])(
    'rejects invalid Reduced %s at representation capture',
    async (fault) => {
      const f = await invalidErgo(true);
      try {
        await storeUnsigned();
        if (fault === 'suffix')
          payment.txBytes = Buffer.concat([
            payment.txBytes,
            Buffer.from('00', 'hex'),
          ]);
        if (fault === 'input-hole')
          delete (payment as ErgoTransaction).inputBoxes[0];
        if (fault === 'data-hole')
          delete (payment as ErgoTransaction).dataInputs[0];
        if (fault === 'reordered')
          (payment as ErgoTransaction).inputBoxes.reverse();
        // Retain direct sparse slots in the injected decoder, not JSON's null normalization.
        helper['dependencies'].decode = () => payment;
        if (!fault.includes('hole'))
          await db().TransactionRepository.update(
            { txId: expected.txId },
            { txJson: payment.toJson() },
          );
        await expect(
          invalidationChecks(
            await invalidationRow(
              fault === 'sent'
                ? TransactionStatus.sent
                : TransactionStatus.signFailed,
            ),
          ),
        ).rejects.toThrow();
        expect(f.getTransaction).not.toHaveBeenCalled();
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'does not reclassify a captured Reduced model changed to Signed during RPC'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not reclassify a captured Reduced model changed to Signed during RPC' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow(TransactionStatus.signFailed)), ).rejects.toThrow();
   */
  it('does not reclassify a captured Reduced model changed to Signed during RPC', async () => {
    const f = await invalidErgo();
    try {
      const signed = Uint8Array.from(payment.txBytes);
      await storeUnsigned();
      helper['dependencies'].decode = () => payment;
      const before = f.getBlockInfo.getMockImplementation()!;
      f.getBlockInfo.mockImplementation(async (...args) => {
        const info = await before(...args);
        payment.txBytes = signed;
        return info;
      });
      await expect(
        invalidationChecks(await invalidationRow(TransactionStatus.signFailed)),
      ).rejects.toThrow();
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'does not reclassify unsigned Avalanche changed to Signed during RPC'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not reclassify unsigned Avalanche changed to Signed during RPC' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow(TransactionStatus.signFailed)), ).rejects.toThrow();
   */
  it('does not reclassify unsigned Avalanche changed to Signed during RPC', async () => {
    const observed = await invalidAvalanche();
    await storeUnsigned();
    helper['dependencies'].decode = () => payment;
    const getEvidence = network.getSettledTransactionEvidence.bind(network);
    vi.spyOn(network, 'getSettledTransactionEvidence').mockImplementation(
      async (...args) => {
        const evidence = await getEvidence(...args);
        payment.txBytes = Buffer.from(
          observed.signed.serialized.slice(2),
          'hex',
        );
        return evidence;
      },
    );
    await expect(
      invalidationChecks(await invalidationRow(TransactionStatus.signFailed)),
    ).rejects.toThrow();
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'rolls back foreign provenance mutated by an actual AFTER SQL trigger'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rolls back foreign provenance mutated by an actual AFTER SQL trigger' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidate(row, checks)).rejects.toThrow(); expect( await db().CommitmentRepository.findOneByOrFail({ id: f.commitment.id, }), ).toEqual(before); expect((await db().getTxById(row.txId))!.status).toBe(row.status);
   */
  it('rolls back foreign provenance mutated by an actual AFTER SQL trigger', async () => {
    const f = await invalidErgo();
    try {
      const row = await invalidationRow(),
        checks = await invalidationChecks(row);
      const before = await db().CommitmentRepository.findOneByOrFail({
        id: f.commitment.id,
      });
      await db().dataSource.query(
        `CREATE TRIGGER invalid_provenance_drift AFTER UPDATE OF status ON transaction_entity WHEN NEW.status = 'invalid' BEGIN UPDATE commitment_entity SET spendIndex = spendIndex + 1 WHERE id = ${f.commitment.id}; END`,
      );
      try {
        await expect(invalidate(row, checks)).rejects.toThrow();
        expect(
          await db().CommitmentRepository.findOneByOrFail({
            id: f.commitment.id,
          }),
        ).toEqual(before);
        expect((await db().getTxById(row.txId))!.status).toBe(row.status);
      } finally {
        await db().dataSource.query('DROP TRIGGER invalid_provenance_drift');
      }
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'rejects isolated scanned %s mismatch for failed Avalanche payment'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects isolated scanned %s mismatch for failed Avalanche payment' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow();
   */
  it.each(['status', 'parentHash', 'height'])(
    'rejects isolated scanned %s mismatch for failed Avalanche payment',
    async (field) => {
      const o = await invalidAvalanche();
      if (field === 'status')
        await db()
          .dataSource.getRepository(AddressTxsEntity)
          .update({ id: o.record.id }, { status: 'succeed' });
      else
        await db()
          .dataSource.getRepository(BlockEntity)
          .update(
            { hash: o.block.hash },
            { [field]: field === 'height' ? 299 : '0x' + '99'.repeat(32) },
          );
      await expect(
        invalidationChecks(await invalidationRow()),
      ).rejects.toThrow();
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers non-PROCEED foreign Ergo block'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers non-PROCEED foreign Ergo block' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'qualified scanned block', );
   */
  it('defers non-PROCEED foreign Ergo block', async () => {
    const f = await invalidErgo();
    try {
      await db()
        .dataSource.getRepository(BlockEntity)
        .update({ hash: f.block.hash }, { status: 'processing' });
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'qualified scanned block',
      );
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'rejects provenance change at the final owned SQL gate'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects provenance change at the final owned SQL gate' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidate(row, checks)).rejects.toThrow(); expect((await db().getTxById(row.txId))!.status).toBe(row.status);
   */
  it('rejects provenance change at the final owned SQL gate', async () => {
    const f = await invalidErgo();
    try {
      const row = await invalidationRow(),
        checks = await invalidationChecks(row);
      await db().CommitmentRepository.update(
        { id: f.commitment.id },
        { spendIndex: 9 },
      );
      await expect(invalidate(row, checks)).rejects.toThrow();
      expect((await db().getTxById(row.txId))!.status).toBe(row.status);
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers unused foreign commitment while all actual payment inputs remain unspent'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers unused foreign commitment while all actual payment inputs remain unspent' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'No proven foreign', );
   */
  it('defers unused foreign commitment while all actual payment inputs remain unspent', async () => {
    const f = await invalidErgo();
    try {
      const existing = await db().CommitmentRepository.findOneByOrFail({
        id: f.commitment.id,
      });
      const box = wasm.ErgoBox.sigma_parse_bytes(
        Buffer.from(existing.serialized, 'base64'),
      );
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(box.to_json());
      } finally {
        box.free();
      }
      // A different creation index gives a real canonical unused box with the same assets/registers.
      json.index = 19;
      delete json.boxId;
      const unused = wasm.ErgoBox.from_json(JSON.stringify(json));
      const id = unused.box_id();
      try {
        await db().CommitmentRepository.update(
          { id: existing.id },
          {
            spendTxId: null,
            spendHeight: null,
            spendBlock: null,
            spendIndex: null,
          },
        );
        await db().CommitmentRepository.insert({
          ...existing,
          id: undefined,
          identifier: id.to_str(),
          serialized: Buffer.from(unused.sigma_serialize_bytes()).toString(
            'base64',
          ),
        });
      } finally {
        id.free();
        unused.free();
      }
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'No proven foreign',
      );
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'rejects captured fee policy drift after settled evidence'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects captured fee policy drift after settled evidence' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'changed', ); expect(o.receipt.status).toBe(0);
   */
  it('rejects captured fee policy drift after settled evidence', async () => {
    const o = await invalidAvalanche();
    const original = network.getSettledTransactionEvidence.bind(network);
    vi.spyOn(network, 'getSettledTransactionEvidence').mockImplementation(
      async (...args) => {
        const result = await original(...args);
        chain.getChainConfigs().confirmations.payment++;
        return result;
      },
    );
    await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
      'changed',
    );
    expect(o.receipt.status).toBe(0);
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'denies expired preparation after settled RPC'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'denies expired preparation after settled RPC' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow(), () => { if (expired) throw new Error('expired'); }), ).rejects.toThrow('expired');
   */
  it('denies expired preparation after settled RPC', async () => {
    await invalidAvalanche();
    let expired = false;
    const original = network.getSettledTransactionEvidence.bind(network);
    vi.spyOn(network, 'getSettledTransactionEvidence').mockImplementation(
      async (...args) => {
        const result = await original(...args);
        expired = true;
        return result;
      },
    );
    await expect(
      invalidationChecks(await invalidationRow(), () => {
        if (expired) throw new Error('expired');
      }),
    ).rejects.toThrow('expired');
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'qualifies foreign Ergo input with actual %s transaction/header/confirmation adapter'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'qualifies foreign Ergo input with actual %s transaction/header/confirmation adapter' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).resolves.toHaveProperty('unexpected', false);
   */
  it.each(['node', 'explorer'])(
    'qualifies foreign Ergo input with actual %s transaction/header/confirmation adapter',
    async (kind) => {
      const f = await invalidErgo();
      try {
        const parsed = wasm.Transaction.sigma_parse_bytes(
          Buffer.from(f.raw.bytes, 'hex'),
        );
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(parsed.to_json());
        } finally {
          parsed.free();
        }
        const header = { height: f.block.height, parentId: f.block.parentHash };
        const absent = () => {
          throw { response: { status: 404, data: {} } };
        };
        const actual =
          kind === 'node'
            ? new ErgoNodeNetwork({ nodeBaseUrl: 'http://127.0.0.1:1' })
            : new ErgoExplorerNetwork({
                explorerBaseUrl: 'http://127.0.0.1:1',
              });
        Object.assign(actual, {
          client:
            kind === 'node'
              ? {
                  getBlockHeaderById: vi.fn(async () => header),
                  getBlockTransactionsById: vi.fn(async () => ({
                    transactions: [json],
                  })),
                  getTxById: vi.fn(async (id: string) =>
                    id === f.raw.txId ? { numConfirmations: 2 } : absent(),
                  ),
                }
              : {
                  v1: {
                    getApiV1BlocksP1: vi.fn(async () => ({
                      block: { header },
                    })),
                    getApiV1TransactionsP1: vi.fn(async (id: string) =>
                      id === f.raw.txId
                        ? {
                            ...json,
                            blockId: f.block.hash,
                            numConfirmations: 2,
                          }
                        : absent(),
                    ),
                  },
                },
          isBoxUnspentAndValid: f.rawNetwork.isBoxUnspentAndValid,
          getMempoolTransactions: f.rawNetwork.getMempoolTransactions,
        });
        f.ergo.network = actual;
        await expect(
          invalidationChecks(await invalidationRow()),
        ).resolves.toHaveProperty('unexpected', false);
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'defers alternate valid signature for the own body even when failed'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers alternate valid signature for the own body even when failed' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected expect(alternate.from).toBe(o.signed.from); expect(alternate.hash).not.toBe(o.signed.hash); await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'reconciliation', );
   */
  it('defers alternate valid signature for the own body even when failed', async () => {
    const o = await invalidAvalanche();
    const alternate = Transaction.from(o.signed.serialized);
    const signature = secp256k1.sign(
      o.signed.unsignedHash.slice(2),
      privateKey.slice(2),
      { extraEntropy: new Uint8Array(32).fill(7) },
    );
    alternate.signature = {
      r: '0x' + signature.r.toString(16).padStart(64, '0'),
      s: '0x' + signature.s.toString(16).padStart(64, '0'),
      yParity: signature.recovery as 0 | 1,
    };
    expect(alternate.from).toBe(o.signed.from);
    expect(alternate.hash).not.toBe(o.signed.hash);
    Object.assign(o.tx, alternate.toJSON(), {
      chainId: alternate.chainId,
      signature: alternate.signature,
      hash: alternate.hash!,
      from: alternate.from!,
    });
    o.receipt.hash = alternate.hash!;
    o.block.transactions = [alternate.hash!];
    vi.mocked(o.rpc.getTransaction).mockResolvedValue(o.tx as never);
    await db()
      .dataSource.getRepository(AddressTxsEntity)
      .update({ id: o.record.id }, { signedHash: alternate.hash! });
    await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
      'reconciliation',
    );
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'rejects isolated after-callback %s substitution'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects isolated after-callback %s substitution' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect( db().invalidateTxIfUnchanged(row, row.lastCheck, checks.unexpected, { assertActive: () => {}, assertBefore: (m, r) => checks.assertBefore(m, r as TransactionCheckPreimage), assertAfter: (m, r, t) => checks.assertAfter( m, { ...r, [field]: field === 'failedInSign' ? !row.failedInSign : ['lastCheck', 'signFailedCount', 'requiredSign'].includes( field, ) ? 123 : 'changed', } as TransactionCheckPreimage, t!, ), }), ).rejects.toThrow(); expect((await db().getTxById(row.txId))!.status).toBe(row.status);
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
  ])('rejects isolated after-callback %s substitution', async (field) => {
    await invalidAvalanche();
    const row = await invalidationRow(),
      checks = await invalidationChecks(row);
    await expect(
      db().invalidateTxIfUnchanged(row, row.lastCheck, checks.unexpected, {
        assertActive: () => {},
        assertBefore: (m, r) =>
          checks.assertBefore(m, r as TransactionCheckPreimage),
        assertAfter: (m, r, t) =>
          checks.assertAfter(
            m,
            {
              ...r,
              [field]:
                field === 'failedInSign'
                  ? !row.failedInSign
                  : ['lastCheck', 'signFailedCount', 'requiredSign'].includes(
                        field,
                      )
                    ? 123
                    : 'changed',
            } as TransactionCheckPreimage,
            t!,
          ),
      }),
    ).rejects.toThrow();
    expect((await db().getTxById(row.txId))!.status).toBe(row.status);
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'rolls back forbidden event AFTER %s mutation'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rolls back forbidden event AFTER %s mutation' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(invalidate(row, checks)).rejects.toThrow(); expect(await db().getEventById(row.eventId!)).toEqual(before);
   */
  it.each(['status', 'firstTry', 'unexpectedFails'])(
    'rolls back forbidden event AFTER %s mutation',
    async (field) => {
      await invalidAvalanche();
      const row = await invalidationRow(),
        checks = await invalidationChecks(row),
        before = await db().getEventById(row.eventId!);
      await db().dataSource.query(
        `CREATE TRIGGER invalid_event_drift AFTER UPDATE OF status ON confirmed_event_entity WHEN NEW.status = 'pending-payment' BEGIN UPDATE confirmed_event_entity SET ${field} = ${field === 'unexpectedFails' ? 'unexpectedFails + 1' : "'changed'"} WHERE id = NEW.id; END`,
      );
      try {
        await expect(invalidate(row, checks)).rejects.toThrow();
        expect(await db().getEventById(row.eventId!)).toEqual(before);
      } finally {
        await db().dataSource.query('DROP TRIGGER invalid_event_drift');
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'invalidates Ergo foreign commitment spend for Signed %s through actual DAO'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'invalidates Ergo foreign commitment spend for Signed %s through actual DAO' with the suite's captured inputs and invoke the bind path.
   * @expected expect(checks.unexpected).toBe(false); expect(checks.reason).toBe( 'Payment input consumed by a confirmed foreign transaction', ); await expect(invalidate(row, checks)).resolves.toBe(true); expect(after.status).toBe(EventStatus.pendingPayment); expect(after.firstTry).toBe(before.firstTry); expect(after.unexpectedFails).toBe(before.unexpectedFails);
   */
  it.each([TransactionStatus.sent, TransactionStatus.signFailed])(
    'invalidates Ergo foreign commitment spend for Signed %s through actual DAO',
    async (status) => {
      const f = await invalidErgo();
      try {
        const row = await invalidationRow(status),
          before = (await db().getEventById(row.eventId!))!;
        const checks = await invalidationChecks(row);
        expect(checks.unexpected).toBe(false);
        expect(checks.reason).toBe(
          'Payment input consumed by a confirmed foreign transaction',
        );
        await expect(invalidate(row, checks)).resolves.toBe(true);
        const after = (await db().getEventById(row.eventId!))!;
        expect(after.status).toBe(EventStatus.pendingPayment);
        expect(after.firstTry).toBe(before.firstTry);
        expect(after.unexpectedFails).toBe(before.unexpectedFails);
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers partial foreign commitment %s tuple'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers partial foreign commitment %s tuple' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow();
   */
  it.each(['spendHeight', 'spendBlock', 'spendTxId', 'spendIndex'])(
    'defers partial foreign commitment %s tuple',
    async (field) => {
      const f = await invalidErgo();
      try {
        await db().CommitmentRepository.update(
          { id: f.commitment.id },
          { [field]: null },
        );
        await expect(
          invalidationChecks(await invalidationRow()),
        ).rejects.toThrow();
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers wrong foreign commitment %s tuple'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers wrong foreign commitment %s tuple' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow();
   */
  it.each(['spendHeight', 'spendBlock', 'spendTxId', 'spendIndex'])(
    'defers wrong foreign commitment %s tuple',
    async (field) => {
      const f = await invalidErgo();
      try {
        await db().CommitmentRepository.update(
          { id: f.commitment.id },
          {
            [field]:
              field === 'spendHeight'
                ? f.block.height + 1
                : field === 'spendIndex'
                  ? 1
                  : '99'.repeat(32),
          },
        );
        await expect(
          invalidationChecks(await invalidationRow()),
        ).rejects.toThrow();
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers invalidation with isolated trigger %s marker'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers invalidation with isolated trigger %s marker' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow('unspent trigger');
   */
  it.each(['spendHeight', 'spendBlock', 'spendTxId', 'result', 'paymentTxId'])(
    'defers invalidation with isolated trigger %s marker',
    async (field) => {
      const f = await invalidErgo();
      try {
        await db().EventRepository.update(
          { eventId: expected.eventId! },
          { [field]: field === 'spendHeight' ? f.block.height : 'foreign' },
        );
        await expect(
          invalidationChecks(await invalidationRow()),
        ).rejects.toThrow('unspent trigger');
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers commitment claiming the own payment as spender'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers commitment claiming the own payment as spender' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow();
   */
  it('defers commitment claiming the own payment as spender', async () => {
    const f = await invalidErgo();
    try {
      await db().CommitmentRepository.update(
        { id: f.commitment.id },
        { spendTxId: expected.txId },
      );
      await expect(
        invalidationChecks(await invalidationRow()),
      ).rejects.toThrow();
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers unproven funding spender even with a proven foreign commitment'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers unproven funding spender even with a proven foreign commitment' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'Unknown payment funding', );
   */
  it('defers unproven funding spender even with a proven foreign commitment', async () => {
    const f = await invalidErgo();
    try {
      f.rawNetwork.isBoxUnspentAndValid.mockResolvedValue(false);
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'Unknown payment funding',
      );
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'rejects foreign Ergo network block %s mismatch'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects foreign Ergo network block %s mismatch' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow('block changed');
   */
  it.each(['hash', 'height', 'parentHash'])(
    'rejects foreign Ergo network block %s mismatch',
    async (field) => {
      const f = await invalidErgo();
      try {
        f.getBlockInfo.mockResolvedValue({
          hash: f.block.hash,
          height: f.block.height,
          parentHash: f.block.parentHash,
          [field]: field === 'height' ? 7 : '99'.repeat(32),
        });
        await expect(
          invalidationChecks(await invalidationRow()),
        ).rejects.toThrow('block changed');
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers foreign Ergo block drift during later funding RPC'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers foreign Ergo block drift during later funding RPC' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'block changed', );
   */
  it('defers foreign Ergo block drift during later funding RPC', async () => {
    const f = await invalidErgo();
    try {
      f.rawNetwork.isBoxUnspentAndValid.mockImplementation(async () => {
        f.getBlockInfo.mockResolvedValue({
          hash: f.block.hash,
          height: f.block.height + 1,
          parentHash: f.block.parentHash,
        });
        return true;
      });
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'block changed',
      );
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers foreign Ergo insufficient confirmation %s'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers foreign Ergo insufficient confirmation %s' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow('not confirmed');
   */
  it.each([-1, 0, 1])(
    'defers foreign Ergo insufficient confirmation %s',
    async (confirmations) => {
      const f = await invalidErgo();
      try {
        f.ergo.getChainConfigs().confirmations.payment = 2;
        f.rawNetwork.getTxConfirmation.mockImplementation(
          async (...args: unknown[]) =>
            args[0] === f.raw.txId ? confirmations : -1,
        );
        await expect(
          invalidationChecks(await invalidationRow()),
        ).rejects.toThrow('not confirmed');
      } finally {
        f.restore();
      }
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers foreign Ergo confirmation lost during funding RPC'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers foreign Ergo confirmation lost during funding RPC' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'not confirmed', );
   */
  it('defers foreign Ergo confirmation lost during funding RPC', async () => {
    const f = await invalidErgo();
    try {
      f.rawNetwork.isBoxUnspentAndValid.mockImplementation(async () => {
        f.rawNetwork.getTxConfirmation.mockResolvedValue(-1);
        return true;
      });
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'not confirmed',
      );
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers positive own Ergo confirmation'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers positive own Ergo confirmation' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'reconciliation', );
   */
  it('defers positive own Ergo confirmation', async () => {
    const f = await invalidErgo();
    try {
      f.rawNetwork.getTxConfirmation.mockResolvedValue(2);
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'reconciliation',
      );
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers a canonical different foreign body with the same claimed spend tuple'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers a canonical different foreign body with the same claimed spend tuple' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'canonical', );
   */
  it('defers a canonical different foreign body with the same claimed spend tuple', async () => {
    const f = await invalidErgo();
    try {
      f.raw.bytes = Buffer.from(payment.txBytes).toString('hex');
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'canonical',
      );
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'rejects foreign Ergo suffix bytes even when the WASM parser accepts them'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects foreign Ergo suffix bytes even when the WASM parser accepts them' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'canonical', );
   */
  it('rejects foreign Ergo suffix bytes even when the WASM parser accepts them', async () => {
    const f = await invalidErgo();
    try {
      // Bypass the adapter's reserialization only to isolate the consumer's canonical check.
      vi.spyOn(f.ergo, 'getTransaction').mockResolvedValue(f.raw.bytes + '00');
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'canonical',
      );
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers unrelated Reduced body before any spender read'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers unrelated Reduced body before any spender read' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( invalidationChecks(await invalidationRow(TransactionStatus.signFailed)), ).rejects.toThrow(); expect(f.getTransaction).not.toHaveBeenCalled();
   */
  it('defers unrelated Reduced body before any spender read', async () => {
    const f = await invalidErgo();
    try {
      const reduced = ErgoTransaction.fromJson(reducedPaymentFixture);
      payment.txBytes = reduced.txBytes;
      await db().TransactionRepository.update(
        { txId: expected.txId },
        { txJson: payment.toJson() },
      );
      await expect(
        invalidationChecks(await invalidationRow(TransactionStatus.signFailed)),
      ).rejects.toThrow();
      expect(f.getTransaction).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'invalidates exact own failed Signed %s through actual DAO'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'invalidates exact own failed Signed %s through actual DAO' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected expect(checks.unexpected).toBe(true); expect(checks.reason).toBe('Own payment failed in settled execution'); expect('authorize' in checks).toBe(false); expect(Object.isFrozen(checks)).toBe(true); await expect(invalidate(row, checks)).resolves.toBe(true); expect(after.status).toBe(EventStatus.pendingPayment); expect(after.unexpectedFails).toBe(before.unexpectedFails + 1); expect(after.firstTry).toBe(before.firstTry); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.invalid, );
   */
  it.each([TransactionStatus.sent, TransactionStatus.signFailed])(
    'invalidates exact own failed Signed %s through actual DAO',
    async (status) => {
      await invalidAvalanche();
      const row = await invalidationRow(status),
        before = (await db().getEventById(expected.eventId!))!;
      const checks = await invalidationChecks(row);
      expect(checks.unexpected).toBe(true);
      expect(checks.reason).toBe('Own payment failed in settled execution');
      expect('authorize' in checks).toBe(false);
      expect(Object.isFrozen(checks)).toBe(true);
      await expect(invalidate(row, checks)).resolves.toBe(true);
      const after = (await db().getEventById(expected.eventId!))!;
      expect(after.status).toBe(EventStatus.pendingPayment);
      expect(after.unexpectedFails).toBe(before.unexpectedFails + 1);
      expect(after.firstTry).toBe(before.firstTry);
      expect((await db().getTxById(expected.txId))!.status).toBe(
        TransactionStatus.invalid,
      );
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'invalidates foreign nonce consumer with settled receipt status %s'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'invalidates foreign nonce consumer with settled receipt status %s' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected expect(checks.unexpected).toBe(false); await expect(invalidate(row, checks)).resolves.toBe(true); expect(after.unexpectedFails).toBe(before.unexpectedFails); expect(after.firstTry).toBe(before.firstTry);
   */
  it.each([0, 1])(
    'invalidates foreign nonce consumer with settled receipt status %s',
    async (status) => {
      await invalidAvalanche(true, status);
      const row = await invalidationRow(),
        before = (await db().getEventById(expected.eventId!))!;
      const checks = await invalidationChecks(row);
      expect(checks.unexpected).toBe(false);
      await expect(invalidate(row, checks)).resolves.toBe(true);
      const after = (await db().getEventById(expected.eventId!))!;
      expect(after.unexpectedFails).toBe(before.unexpectedFails);
      expect(after.firstTry).toBe(before.firstTry);
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'defers own successful execution'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers own successful execution' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'reconciliation', );
   */
  it('defers own successful execution', async () => {
    await invalidAvalanche(false, 1);
    await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
      'reconciliation',
    );
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'defers missing nonce record rather than treating absence as invalidity'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers missing nonce record rather than treating absence as invalidity' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'No settled', ); expect(proof).not.toHaveBeenCalled();
   */
  it('defers missing nonce record rather than treating absence as invalidity', async () => {
    const proof = vi.spyOn(network, 'getSettledTransactionEvidence');
    await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
      'No settled',
    );
    expect(proof).not.toHaveBeenCalled();
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'rejects foreign record outside %s scope'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects foreign record outside %s scope' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow();
   */
  it.each(['extractor', 'address', 'nonce'])(
    'rejects foreign record outside %s scope',
    async (field) => {
      const o = await invalidAvalanche(true);
      await db()
        .dataSource.getRepository(AddressTxsEntity)
        .update(
          { id: o.record.id },
          { [field]: field === 'nonce' ? 2 : 'other' },
        );
      await expect(
        invalidationChecks(await invalidationRow()),
      ).rejects.toThrow();
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'rejects isolated malformed settled evidence %s'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects isolated malformed settled evidence %s' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow();
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
  ])('rejects isolated malformed settled evidence %s', async (field) => {
    const o = await invalidAvalanche();
    const actual = await network.getSettledTransactionEvidence(
      o.signed.hash!,
      o.block.hash,
    );
    const wrong: Record<string, unknown> = {
      hash: '0x' + '99'.repeat(32),
      unsignedHash: '0x' + '99'.repeat(32),
      signedBytes: o.signed.unsignedSerialized,
      from: '0x' + '99'.repeat(20),
      chainId: 43114n,
      nonce: 8,
      blockHash: '0x' + '99'.repeat(32),
      blockNumber: 1,
      index: -1,
      status: EvmTxStatus.mempool,
      confirmations: 0,
      finalizedBlockHash: 'bad',
      finalizedBlockNumber: 299,
    };
    vi.spyOn(network, 'getSettledTransactionEvidence').mockResolvedValue({
      ...actual,
      [field]: wrong[field],
    });
    await expect(invalidationChecks(await invalidationRow())).rejects.toThrow();
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'defers RPC %s execution'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers RPC %s execution' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect( invalidationChecks(await invalidationRow()), ).rejects.toThrow();
   */
  it.each(['pending', 'missing', 'error', 'failed-unfinalized'])(
    'defers RPC %s execution',
    async (mode) => {
      const o = await invalidAvalanche();
      if (mode === 'missing')
        vi.mocked(o.rpc.getTransaction).mockResolvedValue(null);
      if (mode === 'pending')
        Object.assign(o.tx, { blockHash: null, blockNumber: null });
      if (mode === 'error')
        vi.mocked(o.rpc.getTransactionReceipt).mockRejectedValue(
          new Error('unavailable'),
        );
      if (mode === 'failed-unfinalized') o.frontier.number = o.block.number - 1;
      await expect(
        invalidationChecks(await invalidationRow()),
      ).rejects.toThrow();
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'defers insufficient current confirmations'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers insufficient current confirmations' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow();
   */
  it('defers insufficient current confirmations', async () => {
    await invalidAvalanche();
    chain.getChainConfigs().confirmations.payment = 3;
    await expect(invalidationChecks(await invalidationRow())).rejects.toThrow();
  });
  /**
   * @target PaymentSubmissionAuthorization.bind 'defers a valid advancing frontier between proof reads'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers a valid advancing frontier between proof reads' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'evidence changed', );
   */
  it('defers a valid advancing frontier between proof reads', async () => {
    const o = await invalidAvalanche();
    const original = network.getSettledTransactionEvidence.bind(network);
    vi.spyOn(network, 'getSettledTransactionEvidence').mockImplementation(
      async (...args) => {
        const result = await original(...args);
        o.frontier.number++;
        return result;
      },
    );
    await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
      'evidence changed',
    );
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'defers contradictory own %s while a foreign nonce is captured'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers contradictory own %s while a foreign nonce is captured' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(invalidationChecks(await invalidationRow())).rejects.toThrow( 'contradicts', );
   */
  it.each(['succeed', 'mempool', 'failed'])(
    'defers contradictory own %s while a foreign nonce is captured',
    async (status) => {
      await invalidAvalanche(true);
      vi.spyOn(network, 'getTransactionStatus').mockResolvedValue(
        status as EvmTxStatus,
      );
      await expect(invalidationChecks(await invalidationRow())).rejects.toThrow(
        'contradicts',
      );
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bind 'rejects caller check-preimage mutation while RPC is awaited'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects caller check-preimage mutation while RPC is awaited' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(invalidationChecks(row)).rejects.toThrow('changed');
   */
  it('rejects caller check-preimage mutation while RPC is awaited', async () => {
    await invalidAvalanche();
    const row = { ...(await invalidationRow()) };
    const original = network.getSettledTransactionEvidence.bind(network);
    vi.spyOn(network, 'getSettledTransactionEvidence').mockImplementation(
      async (...args) => {
        row.lastCheck++;
        return original(...args);
      },
    );
    await expect(invalidationChecks(row)).rejects.toThrow('changed');
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'is single-use at preparation and never exposes a transport callback'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'is single-use at preparation and never exposes a transport callback' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(bound.prepareUnderScannerLease(() => {})).rejects.toThrow( 'single use', );
   */
  it('is single-use at preparation and never exposes a transport callback', async () => {
    await invalidAvalanche();
    const bound = await helper.bindInvalidation(await invalidationRow());
    await bound.prepareUnderScannerLease(() => {});
    await expect(bound.prepareUnderScannerLease(() => {})).rejects.toThrow(
      'single use',
    );
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'denies unexpected flag substitution and rolls back actual DAO'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'denies unexpected flag substitution and rolls back actual DAO' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect( db().invalidateTxIfUnchanged(row, row.lastCheck, false, { assertActive: () => {}, assertBefore: (m, r) => checks.assertBefore(m, r as TransactionCheckPreimage), assertAfter: (m, r, t) => checks.assertAfter(m, r as TransactionCheckPreimage, t!), }), ).rejects.toThrow(); expect(await db().getTxById(row.txId)).toEqual(before);
   */
  it('denies unexpected flag substitution and rolls back actual DAO', async () => {
    await invalidAvalanche();
    const row = await invalidationRow(),
      checks = await invalidationChecks(row),
      before = await db().getTxById(row.txId);
    await expect(
      db().invalidateTxIfUnchanged(row, row.lastCheck, false, {
        assertActive: () => {},
        assertBefore: (m, r) =>
          checks.assertBefore(m, r as TransactionCheckPreimage),
        assertAfter: (m, r, t) =>
          checks.assertAfter(m, r as TransactionCheckPreimage, t!),
      }),
    ).rejects.toThrow();
    expect(await db().getTxById(row.txId)).toEqual(before);
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'denies isolated owned %s drift before SQL'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'denies isolated owned %s drift before SQL' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect( db().dataSource.transaction((m) => checks.assertBefore(m, row)), ).rejects.toThrow('preimage changed');
   */
  it.each(['lastCheck', 'lastStatusUpdate', 'failedInSign', 'signFailedCount'])(
    'denies isolated owned %s drift before SQL',
    async (field) => {
      await invalidAvalanche();
      const row = await invalidationRow(),
        checks = await invalidationChecks(row);
      await db().TransactionRepository.update(
        { txId: row.txId },
        {
          [field]:
            field === 'failedInSign'
              ? !row.failedInSign
              : field === 'lastStatusUpdate'
                ? 'changed'
                : (row[field as 'lastCheck'] as number) + 1,
        },
      );
      await expect(
        db().dataSource.transaction((m) => checks.assertBefore(m, row)),
      ).rejects.toThrow('preimage changed');
    },
  );
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'rolls back forbidden actual AFTER %s mutation'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rolls back forbidden actual AFTER %s mutation' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect(invalidate(row, checks)).rejects.toThrow(); expect(await db().getTxById(row.txId)).toEqual(before); expect(await db().getEventById(row.eventId!)).toEqual(event); expect(notify).not.toHaveBeenCalled();
   */
  it.each([
    'txJson',
    'chain',
    'type',
    'requiredSign',
    'lastCheck',
    'failedInSign',
    'signFailedCount',
  ])('rolls back forbidden actual AFTER %s mutation', async (field) => {
    await invalidAvalanche();
    const row = await invalidationRow(),
      checks = await invalidationChecks(row),
      before = await db().getTxById(row.txId),
      event = await db().getEventById(row.eventId!);
    const value = [
      'requiredSign',
      'lastCheck',
      'failedInSign',
      'signFailedCount',
    ].includes(field)
      ? `${field} + 1`
      : "'changed'";
    await db().dataSource.query(
      `CREATE TRIGGER invalidation_drift AFTER UPDATE OF status ON transaction_entity WHEN NEW.status = 'invalid' BEGIN UPDATE transaction_entity SET ${field} = ${value} WHERE txId = NEW.txId; END`,
    );
    const notify = vi
      .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
      .mockResolvedValue(undefined);
    try {
      await expect(invalidate(row, checks)).rejects.toThrow();
      expect(await db().getTxById(row.txId)).toEqual(before);
      expect(await db().getEventById(row.eventId!)).toEqual(event);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await db().dataSource.query('DROP TRIGGER invalidation_drift');
    }
  });
  /**
   * @target PaymentSubmissionAuthorization.bindInvalidation 'defers unsigned signFailed when no settled proof exists'
   * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers unsigned signFailed when no settled proof exists' with the suite's captured inputs and invoke the bindInvalidation path.
   * @expected await expect( invalidationChecks(await invalidationRow(TransactionStatus.signFailed)), ).rejects.toThrow('No settled payment nonce evidence'); expect(proof).not.toHaveBeenCalled();
   */
  it('defers unsigned signFailed when no settled proof exists', async () => {
    const unsigned = Transaction.from(
      '0x' + Buffer.from(payment.txBytes).toString('hex'),
    ).unsignedSerialized;
    payment.txBytes = Buffer.from(unsigned.slice(2), 'hex');
    await db().TransactionRepository.update(
      { txId: expected.txId },
      { txJson: payment.toJson() },
    );
    const proof = vi.spyOn(network, 'getSettledTransactionEvidence');
    await expect(
      invalidationChecks(await invalidationRow(TransactionStatus.signFailed)),
    ).rejects.toThrow('No settled payment nonce evidence');
    expect(proof).not.toHaveBeenCalled();
  });
});
/**
 * @target PaymentSubmissionAuthorization.bind 'real Avalanche adapter and real DAO %s preserve the exact stored signed bytes'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'real Avalanche adapter and real DAO %s preserve the exact stored signed bytes' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(checks.authorize(start)).rejects.toThrow( 'cannot be submitted', ); expect(start).not.toHaveBeenCalled(); await expect( purpose === 'completion' ? db().finalizeTxIfUnchanged(expected, authorization) : db().setTxStatusIfUnchanged( expected, TransactionStatus.sent, authorization, ), ).resolves.toBe(true); expect(row.txJson).toBe(expected.txJson); expect(row.status).toBe( purpose === 'completion' ? TransactionStatus.completed : TransactionStatus.sent, ); expect(event.status).toBe( purpose === 'completion' ? EventStatus.pendingReward : EventStatus.inPayment, ); expect(event.firstTry).toBe( purpose === 'completion' ? row.lastStatusUpdate : 'first', ); expect(f.rpc.getTransaction).toHaveBeenCalledWith(f.signed.hash); expect(f.rpc.getTransaction).not.toHaveBeenCalledWith(expected.txId);
 */
it.each(['submission', 'completion'] as const)(
  'real Avalanche adapter and real DAO %s preserve the exact stored signed bytes',
  async (purpose) => {
    const f = await observeAvalanche();
    if (purpose === 'completion') await sent();
    const checks = await observedChecks(purpose);
    const start = vi.fn();
    await expect(checks.authorize(start)).rejects.toThrow(
      'cannot be submitted',
    );
    expect(start).not.toHaveBeenCalled();
    const authorization = { ...checks, assertActive: () => {} };
    await expect(
      purpose === 'completion'
        ? db().finalizeTxIfUnchanged(expected, authorization)
        : db().setTxStatusIfUnchanged(
            expected,
            TransactionStatus.sent,
            authorization,
          ),
    ).resolves.toBe(true);
    const row = (await db().getTxById(expected.txId))!;
    const event = (await db().getEventById(expected.eventId!))!;
    expect(row.txJson).toBe(expected.txJson);
    expect(row.status).toBe(
      purpose === 'completion'
        ? TransactionStatus.completed
        : TransactionStatus.sent,
    );
    expect(event.status).toBe(
      purpose === 'completion'
        ? EventStatus.pendingReward
        : EventStatus.inPayment,
    );
    expect(event.firstTry).toBe(
      purpose === 'completion' ? row.lastStatusUpdate : 'first',
    );
    expect(f.rpc.getTransaction).toHaveBeenCalledWith(f.signed.hash);
    expect(f.rpc.getTransaction).not.toHaveBeenCalledWith(expected.txId);
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'observed Ergo actual Signed/B0 and DAO completion (additional %s)'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'observed Ergo actual Signed/B0 and DAO completion (additional %s)' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().finalizeTxIfUnchanged(expected, { ...checks, assertActive: () => {}, }), ).resolves.toBe(true); expect(event.status).toBe(EventStatus.completed); expect(event.firstTry).toBe('first'); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.completed, ); expect(validity).not.toHaveBeenCalled();
 */
it.each([false, true])(
  'observed Ergo actual Signed/B0 and DAO completion (additional %s)',
  async (additional) => {
    const f = await setupErgo(additional, true);
    try {
      await observeErgo(f);
      await sent();
      const validity = vi
        .spyOn(f.ergo, 'isTxValid')
        .mockRejectedValue(
          new Error('Observed inputs must not be checked as unspent'),
        );
      const checks = await observedChecks('completion');
      await expect(
        db().finalizeTxIfUnchanged(expected, {
          ...checks,
          assertActive: () => {},
        }),
      ).resolves.toBe(true);
      const event = (await db().getEventById(expected.eventId!))!;
      expect(event.status).toBe(EventStatus.completed);
      expect(event.firstTry).toBe('first');
      expect((await db().getTxById(expected.txId))!.status).toBe(
        TransactionStatus.completed,
      );
      expect(validity).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'observed Ergo proof-only difference permits actual sent reconciliation'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'observed Ergo proof-only difference permits actual sent reconciliation' with the suite's captured inputs and invoke the bind path.
 * @expected expect(observation.raw.bytes).not.toBe( Buffer.from(payment.txBytes).toString('hex'), ); await expect( db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, { ...checks, assertActive: () => {}, }), ).resolves.toBe(true);
 */
it('observed Ergo proof-only difference permits actual sent reconciliation', async () => {
  const f = await setupErgo(true, true);
  try {
    const observation = await observeErgo(f);
    const tx = wasm.Transaction.sigma_parse_bytes(payment.txBytes);
    const json = JSON.parse(tx.to_json());
    tx.free();
    json.inputs[0].spendingProof.proofBytes = '01';
    const alternate = wasm.Transaction.from_json(JSON.stringify(json));
    observation.raw.bytes = Buffer.from(
      alternate.sigma_serialize_bytes(),
    ).toString('hex');
    alternate.free();
    expect(observation.raw.bytes).not.toBe(
      Buffer.from(payment.txBytes).toString('hex'),
    );
    const checks = await observedChecks('submission');
    await expect(
      db().setTxStatusIfUnchanged(expected, TransactionStatus.sent, {
        ...checks,
        assertActive: () => {},
      }),
    ).resolves.toBe(true);
  } finally {
    f.restore();
  }
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects %s explicitly'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects %s explicitly' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( helper.bind( expected, (fault === 'missing purpose' ? undefined : fault === 'unknown purpose' ? 'recovery' : 'completion') as PaymentSubmissionPurpose, ), ).rejects.toThrow();
 */
it.each([
  'ready completion',
  'signed completion',
  'missing purpose',
  'unknown purpose',
] as const)('rejects %s explicitly', async (fault) => {
  if (fault === 'ready completion') await sent();
  if (fault === 'signed completion') await observeAvalanche();
  await expect(
    helper.bind(
      expected,
      (fault === 'missing purpose'
        ? undefined
        : fault === 'unknown purpose'
          ? 'recovery'
          : 'completion') as PaymentSubmissionPurpose,
    ),
  ).rejects.toThrow();
});
/**
 * @target PaymentSubmissionAuthorization.bind 'keeps submission identity across ready→observed without normalizing other inputs'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'keeps submission identity across ready→observed without normalizing other inputs' with the suite's captured inputs and invoke the bind path.
 * @expected expect(before.kind).toBe('ready'); expect(after.kind).toBe('observed'); expect(after.identity).toBe(before.identity); expect((await helper.bind(expected, 'submission')).identity).toBe( after.identity, ); await expect(helper.bind(expected, 'submission')).rejects.toThrow( 'order changed', );
 */
it('keeps submission identity across ready→observed without normalizing other inputs', async () => {
  const before = await helper.bind(expected, 'submission');
  await observeAvalanche();
  const after = await helper.bind(expected, 'submission');
  expect(before.kind).toBe('ready');
  expect(after.kind).toBe('observed');
  expect(after.identity).toBe(before.identity);
  expect((await helper.bind(expected, 'submission')).identity).toBe(
    after.identity,
  );
  vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
    ...fee,
    networkFee: 1n,
  });
  await expect(helper.bind(expected, 'submission')).rejects.toThrow(
    'order changed',
  );
});
/**
 * @target PaymentSubmissionAuthorization.bind 'keeps Ergo submission identity across only the complete authorized spend transition'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'keeps Ergo submission identity across only the complete authorized spend transition' with the suite's captured inputs and invoke the bind path.
 * @expected expect((await helper.bind(expected, 'submission')).identity).toBe( before.identity, );
 */
it('keeps Ergo submission identity across only the complete authorized spend transition', async () => {
  const f = await setupErgo(true, true);
  try {
    const before = await helper.bind(expected, 'submission');
    await observeErgo(f);
    expect((await helper.bind(expected, 'submission')).identity).toBe(
      before.identity,
    );
  } finally {
    f.restore();
  }
});
/**
 * @target PaymentSubmissionAuthorization.bind 'defers observed Avalanche %s through the actual RPC adapter'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers observed Avalanche %s through the actual RPC adapter' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(observedChecks('completion')).rejects.toThrow();
 */
it.each([
  'failed receipt',
  'receipt hash',
  'receipt block',
  'receipt height',
  'receipt index',
  'transaction hash',
  'transaction index',
  'transaction chain',
  'inclusion',
  'canonical block',
  'unsettled',
  'missing receipt',
  'missing block',
  'wrong chain',
  'unsupported finalized',
])(
  'defers observed Avalanche %s through the actual RPC adapter',
  async (fault) => {
    const f = await observeAvalanche();
    await sent();
    if (fault === 'failed receipt') f.receipt.status = 0;
    if (fault === 'receipt hash') f.receipt.hash = '0x' + '99'.repeat(32);
    if (fault === 'receipt block') f.receipt.blockHash = '0x' + '99'.repeat(32);
    if (fault === 'receipt height') f.receipt.blockNumber++;
    if (fault === 'receipt index') f.receipt.index++;
    if (fault === 'transaction hash') f.tx.hash = '0x' + '99'.repeat(32);
    if (fault === 'transaction index') f.tx.index++;
    if (fault === 'transaction chain') f.tx.chainId = 43114n;
    if (fault === 'inclusion') f.block.transactions = [];
    if (fault === 'canonical block')
      vi.mocked(f.rpc.getBlock).mockImplementation(
        async (tag) =>
          (tag === f.block.number
            ? { ...f.block, hash: '0x' + '99'.repeat(32) }
            : tag === f.block.hash
              ? f.block
              : f.frontier) as never,
      );
    if (fault === 'unsettled') f.frontier.number = 299;
    if (fault === 'missing receipt')
      vi.mocked(f.rpc.getTransactionReceipt).mockResolvedValue(null);
    if (fault === 'missing block')
      vi.mocked(f.rpc.getBlock).mockResolvedValue(null);
    if (fault === 'wrong chain')
      vi.mocked(f.rpc.send).mockResolvedValue('0xa86a');
    if (fault === 'unsupported finalized')
      vi.mocked(f.rpc.getBlock).mockRejectedValue(
        new Error('unsupported finalized'),
      );
    await expect(observedChecks('completion')).rejects.toThrow();
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects isolated observed scanner %s'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated observed scanner %s' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(observedChecks('completion')).rejects.toThrow();
 */
it.each([
  'signedHash',
  'unsignedHash',
  'nonce',
  'address',
  'extractor',
  'blockId',
  'duplicate record',
  'missing record',
  'block status',
  'block height',
  'block parent',
  'wrong scanner',
  'missing block',
])('rejects isolated observed scanner %s', async (fault) => {
  const f = await observeAvalanche();
  await sent();
  const records = db().dataSource.getRepository(AddressTxsEntity),
    blocks = db().dataSource.getRepository(BlockEntity);
  if (
    ['signedHash', 'unsignedHash', 'address', 'extractor', 'blockId'].includes(
      fault,
    )
  )
    await records.update(
      { id: f.record.id },
      {
        [fault]:
          fault === 'address'
            ? '0x' + '22'.repeat(20)
            : fault === 'extractor'
              ? 'other'
              : '0x' + '99'.repeat(32),
      },
    );
  if (fault === 'nonce')
    await records.update({ id: f.record.id }, { nonce: 1 });
  if (fault === 'duplicate record') {
    await records.insert({ ...f.record, id: undefined });
  }
  if (fault === 'missing record') await records.clear();
  if (fault === 'block status')
    await blocks.update({ hash: f.block.hash }, { status: 'PROCESSING' });
  if (fault === 'block height')
    await blocks.update({ hash: f.block.hash }, { height: 302 });
  if (fault === 'block parent')
    await blocks.update(
      { hash: f.block.hash },
      { parentHash: '0x' + '99'.repeat(32) },
    );
  if (fault === 'wrong scanner')
    await blocks.update({ hash: f.block.hash }, { scanner: 'other' });
  if (fault === 'missing block') await blocks.clear();
  await expect(observedChecks('completion')).rejects.toThrow();
});
/**
 * @target PaymentSubmissionAuthorization.bind 'defers a different valid ECDSA signature even with identical unsigned body and sender'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers a different valid ECDSA signature even with identical unsigned body and sender' with the suite's captured inputs and invoke the bind path.
 * @expected expect(alternate.from).toBe(f.signed.from); expect(alternate.unsignedSerialized).toBe(f.signed.unsignedSerialized); expect(alternate.hash).not.toBe(f.signed.hash); await expect(observedChecks('completion')).rejects.toThrow( 'differs from signed model', );
 */
it('defers a different valid ECDSA signature even with identical unsigned body and sender', async () => {
  const f = await observeAvalanche();
  await sent();
  const alternate = Transaction.from(f.signed.serialized);
  const signature = secp256k1.sign(
    f.signed.unsignedHash.slice(2),
    privateKey.slice(2),
    { extraEntropy: new Uint8Array(32).fill(7) },
  );
  alternate.signature = {
    r: '0x' + signature.r.toString(16).padStart(64, '0'),
    s: '0x' + signature.s.toString(16).padStart(64, '0'),
    yParity: signature.recovery as 0 | 1,
  };
  expect(alternate.from).toBe(f.signed.from);
  expect(alternate.unsignedSerialized).toBe(f.signed.unsignedSerialized);
  expect(alternate.hash).not.toBe(f.signed.hash);
  await db()
    .dataSource.getRepository(AddressTxsEntity)
    .update({ id: f.record.id }, { signedHash: alternate.hash! });
  await expect(observedChecks('completion')).rejects.toThrow(
    'differs from signed model',
  );
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rechecks Avalanche success at the final confirmation after earlier successful reads'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rechecks Avalanche success at the final confirmation after earlier successful reads' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(observedChecks('completion')).rejects.toThrow('not confirmed'); expect(f.rpc.getTransactionReceipt).toHaveBeenCalledTimes(3);
 */
it('rechecks Avalanche success at the final confirmation after earlier successful reads', async () => {
  const f = await observeAvalanche();
  await sent();
  vi.mocked(f.rpc.getTransactionReceipt)
    .mockResolvedValueOnce(f.receipt as never)
    .mockResolvedValueOnce(f.receipt as never)
    .mockResolvedValue({ ...f.receipt, status: 0 } as never);
  await expect(observedChecks('completion')).rejects.toThrow('not confirmed');
  expect(f.rpc.getTransactionReceipt).toHaveBeenCalledTimes(3);
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects %s drift during observed RPC before owned SQL'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects %s drift during observed RPC before owned SQL' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(observedChecks('completion')).rejects.toThrow();
 */
it.each(['record', 'block', 'fee', 'policy', 'row', 'event', 'commitment'])(
  'rejects %s drift during observed RPC before owned SQL',
  async (fault) => {
    const f = await observeAvalanche();
    await sent();
    vi.mocked(f.rpc.getTransactionReceipt).mockImplementationOnce(async () => {
      if (fault === 'record')
        await db()
          .dataSource.getRepository(AddressTxsEntity)
          .update({ id: f.record.id }, { status: 'changed' });
      if (fault === 'block')
        await db()
          .dataSource.getRepository(BlockEntity)
          .update({ hash: f.block.hash }, { status: 'PROCESSING' });
      if (fault === 'fee')
        vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
          ...fee,
          networkFee: 1n,
        });
      if (fault === 'policy') chain.configs.gasLimitCap = 99999n;
      if (fault === 'row')
        await db().TransactionRepository.update(
          { txId: expected.txId },
          { requiredSign: 4 },
        );
      if (fault === 'event')
        await db().ConfirmedEventRepository.update(
          { id: expected.eventId! },
          { unexpectedFails: 99 },
        );
      if (fault === 'commitment')
        await db().CommitmentRepository.update(
          { eventId: expected.eventId! },
          { rwtCount: '9' },
        );
      return f.receipt as never;
    });
    await expect(observedChecks('completion')).rejects.toThrow();
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects isolated observed Ergo trigger %s'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated observed Ergo trigger %s' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(observedChecks('completion')).rejects.toThrow();
 */
it.each(['spendTxId', 'paymentTxId', 'result', 'spendHeight', 'spendBlock'])(
  'rejects isolated observed Ergo trigger %s',
  async (field) => {
    const f = await setupErgo(true);
    try {
      await observeErgo(f);
      await sent();
      await db().EventRepository.update(
        { eventId: expected.eventId! },
        {
          [field]:
            field === 'spendHeight'
              ? -1
              : field === 'result'
                ? 'fraud'
                : '99'.repeat(32),
        },
      );
      await expect(observedChecks('completion')).rejects.toThrow();
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects isolated observed Ergo additional commitment %s'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated observed Ergo additional commitment %s' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(observedChecks('completion')).rejects.toThrow();
 */
it.each([
  'spendTxId',
  'spendHeight',
  'spendBlock',
  'spendIndex',
  'partial',
  'missing',
  'serialized',
  'WID',
  'rwtCount',
  'commitment',
  'height',
])('rejects isolated observed Ergo additional commitment %s', async (field) => {
  const f = await setupErgo(true);
  try {
    await observeErgo(f);
    await sent();
    const row = await db().CommitmentRepository.findOneByOrFail({
      WID: 'cc'.repeat(32),
    });
    if (field === 'missing')
      await db().CommitmentRepository.delete({ id: row.id });
    else
      await db().CommitmentRepository.update(
        { id: row.id },
        field === 'partial'
          ? { spendBlock: null }
          : {
              [field]:
                field === 'spendIndex'
                  ? 1
                  : field === 'spendHeight'
                    ? -1
                    : field === 'height'
                      ? 999999
                      : field === 'rwtCount'
                        ? '9'
                        : field === 'serialized'
                          ? 'AA=='
                          : '99'.repeat(32),
            },
      );
    await expect(observedChecks('completion')).rejects.toThrow();
  } finally {
    f.restore();
  }
});
/**
 * @target PaymentSubmissionAuthorization.bind 'defers observed Ergo %s'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'defers observed Ergo %s' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(observedChecks('completion')).rejects.toThrow();
 */
it.each([
  'missing block',
  'processing block',
  'wrong scanner',
  'foreign hash',
  'missing raw',
  'different body',
  'lost confirmation',
])('defers observed Ergo %s', async (fault) => {
  const f = await setupErgo(true, true);
  try {
    const o = await observeErgo(f);
    await sent();
    const blocks = db().dataSource.getRepository(BlockEntity);
    if (fault === 'missing block') await blocks.clear();
    if (fault === 'processing block')
      await blocks.update({ hash: o.block.hash }, { status: 'PROCESSING' });
    if (fault === 'wrong scanner')
      await blocks.update({ hash: o.block.hash }, { scanner: 'other' });
    if (fault === 'foreign hash')
      await blocks.update({ hash: o.block.hash }, { hash: '99'.repeat(32) });
    if (fault === 'missing raw')
      o.getTransaction.mockRejectedValue(new Error('pruned'));
    if (fault === 'different body') {
      const t = wasm.Transaction.sigma_parse_bytes(payment.txBytes);
      const json = JSON.parse(t.to_json());
      t.free();
      json.outputs[0].value = String(BigInt(json.outputs[0].value) + 1n);
      json.inputs = json.inputs.map(
        (input: { boxId: string; spendingProof: { extension: object } }) => ({
          boxId: input.boxId,
          extension: input.spendingProof.extension,
        }),
      );
      const unsigned = wasm.UnsignedTransaction.from_json(JSON.stringify(json));
      const changed = wasm.Transaction.from_unsigned_tx(
        unsigned,
        (payment as ErgoTransaction).inputBoxes.map(() => new Uint8Array()),
      );
      o.raw.bytes = Buffer.from(changed.sigma_serialize_bytes()).toString(
        'hex',
      );
      changed.free();
    }
    if (fault === 'lost confirmation')
      o.getTransaction.mockImplementation(async () => {
        f.rawNetwork.getTxConfirmation.mockResolvedValue(0);
        return wasm.Transaction.sigma_parse_bytes(payment.txBytes);
      });
    await expect(observedChecks('completion')).rejects.toThrow();
  } finally {
    f.restore();
  }
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rolls back actual completion after isolated SQL trigger %s drift'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back actual completion after isolated SQL trigger %s drift' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().finalizeTxIfUnchanged(expected, { ...checks, assertActive: () => {}, }), ).rejects.toThrow(); expect(await db().getTxById(expected.txId)).toEqual(row); expect(await db().getEventById(expected.eventId!)).toEqual(event); expect( ( await db() .dataSource.getRepository(AddressTxsEntity) .findOneByOrFail({ id: f.record.id }) ).status, ).toBe('succeed'); expect(notify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
 */
it.each([
  'status',
  'firstTry',
  'event counter',
  'transaction counter',
  'commitment',
  'record',
  'block',
])(
  'rolls back actual completion after isolated SQL trigger %s drift',
  async (fault) => {
    const f = await observeAvalanche();
    await sent();
    const checks = await observedChecks('completion');
    const row = await db().getTxById(expected.txId),
      event = await db().getEventById(expected.eventId!);
    const notify = vi
      .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
      .mockResolvedValue(undefined);
    const eventNotify = vi
      .spyOn(PublicStatusHandler.getInstance(), 'updatePublicEventStatus')
      .mockResolvedValue(undefined);
    const sql =
      fault === 'status'
        ? "UPDATE confirmed_event_entity SET status='in-payment' WHERE id=NEW.id;"
        : fault === 'firstTry'
          ? "UPDATE confirmed_event_entity SET firstTry='different' WHERE id=NEW.id;"
          : fault === 'event counter'
            ? 'UPDATE confirmed_event_entity SET unexpectedFails=unexpectedFails+1 WHERE id=NEW.id;'
            : fault === 'transaction counter'
              ? 'UPDATE transaction_entity SET signFailedCount=signFailedCount+1 WHERE eventId=NEW.id;'
              : fault === 'commitment'
                ? "UPDATE commitment_entity SET rwtCount='999' WHERE eventId=NEW.id;"
                : fault === 'record'
                  ? "UPDATE address_txs_entity SET status='changed';"
                  : "UPDATE block_entity SET status='PROCESSING' WHERE scanner='avalanche';";
    await db().dataSource.query(
      `CREATE TRIGGER observed_payment_drift AFTER UPDATE OF status ON confirmed_event_entity BEGIN ${sql} END`,
    );
    try {
      await expect(
        db().finalizeTxIfUnchanged(expected, {
          ...checks,
          assertActive: () => {},
        }),
      ).rejects.toThrow();
      expect(await db().getTxById(expected.txId)).toEqual(row);
      expect(await db().getEventById(expected.eventId!)).toEqual(event);
      expect(
        (
          await db()
            .dataSource.getRepository(AddressTxsEntity)
            .findOneByOrFail({ id: f.record.id })
        ).status,
      ).toBe('succeed');
      expect(notify).not.toHaveBeenCalled();
      expect(eventNotify).not.toHaveBeenCalled();
    } finally {
      await db().dataSource.query('DROP TRIGGER observed_payment_drift');
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects completion after expiry while waiting for SQL ownership and preserves the row'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects completion after expiry while waiting for SQL ownership and preserves the row' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(result).rejects.toThrow('expired'); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.sent, );
 */
it('rejects completion after expiry while waiting for SQL ownership and preserves the row', async () => {
  await observeAvalanche();
  await sent();
  let live = true;
  const bound = await helper.bind(expected, 'completion');
  const checks = await bound.prepareUnderScannerLease(() => {
    if (!live) throw new Error('expired');
  });
  const runner = db().dataSource.createQueryRunner();
  await runner.startTransaction();
  const result = db().finalizeTxIfUnchanged(expected, {
    ...checks,
    assertActive: () => {
      if (!live) throw new Error('expired');
    },
  });
  live = false;
  await runner.rollbackTransaction();
  await runner.release();
  await expect(result).rejects.toThrow('expired');
  expect((await db().getTxById(expected.txId))!.status).toBe(
    TransactionStatus.sent,
  );
});
/**
 * @target PaymentSubmissionAuthorization.bind 'preserves a concurrent completed winner instead of overwriting it'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'preserves a concurrent completed winner instead of overwriting it' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().finalizeTxIfUnchanged(expected, { ...checks, assertActive: () => {} }), ).resolves.toBe(false); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.completed, );
 */
it('preserves a concurrent completed winner instead of overwriting it', async () => {
  await observeAvalanche();
  await sent();
  const checks = await observedChecks('completion');
  await db().TransactionRepository.update(
    { txId: expected.txId },
    { status: TransactionStatus.completed },
  );
  await expect(
    db().finalizeTxIfUnchanged(expected, { ...checks, assertActive: () => {} }),
  ).resolves.toBe(false);
  expect((await db().getTxById(expected.txId))!.status).toBe(
    TransactionStatus.completed,
  );
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects completion after-preimage %s with the actual DAO'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects completion after-preimage %s with the actual DAO' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().finalizeTxIfUnchanged(expected, { assertActive: () => {}, assertBefore: checks.assertBefore, assertAfter: (manager, row) => checks.assertAfter(manager, { ...row, [field]: value }), }), ).rejects.toThrow('not started for this row'); expect(await db().getTxById(expected.txId)).toEqual(before); expect(await db().getEventById(expected.eventId!)).toEqual(event);
 */
it.each([
  ['status', TransactionStatus.sent],
  ['txJson', '{}'],
  ['chain', 'ergo'],
  ['type', TransactionType.reward],
  ['requiredSign', 4],
  ['eventId', null],
  ['orderId', 'foreign-order'],
  ['txId', 'foreign-transaction'],
] as const)(
  'rejects completion after-preimage %s with the actual DAO',
  async (field, value) => {
    await observeAvalanche();
    await sent();
    const checks = await observedChecks('completion');
    const before = await db().getTxById(expected.txId),
      event = await db().getEventById(expected.eventId!);
    await expect(
      db().finalizeTxIfUnchanged(expected, {
        assertActive: () => {},
        assertBefore: checks.assertBefore,
        assertAfter: (manager, row) =>
          checks.assertAfter(manager, { ...row, [field]: value }),
      }),
    ).rejects.toThrow('not started for this row');
    expect(await db().getTxById(expected.txId)).toEqual(before);
    expect(await db().getEventById(expected.eventId!)).toEqual(event);
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects cross-purpose %s'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects cross-purpose %s' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( purpose === 'submission' ? db().finalizeTxIfUnchanged(expected, authorization) : db().setTxStatusIfUnchanged( expected, TransactionStatus.sent, authorization, ), ).rejects.toThrow(); expect((await db().getTxById(expected.txId))!.status).toBe( TransactionStatus.sent, ); expect((await db().getEventById(expected.eventId!))!.status).toBe( EventStatus.inPayment, );
 */
it.each([
  'submission used for completion',
  'completion used for submission',
] as const)('rejects cross-purpose %s', async (fault) => {
  await observeAvalanche();
  await sent();
  const purpose =
    fault === 'submission used for completion' ? 'submission' : 'completion';
  const checks = await observedChecks(purpose),
    authorization = { ...checks, assertActive: () => {} };
  await expect(
    purpose === 'submission'
      ? db().finalizeTxIfUnchanged(expected, authorization)
      : db().setTxStatusIfUnchanged(
          expected,
          TransactionStatus.sent,
          authorization,
        ),
  ).rejects.toThrow();
  expect((await db().getTxById(expected.txId))!.status).toBe(
    TransactionStatus.sent,
  );
  expect((await db().getEventById(expected.eventId!))!.status).toBe(
    EventStatus.inPayment,
  );
});
/**
 * @target PaymentSubmissionAuthorization.bind 'rolls back Ergo completion after SQL %s drift'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rolls back Ergo completion after SQL %s drift' with the suite's captured inputs and invoke the bind path.
 * @expected await expect( db().finalizeTxIfUnchanged(expected, { ...checks, assertActive: () => {}, }), ).rejects.toThrow(); expect(await db().getTxById(expected.txId)).toEqual(row); expect(await db().getEventById(expected.eventId!)).toEqual(before); expect(notify).not.toHaveBeenCalled();
 */
it.each(['firstTry', 'trigger', 'commitment', 'counter'] as const)(
  'rolls back Ergo completion after SQL %s drift',
  async (fault) => {
    const f = await setupErgo(true);
    try {
      await observeErgo(f);
      await sent();
      const checks = await observedChecks('completion');
      const before = await db().getEventById(expected.eventId!),
        row = await db().getTxById(expected.txId);
      const notify = vi
        .spyOn(PublicStatusHandler.getInstance(), 'updatePublicEventStatus')
        .mockResolvedValue(undefined);
      const sql =
        fault === 'firstTry'
          ? "UPDATE confirmed_event_entity SET firstTry='different' WHERE id=NEW.id;"
          : fault === 'trigger'
            ? "UPDATE event_trigger_entity SET spendBlock='foreign' WHERE eventId=NEW.id;"
            : fault === 'commitment'
              ? 'UPDATE commitment_entity SET spendIndex=99 WHERE eventId=NEW.id;'
              : 'UPDATE confirmed_event_entity SET unexpectedFails=unexpectedFails+1 WHERE id=NEW.id;';
      await db().dataSource.query(
        `CREATE TRIGGER observed_ergo_drift AFTER UPDATE OF status ON confirmed_event_entity BEGIN ${sql} END`,
      );
      try {
        await expect(
          db().finalizeTxIfUnchanged(expected, {
            ...checks,
            assertActive: () => {},
          }),
        ).rejects.toThrow();
        expect(await db().getTxById(expected.txId)).toEqual(row);
        expect(await db().getEventById(expected.eventId!)).toEqual(before);
        expect(notify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER observed_ergo_drift');
      }
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'actual Ergo %s adapter binds observed transaction and block metadata'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'actual Ergo %s adapter binds observed transaction and block metadata' with the suite's captured inputs and invoke the bind path.
 * @expected expect(id).toBe(observation.block.hash); expect(id).toBe( selected === 'node' ? observation.block.hash : expected.txId, ); await expect( db().finalizeTxIfUnchanged(expected, { ...checks, assertActive: () => {}, }), ).resolves.toBe(true); expect(blockRead).toHaveBeenCalledOnce(); expect(transactionRead).toHaveBeenCalled();
 */
it.each(['node', 'explorer'] as const)(
  'actual Ergo %s adapter binds observed transaction and block metadata',
  async (selected) => {
    const f = await setupErgo(true, true);
    try {
      const observation = await observeErgo(f);
      await sent();
      const signed = wasm.Transaction.sigma_parse_bytes(payment.txBytes);
      const json = JSON.parse(signed.to_json());
      signed.free();
      const header = {
        parentId: observation.block.parentHash,
        height: observation.block.height,
      };
      const node = new ErgoNodeNetwork({ nodeBaseUrl: 'http://127.0.0.1:1' });
      const explorer = new ErgoExplorerNetwork({
        explorerBaseUrl: 'http://127.0.0.1:1',
      });
      const blockRead = vi.fn(async (id: string) => {
        expect(id).toBe(observation.block.hash);
        return selected === 'node' ? header : { block: { header } };
      });
      const transactionRead = vi.fn(async (id: string) => {
        expect(id).toBe(
          selected === 'node' ? observation.block.hash : expected.txId,
        );
        return selected === 'node'
          ? { transactions: [json] }
          : { ...json, blockId: observation.block.hash, numConfirmations: 2 };
      });
      Object.assign(node, {
        client: {
          getBlockHeaderById: blockRead,
          getBlockTransactionsById: transactionRead,
          getTxById: vi.fn(async () => ({ numConfirmations: 2 })),
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
      const checks = await observedChecks('completion');
      await expect(
        db().finalizeTxIfUnchanged(expected, {
          ...checks,
          assertActive: () => {},
        }),
      ).resolves.toBe(true);
      expect(blockRead).toHaveBeenCalledOnce();
      expect(transactionRead).toHaveBeenCalled();
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind 'rejects isolated Ergo network block %s mismatch'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run 'rejects isolated Ergo network block %s mismatch' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(observedChecks('completion')).rejects.toThrow( 'block identity mismatch', ); expect(o.getTransaction).not.toHaveBeenCalled();
 */
it.each(['height', 'parentHash', 'hash'] as const)(
  'rejects isolated Ergo network block %s mismatch',
  async (field) => {
    const f = await setupErgo(true);
    try {
      const o = await observeErgo(f);
      await sent();
      o.getBlockInfo.mockResolvedValue({
        hash: o.block.hash,
        height: o.block.height,
        parentHash: o.block.parentHash,
        [field]: field === 'height' ? o.block.height + 1 : '99'.repeat(32),
      });
      await expect(observedChecks('completion')).rejects.toThrow(
        'block identity mismatch',
      );
      expect(o.getTransaction).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  },
);
/**
 * @target PaymentSubmissionAuthorization.bind '%s payment checks unused canonical commitment claiming %s execution'
 * @dependencies Actual PaymentSubmissionAuthorization from verification/paymentSubmissionAuthorization.ts and this suite's explicit scanner, database, codec and transport fixtures.
 * @scenario Run '%s payment checks unused canonical commitment claiming %s execution' with the suite's captured inputs and invoke the bind path.
 * @expected await expect(prepare()).rejects.toThrow( 'Ambiguous additional payment commitments', ); await expect(prepare()).resolves.toHaveProperty('assertBefore');
 */
it.each([
  ['ready', 'own'],
  ['observed', 'own'],
  ['ready', 'foreign'],
  ['observed', 'foreign'],
] as const)(
  '%s payment checks unused canonical commitment claiming %s execution',
  async (mode, spender) => {
    const f = await setupErgo(true);
    try {
      const observation =
        mode === 'observed' ? await observeErgo(f) : undefined;
      if (mode === 'observed') await sent();
      const existing = await db().CommitmentRepository.findOneByOrFail({
        WID: 'cc'.repeat(32),
      });
      const extraWid = 'dd'.repeat(32);
      const value = wasm.BoxValue.from_i64(wasm.I64.from_str('1000000'));
      const address = wasm.Address.from_base58(f.ergo.configs.addresses.lock);
      const contract = wasm.Contract.pay_to_address(address);
      const builder = new wasm.ErgoBoxCandidateBuilder(value, contract, 10);
      const tokenId = wasm.TokenId.from_str('cd'.repeat(32));
      const amount = wasm.TokenAmount.from_i64(wasm.I64.from_str('10'));
      const register = wasm.Constant.from_byte_array(
        Buffer.from(extraWid, 'hex'),
      );
      let identifier: string, serialized: string;
      try {
        builder.add_token(tokenId, amount);
        builder.set_register_value(4, register);
        const candidate = builder.build(),
          txId = wasm.TxId.from_str(existing.txId);
        try {
          const box = wasm.ErgoBox.from_box_candidate(candidate, txId, 19);
          try {
            const id = box.box_id();
            try {
              identifier = id.to_str();
            } finally {
              id.free();
            }
            serialized = Buffer.from(box.sigma_serialize_bytes()).toString(
              'base64',
            );
          } finally {
            box.free();
          }
        } finally {
          candidate.free();
          txId.free();
        }
      } finally {
        builder.free();
        value.free();
        contract.free();
        address.free();
        tokenId.free();
        amount.free();
        register.free();
      }
      const event = (await db().getEventById(expected.eventId!))!;
      await db().CommitmentRepository.insert({
        ...existing,
        id: undefined,
        identifier,
        serialized,
        WID: extraWid,
        commitment: Utils.commitmentFromEvent(
          EventSerializer.fromConfirmedEntity(event),
          extraWid,
        ),
        spendTxId: spender === 'own' ? expected.txId : '99'.repeat(32),
        spendBlock: observation?.block.hash ?? '83'.repeat(32),
        spendHeight: observation?.block.height ?? event.eventData.height + 2,
        spendIndex: 1,
      });
      const prepare = async () =>
        (
          await helper.bind(
            expected,
            mode === 'observed' ? 'completion' : 'submission',
          )
        ).prepareUnderScannerLease(() => {});
      if (spender === 'own')
        await expect(prepare()).rejects.toThrow(
          'Ambiguous additional payment commitments',
        );
      else await expect(prepare()).resolves.toHaveProperty('assertBefore');
    } finally {
      f.restore();
    }
  },
);
