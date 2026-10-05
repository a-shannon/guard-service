import { blake2b } from 'blakejs';
import * as wasm from 'ergo-lib-wasm-nodejs';
import { SigningKey, Transaction } from 'ethers';

import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations,
} from '@rosen-bridge/abstract-scanner';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
  AvalancheSafetyState1790769600000,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  AbstractChain,
  ConfirmationStatus,
  PaymentTransaction,
  TransactionType,
  SigningStatus,
} from '@rosen-chains/abstract-chain';
import {
  AbstractErgoNetwork,
  ErgoChain,
  ErgoTransaction,
} from '@rosen-chains/ergo';

import { DatabaseAction } from '../../src/db/databaseAction';
import EventOrder from '../../src/event/eventOrder';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import { TransactionSigningContext } from '../../src/signing/transactionSigningContext';
import { TssAuthorizationRegistry } from '../../src/signing/tssAuthorizationRegistry';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import { EventStatus, TransactionStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import RewardAuthorization from '../../src/verification/rewardAuthorization';
import TransactionVerifier from '../../src/verification/transactionVerifier';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from '../event/testData';
import ergoFixture from '../synchronization/avalancheSynchronizationTestData';

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
describe('Avalanche reward completion authority', () => {
  const db = () => DatabaseActionMock.testDatabase;
  let scannerDb: DataSource;
  let network: AvalancheRpcNetwork;
  let scanner: AvalancheRpcScanner;
  let payment: PaymentTransaction;
  let reward: ErgoTransaction;
  let eventId: string;
  let context: TransactionSigningContext;
  let authorization: RewardAuthorization;
  const confirmation = vi.fn();
  const wallet = vi.fn(() => 'signed');
  const hold = () =>
    scannerDb
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'test hold' });
  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    scannerDb = await new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [BlockEntity, ExtractorStatusEntity, AvalancheSafetyState],
      migrations: [...migrations.sqlite, AvalancheSafetyState1790769600000],
    }).initialize();
    await scannerDb.runMigrations();
    network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
    vi.spyOn(network, 'getCurrentHeight').mockResolvedValue(2);
    vi.spyOn(network, 'getBlockAtHeight').mockImplementation(
      async (height) => ({
        hash: hash(height),
        height,
        parentHash: hash(height - 1),
        timestamp: 100 + height,
        txCount: 0,
      }),
    );
    vi.spyOn(network, 'getBlockTxs').mockResolvedValue([]);
    scanner = new AvalancheRpcScanner({
      network,
      dataSource: scannerDb,
      sourceId: 'reward-source',
      initialHeight: 0,
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 0,
      },
    });
    await scanner.update();
    const event = mockEventTrigger().event;
    Object.assign(event, {
      fromChain: 'ergo',
      toChain: 'avalanche',
      sourceChainHeight: 1,
      sourceBlockId: hash(1),
      WIDsCount: 1,
      WIDsHash: Buffer.from(
        blake2b(Buffer.from('aa'.repeat(32), 'hex'), undefined, 32),
      ).toString('hex'),
    });
    eventId = EventSerializer.getId(event);
    await DatabaseActionMock.insertEventRecord(
      event,
      EventStatus.inReward,
      undefined,
      1,
      'first',
      event.height,
    );
    await db().EventRepository.update(
      { eventId },
      {
        spendBlock: null,
        spendHeight: null,
        spendTxId: null,
        result: null,
        paymentTxId: null,
      },
    );
    await DatabaseActionMock.insertCommitmentBoxRecord(
      event,
      eventId,
      'YQ==',
      'aa'.repeat(32),
      event.height - 1,
      '1',
      'event-creation-tx-id',
      0,
    );
    const signed = Transaction.from({
      type: 2,
      chainId: 43113,
      nonce: 0,
      to: '0x' + '11'.repeat(20),
      value: 1n,
      gasLimit: 21000n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
    });
    signed.signature = new SigningKey('0x' + '01'.repeat(32)).sign(
      signed.unsignedHash,
    );
    payment = new PaymentTransaction(
      'avalanche',
      signed.unsignedHash,
      eventId,
      Buffer.from(signed.serialized.slice(2), 'hex'),
      TransactionType.payment,
    );
    await DatabaseActionMock.insertTxRecord(
      payment,
      TransactionStatus.completed,
      123,
      'updated',
      false,
      0,
      3,
    );
    reward = new ErgoTransaction(
      'reward-id',
      eventId,
      Buffer.from('abcd', 'hex'),
      TransactionType.reward,
      [],
      [],
    );
    confirmation
      .mockReset()
      .mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    wallet.mockClear();
    const target = {
      getActualTxId: vi.fn().mockResolvedValue(signed.hash),
      getTxConfirmationStatus: confirmation,
      verifyPaymentTransaction: vi.fn().mockResolvedValue(true),
      verifyTransactionExtraConditions: vi.fn().mockReturnValue(true),
      getHeight: vi.fn().mockResolvedValue(100),
      extractTransactionOrder: vi.fn().mockReturnValue([]),
    } as unknown as AbstractChain<unknown>;
    context = new TransactionSigningContext({
      safety: new AvalancheTransactionSafety(
        (id) => db().getEventById(id),
        () => scanner,
      ),
      getTx: (id) => db().getTxById(id),
      decode: (json) => {
        const m = JSON.parse(json);
        if (m.network === 'ergo') return ErgoTransaction.fromJson(json);
        return new PaymentTransaction(
          m.network,
          m.txId,
          m.eventId,
          Buffer.from(m.txBytes, 'hex'),
          m.txType,
        );
      },
      registry: new TssAuthorizationRegistry(1000, 4),
      bindReward: (expected, statuses) =>
        authorization.bindExistingReward(expected, statuses),
    });
    authorization = new RewardAuthorization({
      context,
      getDatabase: db,
      getChain: () => target,
    });
    vi.spyOn(RewardAuthorization, 'getInstance').mockReturnValue(authorization);
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
      getErgoChain: () => target,
      getChain: () => target,
    } as never);
    vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue(
      {} as never,
    );
    vi.spyOn(EventOrder, 'createEventRewardOrder').mockResolvedValue([]);
    vi.spyOn(TransactionVerifier, 'verifyTxCommonConditions').mockResolvedValue(
      true,
    );
    await DatabaseActionMock.insertTxRecord(
      reward,
      TransactionStatus.inSign,
      123,
      'updated',
      false,
      0,
      3,
    );
  });
  afterEach(async () => {
    network['provider'].destroy();
    await scannerDb.destroy();
    vi.restoreAllMocks();
  });

  let ergo: ErgoChain;
  let signedHex: string;
  const rewardConfirmation = vi.fn();
  const blockId = 'bc'.repeat(32);
  beforeEach(async () => {
    const oldId = reward.txId;
    reward = ErgoTransaction.fromJson(JSON.stringify(ergoFixture.payment));
    reward.eventId = eventId;
    reward.txType = TransactionType.reward;
    const unsigned = wasm.ReducedTransaction.sigma_parse_bytes(
      reward.txBytes,
    ).unsigned_tx();
    reward.txBytes = wasm.Transaction.from_unsigned_tx(
      unsigned,
      Array.from({ length: unsigned.inputs().len() }, () => new Uint8Array()),
    ).sigma_serialize_bytes();
    signedHex = Buffer.from(reward.txBytes).toString('hex');
    const tokens = new TokenMap();
    await tokens.updateConfigByJson([]);
    ergo = new ErgoChain(
      {} as AbstractErgoNetwork,
      {
        fee: 1100000n,
        confirmations: {
          observation: 5,
          payment: 9,
          cold: 10,
          manual: 11,
          arbitrary: 12,
        },
        addresses: {
          lock: ergoFixture.lock,
          cold: 'unused',
          permit: ergoFixture.lock,
          fraud: 'unused',
        },
        rwtId:
          'ca0c38b1b9e9c253183cebbf6e2372f816b0e1a579aa423c974d100a8911e0e5',
        minBoxValue: 1000000n,
        eventTxConfirmation: 18,
      },
      tokens,
      {
        isInSign: vi.fn().mockResolvedValue(false),
        sign: vi.fn().mockRejectedValue(new Error('No signing')),
      },
    );
    const target = authorization['dependencies'].getChain('avalanche');
    authorization['dependencies'].getChain = (name) =>
      name === 'ergo' ? (ergo as AbstractChain<unknown>) : target;
    vi.mocked(ChainHandler.getInstance).mockReturnValue({
      getErgoChain: () => ergo,
      getChain: (name: string) => authorization['dependencies'].getChain(name),
    } as never);
    rewardConfirmation
      .mockReset()
      .mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
    vi.spyOn(ergo, 'getTxConfirmationStatus').mockImplementation(
      rewardConfirmation,
    );
    vi.spyOn(ergo, 'getTransaction').mockImplementation(async () => signedHex);
    vi.spyOn(EventOrder, 'eventRewardOrder').mockReturnValue({
      watchersOrder: ergo.extractTransactionOrder(reward, SigningStatus.Signed),
      guardsOrder: [],
    });
    const trigger = wasm.ErgoBox.sigma_parse_bytes(reward.inputBoxes[0]);
    const paymentHash = await target.getActualTxId(payment.txId);
    await db().EventRepository.update(
      { eventId },
      {
        identifier: trigger.box_id().to_str(),
        serialized: Buffer.from(reward.inputBoxes[0]).toString('base64'),
        result: 'successful',
        spendTxId: reward.txId,
        paymentTxId: paymentHash,
        spendBlock: blockId,
        spendHeight: 1000000,
      },
    );
    const event = (await db().getEventById(eventId))!;
    await db().CommitmentRepository.update(
      { eventId },
      {
        spendBlock: event.eventData.block,
        spendHeight: event.eventData.height,
      },
    );
    await db().BlockRepository.insert({
      scanner: 'ergo',
      height: 1000000,
      hash: blockId,
      parentHash: 'bd'.repeat(32),
      status: 'PROCEED',
      timestamp: 1,
    });
    await db().TransactionRepository.delete({ txId: oldId });
    await DatabaseActionMock.insertTxRecord(
      reward,
      TransactionStatus.sent,
      123,
      'updated',
      false,
      0,
      3,
    );
    vi.spyOn(DatabaseAction, 'getInstance').mockReturnValue(db());
  });
  const bind = async () =>
    context.bind((await db().getTxById(reward.txId))!, [
      TransactionStatus.sent,
    ]);
  const complete = async (bound?: Awaited<ReturnType<typeof bind>>) => {
    bound ??= await bind();
    return bound.withPersistence('completion', (expected, permit) =>
      db().finalizeTxIfUnchanged(expected, permit),
    );
  };
  const replaceSigned = async (body: unknown) => {
    const oldId = reward.txId;
    const unsigned = wasm.UnsignedTransaction.from_json(JSON.stringify(body));
    const signed = wasm.Transaction.from_unsigned_tx(
      unsigned,
      Array.from({ length: unsigned.inputs().len() }, () => new Uint8Array()),
    );
    reward.txBytes = signed.sigma_serialize_bytes();
    reward.txId = signed.id().to_str();
    signedHex = Buffer.from(reward.txBytes).toString('hex');
    await db().TransactionRepository.update(
      { txId: oldId },
      { txId: reward.txId, txJson: reward.toJson() },
    );
    await db().EventRepository.update({ eventId }, { spendTxId: reward.txId });
  };
  /**
   * @target TransactionSigningContext.bind 'reconstructs outputs through the real pure reward order function'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'reconstructs outputs through the real pure reward order function' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete()).resolves.toBe(true);
   */
  it('reconstructs outputs through the real pure reward order function', async () => {
    vi.mocked(EventOrder.eventRewardOrder).mockRestore();
    vi.spyOn(TokenHandler, 'getInstance').mockReturnValue({
      getTokenMap: () => ({
        search: () => [{}],
        getID: () => 'erg',
        wrapAmount: (_id: string, amount: bigint) => ({ amount }),
      }),
    } as never);
    const fee = {
      bridgeFee: 0n,
      networkFee: 0n,
      feeRatio: 0n,
      feeRatioDivisor: 10000n,
      rsnRatio: 0n,
      rsnRatioDivisor: 10000n,
    };
    vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue(fee);
    const event = (await db().getEventById(eventId))!;
    const triggerHex = Buffer.from(reward.inputBoxes[0]).toString('hex');
    const wanted = EventOrder.eventRewardOrder(
      EventSerializer.fromConfirmedEntity(event),
      [],
      fee,
      event.eventData.paymentTxId!,
      ergo.getRWTToken(),
      ergo.getBoxRWT(triggerHex),
      ergo.getSerializedBoxInfo(triggerHex).assets.nativeToken,
      ['aa'.repeat(32)],
    );
    const body = JSON.parse(
      wasm.ReducedTransaction.sigma_parse_bytes(
        Buffer.from(ergoFixture.payment.txBytes, 'hex'),
      )
        .unsigned_tx()
        .to_json(),
    );
    body.outputs = [...wanted.watchersOrder, ...wanted.guardsOrder].map(
      (out) => ({
        value: Number(out.assets.nativeToken),
        assets: out.assets.tokens.map((token) => ({
          tokenId: token.id,
          amount: Number(token.value),
        })),
        ergoTree: wasm.Address.from_base58(out.address)
          .to_ergo_tree()
          .to_base16_bytes(),
        creationHeight: 1000000,
        additionalRegisters:
          out.extra === undefined
            ? {}
            : {
                R4: wasm.Constant.from_byte_array(
                  Buffer.from(out.extra, 'hex'),
                ).encode_to_base16(),
              },
      }),
    );
    await replaceSigned(body);
    await expect(complete()).resolves.toBe(true);
  });
  /**
   * @target TransactionSigningContext.bind 'binds additional spent commitment %s to its exact signed input'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'binds additional spent commitment %s to its exact signed input' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete()).resolves.toBe(true); expect( vi.mocked(EventOrder.eventRewardOrder).mock.calls.at(-1)![1], ).toEqual([{ wid, boxValue: 1000000n }]); await expect(complete()).rejects.toThrow();
   */
  it.each([
    'none',
    'spendTxId',
    'spendBlock',
    'spendHeight',
    'spendIndex',
    'serialized',
    'WID',
    'commitment',
    'rwtCount',
    'tokenAmount',
    'tokenId',
    'height',
  ])(
    'binds additional spent commitment %s to its exact signed input',
    async (fault) => {
      const wid = 'cc'.repeat(32);
      const builder = new wasm.ErgoBoxCandidateBuilder(
        wasm.BoxValue.from_i64(wasm.I64.from_str('1000000')),
        wasm.Contract.pay_to_address(
          wasm.Address.from_base58(ergoFixture.lock),
        ),
        10,
      );
      const triggerToken = wasm.ErgoBox.sigma_parse_bytes(reward.inputBoxes[0])
        .tokens()
        .get(0);
      builder.add_token(
        fault === 'tokenId'
          ? wasm.TokenId.from_str('dd'.repeat(32))
          : triggerToken.id(),
        fault === 'tokenAmount'
          ? wasm.TokenAmount.from_i64(wasm.I64.from_str('999999'))
          : triggerToken.amount(),
      );
      builder.set_register_value(
        4,
        wasm.Constant.from_byte_array(Buffer.from(wid, 'hex')),
      );
      const extra = wasm.ErgoBox.from_box_candidate(
        builder.build(),
        wasm.TxId.from_str('ee'.repeat(32)),
        0,
      );
      const body = JSON.parse(
        wasm.ReducedTransaction.sigma_parse_bytes(
          Buffer.from(ergoFixture.payment.txBytes, 'hex'),
        )
          .unsigned_tx()
          .to_json(),
      );
      body.inputs.push({ boxId: extra.box_id().to_str(), extension: {} });
      reward.inputBoxes.push(extra.sigma_serialize_bytes());
      await replaceSigned(body);
      const event = (await db().getEventById(eventId))!;
      const rwt = ergo.getBoxRWT(
        Buffer.from(reward.inputBoxes[0]).toString('hex'),
      );
      const row = {
        eventId,
        identifier: extra.box_id().to_str(),
        serialized: Buffer.from(extra.sigma_serialize_bytes()).toString(
          'base64',
        ),
        extractor: 'ergoCommitment',
        block: '11'.repeat(32),
        height: 10,
        txId: 'ee'.repeat(32),
        WID: wid,
        commitment: Utils.commitmentFromEvent(
          EventSerializer.fromConfirmedEntity(event),
          wid,
        ),
        rwtCount: String(rwt),
        spendTxId: reward.txId,
        spendBlock: blockId,
        spendHeight: 1000000,
        spendIndex: 1,
      };
      const patches = {
        spendTxId: 'other',
        spendBlock: 'aa'.repeat(32),
        spendHeight: 999999,
        spendIndex: 0,
        serialized: event.eventData.serialized,
        WID: 'aa'.repeat(32),
        commitment: 'wrong',
        rwtCount: '999999',
        height: event.eventData.height,
      };
      if (fault in patches)
        Object.assign(row, { [fault]: patches[fault as keyof typeof patches] });
      await db().CommitmentRepository.insert(row);
      if (fault === 'none') {
        await expect(complete()).resolves.toBe(true);
        expect(
          vi.mocked(EventOrder.eventRewardOrder).mock.calls.at(-1)![1],
        ).toEqual([{ wid, boxValue: 1000000n }]);
      } else await expect(complete()).rejects.toThrow();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rolls back both records and sends no notifications after %s SQL interference'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rolls back both records and sends no notifications after %s SQL interference' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete()).resolves.toBe(false); await expect(complete()).rejects.toThrow(); expect(await db().getTxById(reward.txId)).toEqual(beforeTx); expect(await db().getEventById(eventId)).toEqual(beforeEvent); expect(txNotify).not.toHaveBeenCalled(); expect(eventNotify).not.toHaveBeenCalled();
   */
  it.each(['transaction', 'event', 'payment', 'ABORT', 'IGNORE'])(
    'rolls back both records and sends no notifications after %s SQL interference',
    async (fault) => {
      const beforeTx = await db().getTxById(reward.txId);
      const beforeEvent = await db().getEventById(eventId);
      const txNotify = vi.spyOn(
        PublicStatusHandler.getInstance(),
        'updatePublicTxStatus',
      );
      const eventNotify = vi.spyOn(
        PublicStatusHandler.getInstance(),
        'updatePublicEventStatus',
      );
      const statements: Record<string, string> = {
        transaction:
          "UPDATE transaction_entity SET txJson = '{}' WHERE type = 'reward';",
        event:
          'UPDATE confirmed_event_entity SET unexpectedFails = 99 WHERE id = NEW.id;',
        payment:
          "UPDATE transaction_entity SET requiredSign = 99 WHERE type = 'payment';",
        ABORT: "SELECT RAISE(ABORT, 'blocked');",
        IGNORE: 'SELECT RAISE(IGNORE);',
      };
      await db().dataSource.query(
        'CREATE TEMP TRIGGER completion_fault ' +
          (fault === 'IGNORE' ? 'BEFORE' : 'AFTER') +
          ' UPDATE ON confirmed_event_entity BEGIN ' +
          statements[fault] +
          ' END',
      );
      try {
        if (fault === 'IGNORE') await expect(complete()).resolves.toBe(false);
        else await expect(complete()).rejects.toThrow();
        expect(await db().getTxById(reward.txId)).toEqual(beforeTx);
        expect(await db().getEventById(eventId)).toEqual(beforeEvent);
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
      } finally {
        await db().dataSource.query('DROP TRIGGER completion_fault');
      }
    },
  );
  /**
   * @target TransactionProcessor.processSentTx 'completes through the actual processor with strict signed inputs and a recorded successful spend'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'completes through the actual processor with strict signed inputs and a recorded successful spend' through TransactionProcessor.processSentTx.
   * @expected expect((await db().getTxById(reward.txId))!.status).toBe( TransactionStatus.completed, ); expect((await db().getEventById(eventId))!.status).toBe( EventStatus.completed, ); expect(EventOrder.eventRewardOrder).toHaveBeenCalled();
   */
  it('completes through the actual processor with strict signed inputs and a recorded successful spend', async () => {
    TransactionProcessor.initSigning(context, {
      timeoutMs: 1000,
      maxPending: 4,
    });
    await TransactionProcessor.processSentTx(
      (await db().getTxById(reward.txId))!,
    );
    expect((await db().getTxById(reward.txId))!.status).toBe(
      TransactionStatus.completed,
    );
    expect((await db().getEventById(eventId))!.status).toBe(
      EventStatus.completed,
    );
    expect(EventOrder.eventRewardOrder).toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'rejects isolated trigger %s corruption'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects isolated trigger %s corruption' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete()).rejects.toThrow(); expect((await db().getTxById(reward.txId))!.status).toBe( TransactionStatus.sent, );
   */
  it.each([
    'result',
    'spendTxId',
    'paymentTxId',
    'spendHeight',
    'spendBlock',
    'serialized',
    'identifier',
  ])('rejects isolated trigger %s corruption', async (field) => {
    const patches = {
      result: 'fraud',
      spendTxId: 'other',
      paymentTxId: 'other',
      spendHeight: 999999,
      spendBlock: 'ab'.repeat(32),
      serialized: 'YQ==',
      identifier: 'aa'.repeat(32),
    };
    await db().EventRepository.update(
      { eventId },
      { [field]: patches[field as keyof typeof patches] },
    );
    await expect(complete()).rejects.toThrow();
    expect((await db().getTxById(reward.txId))!.status).toBe(
      TransactionStatus.sent,
    );
  });
  /**
   * @target TransactionSigningContext.bind 'rejects %s Ergo block provenance'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s Ergo block provenance' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete()).rejects.toThrow();
   */
  it.each(['missing', 'processing', 'wrong-scanner', 'wrong-hash'])(
    'rejects %s Ergo block provenance',
    async (fault) => {
      if (fault === 'missing')
        await db().BlockRepository.delete({ scanner: 'ergo' });
      if (fault === 'processing')
        await db().BlockRepository.update(
          { scanner: 'ergo' },
          { status: 'PROCESSING' },
        );
      if (fault === 'wrong-scanner')
        await db().BlockRepository.update(
          { scanner: 'ergo' },
          { scanner: 'other' },
        );
      if (fault === 'wrong-hash')
        await db().BlockRepository.update(
          { scanner: 'ergo' },
          { hash: 'aa'.repeat(32) },
        );
      await expect(complete()).rejects.toThrow();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects %s signed model inconsistency'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects %s signed model inconsistency' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete()).rejects.toThrow();
   */
  it.each(['reduced', 'txId', 'inputBoxes', 'dataInputs'])(
    'rejects %s signed model inconsistency',
    async (fault) => {
      if (fault === 'reduced')
        reward.txBytes = Buffer.from(ergoFixture.payment.txBytes, 'hex');
      if (fault === 'txId') reward.txId = '00'.repeat(32);
      if (fault === 'inputBoxes')
        reward.inputBoxes[0] = Buffer.from('abcd', 'hex');
      if (fault === 'dataInputs') reward.dataInputs.push(reward.inputBoxes[0]);
      await db().TransactionRepository.update(
        { type: TransactionType.reward },
        { txJson: reward.toJson() },
      );
      await expect(complete()).rejects.toThrow();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'defers completion on %s qualification loss'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'defers completion on %s qualification loss' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete()).rejects.toThrow(); expect((await db().getEventById(eventId))!.status).toBe( EventStatus.inReward, );
   */
  it.each(['hold', 'payment', 'reward', 'late-reward'])(
    'defers completion on %s qualification loss',
    async (fault) => {
      if (fault === 'hold') await hold();
      if (fault === 'payment')
        confirmation.mockResolvedValue(ConfirmationStatus.NotFound);
      if (fault === 'reward')
        rewardConfirmation.mockResolvedValue(ConfirmationStatus.NotFound);
      if (fault === 'late-reward')
        confirmation.mockImplementation(async () => {
          rewardConfirmation.mockResolvedValue(ConfirmationStatus.NotFound);
          return ConfirmationStatus.ConfirmedEnough;
        });
      await expect(complete()).rejects.toThrow();
      expect((await db().getEventById(eventId))!.status).toBe(
        EventStatus.inReward,
      );
    },
  );
  /**
   * @target TransactionSigningContext.bind 'does not use the unspent commitment query to reconstruct a mined reward'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not use the unspent commitment query to reconstruct a mined reward' with the suite's captured inputs and invoke the bind path.
   * @expected expect(unspent).not.toHaveBeenCalled();
   */
  it('does not use the unspent commitment query to reconstruct a mined reward', async () => {
    const unspent = vi
      .spyOn(db(), 'getValidCommitments')
      .mockRejectedValue(new Error('unspent query forbidden'));
    await complete();
    expect(unspent).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionSigningContext.bind 'requires the source observation for Avalanche to %s completion'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'requires the source observation for Avalanche to %s completion' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete()).resolves.toBe(true); expect(observed).toHaveBeenCalled();
   */
  it.each(['ethereum', 'avalanche'])(
    'requires the source observation for Avalanche to %s completion',
    async (destination) => {
      const target = authorization['dependencies'].getChain('avalanche');
      Object.assign(target, { getRWTToken: () => ergo.getRWTToken() });
      await db().EventRepository.update(
        { eventId },
        {
          fromChain: 'avalanche',
          toChain: destination,
          extractor: 'avalancheEventTrigger',
        },
      );
      if (destination === 'ethereum') {
        const tx = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        tx.chainId = 1n;
        tx.signature = new SigningKey('0x' + '01'.repeat(32)).sign(
          tx.unsignedHash,
        );
        const next = new PaymentTransaction(
          'ethereum',
          tx.unsignedHash,
          eventId,
          Buffer.from(tx.serialized.slice(2), 'hex'),
          TransactionType.payment,
        );
        await db().TransactionRepository.update(
          { txId: payment.txId },
          { txId: next.txId, txJson: next.toJson(), chain: 'ethereum' },
        );
        payment = next;
        vi.mocked(target.getActualTxId).mockResolvedValue(tx.hash!);
        await db().EventRepository.update(
          { eventId },
          { paymentTxId: tx.hash! },
        );
      }
      const observed = vi.spyOn(scanner, 'withObservation');
      await expect(complete()).resolves.toBe(true);
      expect(observed).toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rejects pinned %s authority drift before completion'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects pinned %s authority drift before completion' with the suite's captured inputs and invoke the bind path.
   * @expected await expect(complete(bound)).rejects.toThrow();
   */
  it.each(['payment', 'trigger', 'commitment', 'fee'])(
    'rejects pinned %s authority drift before completion',
    async (fault) => {
      const bound = await bind();
      await bound.prepareSigningAuthorization();
      if (fault === 'payment')
        await db().TransactionRepository.update(
          { txId: payment.txId },
          { requiredSign: 9 },
        );
      if (fault === 'trigger')
        await db().EventRepository.update(
          { eventId },
          { spendBlock: 'aa'.repeat(32) },
        );
      if (fault === 'commitment')
        await db().CommitmentRepository.update({ eventId }, { spendIndex: 99 });
      if (fault === 'fee')
        vi.mocked(MinimumFeeHandler.getEventFeeConfig).mockReturnValue({
          drift: true,
        } as never);
      await expect(complete(bound)).rejects.toThrow();
    },
  );
  /**
   * @target TransactionSigningContext.bind 'rechecks a payment mutation committed by a foreign SQL owner after RPC qualification'
   * @dependencies Actual TransactionSigningContext from signing/transactionSigningContext.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rechecks a payment mutation committed by a foreign SQL owner after RPC qualification' with the suite's captured inputs and invoke the bind path.
   * @expected await expect( bound.withPersistence('completion', async (expected, permit) => { let release!: () => void; let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; }); const wait = new Promise<void>((resolve) => { release = resolve; }); const owner = db().dataSource.transaction(async (manager) => { await manager.query( 'UPDATE transaction_entity SET requiredSign = 8 WHERE txId = ?', [payment.txId], ); entered(); await wait; }); await ready; const write = db().finalizeTxIfUnchanged(expected, permit); release(); await owner; return write; }), ).rejects.toThrow(); expect((await db().getTxById(reward.txId))!.status).toBe( TransactionStatus.sent, ); expect((await db().getTxById(payment.txId))!.requiredSign).toBe(8);
   */
  it('rechecks a payment mutation committed by a foreign SQL owner after RPC qualification', async () => {
    const bound = await bind();
    await expect(
      bound.withPersistence('completion', async (expected, permit) => {
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        const owner = db().dataSource.transaction(async (manager) => {
          await manager.query(
            'UPDATE transaction_entity SET requiredSign = 8 WHERE txId = ?',
            [payment.txId],
          );
          entered();
          await wait;
        });
        await ready;
        const write = db().finalizeTxIfUnchanged(expected, permit);
        release();
        await owner;
        return write;
      }),
    ).rejects.toThrow();
    expect((await db().getTxById(reward.txId))!.status).toBe(
      TransactionStatus.sent,
    );
    expect((await db().getTxById(payment.txId))!.requiredSign).toBe(8);
  });
  /**
   * @target TransactionProcessor.processSignFailedTx 'refuses sign-failed observed recovery without replacing reduced bytes explicitly'
   * @dependencies Actual TransactionProcessor sources and the suite's explicit database, scanner, codec and transport fixtures.
   * @scenario Run 'refuses sign-failed observed recovery without replacing reduced bytes explicitly' through TransactionProcessor.processSignFailedTx.
   * @expected await expect( TransactionProcessor.processSignFailedTx( (await db().getTxById(reward.txId))!, ), ).rejects.toThrow(); expect((await db().getTxById(reward.txId))!.status).toBe( TransactionStatus.signFailed, );
   */
  it('refuses sign-failed observed recovery without replacing reduced bytes explicitly', async () => {
    reward.txBytes = Buffer.from(ergoFixture.payment.txBytes, 'hex');
    await db().TransactionRepository.update(
      { txId: reward.txId },
      { txJson: reward.toJson(), status: TransactionStatus.signFailed },
    );
    TransactionProcessor.initSigning(context, {
      timeoutMs: 1000,
      maxPending: 4,
    });
    await expect(
      TransactionProcessor.processSignFailedTx(
        (await db().getTxById(reward.txId))!,
      ),
    ).rejects.toThrow();
    expect((await db().getTxById(reward.txId))!.status).toBe(
      TransactionStatus.signFailed,
    );
  });
});
