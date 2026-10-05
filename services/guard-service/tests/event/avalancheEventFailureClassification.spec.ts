import { Signature, Transaction } from 'ethers';

import {
  AvalancheRpcNetwork as ScannerNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
} from '@rosen-bridge/evm-scanner';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  ConfirmationStatus,
  FailedError,
  TransactionType,
  UnexpectedApiError,
} from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import {
  AVALANCHE_TX_EXTRACTOR,
  AvalancheRpcNetwork,
} from '@rosen-chains/avalanche-rpc';

import Configs from '../../src/configs/configs';
import EventBoxes from '../../src/event/eventBoxes';
import EventProcessor from '../../src/event/eventProcessor';
import ChainHandler from '../../src/handlers/chainHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import { EventStatus } from '../../src/utils/constants';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from './testData';

const getAvalancheScanner = vi.hoisted(() => vi.fn());
vi.mock('../../src/jobs/initScanner', () => ({ getAvalancheScanner }));

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
const address = '0x' + '11'.repeat(20);

// Real chain, adapter, verifier, processor and SQLite. Only RPC responses,
// decoded lock data and the independent Ergo box/RWT checks are synthetic.
const setup = async () => {
  const transaction = Transaction.from({
    type: 2,
    chainId: 43113n,
    to: address,
    nonce: 0,
    value: 50000000000n,
    data: '0xabcd',
    gasLimit: 30000n,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 2n,
    signature: Signature.from({ r: hash(1), s: hash(2), yParity: 0 }),
  });
  const event = {
    ...mockEventTrigger().event,
    fromChain: 'avalanche',
    toChain: 'ergo',
    sourceTxId: transaction.hash!,
    sourceBlockId: hash(1),
    sourceChainHeight: 1,
  };
  const tx = {
    ...transaction.toJSON(),
    chainId: transaction.chainId,
    signature: transaction.signature,
    hash: transaction.hash!,
    blockHash: hash(1),
    blockNumber: 1,
    index: 0,
  };
  const block = {
    hash: hash(1),
    parentHash: hash(0),
    number: 1,
    timestamp: 101,
    transactions: [tx.hash],
  };
  const frontier = {
    ...block,
    hash: hash(2),
    parentHash: hash(1),
    number: 2,
    transactions: [],
  };
  const receipt = {
    hash: tx.hash,
    blockHash: block.hash,
    blockNumber: 1,
    index: 0,
    status: 1,
  };
  const network = new AvalancheRpcNetwork(
    'http://127.0.0.1:1',
    DatabaseActionMock.testDataSource,
    address,
    43113n,
    AVALANCHE_TX_EXTRACTOR,
    1000,
  );
  network['provider'].destroy();
  const rpc = {
    send: vi.fn(async (method: string) => {
      if (method === 'eth_chainId') return '0xa869';
      throw new Error(`Unexpected synthetic RPC: ${method}`);
    }),
    getBlock: vi.fn(async (tag: string | number) => {
      if (tag === 'finalized' || tag === 2) return frontier;
      if (tag === block.hash || tag === 1) return block;
      throw new Error(`Unexpected synthetic block: ${tag}`);
    }),
    getTransaction: vi.fn(async () => tx),
    getTransactionReceipt: vi.fn<() => Promise<typeof receipt | null>>(
      async () => receipt,
    ),
  };
  Object.defineProperty(network, 'provider', { value: rpc });
  const chain = new AvalancheChain(
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
      gasPriceSlippage: 0n,
      gasLimitSlippage: 0n,
      gasLimitMultiplier: 1n,
      gasLimitCap: 100000n,
    },
    new TokenMap(),
    { sign: vi.fn(), isInSign: vi.fn() },
  );
  const confirmation = vi.spyOn(chain, 'getTxConfirmationStatus');
  const lockConditions = vi
    .spyOn(chain, 'verifyLockTransactionExtraConditions')
    .mockResolvedValue(true);
  const decoded = vi
    .spyOn(chain.extractor!, 'get')
    .mockReturnValue({ ...event, rawData: '' });
  const ergo = {
    getHeight: vi.fn(async () => 100000),
    verifyEventRWT: vi.fn(() => true),
  };
  vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
    getChain: () => chain,
    getErgoChain: () => ergo,
  } as unknown as ChainHandler);
  vi.spyOn(EventBoxes, 'getEventBox').mockResolvedValue(
    {} as Awaited<ReturnType<typeof EventBoxes.getEventBox>>,
  );
  vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue({
    bridgeFee: 0n,
    networkFee: 0n,
    rsnRatio: 0n,
    feeRatio: 0n,
    rsnRatioDivisor: 1000000000000n,
    feeRatioDivisor: 10000n,
  });
  await DatabaseActionMock.insertOnlyEventDataRecord(event);
  return {
    event,
    network,
    rpc,
    receipt,
    chain,
    confirmation,
    decoded,
    lockConditions,
  };
};

const expectRetryable = async () => {
  expect(await DatabaseActionMock.allRawEventRecords()).toHaveLength(1);
  expect(
    await DatabaseActionMock.testDatabase.getUnconfirmedEvents(),
  ).toHaveLength(1);
  expect(await DatabaseActionMock.allEventRecords()).toHaveLength(0);
  expect(await DatabaseActionMock.allRejectedEventRecords()).toHaveLength(0);
};

