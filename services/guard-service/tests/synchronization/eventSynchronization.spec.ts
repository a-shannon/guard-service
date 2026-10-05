import { ConfirmationStatus } from '@rosen-chains/abstract-chain';
import { PaymentOrder } from '@rosen-chains/abstract-chain';
import { TransactionType } from '@rosen-chains/abstract-chain';
import { PaymentTransaction } from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import Configs from '../../src/configs/configs';
import { DatabaseAction } from '../../src/db/databaseAction';
import EventBoxes from '../../src/event/eventBoxes';
import EventOrder from '../../src/event/eventOrder';
import EventSerializer from '../../src/event/eventSerializer';
import ChainHandler from '../../src/handlers/chainHandler';
import GuardPkHandler from '../../src/handlers/guardPkHandler';
import MinimumFeeHandler from '../../src/handlers/minimumFeeHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import { SynchronizationMessageTypes } from '../../src/synchronization/interfaces';
import { EventStatus } from '../../src/utils/constants';
import { TransactionStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import { mockPaymentTransaction } from '../agreement/testData';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { mockCreateEventPaymentOrder } from '../event/mocked/eventOrder.mock';
import { mockGetEventFeeConfig } from '../event/mocked/minimumFee.mock';
import * as EventTestData from '../event/testData';
import { mockEventTrigger } from '../event/testData';
import ChainHandlerMock from '../handlers/chainHandler.mock';
import TestConfigs from '../testUtils/testConfigs';
import TestUtils from '../testUtils/testUtils';
import {
  TestPersistenceSynchronization as PersistenceSynchronization,
  eventId,
  deferred,
  TestSynchronizationFixture as SynchronizationFixture,
  evm,
  ergo,
} from './eventSynchronizationTestUtils';
import TestEventSynchronization from './testEventSynchronization';

describe('EventSynchronization', () => {
  describe('baseline scenarios', () => {
    describe('addEventToQueue', () => {
      /**
       * @target EventSynchronization.addEventToQueue should add the event to the memory queue
       * @dependencies
       * @scenario
       * - run test
       * - check events in memory
       * @expected
       * - memory queue should contains mocked event
       */
      it('should add the event to the memory queue', async () => {
        // run test
        const eventId = 'event-id';
        const eventSync = new TestEventSynchronization();
        eventSync.addEventToQueue(eventId);

        // check events in memory
        const queue = eventSync.getEventQueue();
        expect(queue).toEqual([eventId]);
      });
    });

    describe('processSyncQueue', () => {
      const guardsLen = Configs.tssKeys.pubs.length;

      beforeAll(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(TestConfigs.currentTimeStamp));
        mockGetEventFeeConfig({
          bridgeFee: 0n,
          networkFee: 0n,
          rsnRatio: 0n,
          feeRatio: 100n,
          rsnRatioDivisor: 1000000000000n,
          feeRatioDivisor: 10000n,
        });
      });

      afterAll(() => {
        vi.useRealTimers();
      });

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
      });

      /**
       * @target EventSynchronization.processSyncQueue should add event to active sync successfully
       * @dependencies
       * - Date
       * - database
       * - MinimumFee
       * @scenario
       * - mock event
       * - insert mocked event into db
       * - insert event into queue
       * - run test
       * - check active syncs in memory
       * @expected
       * - mocked event should be in memory
       * - mocked event sync responses should be initiated
       * - memory queue should be empty
       */
      it('should add event to active sync successfully', async () => {
        // mock event
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);

        // insert mocked event into db
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into queue
        const eventSync = new TestEventSynchronization();
        eventSync.addEventToQueue(eventId);

        // run test
        await eventSync.processSyncQueue();

        // check active syncs in memory
        const activeSyncs = eventSync.getActiveSyncMap();
        expect(activeSyncs.get(eventId)).toEqual({
          timestamp: TestConfigs.currentTimeStamp / 1000,
          responses: Array(guardsLen).fill(undefined),
        });
        expect(eventSync.getEventQueue().length).toEqual(0);
      });

      /**
       * @target EventSynchronization.processSyncQueue should NOT add event to active sync
       * when there are already maximum number of events in active syncs
       * @dependencies
       * - Date
       * - database
       * - MinimumFee
       * @scenario
       * - mock event
       * - insert mocked event into db
       * - insert event into queue
       * - insert 3 events into active sync
       * - run test
       * - check active syncs in memory
       * @expected
       * - mocked event should still be in queue
       * - active sync map length should still be 3
       */
      it('should NOT add event to active sync when there are already maximum number of events in active syncs', async () => {
        // mock event
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);

        // insert mocked event into db
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into queue
        const eventSync = new TestEventSynchronization();
        eventSync.addEventToQueue(eventId);

        // insert 3 events into active sync
        for (let i = 0; i < 3; i++) {
          eventSync.insertEventIntoActiveSync(TestUtils.generateRandomId(), {
            timestamp: TestConfigs.currentTimeStamp,
            responses: [],
          });
        }

        // run test
        await eventSync.processSyncQueue();

        // check active syncs in memory
        const activeSyncs = eventSync.getActiveSyncMap();
        expect(activeSyncs.size).toEqual(3);
        expect(eventSync.getEventQueue()).toEqual([eventId]);
      });

      /**
       * @target EventSynchronization.processSyncQueue should skip event when event
       * is already in active sync
       * @dependencies
       * - Date
       * - database
       * - MinimumFee
       * @scenario
       * - mock event
       * - insert mocked event into db
       * - insert event into queue and active sync
       * - run test
       * - check active syncs in memory
       * @expected
       * - active sync should remain unchanged
       * - memory queue should be empty
       */
      it('should skip event when event is already in active sync', async () => {
        // mock event
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);

        // insert mocked event into db
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into queue and active sync
        const eventSync = new TestEventSynchronization();
        eventSync.addEventToQueue(eventId);
        const timestamp = TestConfigs.currentTimeStamp / 1000 - 100;
        const responses = Array(guardsLen).fill(undefined);
        responses[2] = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
        );
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: timestamp,
          responses: responses,
        });

        // run test
        await eventSync.processSyncQueue();

        // check active syncs in memory
        const activeSyncs = eventSync.getActiveSyncMap();
        expect(activeSyncs.size).toEqual(1);
        expect(activeSyncs.get(eventId)).toEqual({
          timestamp: timestamp,
          responses: responses,
        });
        expect(eventSync.getEventQueue().length).toEqual(0);
      });

      /**
       * @target EventSynchronization.processSyncQueue should skip event when event
       * is not in the ConfirmedEvent table
       * @dependencies
       * - Date
       * - database
       * - MinimumFee
       * @scenario
       * - mock event
       * - insert event into queue
       * - run test
       * - check active syncs in memory
       * @expected
       * - active sync should remain empty
       * - memory queue should be empty
       */
      it('should skip event when event is not in the ConfirmedEvent table', async () => {
        // mock event
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);

        // insert event into queue
        const eventSync = new TestEventSynchronization();
        eventSync.addEventToQueue(eventId);

        // run test
        await eventSync.processSyncQueue();

        // check active syncs in memory
        const activeSyncs = eventSync.getActiveSyncMap();
        expect(activeSyncs.size).toEqual(0);
        expect(eventSync.getEventQueue().length).toEqual(0);
      });
    });

    describe('sendSyncBatch', () => {
      const guardIndex = TestConfigs.guardIndex;
      const guardsLen = Configs.tssKeys.pubs.length;
      const publicKeys = Configs.tssKeys.pubs.map((pub) => pub.curvePub);

      beforeAll(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(TestConfigs.currentTimeStamp));
      });

      afterAll(() => {
        vi.useRealTimers();
      });

      /**
       * @target EventSynchronization.sendSyncBatch should send sync request to random
       * guards for each events
       * @dependencies
       * - Date
       * - GuardDetection
       * @scenario
       * - mock two events
       * - insert events into active sync
       * - mock EventSynchronization.sendMessage
       * - mock detection.activeGuards
       * - run test
       * - check if function got called
       * @expected
       * - `sendMessage` should got called with expected arguments
       */
      it('should send sync request to random guards for each events', async () => {
        // mock two events
        const mockedEvent1 = EventTestData.mockEventTrigger().event;
        const eventId1 = EventSerializer.getId(mockedEvent1);
        const mockedEvent2 = EventTestData.mockEventTrigger().event;
        const eventId2 = EventSerializer.getId(mockedEvent2);

        // insert events into active sync
        const eventSync = new TestEventSynchronization();
        const timestamp = TestConfigs.currentTimeStamp / 1000 - 100;
        eventSync.insertEventIntoActiveSync(eventId1, {
          timestamp: timestamp,
          responses: Array(guardsLen).fill(undefined),
        });
        eventSync.insertEventIntoActiveSync(eventId2, {
          timestamp: timestamp,
          responses: Array(guardsLen).fill(undefined),
        });

        // mock EventSynchronization.sendMessage
        const mockedSendMessage = vi.fn();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
        const sendMessageSpy = vi.spyOn(eventSync as any, 'sendMessage');
        sendMessageSpy.mockImplementation(mockedSendMessage);

        // mock detection.activeGuards

        vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          (eventSync as any).detection,
          'activeGuards',
        ).mockResolvedValue(
          publicKeys.map((pk, index) => ({
            publicKey: pk,
            peerId: `peer-${index}`,
            index: index,
          })),
        );

        // run test
        await eventSync.sendSyncBatch();

        // `sendMessage` should got called with expected arguments
        expect(mockedSendMessage).toHaveBeenCalledWith(
          SynchronizationMessageTypes.request,
          { eventId: eventId1 },
          expect.not.arrayContaining([`peer-${guardIndex}`]),
          TestConfigs.currentTimeStamp / 1000,
        );
        expect(mockedSendMessage).toHaveBeenCalledWith(
          SynchronizationMessageTypes.request,
          { eventId: eventId2 },
          expect.not.arrayContaining([`peer-${guardIndex}`]),
          TestConfigs.currentTimeStamp / 1000,
        );
      });

      /**
       * @target EventSynchronization.sendSyncBatch should send sync request only to
       * the guards that didn't response yet
       * @dependencies
       * - Date
       * - GuardDetection
       * @scenario
       * - mock event
       * - insert event into active sync
       * - mock EventSynchronization.sendMessage
       * - mock detection.activeGuards
       * - run test
       * - check if function got called
       * @expected
       * - `sendMessage` should got called with expected arguments
       */
      it("should send sync request only to the guards that didn't response yet", async () => {
        // mock event
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = [
          ...Array(guardsLen - 2).fill(mockPaymentTransaction()),
          undefined,
          undefined,
        ];
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock EventSynchronization.sendMessage
        const mockedSendMessage = vi.fn();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
        const sendMessageSpy = vi.spyOn(eventSync as any, 'sendMessage');
        sendMessageSpy.mockImplementation(mockedSendMessage);

        // mock detection.activeGuards

        vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          (eventSync as any).detection,
          'activeGuards',
        ).mockResolvedValue(
          publicKeys.map((pk, index) => ({
            publicKey: pk,
            peerId: `peer-${index}`,
            index: index,
          })),
        );

        // run test
        await eventSync.sendSyncBatch();

        // `sendMessage` should got called with expected arguments
        expect(mockedSendMessage).toHaveBeenCalledWith(
          SynchronizationMessageTypes.request,
          { eventId: eventId },
          expect.arrayContaining([
            `peer-${guardsLen - 1}`,
            `peer-${guardsLen - 2}`,
          ]),
          TestConfigs.currentTimeStamp / 1000,
        );
        expect(mockedSendMessage.mock.lastCall?.at(2).length).toEqual(2);
      });

      /**
       * @target EventSynchronization.sendSyncBatch should not send any request when
       * selected guards are not active
       * @dependencies
       * - Date
       * - GuardDetection
       * @scenario
       * - mock event
       * - insert events into active sync
       * - mock EventSynchronization.sendMessage
       * - mock detection.activeGuards
       * - run test
       * - check if function got called
       * @expected
       * - `sendMessage` should NOT got called
       */
      it('should not send any request when selected guards are not active', async () => {
        // mock event
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);

        // insert events into active sync
        const eventSync = new TestEventSynchronization();
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: Array(guardsLen).fill(undefined),
        });

        // mock EventSynchronization.sendMessage
        const mockedSendMessage = vi.fn();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
        const sendMessageSpy = vi.spyOn(eventSync as any, 'sendMessage');
        sendMessageSpy.mockImplementation(mockedSendMessage);

        // mock detection.activeGuards

        vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          (eventSync as any).detection,
          'activeGuards',
        ).mockResolvedValue([]);

        // run test
        await eventSync.sendSyncBatch();

        // `sendMessage` should NOT got called
        expect(mockedSendMessage).not.toHaveBeenCalled();
      });
    });

    describe('processSyncRequest', () => {
      beforeAll(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(TestConfigs.currentTimeStamp));
      });

      afterAll(() => {
        vi.useRealTimers();
      });

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        ChainHandlerMock.resetMock();
      });

      /**
       * @target EventSynchronization.processSyncRequest should send sync response when
       * event has a completed tx in payment type
       * @dependencies
       * - database
       * - Date
       * @scenario
       * - mock event and transaction and insert into db
       * - mock EventSynchronization.sendMessage
       * - mock ChainHandler.getActualTxId
       * - run test
       * - check if function got called
       * @expected
       * - `sendMessage` should got called with expected arguments
       */
      it('should send sync response when event has a completed tx in payment type', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingReward,
        );
        await DatabaseActionMock.insertTxRecord(
          tx,
          TransactionStatus.completed,
        );

        // mock EventSynchronization.sendMessage
        const eventSync = new TestEventSynchronization();
        const mockedSendMessage = vi.fn();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
        const sendMessageSpy = vi.spyOn(eventSync as any, 'sendMessage');
        sendMessageSpy.mockImplementation(mockedSendMessage);

        // mock `getActualTxId`
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getActualTxId',
          tx.txId,
          true,
        );

        // run test
        await eventSync.processMessage(
          SynchronizationMessageTypes.request,
          { eventId: eventId },
          'signature',
          0,
          'peer-0',
          TestConfigs.currentTimeStamp / 1000,
        );

        // `sendMessage` should got called with expected arguments
        expect(mockedSendMessage).toHaveBeenCalledWith(
          SynchronizationMessageTypes.response,
          { txJson: tx.toJson(), actualTxId: tx.txId },
          expect.any(Array),
          TestConfigs.currentTimeStamp / 1000,
        );
      });

      /**
       * @target EventSynchronization.processSyncRequest should do nothing when event is not found
       * @dependencies
       * - database
       * - Date
       * @scenario
       * - mock EventSynchronization.sendMessage
       * - run test
       * - check if function got called
       * @expected
       * - `sendMessage` should NOT got called
       */
      it('should do nothing when event is not found', async () => {
        // mock EventSynchronization.sendMessage
        const eventSync = new TestEventSynchronization();
        const mockedSendMessage = vi.fn();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
        const sendMessageSpy = vi.spyOn(eventSync as any, 'sendMessage');
        sendMessageSpy.mockImplementation(mockedSendMessage);

        // run test
        await eventSync.processMessage(
          SynchronizationMessageTypes.request,
          { eventId: 'event-id' },
          'signature',
          0,
          'peer-0',
          TestConfigs.currentTimeStamp / 1000,
        );

        // `sendMessage` should NOT got called
        expect(mockedSendMessage).not.toHaveBeenCalledWith();
      });

      /**
       * @target EventSynchronization.processSyncRequest should do nothing when event has no transaction
       * @dependencies
       * - database
       * - Date
       * @scenario
       * - mock event insert into db
       * - mock EventSynchronization.sendMessage
       * - run test
       * - check if function got called
       * @expected
       * - `sendMessage` should NOT got called
       */
      it('should do nothing when event has no transaction', async () => {
        // mock event insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingReward,
        );

        // mock EventSynchronization.sendMessage
        const eventSync = new TestEventSynchronization();
        const mockedSendMessage = vi.fn();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
        const sendMessageSpy = vi.spyOn(eventSync as any, 'sendMessage');
        sendMessageSpy.mockImplementation(mockedSendMessage);

        // run test
        await eventSync.processMessage(
          SynchronizationMessageTypes.request,
          { eventId: eventId },
          'signature',
          0,
          'peer-0',
          TestConfigs.currentTimeStamp / 1000,
        );

        // `sendMessage` should NOT got called
        expect(mockedSendMessage).not.toHaveBeenCalledWith();
      });

      /**
       * @target EventSynchronization.processSyncRequest should do nothing when tx is not completed
       * @dependencies
       * - database
       * - Date
       * @scenario
       * - mock event and transaction and insert into db
       * - mock EventSynchronization.sendMessage
       * - run test
       * - check if function got called
       * @expected
       * - `sendMessage` should NOT got called
       */
      it('should do nothing when tx is not completed', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingReward,
        );
        await DatabaseActionMock.insertTxRecord(tx, TransactionStatus.sent);

        // mock EventSynchronization.sendMessage
        const eventSync = new TestEventSynchronization();
        const mockedSendMessage = vi.fn();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
        const sendMessageSpy = vi.spyOn(eventSync as any, 'sendMessage');
        sendMessageSpy.mockImplementation(mockedSendMessage);

        // run test
        await eventSync.processMessage(
          SynchronizationMessageTypes.request,
          { eventId: eventId },
          'signature',
          0,
          'peer-0',
          TestConfigs.currentTimeStamp / 1000,
        );

        // `sendMessage` should NOT got called
        expect(mockedSendMessage).not.toHaveBeenCalledWith();
      });
    });

    describe('processSyncResponse', () => {
      const guardsLen = Configs.tssKeys.pubs.length;
      const requiredApproval = GuardPkHandler.getInstance().requiredSign - 1;

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
      });

      /**
       * @target EventSynchronization.processSyncResponse should set tx as approved when
       * enough guards responded a transaction
       * @dependencies
       * - database
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock EventSynchronization
       *   - mock `verifySynchronizationResponse`
       *   - mock `setTxAsApproved`
       * - run test
       * - check if function got called
       * @expected
       * - `setTxAsApproved` should got called
       */
      it('should set tx as approved when enough guards responded a transaction', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = [
          undefined,
          ...Array(requiredApproval - 1).fill(tx),
          ...Array(guardsLen - requiredApproval).fill(undefined),
        ];
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock EventSynchronization
        vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          eventSync as any,
          'verifySynchronizationResponse',
        ).mockResolvedValue(true);
        const mockedSetTxAsApproved = vi.fn();

        const setTxAsApprovedSpy = vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          eventSync as any,
          'setTxAsApproved',
        );
        setTxAsApprovedSpy.mockImplementation(mockedSetTxAsApproved);

        // run test
        await eventSync.processMessage(
          SynchronizationMessageTypes.response,
          { txJson: tx.toJson() },
          'signature',
          0,
          'peer-0',
          TestConfigs.currentTimeStamp / 1000,
        );

        // `setTxAsApproved` should got called
        expect(mockedSetTxAsApproved).toHaveBeenCalled();
      });

      /**
       * @target EventSynchronization.processSyncResponse should ignore duplicate response
       * @dependencies
       * - database
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock EventSynchronization
       *   - mock `verifySynchronizationResponse`
       *   - mock `setTxAsApproved`
       * - run test
       * - check if function got called
       * @expected
       * - `setTxAsApproved` should NOT got called
       */
      it('should ignore duplicate response', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = [
          ...Array(requiredApproval - 1).fill(tx),
          ...Array(guardsLen - requiredApproval + 1).fill(undefined),
        ];
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock EventSynchronization
        vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          eventSync as any,
          'verifySynchronizationResponse',
        ).mockResolvedValue(true);
        const mockedSetTxAsApproved = vi.fn();

        const setTxAsApprovedSpy = vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          eventSync as any,
          'setTxAsApproved',
        );
        setTxAsApprovedSpy.mockImplementation(mockedSetTxAsApproved);

        // run test
        await eventSync.processMessage(
          SynchronizationMessageTypes.response,
          { txJson: tx.toJson() },
          'signature',
          0,
          'peer-0',
          TestConfigs.currentTimeStamp / 1000,
        );

        // `setTxAsApproved` should NOT got called
        expect(mockedSetTxAsApproved).not.toHaveBeenCalled();
      });

      /**
       * @target EventSynchronization.processSyncResponse should do nothing when enough
       * guards didn't response with the same transaction
       * @dependencies
       * - database
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock EventSynchronization
       *   - mock `verifySynchronizationResponse`
       *   - mock `setTxAsApproved`
       * - run test
       * - check if function got called
       * - check active syncs in memory
       * @expected
       * - `setTxAsApproved` should NOT got called
       * - response should be added to active sync
       */
      it("should do nothing when enough guards didn't response with the same transaction", async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        const anotherTx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = [
          undefined,
          ...Array(requiredApproval - 2).fill(tx),
          ...Array(requiredApproval - 2).fill(anotherTx),
          ...Array(guardsLen - 2 * requiredApproval + 3).fill(undefined),
        ];
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock EventSynchronization
        vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          eventSync as any,
          'verifySynchronizationResponse',
        ).mockResolvedValue(true);
        const mockedSetTxAsApproved = vi.fn();

        const setTxAsApprovedSpy = vi.spyOn(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the existing baseline mock cast.
          eventSync as any,
          'setTxAsApproved',
        );
        setTxAsApprovedSpy.mockImplementation(mockedSetTxAsApproved);

        // run test
        await eventSync.processMessage(
          SynchronizationMessageTypes.response,
          { txJson: tx.toJson() },
          'signature',
          0,
          'peer-0',
          TestConfigs.currentTimeStamp / 1000,
        );

        // `setTxAsApproved` should NOT got called
        expect(mockedSetTxAsApproved).not.toHaveBeenCalled();

        // response should be added to active sync
        const activeSync = eventSync.getActiveSyncMap();
        expect(activeSync.get(eventId)?.responses.map((_) => _?.txId)).toEqual(
          [tx, ...responses.slice(1)].map((_) => _?.txId),
        );
      });
    });

    describe(`verifySynchronizationResponse`, () => {
      const guardsLen = Configs.tssKeys.pubs.length;

      beforeAll(() => {
        mockGetEventFeeConfig({
          bridgeFee: 0n,
          networkFee: 0n,
          rsnRatio: 0n,
          feeRatio: 100n,
          rsnRatioDivisor: 1000000000000n,
          feeRatioDivisor: 10000n,
        });
      });

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        ChainHandlerMock.resetMock();
      });

      /**
       * @target EventSynchronization.verifySynchronizationResponse should return true
       * when all conditions are met
       * @dependencies
       * - database
       * - ChainHandler
       * - MinimumFee
       * - EventOrder
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock a PaymentOrder
       * - mock ChainHandler `getChain`
       *   - mock `verifyPaymentTransaction`
       *   - mock `extractTransactionOrder`
       *   - mock `getTxConfirmationStatus`
       *   - mock `verifyTransactionExtraConditions`
       *   - mock `getActualTxId`
       * - mock EventOrder.createEventPaymentOrder to return mocked order
       * - run test
       * - check returned value
       * @expected
       * - returned value should be true
       */
      it('should return true when all conditions are met', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = Array(guardsLen).fill(undefined);
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock a PaymentOrder
        const mockedOrder: PaymentOrder = [
          {
            address: 'address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ];

        // mock ChainHandler
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        // mock `verifyPaymentTransaction`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyPaymentTransaction',
          true,
          true,
        );
        // mock `extractTransactionOrder`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'extractTransactionOrder',
          mockedOrder,
          false,
        );
        // mock `getTxConfirmationStatus`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getTxConfirmationStatus',
          ConfirmationStatus.ConfirmedEnough,
          false,
        );
        // mock `verifyTransactionExtraConditions`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyTransactionExtraConditions',
          true,
          false,
        );
        // mock `getActualTxId`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getActualTxId',
          tx.txId,
          true,
        );

        // mock EventOrder.createEventPaymentOrder to return mocked order
        mockCreateEventPaymentOrder(mockedOrder);

        // run test
        const result = await eventSync.callVerifySynchronizationResponse(
          tx,
          tx.txId,
        );

        // check returned value
        expect(result).toEqual(true);
      });

      /**
       * @target EventSynchronization.verifySynchronizationResponse should return false
       * when event has no active sync
       * @dependencies
       * - database
       * - ChainHandler
       * - MinimumFee
       * - EventOrder
       * @scenario
       * - mock event and transaction and insert into db
       * - mock a PaymentOrder
       * - mock ChainHandler `getChain`
       *   - mock `verifyPaymentTransaction`
       *   - mock `extractTransactionOrder`
       *   - mock `getTxConfirmationStatus`
       *   - mock `verifyTransactionExtraConditions`
       * - mock EventOrder.createEventPaymentOrder to return mocked order
       * - run test
       * - check returned value
       * @expected
       * - returned value should be false
       */
      it('should return false when event has no active sync', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // mock a PaymentOrder
        const mockedOrder: PaymentOrder = [
          {
            address: 'address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ];

        // mock ChainHandler
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        // mock `verifyPaymentTransaction`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyPaymentTransaction',
          true,
          true,
        );
        // mock `extractTransactionOrder`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'extractTransactionOrder',
          mockedOrder,
          false,
        );
        // mock `getTxConfirmationStatus`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getTxConfirmationStatus',
          ConfirmationStatus.ConfirmedEnough,
          false,
        );
        // mock `verifyTransactionExtraConditions`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyTransactionExtraConditions',
          true,
          false,
        );

        // mock EventOrder.createEventPaymentOrder to return mocked order
        mockCreateEventPaymentOrder(mockedOrder);

        // run test
        const eventSync = new TestEventSynchronization();
        const result = await eventSync.callVerifySynchronizationResponse(
          tx,
          tx.txId,
        );

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target EventSynchronization.verifySynchronizationResponse should return false
       * when transaction type is not payment
       * @dependencies
       * - database
       * - ChainHandler
       * - MinimumFee
       * - EventOrder
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock a PaymentOrder
       * - mock ChainHandler `getChain`
       *   - mock `verifyPaymentTransaction`
       *   - mock `extractTransactionOrder`
       *   - mock `getTxConfirmationStatus`
       *   - mock `verifyTransactionExtraConditions`
       * - mock EventOrder.createEventPaymentOrder to return mocked order
       * - run test
       * - check returned value
       * @expected
       * - returned value should be false
       */
      it('should return false when transaction type is not payment', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.manual,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = Array(guardsLen).fill(undefined);
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock a PaymentOrder
        const mockedOrder: PaymentOrder = [
          {
            address: 'address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ];

        // mock ChainHandler
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        // mock `verifyPaymentTransaction`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyPaymentTransaction',
          true,
          true,
        );
        // mock `extractTransactionOrder`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'extractTransactionOrder',
          mockedOrder,
          false,
        );
        // mock `getTxConfirmationStatus`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getTxConfirmationStatus',
          ConfirmationStatus.ConfirmedEnough,
          false,
        );
        // mock `verifyTransactionExtraConditions`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyTransactionExtraConditions',
          true,
          false,
        );

        // mock EventOrder.createEventPaymentOrder to return mocked order
        mockCreateEventPaymentOrder(mockedOrder);

        // run test
        const result = await eventSync.callVerifySynchronizationResponse(
          tx,
          tx.txId,
        );

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target EventSynchronization.verifySynchronizationResponse should return false
       * when transaction object is not consistent
       * @dependencies
       * - database
       * - ChainHandler
       * - MinimumFee
       * - EventOrder
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock a PaymentOrder
       * - mock ChainHandler `getChain`
       *   - mock `verifyPaymentTransaction` to return false
       *   - mock `extractTransactionOrder`
       *   - mock `getTxConfirmationStatus`
       *   - mock `verifyTransactionExtraConditions`
       * - mock EventOrder.createEventPaymentOrder to return mocked order
       * - run test
       * - check returned value
       * @expected
       * - returned value should be false
       */
      it('should return false when transaction object is not consistent', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = Array(guardsLen).fill(undefined);
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock a PaymentOrder
        const mockedOrder: PaymentOrder = [
          {
            address: 'address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ];

        // mock ChainHandler
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        // mock `verifyPaymentTransaction`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyPaymentTransaction',
          false,
          true,
        );
        // mock `extractTransactionOrder`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'extractTransactionOrder',
          mockedOrder,
          false,
        );
        // mock `getTxConfirmationStatus`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getTxConfirmationStatus',
          ConfirmationStatus.ConfirmedEnough,
          false,
        );
        // mock `verifyTransactionExtraConditions`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyTransactionExtraConditions',
          true,
          false,
        );

        // mock EventOrder.createEventPaymentOrder to return mocked order
        mockCreateEventPaymentOrder(mockedOrder);

        // run test
        const result = await eventSync.callVerifySynchronizationResponse(
          tx,
          tx.txId,
        );

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target EventSynchronization.verifySynchronizationResponse should return false
       * when transaction order is not verified
       * @dependencies
       * - database
       * - ChainHandler
       * - MinimumFee
       * - EventOrder
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock a PaymentOrder
       * - mock ChainHandler `getChain`
       *   - mock `verifyPaymentTransaction`
       *   - mock `extractTransactionOrder`
       *   - mock `getTxConfirmationStatus`
       *   - mock `verifyTransactionExtraConditions`
       * - mock EventOrder.createEventPaymentOrder to return different order
       * - run test
       * - check returned value
       * @expected
       * - returned value should be false
       */
      it('should return false when transaction order is not verified', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = Array(guardsLen).fill(undefined);
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock a PaymentOrder
        const mockedOrder: PaymentOrder = [
          {
            address: 'address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ];

        // mock ChainHandler
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        // mock `verifyPaymentTransaction`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyPaymentTransaction',
          true,
          true,
        );
        // mock `extractTransactionOrder`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'extractTransactionOrder',
          mockedOrder,
          false,
        );
        // mock `getTxConfirmationStatus`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getTxConfirmationStatus',
          ConfirmationStatus.ConfirmedEnough,
          false,
        );
        // mock `verifyTransactionExtraConditions`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyTransactionExtraConditions',
          true,
          false,
        );

        // mock EventOrder.createEventPaymentOrder to return mocked order
        mockCreateEventPaymentOrder([
          {
            address: 'different-address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ]);

        // run test
        const result = await eventSync.callVerifySynchronizationResponse(
          tx,
          tx.txId,
        );

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target EventSynchronization.verifySynchronizationResponse should return false
       * when transaction is not confirmed enough
       * @dependencies
       * - database
       * - ChainHandler
       * - MinimumFee
       * - EventOrder
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock a PaymentOrder
       * - mock ChainHandler `getChain`
       *   - mock `verifyPaymentTransaction`
       *   - mock `extractTransactionOrder`
       *   - mock `getTxConfirmationStatus` to return NotConfirmedEnough
       *   - mock `verifyTransactionExtraConditions`
       * - mock EventOrder.createEventPaymentOrder to return mocked order
       * - run test
       * - check returned value
       * @expected
       * - returned value should be false
       */
      it('should return false when transaction is not confirmed enough', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = Array(guardsLen).fill(undefined);
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock a PaymentOrder
        const mockedOrder: PaymentOrder = [
          {
            address: 'address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ];

        // mock ChainHandler
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        // mock `verifyPaymentTransaction`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyPaymentTransaction',
          true,
          true,
        );
        // mock `extractTransactionOrder`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'extractTransactionOrder',
          mockedOrder,
          false,
        );
        // mock `getTxConfirmationStatus`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getTxConfirmationStatus',
          ConfirmationStatus.NotConfirmedEnough,
          false,
        );
        // mock `verifyTransactionExtraConditions`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyTransactionExtraConditions',
          true,
          false,
        );

        // mock EventOrder.createEventPaymentOrder to return mocked order
        mockCreateEventPaymentOrder(mockedOrder);

        // run test
        const result = await eventSync.callVerifySynchronizationResponse(
          tx,
          tx.txId,
        );

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target EventSynchronization.verifySynchronizationResponse should return false
       * when transaction is not found
       * @dependencies
       * - database
       * - ChainHandler
       * - MinimumFee
       * - EventOrder
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock a PaymentOrder
       * - mock ChainHandler `getChain`
       *   - mock `verifyPaymentTransaction`
       *   - mock `extractTransactionOrder`
       *   - mock `getTxConfirmationStatus` to return NotFound
       *   - mock `verifyTransactionExtraConditions`
       * - mock EventOrder.createEventPaymentOrder to return mocked order
       * - run test
       * - check returned value
       * @expected
       * - returned value should be false
       */
      it('should return false when transaction is not found', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = Array(guardsLen).fill(undefined);
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock a PaymentOrder
        const mockedOrder: PaymentOrder = [
          {
            address: 'address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ];

        // mock ChainHandler
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        // mock `verifyPaymentTransaction`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyPaymentTransaction',
          true,
          true,
        );
        // mock `extractTransactionOrder`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'extractTransactionOrder',
          mockedOrder,
          false,
        );
        // mock `getTxConfirmationStatus`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getTxConfirmationStatus',
          ConfirmationStatus.NotFound,
          false,
        );
        // mock `verifyTransactionExtraConditions`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyTransactionExtraConditions',
          true,
          false,
        );

        // mock EventOrder.createEventPaymentOrder to return mocked order
        mockCreateEventPaymentOrder(mockedOrder);

        // run test
        const result = await eventSync.callVerifySynchronizationResponse(
          tx,
          tx.txId,
        );

        // check returned value
        expect(result).toEqual(false);
      });

      /**
       * @target EventSynchronization.verifySynchronizationResponse should return false
       * when transaction extra conditions are not verified
       * @dependencies
       * - database
       * - ChainHandler
       * - MinimumFee
       * - EventOrder
       * @scenario
       * - mock event and transaction and insert into db
       * - insert event into active sync
       * - mock a PaymentOrder
       * - mock ChainHandler `getChain`
       *   - mock `verifyPaymentTransaction`
       *   - mock `extractTransactionOrder`
       *   - mock `getTxConfirmationStatus`
       *   - mock `verifyTransactionExtraConditions` to return false
       *   - mock `getActualTxId`
       * - mock EventOrder.createEventPaymentOrder to return mocked order
       * - run test
       * - check returned value
       * @expected
       * - returned value should be false
       */
      it('should return false when transaction extra conditions are not verified', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        const eventId = EventSerializer.getId(mockedEvent);
        const tx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = Array(guardsLen).fill(undefined);
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // mock a PaymentOrder
        const mockedOrder: PaymentOrder = [
          {
            address: 'address',
            assets: {
              nativeToken: 10n,
              tokens: [],
            },
          },
        ];

        // mock ChainHandler
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        // mock `verifyPaymentTransaction`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyPaymentTransaction',
          true,
          true,
        );
        // mock `extractTransactionOrder`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'extractTransactionOrder',
          mockedOrder,
          false,
        );
        // mock `getTxConfirmationStatus`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getTxConfirmationStatus',
          ConfirmationStatus.ConfirmedEnough,
          false,
        );
        // mock `verifyTransactionExtraConditions`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'verifyTransactionExtraConditions',
          false,
          false,
        );
        // mock `getActualTxId`
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getActualTxId',
          tx.txId,
          true,
        );

        // mock EventOrder.createEventPaymentOrder to return mocked order
        mockCreateEventPaymentOrder(mockedOrder);

        // run test
        const result = await eventSync.callVerifySynchronizationResponse(
          tx,
          tx.txId,
        );

        // check returned value
        expect(result).toEqual(false);
      });
    });

    describe(`setTxAsApproved`, () => {
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        ChainHandlerMock.resetMock();
      });

      /**
       * @target EventSynchronization.setTxAsApproved should insert transaction
       * into database and update event status
       * @dependencies
       * - database
       * - ChainHandler
       * @scenario
       * - mock event and transaction and insert into db
       * - mock ChainHandler `getChain`
       *   - mock `getHeight`
       * - insert event into active sync
       * - run test
       * - check database
       * - check active syncs in memory
       * @expected
       * - tx should be inserted into db
       * - event status should be updated in db
       * - event should be removed from active sync
       */
      it('should insert transaction into database and update event status', async () => {
        // mock event and transaction and insert into db
        const mockedEvent = EventTestData.mockEventTrigger().event;
        mockedEvent.fromChain = 'ethereum';
        mockedEvent.toChain = 'binance';
        const eventId = EventSerializer.getId(mockedEvent);
        const paymentTx = mockPaymentTransaction(
          TransactionType.payment,
          mockedEvent.toChain,
          eventId,
        );
        await DatabaseActionMock.insertEventRecord(
          mockedEvent,
          EventStatus.pendingPayment,
        );

        // mock ChainHandler `getChain`
        const mockedCurrentHeight = 100;
        ChainHandlerMock.mockChainName(mockedEvent.toChain);
        ChainHandlerMock.mockChainFunction(
          mockedEvent.toChain,
          'getHeight',
          mockedCurrentHeight,
          true,
        );

        // insert event into active sync
        const eventSync = new TestEventSynchronization();
        const responses = Array(Configs.tssKeys.pubs.length).fill(undefined);
        eventSync.insertEventIntoActiveSync(eventId, {
          timestamp: TestConfigs.currentTimeStamp / 1000 - 100,
          responses: responses,
        });

        // run test
        // This persistence unit fixture supplies the independently tested verification port.
        vi.spyOn(
          eventSync as unknown as {
            verifySynchronizationResponse: (
              tx: PaymentTransaction,
              id: string,
            ) => Promise<boolean>;
          },
          'verifySynchronizationResponse',
        ).mockResolvedValue(true);
        await eventSync.callSetTxAsApproved(paymentTx);

        // tx should be inserted into db
        const dbTxs = (await DatabaseActionMock.allTxRecords()).map((tx) => [
          tx.txId,
          tx.txJson,
          tx.event?.id,
          tx.status,
        ]);
        expect(dbTxs.length).toEqual(1);
        expect(dbTxs).toContainEqual([
          paymentTx.txId,
          paymentTx.toJson(),
          eventId,
          TransactionStatus.completed,
        ]);

        // event status should be updated in db
        const dbEvents = (await DatabaseActionMock.allEventRecords()).map(
          (event) => [event.id, event.status],
        );
        expect(dbEvents.length).toEqual(1);
        expect(dbEvents).toContainEqual([eventId, EventStatus.pendingReward]);

        // event should be removed from active sync
        expect(eventSync.getActiveSyncMap().size).toEqual(0);
      });
    });

    describe('timeoutActiveSyncs', () => {
      const guardsLen = Configs.tssKeys.pubs.length;

      beforeAll(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(TestConfigs.currentTimeStamp));
      });

      afterAll(() => {
        vi.useRealTimers();
      });

      /**
       * @target EventSynchronization.timeoutActiveSyncs should remove event from
       * active sync when enough time is passed
       * @dependencies
       * - Date
       * @scenario
       * - mock two events
       * - insert events into active sync
       * - run test
       * - check active syncs in memory
       * @expected
       * - one event should be removed from active sync
       */
      it('should remove event from active sync when enough time is passed', async () => {
        // mock two events
        const mockedEvent1 = EventTestData.mockEventTrigger().event;
        const eventId1 = EventSerializer.getId(mockedEvent1);
        const mockedEvent2 = EventTestData.mockEventTrigger().event;
        const eventId2 = EventSerializer.getId(mockedEvent2);

        // insert events into active sync
        const eventSync = new TestEventSynchronization();
        eventSync.insertEventIntoActiveSync(eventId1, {
          timestamp:
            TestConfigs.currentTimeStamp / 1000 -
            Configs.eventSyncTimeout -
            100,
          responses: Array(guardsLen).fill(undefined),
        });
        const event2ActiveSync = {
          timestamp:
            TestConfigs.currentTimeStamp / 1000 -
            Configs.eventSyncTimeout +
            100,
          responses: Array(guardsLen).fill(undefined),
        };
        eventSync.insertEventIntoActiveSync(eventId2, event2ActiveSync);

        // run test
        await eventSync.timeoutActiveSyncs();

        // one event should be removed from active sync
        const activeSyncMap = eventSync.getActiveSyncMap();
        expect(activeSyncMap.size).toEqual(1);
        expect(activeSyncMap.get(eventId2)).toEqual(event2ActiveSync);
      });
    });
  });
  describe('setTxAsApproved', () => {
    describe('generic synchronization approval and real SQLite CAS join', () => {
      const db = () => DatabaseActionMock.testDatabase;
      const height = vi.fn();
      const txNotify = vi.fn();
      const eventNotify = vi.fn();
      let sync: PersistenceSynchronization;
      let payment: PaymentTransaction;
      let eventId: string;
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        const event = mockEventTrigger().event;
        event.fromChain = 'ethereum';
        event.toChain = 'ergo';
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.pendingPayment,
        );
        eventId = Utils.txIdToEventId(event.sourceTxId);
        payment = new ErgoTransaction(
          'generic-sync-payment',
          eventId,
          Buffer.from('abcd', 'hex'),
          TransactionType.payment,
          [Buffer.from('dcba', 'hex')],
          [],
        );
        height.mockReset().mockResolvedValue(123);
        vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
          getChain: () => ({ getHeight: height }),
        } as unknown as ChainHandler);
        txNotify.mockReset();
        eventNotify.mockReset();
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicTxStatus',
        ).mockImplementation(txNotify);
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicEventStatus',
        ).mockImplementation(eventNotify);
        sync = new PersistenceSynchronization();
        sync.activate(eventId);
      });
      afterEach(() => vi.restoreAllMocks());

      /**
       * @target EventSynchronization.setTxAsApproved commits the captured payment and event before clearing synchronization
       * @dependencies Existing serializer and guard ports; real SQLite DAO; verification/height fixtures.
       * @scenario Activate a pending Ergo payment; approve it; read persisted row and event.
       * @expected One completed payment, completed event, one notification each, and removed active synchronization.
       */
      it('commits the captured payment and event before clearing synchronization', async () => {
        await sync.approve(payment);
        expect(await db().getTxById(payment.txId)).toMatchObject({
          txJson: payment.toJson(),
          status: TransactionStatus.completed,
          lastCheck: 123,
        });
        expect((await db().getEventById(eventId))!.status).toBe(
          EventStatus.completed,
        );
        expect(txNotify).toHaveBeenCalledTimes(1);
        expect(eventNotify).toHaveBeenCalledTimes(1);
        expect(sync.active(eventId)).toBe(false);
      });

      /**
       * @target EventSynchronization.setTxAsApproved refuses %s between verification and SQL ownership
       * @dependencies Real SQLite CAS and fixed verification/height ports.
       * @scenario Inject exactly one named state, model, guard or height change while obtaining height; approve.
       * @expected No payment or notification is persisted; the active synchronization survives refusal.
       */
      it.each([
        'event phase',
        'event field',
        'replacement synchronization',
        'payment mutation',
        'guard rotation',
        'negative height',
        'unsafe height',
      ])('refuses %s between verification and SQL ownership', async (fault) => {
        height.mockImplementation(async () => {
          if (fault === 'event phase')
            await db().ConfirmedEventRepository.update(
              { id: eventId },
              { status: EventStatus.inPayment },
            );
          if (fault === 'event field')
            await db().EventRepository.update({ eventId }, { amount: '99' });
          if (fault === 'replacement synchronization') sync.activate(eventId);
          if (fault === 'payment mutation')
            sync.verification.mock.calls[0][0].txBytes = Buffer.from(
              'eeee',
              'hex',
            );
          if (fault === 'guard rotation') {
            const guards = GuardPkHandler.getInstance();
            vi.spyOn(GuardPkHandler, 'getInstance').mockReturnValue({
              ...guards,
              requiredSign: guards.requiredSign + 1,
            } as GuardPkHandler);
          }
          return fault === 'negative height'
            ? -1
            : fault === 'unsafe height'
              ? Number.MAX_SAFE_INTEGER + 1
              : 123;
        });
        await sync.approve(payment);
        expect(await db().getTxById(payment.txId)).toBeNull();
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
        expect(sync.active(eventId)).toBe(true);
      });

      /**
       * @target EventSynchronization.setTxAsApproved refuses failed re-verification before asking for height or writing
       * @dependencies Real SQLite DAO and explicit false verification fixture.
       * @scenario Return false when approval repeats verification of an active model.
       * @expected No height query, row, event change, notification or synchronization deletion.
       */
      it('refuses failed re-verification before asking for height or writing', async () => {
        sync.verification.mockResolvedValue(false);
        await sync.approve(payment);
        expect(height).not.toHaveBeenCalled();
        expect(await db().getTxById(payment.txId)).toBeNull();
        expect((await db().getEventById(eventId))!.status).toBe(
          EventStatus.pendingPayment,
        );
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
        expect(sync.active(eventId)).toBe(true);
      });
    });
  });

  describe('verifySynchronizationResponse', () => {
    let sync: SynchronizationFixture;
    const confirmation = vi.fn();
    let target = 'ethereum';
    beforeEach(() => {
      sync = new SynchronizationFixture();
      sync.activate();
      target = 'ethereum';
      confirmation
        .mockReset()
        .mockResolvedValue(ConfirmationStatus.ConfirmedEnough);
      vi.spyOn(DatabaseAction.getInstance(), 'getEventById').mockResolvedValue({
        eventData: { txId: 'trigger' },
      } as never);
      vi.spyOn(EventSerializer, 'fromConfirmedEntity').mockImplementation(
        () => ({ toChain: target }) as never,
      );
      vi.spyOn(MinimumFeeHandler, 'getEventFeeConfig').mockReturnValue(
        {} as never,
      );
      vi.spyOn(EventOrder, 'createEventPaymentOrder').mockResolvedValue([]);
      vi.spyOn(EventBoxes, 'getEventWIDs').mockResolvedValue([]);
      vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
        getChain: () => ({
          verifyPaymentTransaction: vi.fn().mockResolvedValue(true),
          extractTransactionOrder: () => [],
          getTxConfirmationStatus: confirmation,
          verifyTransactionExtraConditions: () => true,
        }),
      } as unknown as ChainHandler);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    for (const chain of ['ethereum', 'binance']) {
      /**
       * @target EventSynchronization.verifySynchronizationResponse `confirms the derived signed ${chain} hash instead of its unsigned identifier`
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke EventSynchronization.verifySynchronizationResponse, and inspect the returned result and resulting state.
       * @expected `confirms the derived signed ${chain} hash instead of its unsigned identifier`; rejected mutations preserve state and do not notify.
       */

      it(`confirms the derived signed ${chain} hash instead of its unsigned identifier`, async () => {
        target = chain;
        const { signed, payment } = evm(chain);
        expect(signed.hash).not.toBe(payment.txId);
        expect(await sync.verify(payment, signed.hash!)).toBe(true);
        expect(confirmation).toHaveBeenCalledWith(
          signed.hash,
          TransactionType.payment,
        );
      });
      for (const fault of [
        'unrelated hash',
        'unsigned hash',
        'malformed hash',
        'unsigned bytes',
        'wrong model id',
        'changed signed body',
      ]) {
        /**
         * @target EventSynchronization.verifySynchronizationResponse `rejects ${chain} ${fault} before confirmation`
         * @dependencies Existing production DAO/chain ports and synthetic fixtures.
         * @scenario Prepare the suite fixture, apply the named input or concurrent change,
         * invoke EventSynchronization.verifySynchronizationResponse, and inspect the returned result and resulting state.
         * @expected `rejects ${chain} ${fault} before confirmation`; rejected mutations preserve state and do not notify.
         */

        it(`rejects ${chain} ${fault} before confirmation`, async () => {
          target = chain;
          const { signed, payment } = evm(chain);
          let actual = signed.hash!;
          if (fault === 'unrelated hash') actual = '0x' + '9'.repeat(64);
          if (fault === 'unsigned hash') actual = signed.unsignedHash;
          if (fault === 'malformed hash') actual = 'invalid';
          if (fault === 'unsigned bytes')
            payment.txBytes = Buffer.from(
              signed.unsignedSerialized.slice(2),
              'hex',
            );
          if (fault === 'wrong model id') payment.txId = '0x' + '8'.repeat(64);
          if (fault === 'changed signed body') {
            const other = evm(chain, 2);
            payment.txBytes = other.payment.txBytes;
            payment.txId = other.payment.txId;
          }
          expect(await sync.verify(payment, actual)).toBe(false);
          expect(confirmation).not.toHaveBeenCalled();
        });
      }
    }
    /**
     * @target EventSynchronization.verifySynchronizationResponse 'accepts case variation in the remote hexadecimal hash but queries its canonical form'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.verifySynchronizationResponse, and inspect the returned result and resulting state.
     * @expected 'accepts case variation in the remote hexadecimal hash but queries its canonical form'; rejected mutations preserve state and do not notify.
     */

    it('accepts case variation in the remote hexadecimal hash but queries its canonical form', async () => {
      const { signed, payment } = evm();
      expect(
        await sync.verify(payment, '0x' + signed.hash!.slice(2).toUpperCase()),
      ).toBe(true);
      expect(confirmation.mock.calls[0][0]).toBe(signed.hash);
    });
    /**
     * @target EventSynchronization.verifySynchronizationResponse 'rejects a network different from the event destination'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.verifySynchronizationResponse, and inspect the returned result and resulting state.
     * @expected 'rejects a network different from the event destination'; rejected mutations preserve state and do not notify.
     */

    it('rejects a network different from the event destination', async () => {
      const { signed, payment } = evm('binance');
      expect(await sync.verify(payment, signed.hash!)).toBe(false);
      expect(confirmation).not.toHaveBeenCalled();
    });
    /**
     * @target EventSynchronization.verifySynchronizationResponse 'rejects a non-payment response'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.verifySynchronizationResponse, and inspect the returned result and resulting state.
     * @expected 'rejects a non-payment response'; rejected mutations preserve state and do not notify.
     */

    it('rejects a non-payment response', async () => {
      const { signed, payment } = evm();
      payment.txType = TransactionType.reward;
      expect(await sync.verify(payment, signed.hash!)).toBe(false);
      expect(confirmation).not.toHaveBeenCalled();
    });
    for (const result of [
      ConfirmationStatus.NotFound,
      ConfirmationStatus.NotConfirmedEnough,
      undefined,
      'unexpected',
    ]) {
      /**
       * @target EventSynchronization.verifySynchronizationResponse `requires positive ConfirmedEnough instead of accepting ${String(result)}`
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke EventSynchronization.verifySynchronizationResponse, and inspect the returned result and resulting state.
       * @expected `requires positive ConfirmedEnough instead of accepting ${String(result)}`; rejected mutations preserve state and do not notify.
       */

      it(`requires positive ConfirmedEnough instead of accepting ${String(result)}`, async () => {
        confirmation.mockResolvedValue(result);
        const { signed, payment } = evm();
        expect(await sync.verify(payment, signed.hash!)).toBe(false);
      });
    }
    for (const chain of ['doge', 'firo']) {
      /**
       * @target EventSynchronization.verifySynchronizationResponse `preserves the legacy ${chain} signed/unsigned identifier distinction`
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke EventSynchronization.verifySynchronizationResponse, and inspect the returned result and resulting state.
       * @expected `preserves the legacy ${chain} signed/unsigned identifier distinction`; rejected mutations preserve state and do not notify.
       */

      it(`preserves the legacy ${chain} signed/unsigned identifier distinction`, async () => {
        target = chain;
        const tx = new PaymentTransaction(
          chain,
          'unsigned-id',
          eventId,
          Buffer.from('ab', 'hex'),
          TransactionType.payment,
        );
        expect(await sync.verify(tx, 'different-signed-id')).toBe(true);
        expect(confirmation).toHaveBeenCalledWith(
          'different-signed-id',
          TransactionType.payment,
        );
      });
    }
    /**
     * @target EventSynchronization.verifySynchronizationResponse 'owns a snapshot before the first event lookup await'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.verifySynchronizationResponse, and inspect the returned result and resulting state.
     * @expected 'owns a snapshot before the first event lookup await'; rejected mutations preserve state and do not notify.
     */

    it('owns a snapshot before the first event lookup await', async () => {
      const pending =
        deferred<Awaited<ReturnType<DatabaseAction['getEventById']>>>();
      vi.mocked(DatabaseAction.getInstance().getEventById).mockReturnValueOnce(
        pending.promise,
      );
      const { signed, payment } = evm();
      const verifying = sync.verify(payment, signed.hash!);
      payment.txBytes.fill(0);
      payment.network = 'binance';
      pending.resolve({ eventData: { txId: 'trigger' } } as never);
      expect(await verifying).toBe(true);
      expect(confirmation).toHaveBeenCalledWith(
        signed.hash,
        TransactionType.payment,
      );
    });
  });

  describe('processSyncResponse', () => {
    let sync: SynchronizationFixture;
    beforeEach(() => {
      vi.spyOn(ChainHandler, 'getInstance').mockReturnValue({
        getChain: vi.fn(),
      } as unknown as ChainHandler);
      sync = new SynchronizationFixture();
      sync.activate();
      sync.useVerification(vi.fn().mockResolvedValue(true));
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    /**
     * @target EventSynchronization.processSyncResponse 'approves two unique senders of the same full model'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'approves two unique senders of the same full model'; rejected mutations preserve state and do not notify.
     */

    it('approves two unique senders of the same full model', async () => {
      await sync.respond(ergo(), 'actual', 0);
      await sync.respond(ergo(), 'actual', 1);
      expect(sync.setTxAsApproved).toHaveBeenCalledTimes(1);
      expect(sync.setTxAsApproved.mock.calls[0][0].toJson()).toBe(
        ergo().toJson(),
      );
    });
    for (const field of [
      'txId',
      'network',
      'eventId',
      'txType',
      'txBytes',
      'inputBoxes',
      'dataInputs',
    ]) {
      /**
       * @target EventSynchronization.processSyncResponse `does not combine votes that differ only in ${field}`
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
       * @expected `does not combine votes that differ only in ${field}`; rejected mutations preserve state and do not notify.
       */

      it(`does not combine votes that differ only in ${field}`, async () => {
        const first = ergo();
        const second = ergo();
        if (field === 'txId') second.txId = 'another-id';
        if (field === 'network') {
          // Retain the complete auxiliary model while changing only its network.
          second.network = 'another-ergo';
        }
        if (field === 'eventId') {
          second.eventId = 'b'.repeat(64);
          sync.activate(second.eventId);
        }
        if (field === 'txType') second.txType = TransactionType.reward;
        if (field === 'txBytes') second.txBytes[0] = 0;
        if (field === 'inputBoxes') second.inputBoxes[0][0] = 0;
        if (field === 'dataInputs') second.dataInputs[0][0] = 0;
        await sync.respond(first, 'actual', 0);
        if (field === 'network') {
          // Existing serializers reject a polymorphic model routed to another chain.
          await expect(sync.respond(second, 'actual', 1)).rejects.toThrow();
        } else await sync.respond(second, 'actual', 1);
        expect(sync.setTxAsApproved).not.toHaveBeenCalled();
      });
    }
    /**
     * @target EventSynchronization.processSyncResponse 'keeps three split votes separate'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'keeps three split votes separate'; rejected mutations preserve state and do not notify.
     */

    it('keeps three split votes separate', async () => {
      for (let sender = 0; sender < 3; sender++) {
        const tx = ergo();
        tx.txId = `candidate-${sender}`;
        await sync.respond(tx, 'actual', sender);
      }
      expect(sync.setTxAsApproved).not.toHaveBeenCalled();
    });
    /**
     * @target EventSynchronization.processSyncResponse 'does not let a previous candidate majority approve a new candidate'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'does not let a previous candidate majority approve a new candidate'; rejected mutations preserve state and do not notify.
     */

    it('does not let a previous candidate majority approve a new candidate', async () => {
      await sync.respond(ergo(), 'actual', 0);
      await sync.respond(ergo(), 'actual', 1);
      expect(sync.setTxAsApproved).toHaveBeenCalledTimes(1);
      const next = ergo();
      next.txId = 'new-candidate';
      await sync.respond(next, 'actual', 2);
      expect(sync.setTxAsApproved).toHaveBeenCalledTimes(1);
    });
    /**
     * @target EventSynchronization.processSyncResponse 'counts a repeated sender only once and ignores its replacement vote'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'counts a repeated sender only once and ignores its replacement vote'; rejected mutations preserve state and do not notify.
     */

    it('counts a repeated sender only once and ignores its replacement vote', async () => {
      await sync.respond(ergo(), 'actual', 0);
      await sync.respond(ergo(), 'actual', 0);
      const replacement = ergo();
      replacement.txId = 'replacement';
      await sync.respond(replacement, 'actual', 0);
      expect(sync.setTxAsApproved).not.toHaveBeenCalled();
      await sync.respond(replacement, 'actual', 1);
      expect(sync.setTxAsApproved).not.toHaveBeenCalled();
      await sync.respond(ergo(), 'actual', 2);
      expect(sync.setTxAsApproved).toHaveBeenCalledTimes(1);
    });
    for (const sender of [-1, 0.5, Number.NaN, 999]) {
      /**
       * @target EventSynchronization.processSyncResponse `rejects invalid sender index ${sender}`
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
       * @expected `rejects invalid sender index ${sender}`; rejected mutations preserve state and do not notify.
       */

      it(`rejects invalid sender index ${sender}`, async () => {
        await sync.respond(ergo(), 'actual', sender);
        await sync.respond(ergo(), 'actual', 0);
        expect(sync.setTxAsApproved).not.toHaveBeenCalled();
      });
    }
    /**
     * @target EventSynchronization.processSyncResponse 'captures complete caller bytes and auxiliary arrays before asynchronous verification'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'captures complete caller bytes and auxiliary arrays before asynchronous verification'; rejected mutations preserve state and do not notify.
     */

    it('captures complete caller bytes and auxiliary arrays before asynchronous verification', async () => {
      const pending = deferred<boolean>();
      sync.useVerification(() => pending.promise);
      const tx = ergo();
      const responding = sync.respond(tx, 'actual', 0);
      tx.txBytes[0] = 0;
      tx.inputBoxes[0][0] = 0;
      tx.dataInputs[0][0] = 0;
      tx.txId = 'changed';
      pending.resolve(true);
      await responding;
      await sync.respond(ergo(), 'actual', 1);
      expect(sync.setTxAsApproved).toHaveBeenCalledTimes(1);
      expect(sync.setTxAsApproved.mock.calls[0][0].toJson()).toBe(
        ergo().toJson(),
      );
    });
    /**
     * @target EventSynchronization.processSyncResponse 'does not apply an old verified response to a replacement synchronization'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'does not apply an old verified response to a replacement synchronization'; rejected mutations preserve state and do not notify.
     */

    it('does not apply an old verified response to a replacement synchronization', async () => {
      const pending = deferred<boolean>();
      sync.useVerification(() => pending.promise);
      const responding = sync.respond(ergo(), 'actual', 0);
      const replacement = sync.activate();
      pending.resolve(true);
      await responding;
      expect(
        replacement.responses.every((response) => response === undefined),
      ).toBe(true);
      expect(sync.setTxAsApproved).not.toHaveBeenCalled();
    });
    /**
     * @target EventSynchronization.processSyncResponse 'rechecks active synchronization identity after waiting for the approval semaphore'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'rechecks active synchronization identity after waiting for the approval semaphore'; rejected mutations preserve state and do not notify.
     */

    it('rechecks active synchronization identity after waiting for the approval semaphore', async () => {
      const release = await sync.acquireApproval();
      const verified = deferred<void>();
      sync.useVerification(async () => {
        verified.resolve();
        return true;
      });
      const responding = sync.respond(ergo(), 'actual', 0);
      await verified.promise;
      const replacement = sync.activate();
      release();
      await responding;
      expect(
        replacement.responses.every((response) => response === undefined),
      ).toBe(true);
      expect(sync.setTxAsApproved).not.toHaveBeenCalled();
    });
    /**
     * @target EventSynchronization.processSyncResponse 'counts immutable verified response content after the stored model is mutated'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'counts immutable verified response content after the stored model is mutated'; rejected mutations preserve state and do not notify.
     */

    it('counts immutable verified response content after the stored model is mutated', async () => {
      const active = sync.activate();
      await sync.respond(ergo(), 'actual', 0);
      const stored = active.responses[0] as ErgoTransaction;
      stored.txId = 'mutated';
      stored.txBytes[0] = 0;
      stored.inputBoxes[0][0] = 0;
      await sync.respond(ergo(), 'actual', 1);
      expect(sync.setTxAsApproved).toHaveBeenCalledTimes(1);
      expect(sync.setTxAsApproved.mock.calls[0][0].toJson()).toBe(
        ergo().toJson(),
      );
    });
    /**
     * @target EventSynchronization.processSyncResponse 'rejects mutation by a verifier instead of approving unverified bytes'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'rejects mutation by a verifier instead of approving unverified bytes'; rejected mutations preserve state and do not notify.
     */

    it('rejects mutation by a verifier instead of approving unverified bytes', async () => {
      sync.useVerification(async (tx) => {
        tx.txBytes[0] = 0;
        return true;
      });
      await expect(sync.respond(ergo(), 'actual', 0)).rejects.toThrow(
        'changed during verification',
      );
      expect(sync.setTxAsApproved).not.toHaveBeenCalled();
    });
    /**
     * @target EventSynchronization.processSyncResponse 'serializes concurrent responses from the same sender into one vote'
     * @dependencies Existing production DAO/chain ports and synthetic fixtures.
     * @scenario Prepare the suite fixture, apply the named input or concurrent change,
     * invoke EventSynchronization.processSyncResponse, and inspect the returned result and resulting state.
     * @expected 'serializes concurrent responses from the same sender into one vote'; rejected mutations preserve state and do not notify.
     */

    it('serializes concurrent responses from the same sender into one vote', async () => {
      const pending = deferred<boolean>();
      sync.useVerification(() => pending.promise);
      const first = sync.respond(ergo(), 'actual', 0);
      const second = sync.respond(ergo(), 'actual', 0);
      pending.resolve(true);
      await Promise.all([first, second]);
      expect(sync.setTxAsApproved).not.toHaveBeenCalled();
    });
  });
});
