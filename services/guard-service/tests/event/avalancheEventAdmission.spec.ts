import { BlockEntity } from '@rosen-bridge/abstract-scanner';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
} from '@rosen-bridge/evm-scanner';

import { DatabaseAction } from '../../src/db/databaseAction';
import EventProcessor from '../../src/event/eventProcessor';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import { EventStatus } from '../../src/utils/constants';
import EventVerifier from '../../src/verification/eventVerifier';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockEventTrigger } from './testData';

const getAvalancheScanner = vi.hoisted(() => vi.fn());
vi.mock('../../src/jobs/initScanner', () => ({ getAvalancheScanner }));

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');

type Route = 'source' | 'destination';

describe('Avalanche event admission', () => {
  let scannerNetwork: AvalancheRpcNetwork | undefined;
  let scanner: AvalancheRpcScanner | undefined;

  const registerScanner = async (qualified = true) => {
    scannerNetwork = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
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
      sourceId: 'event-admission-fixture',
      initialHeight: 0,
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 0,
      },
    });
    if (qualified) await scanner.update();
    getAvalancheScanner.mockReturnValue(scanner);
    return scanner;
  };

  const insertEvent = async (
    route: Route | 'legacy',
    sourceBlockId = hash(1),
  ) => {
    const event = {
      ...mockEventTrigger().event,
      fromChain: route === 'source' ? 'avalanche' : 'ergo',
      toChain: route === 'destination' ? 'avalanche' : 'cardano',
      sourceChainHeight: 1,
      sourceBlockId,
    };
    await DatabaseActionMock.insertOnlyEventDataRecord(event);
    return event;
  };

  const mockVerification = () => {
    const confirmation = vi
      .spyOn(EventVerifier, 'isEventConfirmedEnough')
      .mockResolvedValue(true);
    const verification = vi
      .spyOn(EventVerifier, 'verifyEvent')
      .mockResolvedValue(true);
    vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue({
      bridgeFee: 0n,
      networkFee: 0n,
      rsnRatio: 0n,
      feeRatio: 0n,
      rsnRatioDivisor: 1000000000000n,
      feeRatioDivisor: 10000n,
    });
    return { confirmation, verification };
  };

  const expectPending = async () => {
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

  beforeEach(async () => {
    await DatabaseActionMock.clearTables();
    getAvalancheScanner.mockReset();
  });

  afterEach(async () => {
    scannerNetwork?.['provider'].destroy();
    scanner = undefined;
    scannerNetwork = undefined;
    vi.restoreAllMocks();
  });

  /**
   * @target EventProcessor.processScannedEvents 'admits a qualified %s event while holding scanner exclusion through the database write'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'admits a qualified %s event while holding scanner exclusion through the database write' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected vi.spyOn(dbAction, 'insertConfirmedEvent').mockImplementation( async (event) => { await expect(activeScanner.update()).rejects.toThrow( 'already running', ); await realInsert(event); }, ); await expect(activeScanner.update()).rejects.toThrow( 'already running', ); expect(confirmation).toHaveBeenCalledOnce(); expect(verification).toHaveBeenCalledOnce(); expect(observed).toHaveBeenCalledWith(1, hash(1), expect.any(Function)); expect(observed).not.toHaveBeenCalled(); expect(safety).toHaveBeenCalledWith(expect.any(Function));
   */
  it.each(['source', 'destination'] as const)(
    'admits a qualified %s event while holding scanner exclusion through the database write',
    async (route) => {
      const activeScanner = await registerScanner();
      await insertEvent(route);
      const { confirmation, verification } = mockVerification();
      const dbAction = DatabaseAction.getInstance();
      const realInsert = dbAction.insertConfirmedEvent.bind(dbAction);
      vi.spyOn(dbAction, 'insertConfirmedEvent').mockImplementation(
        async (event) => {
          await expect(activeScanner.update()).rejects.toThrow(
            'already running',
          );
          await realInsert(event);
        },
      );
      const observed = vi.spyOn(activeScanner, 'withObservation');
      const safety = vi.spyOn(activeScanner, 'withSafety');

      await EventProcessor.processScannedEvents();

      await expectConfirmed();
      expect(confirmation).toHaveBeenCalledOnce();
      expect(verification).toHaveBeenCalledOnce();
      if (route === 'source') {
        expect(observed).toHaveBeenCalledWith(1, hash(1), expect.any(Function));
      } else {
        expect(observed).not.toHaveBeenCalled();
        expect(safety).toHaveBeenCalledWith(expect.any(Function));
      }
    },
  );

  /**
   * @target EventProcessor.processScannedEvents 'keeps a verified but invalid Avalanche event inside the same exclusion until rejection'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps a verified but invalid Avalanche event inside the same exclusion until rejection' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected vi.spyOn(dbAction, 'insertRejectedEvent').mockImplementation( async (event, reason) => { await expect(activeScanner.update()).rejects.toThrow('already running'); await realInsert(event, reason); }, ); await expect(activeScanner.update()).rejects.toThrow('already running'); expect(await DatabaseActionMock.allEventRecords()).toHaveLength(0); expect(await DatabaseActionMock.allRejectedEventRecords()).toEqual([ expect.objectContaining({ reason: 'unknown' }), ]);
   */
  it('keeps a verified but invalid Avalanche event inside the same exclusion until rejection', async () => {
    const activeScanner = await registerScanner();
    await insertEvent('source');
    const { verification } = mockVerification();
    verification.mockResolvedValue(false);
    const dbAction = DatabaseAction.getInstance();
    const realInsert = dbAction.insertRejectedEvent.bind(dbAction);
    vi.spyOn(dbAction, 'insertRejectedEvent').mockImplementation(
      async (event, reason) => {
        await expect(activeScanner.update()).rejects.toThrow('already running');
        await realInsert(event, reason);
      },
    );

    await EventProcessor.processScannedEvents();

    expect(await DatabaseActionMock.allEventRecords()).toHaveLength(0);
    expect(await DatabaseActionMock.allRejectedEventRecords()).toEqual([
      expect.objectContaining({ reason: 'unknown' }),
    ]);
  });

  /**
   * @target EventProcessor.processScannedEvents 'keeps a duplicate-trigger rejection inside the source observation lease'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps a duplicate-trigger rejection inside the source observation lease' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected vi.spyOn(dbAction, 'insertRejectedEvent').mockImplementation( async (trigger, reason) => { await expect(activeScanner.update()).rejects.toThrow('already running'); await realInsert(trigger, reason); }, ); await expect(activeScanner.update()).rejects.toThrow('already running'); expect(confirmed).toHaveLength(1); expect(confirmed[0].eventData.id).toBe(first.id); expect(rejected).toHaveLength(1); expect(rejected[0].eventDataId).toBe(secondId); expect(rejected[0].reason).toBe('duplicate-trigger'); expect(verification).toHaveBeenCalledOnce();
   */
  it('keeps a duplicate-trigger rejection inside the source observation lease', async () => {
    const activeScanner = await registerScanner();
    const event = await insertEvent('source');
    const [first] =
      await DatabaseActionMock.testDatabase.getUnconfirmedEvents();
    const secondId = await DatabaseActionMock.insertOnlyEventDataRecord(
      event,
      'second-trigger-box',
    );
    const { verification } = mockVerification();
    const dbAction = DatabaseAction.getInstance();
    const realInsert = dbAction.insertRejectedEvent.bind(dbAction);
    vi.spyOn(dbAction, 'insertRejectedEvent').mockImplementation(
      async (trigger, reason) => {
        await expect(activeScanner.update()).rejects.toThrow('already running');
        await realInsert(trigger, reason);
      },
    );

    await EventProcessor.processScannedEvents();

    const confirmed = await DatabaseActionMock.allEventRecords();
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].eventData.id).toBe(first.id);
    const rejected = await DatabaseActionMock.allRejectedEventRecords();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].eventDataId).toBe(secondId);
    expect(rejected[0].reason).toBe('duplicate-trigger');
    expect(verification).toHaveBeenCalledOnce();
  });

  /**
   * @target EventProcessor.processScannedEvents 'keeps a %s event retryable until a real scanner is registered'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps a %s event retryable until a real scanner is registered' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).not.toHaveBeenCalled();
   */
  it.each(['source', 'destination'] as const)(
    'keeps a %s event retryable until a real scanner is registered',
    async (route) => {
      await insertEvent(route);
      const { confirmation } = mockVerification();
      await EventProcessor.processScannedEvents();
      await expectPending();
      expect(confirmation).not.toHaveBeenCalled();
      await registerScanner();
      await EventProcessor.processScannedEvents();
      await expectConfirmed();
    },
  );

  /**
   * @target EventProcessor.processScannedEvents 'does not accept a scanner-shaped substitute'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not accept a scanner-shaped substitute' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).not.toHaveBeenCalled();
   */
  it('does not accept a scanner-shaped substitute', async () => {
    await insertEvent('source');
    const { confirmation } = mockVerification();
    getAvalancheScanner.mockReturnValue({
      withObservation: vi.fn(async (_height, _hash, action) => action()),
      withSafety: vi.fn(async (action) => action()),
    });

    await EventProcessor.processScannedEvents();

    await expectPending();
    expect(confirmation).not.toHaveBeenCalled();
  });

  /**
   * @target EventProcessor.processScannedEvents 'keeps a %s event retryable before persistent scanner initialization'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps a %s event retryable before persistent scanner initialization' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).not.toHaveBeenCalled();
   */
  it.each(['source', 'destination'] as const)(
    'keeps a %s event retryable before persistent scanner initialization',
    async (route) => {
      const inactiveScanner = await registerScanner(false);
      await insertEvent(route);
      const { confirmation } = mockVerification();
      await EventProcessor.processScannedEvents();
      await expectPending();
      expect(confirmation).not.toHaveBeenCalled();
      await inactiveScanner.update();
      await EventProcessor.processScannedEvents();
      await expectConfirmed();
    },
  );

  /**
   * @target EventProcessor.processScannedEvents 'blocks source admission on unqualified persisted state %j'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'blocks source admission on unqualified persisted state %j' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).not.toHaveBeenCalled();
   */
  it.each([
    { holdReason: 'synthetic-hold' },
    { sourceId: 'other-source' },
    { chainId: '43114' },
    { policy: 'other-policy' },
    { finalizedHeight: null },
  ])(
    'blocks source admission on unqualified persisted state %j',
    async (override) => {
      await registerScanner();
      await insertEvent('source');
      const { confirmation } = mockVerification();
      await DatabaseActionMock.testDataSource
        .getRepository(AvalancheSafetyState)
        .update({ scanner: 'avalanche' }, override);

      await EventProcessor.processScannedEvents();

      await expectPending();
      expect(confirmation).not.toHaveBeenCalled();
    },
  );

  /**
   * @target EventProcessor.processScannedEvents 'blocks destination admission while the scanner is persistently held'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'blocks destination admission while the scanner is persistently held' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).not.toHaveBeenCalled();
   */
  it('blocks destination admission while the scanner is persistently held', async () => {
    await registerScanner();
    await insertEvent('destination');
    const { confirmation } = mockVerification();
    await DatabaseActionMock.testDataSource
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'synthetic-hold' });

    await EventProcessor.processScannedEvents();

    await expectPending();
    expect(confirmation).not.toHaveBeenCalled();
  });

  /**
   * @target EventProcessor.processScannedEvents 'requires a matching completed Avalanche source block: %s'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'requires a matching completed Avalanche source block: %s' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).not.toHaveBeenCalled();
   */
  it.each(['absent', 'incomplete', 'different hash'] as const)(
    'requires a matching completed Avalanche source block: %s',
    async (kind) => {
      await registerScanner();
      await insertEvent(
        'source',
        kind === 'different hash' ? hash(99) : hash(1),
      );
      const { confirmation } = mockVerification();
      const blocks =
        DatabaseActionMock.testDataSource.getRepository(BlockEntity);
      if (kind === 'absent')
        await blocks.delete({ scanner: 'avalanche', height: 1 });
      if (kind === 'incomplete')
        await blocks.update(
          { scanner: 'avalanche', height: 1 },
          { status: 'PROCESSING' },
        );

      await EventProcessor.processScannedEvents();

      await expectPending();
      expect(confirmation).not.toHaveBeenCalled();
    },
  );

  /**
   * @target EventProcessor.processScannedEvents 'uses the source observation gate when Avalanche is both source and destination'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'uses the source observation gate when Avalanche is both source and destination' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(observed).toHaveBeenCalledWith(1, hash(99), expect.any(Function)); expect(confirmation).not.toHaveBeenCalled();
   */
  it('uses the source observation gate when Avalanche is both source and destination', async () => {
    const activeScanner = await registerScanner();
    const event = {
      ...mockEventTrigger().event,
      fromChain: 'avalanche',
      toChain: 'avalanche',
      sourceChainHeight: 1,
      sourceBlockId: hash(99),
    };
    await DatabaseActionMock.insertOnlyEventDataRecord(event);
    const { confirmation } = mockVerification();
    const observed = vi.spyOn(activeScanner, 'withObservation');

    await EventProcessor.processScannedEvents();

    await expectPending();
    expect(observed).toHaveBeenCalledWith(1, hash(99), expect.any(Function));
    expect(confirmation).not.toHaveBeenCalled();
  });

  /**
   * @target EventProcessor.processScannedEvents 'does not admit a %s event whose stored event ID disagrees with sourceTxId'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not admit a %s event whose stored event ID disagrees with sourceTxId' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(observed).not.toHaveBeenCalled(); expect(safety).not.toHaveBeenCalled(); expect(confirmation).not.toHaveBeenCalled(); expect(verification).not.toHaveBeenCalled();
   */
  it.each(['source', 'destination'] as const)(
    'does not admit a %s event whose stored event ID disagrees with sourceTxId',
    async (route) => {
      const activeScanner = await registerScanner();
      await insertEvent(route);
      const [row] =
        await DatabaseActionMock.testDatabase.getUnconfirmedEvents();
      await DatabaseActionMock.testDatabase.EventRepository.update(row.id, {
        eventId: 'f'.repeat(64),
      });
      const { confirmation, verification } = mockVerification();
      const observed = vi.spyOn(activeScanner, 'withObservation');
      const safety = vi.spyOn(activeScanner, 'withSafety');

      await EventProcessor.processScannedEvents();

      await expectPending();
      expect(observed).not.toHaveBeenCalled();
      expect(safety).not.toHaveBeenCalled();
      expect(confirmation).not.toHaveBeenCalled();
      expect(verification).not.toHaveBeenCalled();
    },
  );

  /**
   * @target EventProcessor.processScannedEvents 'does not write a %s event if its entity changes during asynchronous confirmation'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'does not write a %s event if its entity changes during asynchronous confirmation' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).toHaveBeenCalledOnce();
   */
  it.each(['source', 'destination'] as const)(
    'does not write a %s event if its entity changes during asynchronous confirmation',
    async (route) => {
      await registerScanner();
      await insertEvent(route);
      const { confirmation } = mockVerification();
      const dbAction = DatabaseAction.getInstance();
      const [row] = await dbAction.getUnconfirmedEvents();
      vi.spyOn(dbAction, 'getUnconfirmedEvents').mockResolvedValueOnce([row]);
      confirmation.mockImplementationOnce(async () => {
        if (route === 'source') row.sourceBlockId = hash(99);
        else row.toChain = 'ergo';
        return true;
      });

      await EventProcessor.processScannedEvents();

      await expectPending();
      expect(confirmation).toHaveBeenCalledOnce();
      await EventProcessor.processScannedEvents();
      await expectConfirmed();
    },
  );

  /**
   * @target EventProcessor.processScannedEvents 'preserves admission for an unrelated legacy route without an Avalanche scanner'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'preserves admission for an unrelated legacy route without an Avalanche scanner' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).toHaveBeenCalledOnce(); expect(verification).toHaveBeenCalledOnce(); expect(getAvalancheScanner).not.toHaveBeenCalled();
   */
  it('preserves admission for an unrelated legacy route without an Avalanche scanner', async () => {
    await insertEvent('legacy');
    const { confirmation, verification } = mockVerification();

    await EventProcessor.processScannedEvents();

    await expectConfirmed();
    expect(confirmation).toHaveBeenCalledOnce();
    expect(verification).toHaveBeenCalledOnce();
    expect(getAvalancheScanner).not.toHaveBeenCalled();
  });

  /**
   * @target EventProcessor.processScannedEvents 'keeps a noncanonical Avalanche route retryable: %j'
   * @dependencies Actual EventProcessor from event/eventProcessor.ts and this suite's explicit scanner, database, codec and transport fixtures.
   * @scenario Run 'keeps a noncanonical Avalanche route retryable: %j' with the suite's captured inputs and invoke the processScannedEvents path.
   * @expected expect(confirmation).not.toHaveBeenCalled(); expect(verification).not.toHaveBeenCalled();
   */
  it.each([
    { fromChain: 'Avalanche', toChain: 'ergo' },
    { fromChain: ' avalanche ', toChain: 'ergo' },
    { fromChain: 'ergo', toChain: 'Avalanche' },
    { fromChain: 'ergo', toChain: ' avalanche ' },
  ])(
    'keeps a noncanonical Avalanche route retryable: %j',
    async ({ fromChain, toChain }) => {
      const event = {
        ...mockEventTrigger().event,
        fromChain,
        toChain,
        sourceChainHeight: 1,
        sourceBlockId: hash(1),
      };
      await DatabaseActionMock.insertOnlyEventDataRecord(event);
      const { confirmation, verification } = mockVerification();

      await EventProcessor.processScannedEvents();

      await expectPending();
      expect(confirmation).not.toHaveBeenCalled();
      expect(verification).not.toHaveBeenCalled();
    },
  );
});