const expectConfirmed = async () => {
  expect(await DatabaseActionMock.allEventRecords()).toEqual([
    expect.objectContaining({ status: EventStatus.pendingPayment }),
  ]);
  expect(await DatabaseActionMock.allRejectedEventRecords()).toHaveLength(0);
  expect(
    await DatabaseActionMock.testDatabase.getUnconfirmedEvents(),
  ).toHaveLength(0);
};

describe('Avalanche event failure classification', () => {
  let scannerNetwork: ScannerNetwork;
  let scanner: AvalancheRpcScanner;

  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    getAvalancheScanner.mockReset();
    scannerNetwork = new ScannerNetwork('http://127.0.0.1:1', 43113n);
    vi.spyOn(scannerNetwork, 'getCurrentHeight').mockResolvedValue(2);
    vi.spyOn(scannerNetwork, 'getBlockAtHeight').mockImplementation(
      async (height) => ({
        hash: hash(height),
        height,
        parentHash: hash(height - 1),
        timestamp: 100 + height,
        txCount: 0,
      }),
    );
    vi.spyOn(scannerNetwork, 'getBlockTxs').mockResolvedValue([]);
    scanner = new AvalancheRpcScanner({
      network: scannerNetwork,
      dataSource: DatabaseActionMock.testDataSource,
      sourceId: 'event-classification-fixture',
      initialHeight: 0,
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 0,
      },
    });
    await scanner.update();
    getAvalancheScanner.mockReturnValue(scanner);
  });
  afterEach(() => {
    scannerNetwork['provider'].destroy();
    vi.restoreAllMocks();
  });

  /**
   * @target EventProcessor.processScannedEvents 'keeps %s retryable after successful initial confirmation, then recovers'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps %s retryable after successful initial confirmation, then recovers' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(status).toBe(ConfirmationStatus.ConfirmedEnough); expect(confirmation).toHaveBeenCalledWith( f.event.sourceTxId, TransactionType.lock, ); await expect(confirmation.mock.results[0].value).resolves.toBe( ConfirmationStatus.ConfirmedEnough, ); await expect( f.network.getTransaction(f.event.sourceTxId, f.event.sourceBlockId), ).rejects.toBeInstanceOf(UnexpectedApiError); await expect( f.network.getTransaction(f.event.sourceTxId, f.event.sourceBlockId), ).rejects.toBeInstanceOf(FailedError);
   */
  it.each([
    'missing receipt',
    'reverted execution',
    'transport failure',
  ] as const)(
    'keeps %s retryable after successful initial confirmation, then recovers',
    async (failure) => {
      const f = await setup();
      // Delegate initial confirmation to the real adapter, then change only
      // the later verification response to reproduce the asynchronous gap.
      f.confirmation.mockRestore();
      const realConfirmation = f.chain.getTxConfirmationStatus;
      const confirmation = vi
        .spyOn(f.chain, 'getTxConfirmationStatus')
        .mockImplementation(async (...args) => {
          const status = await realConfirmation(...args);
          expect(status).toBe(ConfirmationStatus.ConfirmedEnough);
          if (failure === 'missing receipt')
            f.rpc.getTransactionReceipt.mockResolvedValue(null);
          else if (failure === 'reverted execution') f.receipt.status = 0;
          else
            f.rpc.getTransactionReceipt.mockRejectedValue(
              new Error('synthetic RPC timeout'),
            );
          return status;
        });
      await EventProcessor.processScannedEvents();
      expect(confirmation).toHaveBeenCalledWith(
        f.event.sourceTxId,
        TransactionType.lock,
      );
      await expect(confirmation.mock.results[0].value).resolves.toBe(
        ConfirmationStatus.ConfirmedEnough,
      );
      await expectRetryable();
      if (failure === 'missing receipt')
        await expect(
          f.network.getTransaction(f.event.sourceTxId, f.event.sourceBlockId),
        ).rejects.toBeInstanceOf(UnexpectedApiError);
      else if (failure === 'reverted execution')
        await expect(
          f.network.getTransaction(f.event.sourceTxId, f.event.sourceBlockId),
        ).rejects.toBeInstanceOf(FailedError);
      f.receipt.status = 1;
      f.rpc.getTransactionReceipt.mockResolvedValue(f.receipt);
      confirmation.mockRestore();
      await EventProcessor.processScannedEvents();
      await expectConfirmed();
    },
  );

  /**
   * @target EventProcessor.processScannedEvents 'rejects an independently mismatched protocol amount'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'rejects an independently mismatched protocol amount' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected await expect(f.confirmation.mock.results[0].value).resolves.toBe( ConfirmationStatus.ConfirmedEnough, ); expect(f.lockConditions).toHaveBeenCalled(); expect(await DatabaseActionMock.allEventRecords()).toHaveLength(0); expect(await DatabaseActionMock.allRejectedEventRecords()).toEqual([ expect.objectContaining({ reason: 'unknown' }), ]); expect( await DatabaseActionMock.testDatabase.getUnconfirmedEvents(), ).toHaveLength(0);
   */
  it('rejects an independently mismatched protocol amount', async () => {
    const f = await setup();
    f.decoded.mockReturnValue({
      ...f.event,
      amount: '49999999999',
      rawData: '',
    });
    await EventProcessor.processScannedEvents();
    await expect(f.confirmation.mock.results[0].value).resolves.toBe(
      ConfirmationStatus.ConfirmedEnough,
    );
    expect(f.lockConditions).toHaveBeenCalled();
    expect(await DatabaseActionMock.allEventRecords()).toHaveLength(0);
    expect(await DatabaseActionMock.allRejectedEventRecords()).toEqual([
      expect.objectContaining({ reason: 'unknown' }),
    ]);
    expect(
      await DatabaseActionMock.testDatabase.getUnconfirmedEvents(),
    ).toHaveLength(0);
  });

  /**
   * @target EventProcessor.processScannedEvents 'retries insufficient source confirmation without rejecting the trigger'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'retries insufficient source confirmation without rejecting the trigger' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(f.decoded).not.toHaveBeenCalled(); await expect(f.confirmation.mock.results[0].value).resolves.toBe( ConfirmationStatus.NotConfirmedEnough, );
   */
  it('retries insufficient source confirmation without rejecting the trigger', async () => {
    const f = await setup();
    f.chain.configs.confirmations.observation = 3;
    await EventProcessor.processScannedEvents();
    await expectRetryable();
    expect(f.decoded).not.toHaveBeenCalled();
    await expect(f.confirmation.mock.results[0].value).resolves.toBe(
      ConfirmationStatus.NotConfirmedEnough,
    );
    f.chain.configs.confirmations.observation = 1;
    await EventProcessor.processScannedEvents();
    await expectConfirmed();
  });

  /**
   * @target EventProcessor.processScannedEvents 'keeps admission retryable under a scanner hold and times out only after later admission'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps admission retryable under a scanner hold and times out only after later admission' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected await expect(scanner.assertUsable()).resolves.toBeUndefined(); expect(f.confirmation).not.toHaveBeenCalled(); expect(f.confirmation).toHaveBeenCalled(); await expect(bound.withAction(valueAction)).rejects.toThrow( 'Avalanche scanner is not qualified for downstream processing', ); expect(valueAction).not.toHaveBeenCalled(); expect(await DatabaseActionMock.allEventRecords()).toEqual([ expect.objectContaining({ status: EventStatus.timeout }), ]); await expect(bound.withAction(valueAction)).rejects.toThrow( 'Avalanche scanner is not qualified for downstream processing', ); expect(valueAction).not.toHaveBeenCalled(); expect(await DatabaseActionMock.allRejectedEventRecords()).toHaveLength(0);
   */
  it('keeps admission retryable under a scanner hold and times out only after later admission', async () => {
    const f = await setup();
    await expect(scanner.assertUsable()).resolves.toBeUndefined();
    await DatabaseActionMock.testDataSource
      .getRepository(AvalancheSafetyState)
      .update(
        { scanner: 'avalanche' },
        { holdReason: 'synthetic finality conflict' },
      );
    await EventProcessor.processScannedEvents();
    await expectRetryable();
    expect(f.confirmation).not.toHaveBeenCalled();
    await EventProcessor.TimeoutLeftoverEvents();
    await expectRetryable();

    await DatabaseActionMock.testDataSource
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: null });
    await EventProcessor.processScannedEvents();
    await expectConfirmed();
    expect(f.confirmation).toHaveBeenCalled();

    const [event] = await DatabaseActionMock.allEventRecords();
    const safety = new AvalancheTransactionSafety(
      async () => event,
      () => scanner,
    );
    const bound = await safety.bindTransaction({
      network: 'ergo',
      eventId: event.id,
      txType: TransactionType.payment,
      txId: 'synthetic-payment',
      txBytes: 'abcd',
    });
    await DatabaseActionMock.testDataSource
      .getRepository(AvalancheSafetyState)
      .update(
        { scanner: 'avalanche' },
        { holdReason: 'synthetic finality conflict' },
      );
    const valueAction = vi.fn();
    await expect(bound.withAction(valueAction)).rejects.toThrow(
      'Avalanche scanner is not qualified for downstream processing',
    );
    expect(valueAction).not.toHaveBeenCalled();
    await DatabaseActionMock.testDatabase.ConfirmedEventRepository.update(
      event.id,
      {
        firstTry: String(
          Math.round(Date.now() / 1000) - Configs.eventTimeout - 1,
        ),
      },
    );
    await EventProcessor.TimeoutLeftoverEvents();
    expect(await DatabaseActionMock.allEventRecords()).toEqual([
      expect.objectContaining({ status: EventStatus.timeout }),
    ]);
    await expect(bound.withAction(valueAction)).rejects.toThrow(
      'Avalanche scanner is not qualified for downstream processing',
    );
    expect(valueAction).not.toHaveBeenCalled();
    expect(await DatabaseActionMock.allRejectedEventRecords()).toHaveLength(0);
  });
});
