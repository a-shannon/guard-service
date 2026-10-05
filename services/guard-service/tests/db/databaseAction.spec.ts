import { setTimeout as delay } from 'node:timers/promises';
import type { MockInstance } from 'vitest';

import { EntitySubscriberInterface } from '@rosen-bridge/extended-typeorm';
import { UpdateEvent } from '@rosen-bridge/extended-typeorm';
import { EventTriggerEntity } from '@rosen-bridge/watcher-data-extractor';
import { TransactionType } from '@rosen-chains/abstract-chain';
import { PaymentTransaction } from '@rosen-chains/abstract-chain';
import { ERGO_CHAIN } from '@rosen-chains/ergo';
import { ErgoTransaction } from '@rosen-chains/ergo';

import { DatabaseAction } from '../../src/db/databaseAction';
import type { TransactionCheckPreimage } from '../../src/db/databaseAction';
import { ConfirmedEventEntity } from '../../src/db/entities/confirmedEventEntity';
import { TransactionEntity } from '../../src/db/entities/transactionEntity';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import type { SigningRowPreimage } from '../../src/signing/transactionSigningContext';
import type { SigningPersistenceAuthorization } from '../../src/signing/transactionSigningContext';
import { SortRequest } from '../../src/types/api';
import { EventStatus } from '../../src/utils/constants';
import { RevenuePeriod } from '../../src/utils/constants';
import { RevenueType } from '../../src/utils/constants';
import { TransactionStatus } from '../../src/utils/constants';
import { OrderStatus } from '../../src/utils/constants';
import Utils from '../../src/utils/utils';
import * as TxTestData from '../agreement/testData';
import * as EventTestData from '../event/testData';
import { mockEventTrigger } from '../event/testData';
import PublicStatusHandlerMock from '../handlers/mocked/publicStatusHandler.mock';
import TestConfigs from '../testUtils/testConfigs';
import TestUtils from '../testUtils/testUtils';
import { insertCompletedEvent } from './databaseTestUtils';
import { insertEventsWithAmount } from './databaseTestUtils';
import { insertEventsWithHeight } from './databaseTestUtils';
import { insertRevenueDataWithDifferentNetworks } from './databaseTestUtils';
import { insertRevenueDataWithTimestamps } from './databaseTestUtils';
import DatabaseActionMock from './mocked/databaseAction.mock';

describe('DatabaseAction', () => {
  describe('baseline scenarios', () => {
    afterAll(() => vi.restoreAllMocks());
    beforeEach(async () => {
      await DatabaseActionMock.clearTables();
      PublicStatusHandlerMock.resetMock();
      PublicStatusHandlerMock.mock();
    });

    describe('getEvents', () => {
      /**
       * @target DatabaseAction.getEvents should return completed events successfully
       * @dependencies
       * - database
       * @scenario
       * - insert 6 mocked events
       *   - completed event
       *   - unspent event with timeout status
       *   - rejected event
       *   - timeout event with spendTxId
       *   - unspent event with pending-payment status
       *   - unconfirmed event
       * - run test (call `getEvents`) with ascending sort
       * - check events
       * @expected
       * - should return 4 events
       *   - completed event
       *   - unspent event with timeout status
       *   - rejected event
       *   - timeout event with spendTxId event
       */
      it('should return completed events successfully', async () => {
        // insert 6 mocked events
        //  completed event
        const completedEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          completedEvent,
          EventStatus.completed,
          'box_serialized',
          300,
          undefined,
          1000,
          1040,
          'spendBlockId',
          'spendTxId',
          'successful',
          'paymentTxId',
        );
        //  unspent event with timeout status
        const timeoutEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          timeoutEvent,
          EventStatus.timeout,
        );
        //  rejected event
        const rejectedEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          rejectedEvent,
          EventStatus.rejected,
        );
        //  timeout event with spendTxId
        const spentTimeoutEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          spentTimeoutEvent,
          EventStatus.timeout,
          'box_serialized',
          300,
          undefined,
          1000,
          1040,
          'spendBlockId',
          'spendTxId',
          'successful',
          'paymentTxId',
        );
        //  unspent event with pending-payment status
        const unspentEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          unspentEvent,
          EventStatus.pendingPayment,
        );
        //  unconfirmed event
        const unconfirmedEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertOnlyEventDataRecord(unconfirmedEvent);

        // run test
        const events = await DatabaseAction.getInstance().getEvents(
          true,
          SortRequest.ASC,
          undefined,
          undefined,
          undefined,
          undefined,
        );

        // check events
        expect(events.total).toEqual(4);
        const eventSourceTxIds = events.items.map((event) => event.sourceTxId);
        expect(eventSourceTxIds).toContainEqual(completedEvent.sourceTxId);
        expect(eventSourceTxIds).toContainEqual(timeoutEvent.sourceTxId);
        expect(eventSourceTxIds).toContainEqual(rejectedEvent.sourceTxId);
        expect(eventSourceTxIds).toContainEqual(spentTimeoutEvent.sourceTxId);
      });
      /**
       * @target DatabaseAction.getEvents should return ongoing events successfully
       * @dependencies
       * - database
       * @scenario
       * - insert 6 mocked events
       *   - completed event
       *   - unspent event with timeout status
       *   - rejected event
       *   - timeout event with spendTxId
       *   - unspent event with pending-payment status
       *   - unconfirmed event
       * - run test (call `getEvents`) with ascending sort
       * - check events
       * @expected
       * - should return 2 events
       *   - unspent event with pending-payment status
       *   - unconfirmed event
       */
      it('should return ongoing events successfully', async () => {
        // insert 6 mocked events
        //  completed event
        const completedEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          completedEvent,
          EventStatus.completed,
          'box_serialized',
          300,
          undefined,
          1000,
          1040,
          'spendBlockId',
          'spendTxId',
          'successful',
          'paymentTxId',
        );
        //  unspent event with timeout status
        const timeoutEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          timeoutEvent,
          EventStatus.timeout,
        );
        //  rejected event
        const rejectedEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          rejectedEvent,
          EventStatus.rejected,
        );
        //  timeout event with spendTxId
        const spentTimeoutEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          spentTimeoutEvent,
          EventStatus.timeout,
          'box_serialized',
          300,
          undefined,
          1000,
          1040,
          'spendBlockId',
          'spendTxId',
          'successful',
          'paymentTxId',
        );
        //  unspent event with pending-payment status
        const unspentEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          unspentEvent,
          EventStatus.pendingPayment,
        );
        //  unconfirmed event
        const unconfirmedEvent = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertOnlyEventDataRecord(unconfirmedEvent);

        // run test
        const events = await DatabaseAction.getInstance().getEvents(
          false,
          SortRequest.ASC,
          undefined,
          undefined,
          undefined,
          undefined,
        );

        // check events
        expect(events.total).toEqual(2);
        const eventSourceTxIds = events.items.map((event) => event.sourceTxId);
        expect(eventSourceTxIds).toContainEqual(unspentEvent.sourceTxId);
        expect(eventSourceTxIds).toContainEqual(unconfirmedEvent.sourceTxId);
      });

      /**
       * @target DatabaseAction.getEvents should return events in ascending order
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked events with various heights into db
       * - run test (call `getEvents`) with ascending sort
       * - check events
       * @expected
       * - should return 10 available events in ascending order
       * - events should be sorted from the first (in height 1000) to the last (in height 1009)
       */
      it('should return events in ascending order', async () => {
        await insertEventsWithHeight(10);
        const events = await DatabaseAction.getInstance().getEvents(
          true,
          SortRequest.ASC,
          undefined,
          undefined,
          undefined,
          undefined,
        );
        expect(events.total).toEqual(10);
        for (let index = 0; index < 10; index++) {
          expect(events.items[index].height).toEqual(1000 + index);
        }
      });

      /**
       * @target DatabaseAction.getEvents should return events in descending order
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked events with various heights into db
       * - run test (call `getEvents`) with descending sort
       * - check events
       * @expected
       * - should return 10 available events in descending order
       * - events should be sorted from the last (in height 1009) to the first (in height 1000)
       */
      it('should return events in descending order', async () => {
        await insertEventsWithHeight(10);
        const events = await DatabaseAction.getInstance().getEvents(
          true,
          SortRequest.DESC,
          undefined,
          undefined,
          undefined,
          undefined,
        );
        expect(events.total).toEqual(10);
        for (let index = 0; index < 10; index++) {
          expect(events.items[index].height).toEqual(1009 - index);
        }
      });

      /**
       * @target DatabaseHandler.getEvents should return events that are transferring assets to ergo network
       * @dependencies
       * - database
       * @scenario
       * - insert 10 "to ergo" events and 10 other mocked events into db
       * - run test (call `getEvents`) to filter "to ergo" events
       * - check events
       * @expected
       * - should return 10 events "to ergo" network
       */
      it('should return events that are transferring assets to ergo network', async () => {
        for (let index = 0; index < 10; index++) {
          // insert 10 mocked events into db
          const mockedEvent = EventTestData.mockEventTrigger().event;
          await insertCompletedEvent(mockedEvent);
          // insert 10 mocked events to ergo network into db
          const mockedErgoEvent = EventTestData.mockToErgoEventTrigger().event;
          await insertCompletedEvent(mockedErgoEvent);
        }

        const events = await DatabaseAction.getInstance().getEvents(
          true,
          undefined,
          undefined,
          ERGO_CHAIN,
          undefined,
          undefined,
        );
        expect(events.total).toEqual(10);
        for (const event of events.items) {
          expect(event.toChain).toEqual(ERGO_CHAIN);
        }
      });

      /**
       * @target DatabaseHandler.getEvents should return events that are transferring assets from ergo network
       * @dependencies
       * - database
       * @scenario
       * - insert 10 "from ergo" events and 10 other mocked events into db
       * - run test (call `getEvents`) to filter "from ergo" events
       * - check events
       * @expected
       * - should return 10 events "from ergo" network
       */
      it('should return events that are transferring assets from ergo network', async () => {
        for (let index = 0; index < 10; index++) {
          // insert 10 mocked events into db
          const mockedEvent = EventTestData.mockEventTrigger().event;
          await insertCompletedEvent(mockedEvent);

          // insert 10 mocked events from ergo network into db
          const mockedEvent2 = EventTestData.mockFromErgoEventTrigger().event;
          await insertCompletedEvent(mockedEvent2);
        }

        const events = await DatabaseAction.getInstance().getEvents(
          true,
          undefined,
          ERGO_CHAIN,
          undefined,
          undefined,
          undefined,
        );
        expect(events.total).toEqual(10);
        for (const event of events.items) {
          expect(event.fromChain).toEqual(ERGO_CHAIN);
        }
      });

      /**
       * @target DatabaseAction.getEvents should return events with at least minimum amount
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked events with various amounts into db
       * - run test (call `getEvents`) to filter events with minimum amount
       * - check events
       * @expected
       * - should return 5 events with value more than or equal to 15000
       */
      it('should return events with at least minimum amount', async () => {
        await insertEventsWithAmount(10);
        const events = await DatabaseAction.getInstance().getEvents(
          true,
          undefined,
          undefined,
          undefined,
          '15000',
          undefined,
        );
        expect(events.total).toEqual(5);
        for (const event of events.items) {
          expect(BigInt(event.amount)).toBeGreaterThanOrEqual(15000n);
        }
      });

      /**
       * @target DatabaseAction.getEvents should return events with amount less than the maximum value
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked events with various amounts into db
       * - run test (call `getEvents`) to filter events with maximum amount
       * - check events
       * @expected
       * - should return 6 events with value less than or equal to 15000
       */
      it('should return events with amount less than the maximum value', async () => {
        await insertEventsWithAmount(10);
        const events = await DatabaseAction.getInstance().getEvents(
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          '15000',
        );
        expect(events.total).toEqual(5);
        for (const event of events.items) {
          expect(BigInt(event.amount)).toBeLessThan(15000n);
        }
      });
    });

    describe('getUnsavedRevenueEvents', () => {
      /**
       * @target DatabaseAction.getUnsavedRevenueEvents should return
       * unsaved revenue events containing spendTx
       * @dependencies
       * - database
       * @scenario
       * - insert 3 events
       *   - one without spendTxId
       *   - one with spendTxId but without revenue
       *   - one with spendTxId and revenue
       * - run test
       * - check returned value
       * @expected
       * - should return only the second event which is
       *   event with spendTxId but without revenue
       */
      it('should return unsaved revenue events containing spendTx', async () => {
        // insert 3 events
        const boxSerialized = 'boxSerialized';
        //  one without spendTxId
        const mockedEvent1 = EventTestData.mockEventTrigger().event;
        await DatabaseActionMock.insertOnlyEventDataRecord(
          mockedEvent1,
          boxSerialized,
        );
        //  one with spendTxId but without revenue
        const mockedEvent2 = EventTestData.mockEventTrigger().event;
        const spendTxId2 = TestUtils.generateRandomId();
        await DatabaseActionMock.insertOnlyEventDataRecord(
          mockedEvent2,
          boxSerialized,
          100,
          spendTxId2,
          TestUtils.generateRandomId(),
        );
        //  one with spendTxId and revenue
        const mockedEvent3 = EventTestData.mockEventTrigger().event;
        const spendTxId3 = TestUtils.generateRandomId();
        await DatabaseActionMock.insertOnlyEventDataRecord(
          mockedEvent3,
          boxSerialized,
          100,
          spendTxId3,
          TestUtils.generateRandomId(),
        );
        const mockedEvent3Entity = (
          await DatabaseActionMock.allRawEventRecords()
        ).find((event) => event.spendTxId === spendTxId3)!;
        await DatabaseAction.getInstance().insertRevenue(
          TestUtils.generateRandomId(),
          100n,
          spendTxId3,
          RevenueType.fraud,
          mockedEvent3Entity,
        );

        // run test
        const result =
          await DatabaseAction.getInstance().getConfirmedUnsavedRevenueEvents(
            115,
            10,
          );

        // check returned value
        expect(result.length).toEqual(1);
        expect(result[0].spendTxId).toEqual(spendTxId2);
      });
    });

    describe('getTxsById', () => {
      /**
       * @target DatabaseAction.getTxsById should return requested txs
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked reward and 10 mocked payment txs in database
       * - run test (call `getTxsById`)
       * - check returned txs
       * @expected
       * - should return 5 selected txs with requested ids
       */
      it('should return requested txs', async () => {
        const txIds = [];
        for (let index = 0; index < 10; index++) {
          // insert 10 reward tx to database
          const tx = TxTestData.mockPaymentTransaction(TransactionType.reward);
          await DatabaseActionMock.insertTxRecord(
            tx,
            TransactionStatus.completed,
          );
          txIds.push(tx.txId);
        }

        const requiredTxs = txIds.slice(0, 5);
        const txs = await DatabaseAction.getInstance().getTxsById(requiredTxs);
        expect(txs.length).toEqual(5);
        expect(txs.map((tx) => tx.txId).sort()).toEqual(requiredTxs.sort());
      });
    });

    describe('getRevenuesWithFilters', () => {
      /**
       * @target DatabaseAction.getRevenuesWithFilters should return all stored revenues in descending order
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked revenues with different timestamps
       * - run test (call `getRevenuesWithFilters`)
       * - check returned revenues
       * @expected
       * - should return all stored revenues
       * - the revenues timestamps should be descending
       */
      it('should return all stored revenues in descending order', async () => {
        await insertRevenueDataWithTimestamps(10);
        const revenues =
          await DatabaseAction.getInstance().getRevenuesWithFilters();
        expect(revenues.total).toEqual(10);
        for (let index = 0; index < 9; index++) {
          expect(revenues.items[index].timestamp).toBeGreaterThanOrEqual(
            revenues.items[index + 1].timestamp,
          );
        }
      });

      /**
       * @target DatabaseAction.getRevenuesWithFilters should return all stored revenues in ascending order
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked revenues with different timestamps
       * - run test (call `getRevenuesWithFilters`)
       * - check returned revenues
       * @expected
       * - should return all stored revenues
       * - the revenues timestamps should be ascending
       */
      it('should return all stored revenues in ascending order', async () => {
        await insertRevenueDataWithTimestamps(10);
        const revenues =
          await DatabaseAction.getInstance().getRevenuesWithFilters(
            SortRequest.ASC,
          );
        expect(revenues.total).toEqual(10);
        for (let index = 0; index < 9; index++) {
          expect(revenues.items[index].timestamp).toBeLessThanOrEqual(
            revenues.items[index + 1].timestamp,
          );
        }
      });

      /**
       * @target DatabaseAction.getRevenuesWithFilters should return the revenue with specified height
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked revenues with different heights
       * - run test (call `getRevenuesWithFilters`)
       * - check returned revenues
       * @expected
       * - should return the specified revenue
       */
      it('should return the revenue with specified height', async () => {
        await insertRevenueDataWithTimestamps(10);
        const revenues =
          await DatabaseAction.getInstance().getRevenuesWithFilters(
            undefined,
            undefined,
            undefined,
            1002,
            1003,
          );
        expect(revenues.total).toEqual(1);
        expect(revenues.items[0].height).toBeGreaterThanOrEqual(1002);
        expect(revenues.items[0].height).toBeLessThan(1003);
      });

      /**
       * @target DatabaseAction.getRevenuesWithFilters should return the revenue with specified timestamp
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked revenues with different timestamps
       * - run test (call `getRevenuesWithFilters`)
       * - check returned revenues
       * @expected
       * - should return the specified revenue
       */
      it('should return the revenue with specified timestamp', async () => {
        await insertRevenueDataWithTimestamps(10);
        const revenues =
          await DatabaseAction.getInstance().getRevenuesWithFilters(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            1665438000000,
            1665439000000,
          );
        expect(revenues.total).toEqual(1);
        expect(revenues.items[0].timestamp).toBeGreaterThanOrEqual(
          1665438000000,
        );
        expect(revenues.items[0].timestamp).toBeLessThanOrEqual(1665439000000);
      });

      /**
       * @target DatabaseAction.getRevenuesWithFilters should return the revenue for events that are transferring assets from ergo network
       * @dependencies
       * - database
       * @scenario
       * - insert 20 mocked revenues with different networks (10 "from ergo", 10 others)
       * - run test (call `getRevenuesWithFilters`)
       * - check returned revenues
       * @expected
       * - should return 10 "from ergo" event revenues
       */
      it('should return the revenue for events that are transferring assets from ergo network', async () => {
        await insertRevenueDataWithDifferentNetworks(10);
        const revenues =
          await DatabaseAction.getInstance().getRevenuesWithFilters(
            undefined,
            ERGO_CHAIN,
          );
        expect(revenues.total).toEqual(10);
        revenues.items.forEach((revenue) =>
          expect(revenue.fromChain).toEqual(ERGO_CHAIN),
        );
      });

      /**
       * @target DatabaseAction.getRevenuesWithFilters should return the revenue for events that are transferring assets to ergo network
       * @dependencies
       * - database
       * @scenario
       * - insert 20 mocked revenues with different networks (10 "to ergo", 10 others)
       * - run test (call `getRevenuesWithFilters`)
       * - check returned revenues
       * @expected
       * - should return 10 "to ergo" event revenues
       */
      it('should return the revenue for events that are transferring assets to ergo network', async () => {
        await insertRevenueDataWithDifferentNetworks(10);
        const revenues =
          await DatabaseAction.getInstance().getRevenuesWithFilters(
            undefined,
            undefined,
            ERGO_CHAIN,
          );
        expect(revenues.total).toEqual(10);
        revenues.items.forEach((revenue) =>
          expect(revenue.toChain).toEqual(ERGO_CHAIN),
        );
      });

      /**
       * @target DatabaseAction.getRevenuesWithFilters should consider pagination
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked revenues with different timestamps
       * - run test (call `getRevenuesWithFilters`)
       * - check returned revenues
       * @expected
       * - should return limited data with correct total value
       */
      it('should consider pagination', async () => {
        await insertRevenueDataWithTimestamps(10);
        const revenues =
          await DatabaseAction.getInstance().getRevenuesWithFilters(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            1,
            3,
          );
        expect(revenues.items).toHaveLength(3);
        expect(revenues.total).toEqual(10);
      });
    });

    describe('getRevenueChartData', () => {
      /**
       * @target DatabaseAction.getRevenueChartData should return yearly revenue report
       * @dependencies
       * - database
       * @scenario
       * - insert 30 mocked revenues with different timestamps
       * - run test (call `getRevenueChartData`)
       * - check revenue report
       * @expected
       * - should return 2 years revenue report
       */
      it('should return yearly revenue report', async () => {
        await insertRevenueDataWithTimestamps(5, 31539600000);

        const revenueChart =
          await DatabaseAction.getInstance().getRevenueChartData(
            RevenuePeriod.year,
          );
        expect(revenueChart).toHaveLength(5);
        for (const revenue of revenueChart) {
          expect(revenue.amount).toEqual(10000);
        }
      });

      /**
       * @target DatabaseAction.getRevenueChartData should return monthly revenue report
       * @dependencies
       * - database
       * @scenario
       * - insert 20 mocked revenues with different timestamps
       * - run test (call `getRevenueChartData`)
       * - check revenue report
       * @expected
       * - should return 4 months revenue report
       */
      it('should return monthly revenue report', async () => {
        await insertRevenueDataWithTimestamps(5, 2592000000);

        const revenueChart =
          await DatabaseAction.getInstance().getRevenueChartData(
            RevenuePeriod.month,
          );
        expect(revenueChart).toHaveLength(5);
        for (const revenue of revenueChart) {
          expect(revenue.amount).toEqual(10000);
        }
      });

      /**
       * @target DatabaseAction.getRevenueChartData should return weekly revenue report
       * @dependencies
       * - database
       * @scenario
       * - insert 10 mocked revenues with different timestamps
       * - run test (call `getRevenueChartData`)
       * - check revenue report
       * @expected
       * - should return 6 weeks revenue report
       */
      it('should return weekly revenue report', async () => {
        await insertRevenueDataWithTimestamps(5);

        const revenueChart =
          await DatabaseAction.getInstance().getRevenueChartData(
            RevenuePeriod.week,
          );
        expect(revenueChart).toHaveLength(5);
        for (const revenue of revenueChart) {
          expect(revenue.amount).toEqual(10000);
        }
      });
    });

    describe('setTxAsSignFailed', () => {
      const currentTimeStampSeconds = Math.round(
        TestConfigs.currentTimeStamp / 1000,
      );

      beforeAll(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(TestConfigs.currentTimeStamp));
      });

      afterAll(() => {
        vi.useRealTimers();
      });

      /**
       * @target DatabaseAction.setTxAsSignFailed should set tx as sign-failed successfully
       * @dependencies
       * - database
       * - Date
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - mock transaction and insert into db as 'in-sign'
       * - run test
       * - check tx
       * @expected
       * - status should be updated to 'sign-failed'
       * - signFailedCount should be incremented
       * - failedInSign should be updated to true
       * - PublicStatusHandler.updatePublicTxStatus should have been called once
       */
      it('should set tx as sign-failed successfully', async () => {
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        // mock transaction and insert into db as 'in-sign'
        const tx = TxTestData.mockPaymentTransaction();
        await DatabaseActionMock.insertTxRecord(tx, TransactionStatus.inSign);

        // run test
        await DatabaseAction.getInstance().setTxAsSignFailed(tx.txId);

        // signFailedCount should remain unchanged
        const dbTxs = (await DatabaseActionMock.allTxRecords()).map((tx) => [
          tx.txId,
          tx.status,
          tx.lastStatusUpdate,
          tx.failedInSign,
          tx.signFailedCount,
        ]);
        expect(dbTxs).toEqual([
          [
            tx.txId,
            TransactionStatus.signFailed,
            currentTimeStampSeconds.toString(),
            true,
            1,
          ],
        ]);
        expect(updatePublicTxStatusSpy).toHaveBeenCalledExactlyOnceWith(
          tx.txId,
          TransactionStatus.signFailed,
        );
      });

      /**
       * @target DatabaseAction.setTxAsSignFailed should not increment counter
       * when tx status is already sign-failed
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - mock transaction and insert into db as 'sign-failed'
       * - run test
       * - check tx
       * @expected
       * - signFailedCount should remain unchanged
       * - PublicStatusHandler.updatePublicTxStatus should not have been called
       */
      it('should not increment counter when tx status is already sign-failed', async () => {
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        // mock transaction and insert into db as 'in-sign'
        const tx = TxTestData.mockPaymentTransaction();
        await DatabaseActionMock.insertTxRecord(
          tx,
          TransactionStatus.signFailed,
        );

        // run test
        await DatabaseAction.getInstance().setTxAsSignFailed(tx.txId);

        // signFailedCount should remain unchanged
        const dbTxs = (await DatabaseActionMock.allTxRecords()).map((tx) => [
          tx.txId,
          tx.signFailedCount,
        ]);
        expect(dbTxs).toEqual([[tx.txId, 0]]);
        expect(updatePublicTxStatusSpy).not.toBeCalled();
      });

      /**
       * @target DatabaseAction.setTxAsSignFailed should call updatePublicTxStatus after updating database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - call DatabaseAction.insertTxRecord to insert a mock TransactionEntity
       * - call DatabaseAction.setTxAsSignFailed
       * - call TransactionRepository.findOne with txId
       * @expected
       * - database record should have been updated
       * - PublicStatusHandler.updatePublicTxStatus should have been called once
       */
      it('should call updatePublicTxStatus after updating database record', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        await DatabaseActionMock.insertTxRecord(
          mockTx,
          TransactionStatus.inSign,
        );

        // act
        await DatabaseActionMock.testDatabase.setTxAsSignFailed(mockTx.txId);

        // assert
        const record =
          await DatabaseActionMock.testDatabase.TransactionRepository.findOneByOrFail(
            {
              txId: mockTx.txId,
            },
          );

        expect(record.status).toBe(TransactionStatus.signFailed);

        expect(updatePublicTxStatusSpy).toHaveBeenCalledExactlyOnceWith(
          mockTx.txId,
          TransactionStatus.signFailed,
        );
      });
    });

    describe('setEventStatus', () => {
      /**
       * @target DatabaseAction.setEventStatus should call updatePublicEventStatus after updating database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicEventStatus to resolve
       * - define a mock EventTrigger
       * - call DatabaseAction.insertEventRecord to insert a mock ConfirmedEventEntity
       * - call DatabaseAction.setEventStatus
       * - call ConfirmedEventRepository.findOne with eventId
       * @expected
       * - database record should have been updated
       * - PublicStatusHandler.updatePublicEventStatus should have been called once
       */
      it('should call updatePublicEventStatus after updating database record', async () => {
        // arrange
        const updatePublicEventStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicEventStatus();

        const event = EventTestData.mockEventTrigger().event;
        const eventId = Utils.txIdToEventId(event.sourceTxId);

        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.pendingPayment,
        );

        // act
        await DatabaseActionMock.testDatabase.setEventStatus(
          eventId,
          EventStatus.pendingReward,
        );

        // assert
        const record =
          await DatabaseActionMock.testDatabase.ConfirmedEventRepository.findOneByOrFail(
            {
              id: eventId,
            },
          );

        expect(record.status).toBe(EventStatus.pendingReward);

        expect(updatePublicEventStatusSpy).toHaveBeenCalledExactlyOnceWith(
          eventId,
          EventStatus.pendingReward,
        );
      });

      /**
       * @target DatabaseAction.setEventStatus should not call updatePublicEventStatus if no records were updated
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicEventStatus to resolve
       * - define a mock EventTrigger
       * - call DatabaseAction.setEventStatus
       * - call ConfirmedEventRepository.findOne with eventId
       * @expected
       * - PublicStatusHandler.updatePublicEventStatus should not have been called
       */
      it('should not call updatePublicEventStatus if no records were updated', async () => {
        // arrange
        const updatePublicEventStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicEventStatus();

        const event = EventTestData.mockEventTrigger().event;
        const eventId = Utils.txIdToEventId(event.sourceTxId);

        // act
        await DatabaseActionMock.testDatabase.setEventStatus(
          eventId,
          EventStatus.pendingReward,
        );

        // assert
        expect(updatePublicEventStatusSpy).not.toHaveBeenCalled();
      });
    });

    describe('setEventStatusToPending', () => {
      /**
       * @target DatabaseAction.setEventStatusToPending should call updatePublicEventStatus after updating database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicEventStatus to resolve
       * - define a mock EventTrigger
       * - call DatabaseAction.insertEventRecord to insert a mock ConfirmedEventEntity
       * - call DatabaseAction.setEventStatusToPending
       * - call ConfirmedEventRepository.findOne with eventId
       * @expected
       * - database record should have been updated
       * - PublicStatusHandler.updatePublicEventStatus should have been called once
       */
      it('should call updatePublicEventStatus after updating database record', async () => {
        // arrange
        const updatePublicEventStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicEventStatus();

        const event = EventTestData.mockEventTrigger().event;
        const eventId = Utils.txIdToEventId(event.sourceTxId);

        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.pendingPayment,
        );

        // act
        await DatabaseActionMock.testDatabase.setEventStatusToPending(
          eventId,
          EventStatus.pendingReward,
        );

        // assert
        const record =
          await DatabaseActionMock.testDatabase.ConfirmedEventRepository.findOneByOrFail(
            {
              id: eventId,
            },
          );

        expect(record.status).toBe(EventStatus.pendingReward);

        expect(updatePublicEventStatusSpy).toHaveBeenCalledExactlyOnceWith(
          eventId,
          EventStatus.pendingReward,
        );
      });

      /**
       * @target DatabaseAction.setEventStatusToPending should not call updatePublicEventStatus if no records were updated
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicEventStatus to resolve
       * - define a mock EventTrigger
       * - call DatabaseAction.setEventStatusToPending
       * @expected
       * - PublicStatusHandler.updatePublicEventStatus should not have been called
       */
      it('should not call updatePublicEventStatus if no records were updated', async () => {
        // arrange
        const updatePublicEventStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicEventStatus();

        const event = EventTestData.mockEventTrigger().event;
        const eventId = Utils.txIdToEventId(event.sourceTxId);

        // act
        await DatabaseActionMock.testDatabase.setEventStatusToPending(
          eventId,
          EventStatus.pendingReward,
        );

        // assert
        expect(updatePublicEventStatusSpy).not.toHaveBeenCalled();
      });
    });

    describe('insertConfirmedEvent', () => {
      /**
       * @target DatabaseAction.insertConfirmedEvent should call updatePublicEventStatus after updating database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicEventStatus to resolve
       * - define a mock EventTrigger
       * - call DatabaseAction.insertEventRecord to insert a mock ConfirmedEventEntity
       * - call DatabaseAction.insertConfirmedEvent
       * - call ConfirmedEventRepository.findOne with eventId
       * @expected
       * - database record should have been updated
       * - PublicStatusHandler.updatePublicEventStatus should have been called once
       */
      it('should call updatePublicEventStatus after updating database record', async () => {
        // arrange
        const updatePublicEventStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicEventStatus();

        const event = EventTestData.mockEventTrigger().event;
        const eventId = Utils.txIdToEventId(event.sourceTxId);

        // act
        await DatabaseActionMock.testDatabase.insertConfirmedEvent(
          event as EventTriggerEntity,
        );

        // assert
        const record =
          await DatabaseActionMock.testDatabase.ConfirmedEventRepository.findOneByOrFail(
            {
              id: eventId,
            },
          );

        expect(record.status).toBe(EventStatus.pendingPayment);

        expect(updatePublicEventStatusSpy).toHaveBeenCalledExactlyOnceWith(
          eventId,
          EventStatus.pendingPayment,
        );
      });
    });

    describe('setTxStatus', () => {
      /**
       * @target DatabaseAction.setTxStatus should call updatePublicTxStatus after updating database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - call DatabaseAction.insertTxRecord to insert a mock TransactionEntity
       * - call DatabaseAction.setTxStatus
       * - call TransactionRepository.findOne with txId
       * @expected
       * - database record should have been updated
       * - PublicStatusHandler.updatePublicTxStatus should have been called once
       */
      it('should call updatePublicTxStatus after updating database record', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        await DatabaseActionMock.insertTxRecord(mockTx, TransactionStatus.sent);

        // act
        await DatabaseActionMock.testDatabase.setTxStatus(
          mockTx.txId,
          TransactionStatus.approved,
        );

        // assert
        const record =
          await DatabaseActionMock.testDatabase.TransactionRepository.findOneByOrFail(
            {
              txId: mockTx.txId,
            },
          );

        expect(record.status).toBe(TransactionStatus.approved);

        expect(updatePublicTxStatusSpy).toHaveBeenCalledExactlyOnceWith(
          mockTx.txId,
          TransactionStatus.approved,
        );
      });

      /**
       * @target DatabaseAction.setTxStatus should not call updatePublicTxStatus if no records were updated
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - call DatabaseAction.setTxStatus
       * @expected
       * - PublicStatusHandler.updatePublicTxStatus should not have been called
       */
      it('should not call updatePublicTxStatus if no records were updated', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        // act
        await DatabaseActionMock.testDatabase.setTxStatus(
          mockTx.txId,
          TransactionStatus.approved,
        );

        // assert
        expect(updatePublicTxStatusSpy).not.toHaveBeenCalled();
      });
    });

    describe('updateWithSignedTx', () => {
      /**
       * @target DatabaseAction.updateWithSignedTx should call updatePublicTxStatus after updating database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - call DatabaseAction.insertTxRecord to insert a mock TransactionEntity
       * - call DatabaseAction.updateWithSignedTx
       * - call TransactionRepository.findOne with txId
       * @expected
       * - database record should have been updated
       * - PublicStatusHandler.updatePublicTxStatus should have been called once
       */
      it('should call updatePublicTxStatus after updating database record', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        await DatabaseActionMock.insertTxRecord(
          mockTx,
          TransactionStatus.inSign,
        );

        // act
        await DatabaseActionMock.testDatabase.updateWithSignedTx(
          mockTx.txId,
          '{}',
        );

        // assert
        const record =
          await DatabaseActionMock.testDatabase.TransactionRepository.findOneByOrFail(
            {
              txId: mockTx.txId,
            },
          );

        expect(record.status).toBe(TransactionStatus.signed);

        expect(updatePublicTxStatusSpy).toHaveBeenCalledExactlyOnceWith(
          mockTx.txId,
          TransactionStatus.signed,
        );
      });

      /**
       * @target DatabaseAction.updateWithSignedTx should not call updatePublicTxStatus if no records were updated
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - call DatabaseAction.updateWithSignedTx
       * @expected
       * - database record should have been updated
       * - PublicStatusHandler.updatePublicTxStatus should not have been called
       */
      it('should not call updatePublicTxStatus if no records were updated', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        // act
        await DatabaseActionMock.testDatabase.updateWithSignedTx(
          mockTx.txId,
          '{}',
        );

        // assert
        expect(updatePublicTxStatusSpy).not.toHaveBeenCalled();
      });
    });

    describe('replaceTx', () => {
      /**
       * @target DatabaseAction.replaceTx should call updatePublicTxStatus after updating database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - define a mock PaymentTransaction with a different id
       * - call DatabaseAction.insertTxRecord to insert a mock TransactionEntity
       * - call DatabaseAction.replaceTx
       * - call TransactionRepository.findOne with txId
       * @expected
       * - database record should have been updated
       * - PublicStatusHandler.updatePublicTxStatus should have been called once
       */
      it('should call updatePublicTxStatus after updating database record', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );
        const mockTx2 = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        await DatabaseActionMock.insertTxRecord(
          mockTx,
          TransactionStatus.inSign,
        );

        // act
        await DatabaseActionMock.testDatabase.replaceTx(
          mockTx.txId,
          mockTx2,
          100,
        );

        // assert
        const record =
          await DatabaseActionMock.testDatabase.TransactionRepository.findOneByOrFail(
            {
              txId: mockTx2.txId,
            },
          );

        expect(record.txId).toBe(mockTx2.txId);

        expect(updatePublicTxStatusSpy).toHaveBeenCalledExactlyOnceWith(
          mockTx2.txId,
          TransactionStatus.approved,
        );
      });

      /**
       * @target DatabaseAction.replaceTx should not call updatePublicTxStatus if no records were updated
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - define a mock PaymentTransaction with a different id
       * - call DatabaseAction.replaceTx
       * @expected
       * - PublicStatusHandler.updatePublicTxStatus should not have been called
       */
      it('should not call updatePublicTxStatus if no records were updated', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );
        const mockTx2 = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        // act
        await DatabaseActionMock.testDatabase.replaceTx(
          mockTx.txId,
          mockTx2,
          100,
        );

        // assert
        expect(updatePublicTxStatusSpy).not.toHaveBeenCalled();
      });
    });

    describe('insertNewTx', () => {
      /**
       * @target DatabaseAction.insertNewTx should call updatePublicTxStatus after inserting database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - call DatabaseAction.insertNewTx
       * - call TransactionRepository.findOne with txId
       * @expected
       * - database record should have been inserted
       * - PublicStatusHandler.updatePublicTxStatus should have been called once
       */
      it('should call updatePublicTxStatus after inserting database record', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        // act
        await DatabaseActionMock.testDatabase.insertNewTx(
          mockTx,
          null,
          2,
          null,
          100,
        );

        // assert
        const record =
          await DatabaseActionMock.testDatabase.TransactionRepository.findOneByOrFail(
            {
              txId: mockTx.txId,
            },
          );

        expect(record.txId).toBe(mockTx.txId);

        expect(updatePublicTxStatusSpy).toHaveBeenCalledExactlyOnceWith(
          mockTx.txId,
          TransactionStatus.approved,
        );
      });
    });

    describe('insertCompletedTx', () => {
      /**
       * @target DatabaseAction.insertCompletedTx should call updatePublicTxStatus after inserting database record
       * @dependencies
       * - database
       * @scenario
       * - stub PublicStatusHandler.updatePublicTxStatus to resolve
       * - define a mock PaymentTransaction
       * - call DatabaseAction.insertCompletedTx
       * - call TransactionRepository.findOne with txId
       * @expected
       * - database record should have been inserted
       * - PublicStatusHandler.updatePublicTxStatus should have been called once
       */
      it('should call updatePublicTxStatus after inserting database record', async () => {
        // arrange
        const updatePublicTxStatusSpy =
          PublicStatusHandlerMock.mockUpdatePublicTxStatus();

        const mockTx = TxTestData.mockPaymentTransaction(
          TransactionType.reward,
        );

        // act
        await DatabaseActionMock.testDatabase.insertCompletedTx(
          mockTx,
          null,
          2,
          null,
          100,
        );

        // assert
        const record =
          await DatabaseActionMock.testDatabase.TransactionRepository.findOneByOrFail(
            {
              txId: mockTx.txId,
            },
          );

        expect(record.txId).toBe(mockTx.txId);

        expect(updatePublicTxStatusSpy).toHaveBeenCalledExactlyOnceWith(
          mockTx.txId,
          TransactionStatus.completed,
        );
      });
    });
  });
  describe('finalizeTxIfUnchanged', () => {
    describe('atomic qualified transaction finalization', () => {
      const db = () => DatabaseActionMock.testDatabase;
      let expected: SigningRowPreimage;
      const txNotify = vi.fn();
      const eventNotify = vi.fn();
      let eventId: string;
      const orderId = 'finalization-order';
      const prepare = async (
        type = TransactionType.payment,
        chain = 'ethereum',
      ) => {
        const event = [
          TransactionType.payment,
          TransactionType.reward,
        ].includes(type);
        const order = type === TransactionType.arbitrary;
        await db().ConfirmedEventRepository.update(
          { id: eventId },
          {
            status:
              type === TransactionType.reward
                ? EventStatus.inReward
                : EventStatus.inPayment,
          },
        );
        const payment = new PaymentTransaction(
          chain,
          'finalization-tx',
          event ? eventId : order ? orderId : '',
          Buffer.from('abcd', 'hex'),
          type,
        );
        await DatabaseActionMock.insertTxRecord(
          payment,
          TransactionStatus.sent,
          123,
          'old-update',
          true,
          4,
          3,
        );
        expected = {
          txId: payment.txId,
          txJson: payment.toJson(),
          chain,
          type,
          status: TransactionStatus.sent,
          requiredSign: 3,
          eventId: event ? eventId : null,
          orderId: order ? orderId : null,
        };
      };
      const state = async () => ({
        tx: await db().getTxById('finalization-tx'),
        event: await db().ConfirmedEventRepository.findOneByOrFail({
          id: eventId,
        }),
        order: await db().getOrderById(orderId),
      });

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        const event = mockEventTrigger().event;
        eventId = Utils.txIdToEventId(event.sourceTxId);
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.inPayment,
          undefined,
          undefined,
          'event-first',
        );
        await DatabaseActionMock.insertOrderRecord(
          orderId,
          'ergo',
          '[]',
          OrderStatus.inProcess,
          'order-first',
        );
        txNotify.mockReset().mockResolvedValue(undefined);
        eventNotify.mockReset().mockResolvedValue(undefined);
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicTxStatus',
        ).mockImplementation(txNotify);
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicEventStatus',
        ).mockImplementation(eventNotify);
      });
      afterEach(() => vi.restoreAllMocks());
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'commits %s on %s and preserves unrelated fields'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'commits %s on %s and preserves unrelated fields'; rejected mutations preserve state and do not notify.
       */

      it.each([
        [TransactionType.payment, 'ethereum', EventStatus.pendingReward],
        [TransactionType.payment, 'ergo', EventStatus.completed],
        [TransactionType.reward, 'ergo', EventStatus.completed],
        [TransactionType.arbitrary, 'ergo', null],
        [TransactionType.coldStorage, 'ergo', null],
        [TransactionType.manual, 'ergo', null],
      ] as const)(
        'commits %s on %s and preserves unrelated fields',
        async (type, chain, eventStatus) => {
          await prepare(type, chain);
          const before = await state();
          const now = 1730000000000;
          vi.spyOn(Date, 'now').mockReturnValue(now);
          const createRunner = db().dataSource.createQueryRunner.bind(
            db().dataSource,
          );
          const runners: ReturnType<typeof createRunner>[] = [];
          const commits: ReturnType<typeof vi.fn>[] = [];
          vi.spyOn(db().dataSource, 'createQueryRunner').mockImplementation(
            (mode) => {
              const runner = createRunner(mode);
              runners.push(runner);
              const committed = vi.fn();
              const commit = runner.commitTransaction.bind(runner);
              vi.spyOn(runner, 'commitTransaction').mockImplementation(
                async () => {
                  await commit();
                  committed();
                },
              );
              commits.push(committed);
              return runner;
            },
          );
          txNotify.mockImplementation(async () => {
            expect(runners.every((runner) => !runner.isTransactionActive)).toBe(
              true,
            );
          });
          await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(
            true,
          );
          expect(
            commits.reduce(
              (count, commit) => count + commit.mock.calls.length,
              0,
            ),
          ).toBe(1);
          const after = await state();
          expect(after.tx).toMatchObject({
            status: TransactionStatus.completed,
            txJson: expected.txJson,
            lastCheck: 123,
            lastStatusUpdate: String(now / 1000),
            failedInSign: true,
            signFailedCount: 4,
            requiredSign: 3,
          });
          expect(txNotify).toHaveBeenCalledExactlyOnceWith(
            expected.txId,
            TransactionStatus.completed,
          );
          if (eventStatus) {
            expect(after.event).toEqual({
              ...before.event,
              status: eventStatus,
              firstTry:
                eventStatus === EventStatus.pendingReward
                  ? String(now / 1000)
                  : 'event-first',
            });
            expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
              eventId,
              eventStatus,
            );
          } else {
            expect(after.event).toEqual(before.event);
            expect(eventNotify).not.toHaveBeenCalled();
          }
          expect(after.order).toEqual(
            type === TransactionType.arbitrary
              ? { ...before.order, status: OrderStatus.completed }
              : before.order,
          );
          await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(
            false,
          );
          expect(txNotify).toHaveBeenCalledTimes(1);
        },
      );
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'rejects missing %s before a transaction begins'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects missing %s before a transaction begins'; rejected mutations preserve state and do not notify.
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
      ] as const)(
        'rejects missing %s before a transaction begins',
        async (field) => {
          await prepare();
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(
            db().finalizeTxIfUnchanged({
              ...expected,
              [field]: undefined,
            } as unknown as SigningRowPreimage),
          ).rejects.toThrow('preimage');
          expect(transaction).not.toHaveBeenCalled();
          expect(txNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'preserves all rows on isolated %s mismatch'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'preserves all rows on isolated %s mismatch'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['txId', 'different'],
        ['txJson', 'replacement'],
        ['chain', 'binance'],
        ['requiredSign', 4],
        ['eventId', 'missing-event'],
      ] as const)(
        'preserves all rows on isolated %s mismatch',
        async (field, value) => {
          await prepare();
          const before = await state();
          await expect(
            db().finalizeTxIfUnchanged({ ...expected, [field]: value }),
          ).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'rejects non-sent preimage %s before writing'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects non-sent preimage %s before writing'; rejected mutations preserve state and do not notify.
       */

      it.each(
        Object.values(TransactionStatus).filter(
          (status) => status !== TransactionStatus.sent,
        ),
      )('rejects non-sent preimage %s before writing', async (status) => {
        await prepare();
        const transaction = vi.spyOn(db().dataSource, 'transaction');
        await expect(
          db().finalizeTxIfUnchanged({ ...expected, status }),
        ).rejects.toThrow('preimage');
        expect(transaction).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'rejects invalid association %s/%s/%s before writing'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid association %s/%s/%s before writing'; rejected mutations preserve state and do not notify.
       */

      it.each([
        [TransactionType.payment, null, null],
        [TransactionType.reward, null, null],
        [TransactionType.payment, 'event', 'order'],
        [TransactionType.reward, 'event', 'order'],
        [TransactionType.arbitrary, null, null],
        [TransactionType.arbitrary, 'event', 'order'],
        [TransactionType.coldStorage, 'event', null],
        [TransactionType.coldStorage, null, 'order'],
        [TransactionType.manual, 'event', null],
        [TransactionType.manual, null, 'order'],
        [TransactionType.lock, null, null],
        ['unknown', null, null],
      ] as const)(
        'rejects invalid association %s/%s/%s before writing',
        async (type, event, order) => {
          await prepare();
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(
            db().finalizeTxIfUnchanged({
              ...expected,
              type,
              eventId: event,
              orderId: order,
            }),
          ).rejects.toThrow('preimage');
          expect(transaction).not.toHaveBeenCalled();
          expect(txNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'refuses a missing or wrong-phase %s relation without completing the transaction'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'refuses a missing or wrong-phase %s relation without completing the transaction'; rejected mutations preserve state and do not notify.
       */

      it.each([
        TransactionType.payment,
        TransactionType.reward,
        TransactionType.arbitrary,
      ])(
        'refuses a missing or wrong-phase %s relation without completing the transaction',
        async (type) => {
          await prepare(type);
          if (type === TransactionType.arbitrary)
            await db().ArbitraryRepository.update(
              { id: orderId },
              { status: OrderStatus.completed },
            );
          else
            await db().ConfirmedEventRepository.update(
              { id: eventId },
              {
                status:
                  type === TransactionType.payment
                    ? EventStatus.inReward
                    : EventStatus.inPayment,
              },
            );
          const before = await state();
          await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(
            false,
          );
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
          await expect(
            db().finalizeTxIfUnchanged({
              ...expected,
              ...(type === TransactionType.arbitrary
                ? { orderId: 'missing' }
                : { eventId: 'missing' }),
            }),
          ).resolves.toBe(false);
        },
      );
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'preserves a replacement row written after capture'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'preserves a replacement row written after capture'; rejected mutations preserve state and do not notify.
       */

      it('preserves a replacement row written after capture', async () => {
        await prepare();
        await db().TransactionRepository.update(
          { txId: expected.txId },
          { txJson: 'concurrent-winner' },
        );
        const before = await state();
        await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'refuses stored %s drift even with a valid original association'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'refuses stored %s drift even with a valid original association'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['type', TransactionType.reward],
        ['status', TransactionStatus.signed],
      ] as const)(
        'refuses stored %s drift even with a valid original association',
        async (field, value) => {
          await prepare();
          await db().TransactionRepository.update(
            { txId: expected.txId },
            { [field]: value },
          );
          const before = await state();
          await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(
            false,
          );
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'rejects a different populated %s despite its valid phase'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects a different populated %s despite its valid phase'; rejected mutations preserve state and do not notify.
       */

      it.each(['event', 'order'] as const)(
        'rejects a different populated %s despite its valid phase',
        async (relation) => {
          await prepare(
            relation === 'event'
              ? TransactionType.payment
              : TransactionType.arbitrary,
          );
          let alternate: string;
          if (relation === 'event') {
            const event = {
              ...mockEventTrigger().event,
              sourceTxId: 'ab'.repeat(32),
            };
            alternate = Utils.txIdToEventId(event.sourceTxId);
            await DatabaseActionMock.insertEventRecord(
              event,
              EventStatus.inPayment,
            );
          } else {
            alternate = 'another-order';
            await DatabaseActionMock.insertOrderRecord(
              alternate,
              'ergo',
              '[]',
              OrderStatus.inProcess,
            );
          }
          const before = await state();
          await expect(
            db().finalizeTxIfUnchanged({
              ...expected,
              [relation === 'event' ? 'eventId' : 'orderId']: alternate,
            }),
          ).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'does not recreate a missing transaction or advance its event'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'does not recreate a missing transaction or advance its event'; rejected mutations preserve state and do not notify.
       */

      it('does not recreate a missing transaction or advance its event', async () => {
        await prepare();
        await db().TransactionRepository.delete({ txId: expected.txId });
        const before = await state();
        await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'commits exactly one of two overlapping finalizations'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'commits exactly one of two overlapping finalizations'; rejected mutations preserve state and do not notify.
       */

      it('commits exactly one of two overlapping finalizations', async () => {
        await prepare();
        const results = await Promise.all([
          db().finalizeTxIfUnchanged(expected),
          db().finalizeTxIfUnchanged(expected),
        ]);
        expect(results.sort()).toEqual([false, true]);
        expect((await state()).tx!.status).toBe(TransactionStatus.completed);
        expect(txNotify).toHaveBeenCalledTimes(1);
        expect(eventNotify).toHaveBeenCalledTimes(1);
      });
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'rolls back the first write on %s second-write SQL failure'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back the first write on %s second-write SQL failure'; rejected mutations preserve state and do not notify.
       */

      it.each([TransactionType.payment, TransactionType.arbitrary])(
        'rolls back the first write on %s second-write SQL failure',
        async (type) => {
          await prepare(type);
          const before = await state();
          const table =
            type === TransactionType.arbitrary
              ? 'arbitrary_entity'
              : 'confirmed_event_entity';
          await db().dataSource.query(
            `CREATE TEMP TRIGGER fail_finalization BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture second write'); END`,
          );
          try {
            await expect(db().finalizeTxIfUnchanged(expected)).rejects.toThrow(
              'fixture second write',
            );
            expect(await state()).toEqual(before);
            expect(txNotify).not.toHaveBeenCalled();
            expect(eventNotify).not.toHaveBeenCalled();
          } finally {
            await db().dataSource.query('DROP TRIGGER fail_finalization');
          }
        },
      );
      /**
       * @target DatabaseAction.finalizeTxIfUnchanged 'rolls back when %s second-write CAS affects zero rows'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.finalizeTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back when %s second-write CAS affects zero rows'; rejected mutations preserve state and do not notify.
       */

      it.each([TransactionType.payment, TransactionType.arbitrary])(
        'rolls back when %s second-write CAS affects zero rows',
        async (type) => {
          await prepare(type);
          const before = await state();
          const table =
            type === TransactionType.arbitrary
              ? 'arbitrary_entity'
              : 'confirmed_event_entity';
          await db().dataSource.query(
            `CREATE TEMP TRIGGER skip_finalization BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
          );
          try {
            await expect(db().finalizeTxIfUnchanged(expected)).resolves.toBe(
              false,
            );
            expect(await state()).toEqual(before);
            expect(txNotify).not.toHaveBeenCalled();
            expect(eventNotify).not.toHaveBeenCalled();
          } finally {
            await db().dataSource.query('DROP TRIGGER skip_finalization');
          }
        },
      );
    });
  });
  describe('invalidateTxIfUnchanged', () => {
    describe('atomic checked transaction invalidation', () => {
      const db = () => DatabaseActionMock.testDatabase;
      const txId = 'invalidation-tx';
      const orderId = 'invalidation-order';
      let eventId: string;
      let expected: SigningRowPreimage;
      const txNotify = vi.fn();
      const eventNotify = vi.fn();
      const prepare = async (
        type = TransactionType.payment,
        status = TransactionStatus.sent,
        chain = 'ethereum',
      ) => {
        const event = [
          TransactionType.payment,
          TransactionType.reward,
        ].includes(type);
        const order = type === TransactionType.arbitrary;
        await db().ConfirmedEventRepository.update(
          { id: eventId },
          {
            status:
              type === TransactionType.reward
                ? EventStatus.inReward
                : EventStatus.inPayment,
          },
        );
        const tx = new PaymentTransaction(
          chain,
          txId,
          event ? eventId : order ? orderId : '',
          Buffer.from('abcd', 'hex'),
          type,
        );
        await DatabaseActionMock.insertTxRecord(
          tx,
          status,
          123,
          'old-update',
          true,
          4,
          3,
        );
        expected = {
          txId,
          txJson: tx.toJson(),
          chain,
          type,
          status,
          requiredSign: 3,
          eventId: event ? eventId : null,
          orderId: order ? orderId : null,
        };
      };
      const state = async () => ({
        tx: await db().getTxById(txId),
        event: await db().ConfirmedEventRepository.findOneBy({ id: eventId }),
        order: await db().getOrderById(orderId),
      });
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        const event = mockEventTrigger().event;
        eventId = Utils.txIdToEventId(event.sourceTxId);
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.inPayment,
          undefined,
          undefined,
          'event-first',
        );
        await db().ConfirmedEventRepository.update(
          { id: eventId },
          { unexpectedFails: 5 },
        );
        await DatabaseActionMock.insertOrderRecord(
          orderId,
          'ergo',
          '[]',
          OrderStatus.inProcess,
          'order-first',
        );
        await db().ArbitraryRepository.update(
          { id: orderId },
          { unexpectedFails: 7 },
        );
        txNotify.mockReset().mockResolvedValue(undefined);
        eventNotify.mockReset().mockResolvedValue(undefined);
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicTxStatus',
        ).mockImplementation(txNotify);
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicEventStatus',
        ).mockImplementation(eventNotify);
      });
      afterEach(() => vi.restoreAllMocks());

      for (const status of [
        TransactionStatus.sent,
        TransactionStatus.signFailed,
      ]) {
        for (const unexpected of [false, true]) {
          /**
           * @target DatabaseAction.invalidateTxIfUnchanged `invalidates %s on %s from ${status} (unexpected=${unexpected})`
           * @dependencies Existing production DAO/chain ports and synthetic fixtures.
           * @scenario Prepare the suite fixture, apply the named input or concurrent change,
           * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
           * @expected `invalidates %s on %s from ${status} (unexpected=${unexpected})`; rejected mutations preserve state and do not notify.
           */

          it.each([
            [TransactionType.payment, 'ethereum', EventStatus.pendingPayment],
            [TransactionType.payment, 'ergo', EventStatus.pendingPayment],
            [TransactionType.reward, 'ergo', EventStatus.pendingReward],
            [TransactionType.arbitrary, 'ergo', null],
            [TransactionType.coldStorage, 'ethereum', null],
            [TransactionType.manual, 'ergo', null],
          ] as const)(
            `invalidates %s on %s from ${status} (unexpected=${unexpected})`,
            async (type, chain, eventStatus) => {
              await prepare(type, status, chain);
              const before = await state();
              vi.spyOn(Date, 'now').mockReturnValue(1730000000000);
              const transaction = db().dataSource.transaction.bind(
                db().dataSource,
              );
              let committed = false;
              vi.spyOn(db().dataSource, 'transaction').mockImplementation(
                async (...args: Parameters<typeof transaction>) => {
                  const result = await transaction(...args);
                  committed = true;
                  return result;
                },
              );
              txNotify.mockImplementation(() => expect(committed).toBe(true));
              eventNotify.mockImplementation(() =>
                expect(committed).toBe(true),
              );
              await expect(
                db().invalidateTxIfUnchanged(expected, 123, unexpected),
              ).resolves.toBe(true);
              const after = await state();
              expect(after.tx).toEqual({
                ...before.tx,
                status: TransactionStatus.invalid,
                lastStatusUpdate: '1730000000',
                event: before.tx!.event === null ? null : after.event,
                order: before.tx!.order === null ? null : after.order,
              });
              expect(after.event).toEqual(
                eventStatus
                  ? {
                      ...before.event,
                      status: eventStatus,
                      unexpectedFails: 5 + Number(unexpected),
                    }
                  : before.event,
              );
              expect(after.order).toEqual(
                type === TransactionType.arbitrary
                  ? {
                      ...before.order,
                      status: OrderStatus.pending,
                      unexpectedFails: 7 + Number(unexpected),
                    }
                  : before.order,
              );
              expect(txNotify).toHaveBeenCalledExactlyOnceWith(
                txId,
                TransactionStatus.invalid,
              );
              if (eventStatus)
                expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
                  eventId,
                  eventStatus,
                );
              else expect(eventNotify).not.toHaveBeenCalled();
              await expect(
                db().invalidateTxIfUnchanged(expected, 123, unexpected),
              ).resolves.toBe(false);
              expect(await state()).toEqual(after);
              expect(txNotify).toHaveBeenCalledTimes(1);
            },
          );
        }
      }
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'rejects undefined %s before opening a transaction'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects undefined %s before opening a transaction'; rejected mutations preserve state and do not notify.
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
      ] as const)(
        'rejects undefined %s before opening a transaction',
        async (field) => {
          await prepare();
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(
            db().invalidateTxIfUnchanged(
              {
                ...expected,
                [field]: undefined,
              } as unknown as SigningRowPreimage,
              123,
              false,
            ),
          ).rejects.toThrow('preimage');
          expect(transaction).not.toHaveBeenCalled();
          expect(txNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'rejects invalid lastCheck %s before query'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid lastCheck %s before query'; rejected mutations preserve state and do not notify.
       */

      it.each([
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        undefined,
        '123',
      ])('rejects invalid lastCheck %s before query', async (lastCheck) => {
        await prepare();
        const transaction = vi.spyOn(db().dataSource, 'transaction');
        await expect(
          db().invalidateTxIfUnchanged(expected, lastCheck as number, false),
        ).rejects.toThrow('preimage');
        expect(transaction).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'rejects invalid unexpected %s before query'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid unexpected %s before query'; rejected mutations preserve state and do not notify.
       */

      it.each([undefined, null, 0, 'true'])(
        'rejects invalid unexpected %s before query',
        async (unexpected) => {
          await prepare();
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(
            db().invalidateTxIfUnchanged(
              expected,
              123,
              unexpected as unknown as boolean,
            ),
          ).rejects.toThrow('preimage');
          expect(transaction).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'rejects starting status %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects starting status %s'; rejected mutations preserve state and do not notify.
       */

      it.each(
        Object.values(TransactionStatus).filter(
          (status) =>
            ![TransactionStatus.sent, TransactionStatus.signFailed].includes(
              status,
            ),
        ),
      )('rejects starting status %s', async (status) => {
        await prepare();
        const transaction = vi.spyOn(db().dataSource, 'transaction');
        await expect(
          db().invalidateTxIfUnchanged({ ...expected, status }, 123, false),
        ).rejects.toThrow('preimage');
        expect(transaction).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'does not overwrite an isolated %s mismatch'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'does not overwrite an isolated %s mismatch'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['txId', 'replacement'],
        ['txJson', 'replacement'],
        ['chain', 'binance'],
        ['type', TransactionType.reward],
        ['status', TransactionStatus.signFailed],
        ['requiredSign', 4],
        ['eventId', 'missing-event'],
      ] as const)(
        'does not overwrite an isolated %s mismatch',
        async (field, value) => {
          await prepare();
          // Keep both event phases eligible when changing type alone.
          if (field === 'type')
            await db().ConfirmedEventRepository.update(
              { id: eventId },
              { status: EventStatus.inReward },
            );
          const before = await state();
          await expect(
            db().invalidateTxIfUnchanged(
              { ...expected, [field]: value },
              123,
              true,
            ),
          ).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'requires the exact order relation'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'requires the exact order relation'; rejected mutations preserve state and do not notify.
       */

      it('requires the exact order relation', async () => {
        await prepare(TransactionType.arbitrary);
        await DatabaseActionMock.insertOrderRecord(
          'other',
          'ergo',
          '[]',
          OrderStatus.inProcess,
        );
        const before = await state();
        await expect(
          db().invalidateTxIfUnchanged(
            { ...expected, orderId: 'other' },
            123,
            true,
          ),
        ).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect((await db().getOrderById('other'))?.status).toBe(
          OrderStatus.inProcess,
        );
        expect(txNotify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'preserves a concurrent mempool refresh to %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'preserves a concurrent mempool refresh to %s'; rejected mutations preserve state and do not notify.
       */

      it.each([0, 124, Number.MAX_SAFE_INTEGER])(
        'preserves a concurrent mempool refresh to %s',
        async (lastCheck) => {
          await prepare();
          await db().TransactionRepository.update({ txId }, { lastCheck });
          const before = await state();
          await expect(
            db().invalidateTxIfUnchanged(expected, 123, true),
          ).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'rejects invalid association %s/%s/%s before query'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid association %s/%s/%s before query'; rejected mutations preserve state and do not notify.
       */

      it.each([
        [TransactionType.payment, null, null],
        [TransactionType.reward, null, null],
        [TransactionType.payment, 'event', 'order'],
        [TransactionType.reward, 'event', 'order'],
        [TransactionType.arbitrary, null, null],
        [TransactionType.arbitrary, 'event', 'order'],
        [TransactionType.coldStorage, 'event', null],
        [TransactionType.coldStorage, null, 'order'],
        [TransactionType.manual, 'event', null],
        [TransactionType.manual, null, 'order'],
        ['unknown', null, null],
      ] as const)(
        'rejects invalid association %s/%s/%s before query',
        async (type, event, order) => {
          await prepare();
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(
            db().invalidateTxIfUnchanged(
              { ...expected, type, eventId: event, orderId: order },
              123,
              false,
            ),
          ).rejects.toThrow('preimage');
          expect(transaction).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'rejects a missing or wrong-phase %s relation'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects a missing or wrong-phase %s relation'; rejected mutations preserve state and do not notify.
       */

      it.each([
        TransactionType.payment,
        TransactionType.reward,
        TransactionType.arbitrary,
      ])('rejects a missing or wrong-phase %s relation', async (type) => {
        await prepare(type);
        const isOrder = type === TransactionType.arbitrary;
        const repository = isOrder
          ? db().ArbitraryRepository
          : db().ConfirmedEventRepository;
        const id = isOrder ? orderId : eventId;
        await repository.update({ id }, { status: 'wrong-phase' });
        const before = await state();
        await expect(
          db().invalidateTxIfUnchanged(expected, 123, true),
        ).resolves.toBe(false);
        expect(await state()).toEqual(before);
        // An absent association is represented by a captured identifier with no row.
        await expect(
          db().invalidateTxIfUnchanged(
            {
              ...expected,
              ...(isOrder ? { orderId: 'absent' } : { eventId: 'absent' }),
            },
            123,
            true,
          ),
        ).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
      });

      for (const type of [TransactionType.payment, TransactionType.arbitrary]) {
        /**
         * @target DatabaseAction.invalidateTxIfUnchanged `rolls back the transaction when ${type}'s second update raises %s`
         * @dependencies Existing production DAO/chain ports and synthetic fixtures.
         * @scenario Prepare the suite fixture, apply the named input or concurrent change,
         * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
         * @expected `rolls back the transaction when ${type}'s second update raises %s`; rejected mutations preserve state and do not notify.
         */

        it.each(['ABORT', 'IGNORE'])(
          `rolls back the transaction when ${type}'s second update raises %s`,
          async (mode) => {
            await prepare(type);
            const before = await state();
            const source = db().dataSource;
            const table =
              type === TransactionType.arbitrary
                ? 'arbitrary_entity'
                : 'confirmed_event_entity';
            await source.query(
              `CREATE TEMP TRIGGER reject_invalidation BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(${mode === 'ABORT' ? "ABORT, 'second update failed'" : 'IGNORE'}); END`,
            );
            try {
              const result = db().invalidateTxIfUnchanged(expected, 123, true);
              if (mode === 'ABORT')
                await expect(result).rejects.toThrow('second update failed');
              else await expect(result).resolves.toBe(false);
              expect(await state()).toEqual(before);
              expect(txNotify).not.toHaveBeenCalled();
              expect(eventNotify).not.toHaveBeenCalled();
            } finally {
              await source.query('DROP TRIGGER reject_invalidation');
            }
          },
        );
      }
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'accepts matching lastCheck boundary %s without changing it'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'accepts matching lastCheck boundary %s without changing it'; rejected mutations preserve state and do not notify.
       */

      it.each([0, Number.MAX_SAFE_INTEGER])(
        'accepts matching lastCheck boundary %s without changing it',
        async (lastCheck) => {
          await prepare();
          await db().TransactionRepository.update({ txId }, { lastCheck });
          await expect(
            db().invalidateTxIfUnchanged(expected, lastCheck, false),
          ).resolves.toBe(true);
          expect((await db().getTxById(txId))?.lastCheck).toBe(lastCheck);
        },
      );
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'requires a null %s relation for management rows'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'requires a null %s relation for management rows'; rejected mutations preserve state and do not notify.
       */

      it.each(['event', 'order'] as const)(
        'requires a null %s relation for management rows',
        async (relation) => {
          await prepare(TransactionType.manual);
          await db().TransactionRepository.update(
            { txId },
            { [relation]: { id: relation === 'event' ? eventId : orderId } },
          );
          const before = await state();
          await expect(
            db().invalidateTxIfUnchanged(expected, 123, true),
          ).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'does not overwrite an existing eligible but different event relation'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'does not overwrite an existing eligible but different event relation'; rejected mutations preserve state and do not notify.
       */

      it('does not overwrite an existing eligible but different event relation', async () => {
        await prepare();
        const other = mockEventTrigger().event;
        other.sourceTxId = 'cd'.repeat(32);
        await DatabaseActionMock.insertEventRecord(
          other,
          EventStatus.inPayment,
        );
        const otherId = Utils.txIdToEventId(other.sourceTxId);
        const before = await state();
        await expect(
          db().invalidateTxIfUnchanged(
            { ...expected, eventId: otherId },
            123,
            true,
          ),
        ).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect((await db().getEventById(otherId))?.status).toBe(
          EventStatus.inPayment,
        );
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'captures the preimage before its first asynchronous lookup'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'captures the preimage before its first asynchronous lookup'; rejected mutations preserve state and do not notify.
       */

      it('captures the preimage before its first asynchronous lookup', async () => {
        await prepare();
        const mutable = { ...expected };
        const pending = db().invalidateTxIfUnchanged(mutable, 123, false);
        mutable.txId = 'changed';
        mutable.eventId = 'changed';
        mutable.type = TransactionType.manual;
        await expect(pending).resolves.toBe(true);
        expect((await db().getTxById(txId))?.status).toBe(
          TransactionStatus.invalid,
        );
        expect(txNotify).toHaveBeenCalledExactlyOnceWith(
          txId,
          TransactionStatus.invalid,
        );
        expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
          eventId,
          EventStatus.pendingPayment,
        );
      });
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'preserves relations when the transaction has been deleted'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'preserves relations when the transaction has been deleted'; rejected mutations preserve state and do not notify.
       */

      it('preserves relations when the transaction has been deleted', async () => {
        await prepare();
        await db().TransactionRepository.delete({ txId });
        const before = await state();
        await expect(
          db().invalidateTxIfUnchanged(expected, 123, true),
        ).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
        expect(eventNotify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'allows one concurrent winner and increments exactly once'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'allows one concurrent winner and increments exactly once'; rejected mutations preserve state and do not notify.
       */

      it('allows one concurrent winner and increments exactly once', async () => {
        await prepare();
        const results = await Promise.all([
          db().invalidateTxIfUnchanged(expected, 123, true),
          db().invalidateTxIfUnchanged(expected, 123, true),
        ]);
        expect(results.sort()).toEqual([false, true]);
        expect((await state()).event?.unexpectedFails).toBe(6);
        expect(txNotify).toHaveBeenCalledTimes(1);
        expect(eventNotify).toHaveBeenCalledTimes(1);
      });
      /**
       * @target DatabaseAction.invalidateTxIfUnchanged 'keeps an unrelated writer outside a transaction that later rolls back'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.invalidateTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'keeps an unrelated writer outside a transaction that later rolls back'; rejected mutations preserve state and do not notify.
       */

      it('keeps an unrelated writer outside a transaction that later rolls back', async () => {
        await prepare();
        const before = await state();
        const unrelated = new PaymentTransaction(
          'ergo',
          'unrelated',
          '',
          Buffer.from('dcba', 'hex'),
          TransactionType.manual,
        );
        await DatabaseActionMock.insertTxRecord(
          unrelated,
          TransactionStatus.approved,
          0,
        );
        const source = db().dataSource;
        let announce!: () => void;
        let resume!: () => void;
        const entered = new Promise<void>((resolve) => (announce = resolve));
        const pause = new Promise<void>((resolve) => (resume = resolve));
        const subscriber: EntitySubscriberInterface<TransactionEntity> = {
          listenTo: () => TransactionEntity,
          afterUpdate: async (event: UpdateEvent<TransactionEntity>) => {
            if (event.entity?.status !== TransactionStatus.invalid) return;
            announce();
            await pause;
          },
        };
        source.subscribers.push(subscriber);
        await source.query(
          "CREATE TEMP TRIGGER reject_invalidation BEFORE UPDATE ON confirmed_event_entity BEGIN SELECT RAISE(ABORT, 'second update failed'); END",
        );
        const invalidating = db()
          .invalidateTxIfUnchanged(expected, 123, true)
          .catch((error: Error) => error);
        let writer: Promise<unknown> | undefined;
        try {
          await entered;
          writer = db().TransactionRepository.update(
            { txId: unrelated.txId },
            { txJson: 'winner' },
          );
          const early = await Promise.race([
            writer.then(() => 'escaped'),
            delay(30).then(() => 'waiting'),
          ]);
          resume();
          const [result] = await Promise.all([invalidating, writer]);
          expect(early).toBe('waiting');
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toContain('second update failed');
          expect(await state()).toEqual(before);
          expect((await db().getTxById(unrelated.txId))?.txJson).toBe('winner');
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        } finally {
          resume();
          await Promise.allSettled([invalidating, writer]);
          source.subscribers.splice(source.subscribers.indexOf(subscriber), 1);
          await source.query('DROP TRIGGER reject_invalidation');
        }
      });
    });
  });
  describe('updateTxLastCheckIfUnchanged', () => {
    describe('exact transaction last-check persistence', () => {
      const db = () => DatabaseActionMock.testDatabase;
      const id = 'last-check-fixture';
      const row = async () => (await db().getTxById(id))!;
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        const payment = new PaymentTransaction(
          'ergo',
          id,
          'event',
          Buffer.from('abcd', 'hex'),
          TransactionType.payment,
        );
        await DatabaseActionMock.insertTxRecord(
          payment,
          TransactionStatus.sent,
          10,
          'captured',
          true,
          2,
          3,
        );
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicTxStatus',
        ).mockResolvedValue(undefined);
      });
      afterEach(() => vi.restoreAllMocks());
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'updates only lastCheck for %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'updates only lastCheck for %s'; rejected mutations preserve state and do not notify.
       */

      it.each([TransactionStatus.sent, TransactionStatus.signFailed])(
        'updates only lastCheck for %s',
        async (status) => {
          await db().TransactionRepository.update({ txId: id }, { status });
          const before = await row();
          await expect(
            db().updateTxLastCheckIfUnchanged(
              db().captureTxCheckPreimage(before),
              11,
            ),
          ).resolves.toBe(true);
          expect(await row()).toEqual({ ...before, lastCheck: 11 });
          expect(
            PublicStatusHandler.getInstance().updatePublicTxStatus,
          ).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'accepts equal height and an explicit null status timestamp'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'accepts equal height and an explicit null status timestamp'; rejected mutations preserve state and do not notify.
       */

      it('accepts equal height and an explicit null status timestamp', async () => {
        await db().dataSource.query(
          'UPDATE transaction_entity SET lastStatusUpdate=NULL WHERE txId=?',
          [id],
        );
        const before = await row();
        await expect(
          db().updateTxLastCheckIfUnchanged(
            db().captureTxCheckPreimage(before),
            10,
          ),
        ).resolves.toBe(true);
        expect(await row()).toEqual(before);
      });
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rejects isolated captured %s mismatch'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects isolated captured %s mismatch'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['txId', 'other'],
        ['txJson', 'different'],
        ['chain', 'ethereum'],
        ['type', TransactionType.reward],
        ['status', TransactionStatus.signFailed],
        ['requiredSign', 4],
        ['eventId', 'other'],
        ['orderId', 'other'],
        ['lastCheck', 9],
        ['lastStatusUpdate', 'different'],
        ['failedInSign', false],
        ['signFailedCount', 3],
      ])('rejects isolated captured %s mismatch', async (field, value) => {
        const before = await row();
        const expected = db().captureTxCheckPreimage(before);
        await expect(
          db().updateTxLastCheckIfUnchanged(
            { ...expected, [field as string]: value },
            11,
          ),
        ).resolves.toBe(false);
        expect(await row()).toEqual(before);
        expect(
          PublicStatusHandler.getInstance().updatePublicTxStatus,
        ).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rejects undefined %s before SQL'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects undefined %s before SQL'; rejected mutations preserve state and do not notify.
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
      ])('rejects undefined %s before SQL', async (field) => {
        const expected = db().captureTxCheckPreimage(await row());
        const transaction = vi.spyOn(db().dataSource, 'transaction');
        await expect(
          db().updateTxLastCheckIfUnchanged(
            { ...expected, [field]: undefined },
            11,
          ),
        ).rejects.toThrow();
        expect(transaction).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rejects invalid or regressing target %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid or regressing target %s'; rejected mutations preserve state and do not notify.
       */

      it.each([-1, 9, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 10.5, '11'])(
        'rejects invalid or regressing target %s',
        async (height) => {
          const before = await row();
          await expect(
            db().updateTxLastCheckIfUnchanged(
              db().captureTxCheckPreimage(before),
              height as number,
            ),
          ).rejects.toThrow();
          expect(await row()).toEqual(before);
        },
      );
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rejects ineligible status %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects ineligible status %s'; rejected mutations preserve state and do not notify.
       */

      it.each([
        TransactionStatus.approved,
        TransactionStatus.inSign,
        TransactionStatus.signed,
        TransactionStatus.completed,
        TransactionStatus.invalid,
      ])('rejects ineligible status %s', async (status) => {
        const before = await row();
        expect(() =>
          db().captureTxCheckPreimage({ ...before, status }),
        ).toThrow();
      });
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'captures caller fields before waiting for SQL ownership'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'captures caller fields before waiting for SQL ownership'; rejected mutations preserve state and do not notify.
       */

      it('captures caller fields before waiting for SQL ownership', async () => {
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const acquired = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const before = await row();
        const expected = { ...db().captureTxCheckPreimage(before) };
        const owner = db().dataSource.transaction(async () => {
          entered();
          await gate;
        });
        await acquired;
        const pending = db().updateTxLastCheckIfUnchanged(expected, 11);
        expected.txJson = 'caller mutation';
        expected.lastCheck = 999;
        release();
        await owner;
        await expect(pending).resolves.toBe(true);
        expect(await row()).toEqual({ ...before, lastCheck: 11 });
      });
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'preserves a concurrent newer refresh after waiting for SQL ownership'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'preserves a concurrent newer refresh after waiting for SQL ownership'; rejected mutations preserve state and do not notify.
       */

      it('preserves a concurrent newer refresh after waiting for SQL ownership', async () => {
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const acquired = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const expected = db().captureTxCheckPreimage(await row());
        const owner = db().dataSource.transaction(async (manager) => {
          await manager
            .getRepository(TransactionEntity)
            .update({ txId: id }, { lastCheck: 20 });
          entered();
          await gate;
        });
        await acquired;
        const pending = db().updateTxLastCheckIfUnchanged(expected, 11);
        release();
        await owner;
        await expect(pending).resolves.toBe(false);
        expect((await row()).lastCheck).toBe(20);
      });
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'rolls back AFTER-trigger %s mutation'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back AFTER-trigger %s mutation'; rejected mutations preserve state and do not notify.
       */

      it.each([
        'status',
        'txJson',
        'lastCheck',
        'lastStatusUpdate',
        'failedInSign',
        'signFailedCount',
        'requiredSign',
      ])('rolls back AFTER-trigger %s mutation', async (field) => {
        const values: Record<string, string> = {
          status: "'completed'",
          txJson: "'changed'",
          lastCheck: '99',
          lastStatusUpdate: "'changed'",
          failedInSign: '0',
          signFailedCount: '99',
          requiredSign: '99',
        };
        const before = await row();
        await db().dataSource.query(
          `CREATE TEMP TRIGGER lastcheck_test AFTER UPDATE ON transaction_entity WHEN NEW.lastCheck=11 BEGIN UPDATE transaction_entity SET "${field}"=${values[field]} WHERE txId=NEW.txId; END`,
        );
        try {
          await expect(
            db().updateTxLastCheckIfUnchanged(
              db().captureTxCheckPreimage(before),
              11,
            ),
          ).rejects.toThrow('postcondition');
          expect(await row()).toEqual(before);
        } finally {
          await db().dataSource.query('DROP TRIGGER lastcheck_test');
        }
      });
      /**
       * @target DatabaseAction.updateTxLastCheckIfUnchanged 'leaves no partial write on %s trigger'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateTxLastCheckIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'leaves no partial write on %s trigger'; rejected mutations preserve state and do not notify.
       */

      it.each(['ABORT', 'IGNORE'])(
        'leaves no partial write on %s trigger',
        async (fault) => {
          const before = await row();
          await db().dataSource.query(
            `CREATE TEMP TRIGGER lastcheck_test BEFORE UPDATE ON transaction_entity BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'refused'" : ''}); END`,
          );
          try {
            const pending = db().updateTxLastCheckIfUnchanged(
              db().captureTxCheckPreimage(before),
              11,
            );
            if (fault === 'ABORT')
              await expect(pending).rejects.toThrow('refused');
            else await expect(pending).resolves.toBe(false);
            expect(await row()).toEqual(before);
          } finally {
            await db().dataSource.query('DROP TRIGGER lastcheck_test');
          }
        },
      );
    });
  });
  describe('recoverSignedPaymentIfUnchanged', () => {
    describe('observed payment recovery persistence', () => {
      const db = () => DatabaseActionMock.testDatabase;
      let expected: TransactionCheckPreimage;
      let signedJson: string;
      let authority: SigningPersistenceAuthorization;
      let notify: MockInstance<PublicStatusHandler['updatePublicTxStatus']>;
      const fields = [
        ['txId', "'different-id'"],
        ['txJson', "'different-json'"],
        ['chain', "'different-chain'"],
        ['type', "'different-type'"],
        ['status', "'different-status'"],
        ['requiredSign', '99'],
        ['eventId', 'NULL'],
        ['orderId', "'other-order'"],
        ['lastCheck', '99'],
        ['lastStatusUpdate', "'different-time'"],
        ['failedInSign', '0'],
        ['signFailedCount', '99'],
      ] as const;
      const row = () => db().getTxById(expected.txId);
      const snapshot = async () => ({
        transactions: await db().TransactionRepository.find({
          relations: ['event', 'order'],
        }),
        events: await db().ConfirmedEventRepository.find({
          relations: ['eventData'],
        }),
      });
      const recover = () =>
        db().recoverSignedPaymentIfUnchanged(expected, signedJson, authority);

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        const event = mockEventTrigger().event;
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.inPayment,
        );
        await DatabaseActionMock.insertOrderRecord(
          'other-order',
          'ergo',
          '[]',
          OrderStatus.inProcess,
        );
        const payment = new PaymentTransaction(
          'ergo',
          'fixture-id',
          Utils.txIdToEventId(event.sourceTxId),
          Buffer.from('abcd', 'hex'),
          TransactionType.payment,
        );
        await DatabaseActionMock.insertTxRecord(
          payment,
          TransactionStatus.signFailed,
          7,
          'old-time',
          true,
          2,
          3,
        );
        expected = db().captureTxCheckPreimage(
          (await db().getTxById(payment.txId))!,
        );
        payment.txBytes = Buffer.from('aabb', 'hex');
        signedJson = payment.toJson();
        authority = {
          assertActive: vi.fn(),
          assertBefore: vi.fn(async () => undefined),
          assertAfter: vi.fn(async () => undefined),
        };
        notify = vi
          .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
          .mockResolvedValue(undefined);
      });
      afterEach(() => vi.restoreAllMocks());
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'atomically recovers %s and passes the actual full after tuple'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'atomically recovers %s and passes the actual full after tuple'; rejected mutations preserve state and do not notify.
       */

      it.each(['ergo'])(
        'atomically recovers %s and passes the actual full after tuple',
        async (chain) => {
          const original = JSON.parse(expected.txJson);
          original.network = chain;
          await db().TransactionRepository.update(
            { txId: expected.txId },
            { chain, txJson: JSON.stringify(original) },
          );
          expected = db().captureTxCheckPreimage((await row())!);
          signedJson = JSON.stringify({ ...original, txBytes: 'aabb' });
          const eventBefore = (await snapshot()).events;
          const before = vi.fn(async (manager, input) => {
            expect(manager).not.toBe(db().dataSource.manager);
            expect(input).toEqual(expected);
            expect(Object.isFrozen(input)).toBe(true);
            expect(
              await manager
                .getRepository(TransactionEntity)
                .findOneBy({ txId: input.txId }),
            ).toMatchObject({
              txJson: expected.txJson,
              status: TransactionStatus.signFailed,
            });
            expect(notify).not.toHaveBeenCalled();
          });
          const after = vi.fn(async (manager, input) => {
            expect(input).toEqual({
              ...expected,
              status: TransactionStatus.sent,
              txJson: signedJson,
              lastStatusUpdate: expect.stringMatching(/^\d+$/),
            });
            expect(Object.isFrozen(input)).toBe(true);
            expect(
              await manager
                .getRepository(TransactionEntity)
                .findOneBy({ txId: input.txId }),
            ).toMatchObject({
              txJson: signedJson,
              status: TransactionStatus.sent,
              lastStatusUpdate: input.lastStatusUpdate,
            });
            expect(notify).not.toHaveBeenCalled();
          });
          authority.assertBefore = before;
          authority.assertAfter = after;
          await expect(recover()).resolves.toBe(true);
          expect(before).toHaveBeenCalledTimes(1);
          expect(after).toHaveBeenCalledTimes(1);
          expect((await snapshot()).events).toEqual(eventBefore);
          expect(db().captureTxCheckPreimage((await row())!)).toEqual({
            ...expected,
            txJson: signedJson,
            status: TransactionStatus.sent,
            lastStatusUpdate: expect.any(String),
          });
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expected.txId,
            TransactionStatus.sent,
          );
          await expect(recover()).resolves.toBe(false);
          expect(notify).toHaveBeenCalledTimes(1);
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'compares stale %s in the original twelve-field CAS'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'compares stale %s in the original twelve-field CAS'; rejected mutations preserve state and do not notify.
       */

      it.each(fields)(
        'compares stale %s in the original twelve-field CAS',
        async (field, value) => {
          await db().dataSource.query(
            `UPDATE transaction_entity SET "${field}"=${value}`,
          );
          const before = await snapshot();
          await expect(recover()).resolves.toBe(false);
          expect(await snapshot()).toEqual(before);
          expect(authority.assertBefore).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects malformed preimage %s=%s before SQL'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects malformed preimage %s=%s before SQL'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['status', TransactionStatus.sent],
        ['type', TransactionType.reward],
        ['chain', 'ethereum'],
        ['eventId', null],
        ['orderId', 'other-order'],
        ['lastCheck', -1],
        ['lastCheck', 1.5],
        ['lastCheck', Number.MAX_SAFE_INTEGER + 1],
        ['lastStatusUpdate', undefined],
        ['failedInSign', 1],
        ['signFailedCount', -1],
        ['signFailedCount', 1.5],
        ['requiredSign', 0],
        ['txId', ''],
        ['txJson', ''],
      ])(
        'rejects malformed preimage %s=%s before SQL',
        async (field, value) => {
          expected = {
            ...expected,
            [field as string]: value,
          } as TransactionCheckPreimage;
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(recover()).rejects.toThrow();
          expect(transaction).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects omitted preimage %s before SQL'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects omitted preimage %s before SQL'; rejected mutations preserve state and do not notify.
       */

      it.each(fields)(
        'rejects omitted preimage %s before SQL',
        async (field) => {
          expected = {
            ...expected,
            [field]: undefined,
          } as unknown as TransactionCheckPreimage;
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(recover()).rejects.toThrow();
          expect(transaction).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'matches a null previous timestamp exactly'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'matches a null previous timestamp exactly'; rejected mutations preserve state and do not notify.
       */

      it('matches a null previous timestamp exactly', async () => {
        await db().dataSource.query(
          'UPDATE transaction_entity SET lastStatusUpdate=NULL',
        );
        expected = db().captureTxCheckPreimage((await row())!);
        await expect(recover()).resolves.toBe(true);
        expect((await row())!.lastStatusUpdate).toMatch(/^\d+$/);
      });
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects malformed signed JSON %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects malformed signed JSON %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['', '{', 'null', '[]', '"scalar"', '{}'])(
        'rejects malformed signed JSON %s',
        async (json) => {
          signedJson = json;
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(recover()).rejects.toThrow();
          expect(transaction).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects malformed signed model %s=%s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects malformed signed model %s=%s'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['network', 'ethereum'],
        ['txId', 'other'],
        ['eventId', 'other'],
        ['txType', TransactionType.reward],
        ['txBytes', ''],
        ['txBytes', 'abc'],
        ['txBytes', 'AA'],
        ['txBytes', 'zz'],
        ['txBytes', 3],
      ])('rejects malformed signed model %s=%s', async (field, value) => {
        signedJson = JSON.stringify({
          ...JSON.parse(signedJson),
          [field as string]: value,
        });
        await expect(recover()).rejects.toThrow('signed model');
        expect(notify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'requires %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'requires %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['assertActive', 'assertBefore', 'assertAfter'] as const)(
        'requires %s',
        async (field) => {
          authority = {
            ...authority,
            [field]: undefined,
          } as unknown as SigningPersistenceAuthorization;
          await expect(recover()).rejects.toThrow('authority');
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'requires the authority object'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'requires the authority object'; rejected mutations preserve state and do not notify.
       */

      it('requires the authority object', async () => {
        authority = undefined as unknown as SigningPersistenceAuthorization;
        await expect(recover()).rejects.toThrow('authority');
      });
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back rejected %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back rejected %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['assertBefore', 'assertAfter'] as const)(
        'rolls back rejected %s',
        async (phase) => {
          const before = await snapshot();
          authority[phase] = async () => {
            throw new Error('authority refused');
          };
          await expect(recover()).rejects.toThrow('authority refused');
          expect(await snapshot()).toEqual(before);
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back expired activity gate %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back expired activity gate %s'; rejected mutations preserve state and do not notify.
       */

      it.each([1, 2, 3])(
        'rolls back expired activity gate %s',
        async (gate) => {
          const before = await snapshot();
          let calls = 0;
          authority.assertActive = () => {
            if (++calls === gate) throw new Error('expired');
          };
          await expect(recover()).rejects.toThrow('expired');
          expect(await snapshot()).toEqual(before);
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back AFTER-trigger %s mutation'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back AFTER-trigger %s mutation'; rejected mutations preserve state and do not notify.
       */

      it.each(fields)(
        'rolls back AFTER-trigger %s mutation',
        async (field, value) => {
          const before = await snapshot();
          await db().dataSource.query(
            `CREATE TEMP TRIGGER recovery_test AFTER UPDATE ON transaction_entity BEGIN UPDATE transaction_entity SET "${field}"=${value} WHERE txId=NEW.txId; END`,
          );
          try {
            await expect(recover()).rejects.toThrow('postcondition');
            expect(await snapshot()).toEqual(before);
            expect(notify).not.toHaveBeenCalled();
          } finally {
            await db().dataSource.query('DROP TRIGGER recovery_test');
          }
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back %s including callback writes'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back %s including callback writes'; rejected mutations preserve state and do not notify.
       */

      it.each(['ABORT', 'IGNORE'])(
        'rolls back %s including callback writes',
        async (fault) => {
          const before = await snapshot();
          authority.assertBefore = async (manager) => {
            await manager
              .getRepository(ConfirmedEventEntity)
              .update({ id: expected.eventId! }, { unexpectedFails: 7 });
          };
          await db().dataSource.query(
            `CREATE TEMP TRIGGER recovery_test BEFORE UPDATE ON transaction_entity BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'refused'" : ''}); END`,
          );
          try {
            if (fault === 'ABORT')
              await expect(recover()).rejects.toThrow('refused');
            else await expect(recover()).resolves.toBe(false);
            expect(await snapshot()).toEqual(before);
            expect(notify).not.toHaveBeenCalled();
          } finally {
            await db().dataSource.query('DROP TRIGGER recovery_test');
          }
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back event trigger %s.%s changes'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back event trigger %s.%s changes'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['confirmed_event_entity', 'status', "'pending-payment'"],
        ['confirmed_event_entity', 'firstTry', "'changed'"],
        ['confirmed_event_entity', 'unexpectedFails', '99'],
        ['confirmed_event_entity', 'eventDataId', 'NULL'],
        ['event_trigger_entity', 'spendTxId', "'other-spend'"],
      ])(
        'rolls back event trigger %s.%s changes',
        async (table, field, value) => {
          const before = await snapshot();
          await db().dataSource.query(
            `CREATE TEMP TRIGGER recovery_test AFTER UPDATE ON transaction_entity BEGIN UPDATE ${table} SET "${field}"=${value}; END`,
          );
          try {
            await expect(recover()).rejects.toThrow('event postcondition');
            expect(await snapshot()).toEqual(before);
            expect(notify).not.toHaveBeenCalled();
          } finally {
            await db().dataSource.query('DROP TRIGGER recovery_test');
          }
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back callback event mutation at %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back callback event mutation at %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['assertBefore', 'assertAfter'] as const)(
        'rolls back callback event mutation at %s',
        async (phase) => {
          const before = await snapshot();
          authority[phase] = async (manager) => {
            await manager
              .getRepository(ConfirmedEventEntity)
              .update({ id: expected.eventId! }, { unexpectedFails: 99 });
          };
          await expect(recover()).rejects.toThrow('event postcondition');
          expect(await snapshot()).toEqual(before);
        },
      );
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back callback row mutation before the exact CAS'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back callback row mutation before the exact CAS'; rejected mutations preserve state and do not notify.
       */

      it('rolls back callback row mutation before the exact CAS', async () => {
        const before = await snapshot();
        authority.assertBefore = async (manager) => {
          await manager
            .getRepository(TransactionEntity)
            .update({ txId: expected.txId }, { signFailedCount: 999 });
        };
        await expect(recover()).resolves.toBe(false);
        expect(await snapshot()).toEqual(before);
        expect(notify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rolls back callback row mutation after writing'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rolls back callback row mutation after writing'; rejected mutations preserve state and do not notify.
       */

      it('rolls back callback row mutation after writing', async () => {
        const before = await snapshot();
        authority.assertAfter = async (manager) => {
          await manager
            .getRepository(TransactionEntity)
            .update({ txId: expected.txId }, { lastCheck: 999 });
        };
        await expect(recover()).rejects.toThrow('row postcondition');
        expect(await snapshot()).toEqual(before);
      });
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'rejects a different event phase without touching the row'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects a different event phase without touching the row'; rejected mutations preserve state and do not notify.
       */

      it('rejects a different event phase without touching the row', async () => {
        await db().ConfirmedEventRepository.update(
          { id: expected.eventId! },
          { status: EventStatus.pendingPayment },
        );
        const before = await snapshot();
        await expect(recover()).rejects.toThrow('recovery event');
        expect(await snapshot()).toEqual(before);
      });
      /**
       * @target DatabaseAction.recoverSignedPaymentIfUnchanged 'handles queued SQL ownership: %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.recoverSignedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'handles queued SQL ownership: %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['capture', 'expiry', 'concurrent winner'])(
        'handles queued SQL ownership: %s',
        async (scenario) => {
          let release!: () => void, entered!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const acquired = new Promise<void>((resolve) => {
            entered = resolve;
          });
          let active = true;
          authority.assertActive = () => {
            if (!active) throw new Error('expired');
          };
          expected = { ...expected };
          const original = { ...expected };
          const owner = db().dataSource.transaction(async (manager) => {
            if (scenario === 'concurrent winner')
              await manager
                .getRepository(TransactionEntity)
                .update({ txId: original.txId }, { lastCheck: 99 });
            entered();
            await gate;
          });
          await acquired;
          const pending = recover();
          const outcome = pending.then(
            (value) => value,
            (error: Error) => error,
          );
          try {
            if (scenario === 'capture') {
              (expected as { txJson: string }).txJson = 'caller mutation';
              authority.assertActive = () => {
                throw new Error('replacement callback');
              };
            } else if (scenario === 'expiry') active = false;
          } finally {
            release();
            await owner;
          }
          const result = await outcome;
          if (scenario === 'capture') {
            expect(result).toBe(true);
            expect((await row())!.txJson).toBe(signedJson);
          } else {
            if (scenario === 'expiry') expect(result).toBeInstanceOf(Error);
            else expect(result).toBe(false);
            expect((await row())!.txJson).toBe(original.txJson);
            expect(notify).not.toHaveBeenCalled();
            expect(authority.assertBefore).not.toHaveBeenCalled();
          }
        },
      );
    });
  });
  describe('updateWithSignedTxIfUnchanged', () => {
    describe('qualified signed transaction persistence', () => {
      const db = () => DatabaseActionMock.testDatabase;
      let expected: SigningRowPreimage;
      let signedJson: string;
      let notify: MockInstance<PublicStatusHandler['updatePublicTxStatus']>;

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        const payment = new PaymentTransaction(
          'ergo',
          'fixture-id',
          'fixture-event',
          Buffer.from('abcd', 'hex'),
          TransactionType.payment,
        );
        await DatabaseActionMock.insertTxRecord(
          payment,
          TransactionStatus.inSign,
          0,
          undefined,
          false,
          0,
          3,
        );
        expected = {
          txId: payment.txId,
          txJson: payment.toJson(),
          chain: payment.network,
          type: payment.txType,
          status: TransactionStatus.inSign,
          requiredSign: 3,
          eventId: null,
          orderId: null,
        };
        payment.txBytes = Buffer.from('aabb', 'hex');
        signedJson = payment.toJson();
        notify = vi
          .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
          .mockResolvedValue(undefined);
      });

      afterEach(() => notify.mockRestore());
      /**
       * @target DatabaseAction.updateWithSignedTxIfUnchanged 'atomically replaces the exact in-sign row and notifies once'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateWithSignedTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'atomically replaces the exact in-sign row and notifies once'; rejected mutations preserve state and do not notify.
       */

      it('atomically replaces the exact in-sign row and notifies once', async () => {
        await expect(
          db().updateWithSignedTxIfUnchanged(expected, signedJson),
        ).resolves.toBe(true);
        expect(await db().getTxById(expected.txId)).toMatchObject({
          txJson: signedJson,
          status: TransactionStatus.signed,
          requiredSign: 3,
        });
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          expected.txId,
          TransactionStatus.signed,
        );
        await expect(
          db().updateWithSignedTxIfUnchanged(expected, 'late-result'),
        ).resolves.toBe(false);
        expect((await db().getTxById(expected.txId))!.txJson).toBe(signedJson);
        expect(notify).toHaveBeenCalledTimes(1);
      });
      /**
       * @target DatabaseAction.updateWithSignedTxIfUnchanged 'matches a populated %s foreign key and rejects a stale null reference'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateWithSignedTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'matches a populated %s foreign key and rejects a stale null reference'; rejected mutations preserve state and do not notify.
       */

      it.each(['event', 'order'] as const)(
        'matches a populated %s foreign key and rejects a stale null reference',
        async (relation) => {
          let id: string;
          if (relation === 'event') {
            const event = mockEventTrigger().event;
            await DatabaseActionMock.insertEventRecord(
              event,
              EventStatus.inPayment,
            );
            id = Utils.txIdToEventId(event.sourceTxId);
          } else {
            id = 'fixture-order';
            await DatabaseActionMock.insertOrderRecord(
              id,
              'ergo',
              '[]',
              OrderStatus.inProcess,
            );
          }
          await db().TransactionRepository.update(
            { txId: expected.txId },
            { [relation]: { id } },
          );
          await expect(
            db().updateWithSignedTxIfUnchanged(expected, signedJson),
          ).resolves.toBe(false);
          const matched = {
            ...expected,
            [relation === 'event' ? 'eventId' : 'orderId']: id,
          };
          await expect(
            db().updateWithSignedTxIfUnchanged(matched, signedJson),
          ).resolves.toBe(true);
          expect((await db().getTxById(expected.txId))![relation]?.id).toBe(id);
          expect(notify).toHaveBeenCalledTimes(1);
        },
      );
      /**
       * @target DatabaseAction.updateWithSignedTxIfUnchanged 'does not persist when only %s differs from the preimage'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateWithSignedTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'does not persist when only %s differs from the preimage'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['txId', 'missing-id'],
        ['txJson', 'changed-unsigned'],
        ['chain', 'ethereum'],
        ['type', TransactionType.reward],
        ['requiredSign', 4],
        ['eventId', 'other-event'],
        ['orderId', 'other-order'],
      ] as const)(
        'does not persist when only %s differs from the preimage',
        async (field, value) => {
          await expect(
            db().updateWithSignedTxIfUnchanged(
              { ...expected, [field]: value },
              signedJson,
            ),
          ).resolves.toBe(false);
          expect((await db().getTxById(expected.txId))!.txJson).toBe(
            expected.txJson,
          );
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.updateWithSignedTxIfUnchanged 'rejects a row that changed to %s after validation'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateWithSignedTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects a row that changed to %s after validation'; rejected mutations preserve state and do not notify.
       */

      it.each([
        TransactionStatus.approved,
        TransactionStatus.signFailed,
        TransactionStatus.signed,
        TransactionStatus.sent,
        TransactionStatus.invalid,
        TransactionStatus.completed,
      ])(
        'rejects a row that changed to %s after validation',
        async (status) => {
          await db().TransactionRepository.update(
            { txId: expected.txId },
            { status },
          );
          await expect(
            db().updateWithSignedTxIfUnchanged(expected, signedJson),
          ).resolves.toBe(false);
          expect((await db().getTxById(expected.txId))!.txJson).toBe(
            expected.txJson,
          );
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.updateWithSignedTxIfUnchanged 'does not recreate a deleted row'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateWithSignedTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'does not recreate a deleted row'; rejected mutations preserve state and do not notify.
       */

      it('does not recreate a deleted row', async () => {
        await db().TransactionRepository.delete({ txId: expected.txId });
        await expect(
          db().updateWithSignedTxIfUnchanged(expected, signedJson),
        ).resolves.toBe(false);
        expect(await db().getTxById(expected.txId)).toBeNull();
        expect(notify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.updateWithSignedTxIfUnchanged 'preserves a replacement written after the preimage was captured'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateWithSignedTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'preserves a replacement written after the preimage was captured'; rejected mutations preserve state and do not notify.
       */

      it('preserves a replacement written after the preimage was captured', async () => {
        await db().TransactionRepository.update(
          { txId: expected.txId },
          { txJson: 'replacement' },
        );
        await expect(
          db().updateWithSignedTxIfUnchanged(expected, signedJson),
        ).resolves.toBe(false);
        expect((await db().getTxById(expected.txId))!.txJson).toBe(
          'replacement',
        );
        expect(notify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.updateWithSignedTxIfUnchanged 'refuses missing %s rather than omitting an SQL predicate'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateWithSignedTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'refuses missing %s rather than omitting an SQL predicate'; rejected mutations preserve state and do not notify.
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
      ] as const)(
        'refuses missing %s rather than omitting an SQL predicate',
        async (field) => {
          await expect(
            db().updateWithSignedTxIfUnchanged(
              {
                ...expected,
                [field]: undefined,
              } as unknown as SigningRowPreimage,
              signedJson,
            ),
          ).rejects.toThrow('preimage');
          expect((await db().getTxById(expected.txId))!.txJson).toBe(
            expected.txJson,
          );
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.updateWithSignedTxIfUnchanged 'requires an in-sign preimage and nonempty signed bytes'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.updateWithSignedTxIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'requires an in-sign preimage and nonempty signed bytes'; rejected mutations preserve state and do not notify.
       */

      it('requires an in-sign preimage and nonempty signed bytes', async () => {
        await expect(
          db().updateWithSignedTxIfUnchanged(
            { ...expected, status: TransactionStatus.approved },
            signedJson,
          ),
        ).rejects.toThrow('preimage');
        await expect(
          db().updateWithSignedTxIfUnchanged(expected, ''),
        ).rejects.toThrow('preimage');
        expect(notify).not.toHaveBeenCalled();
      });
    });
  });
  describe('setTxStatusIfUnchanged', () => {
    describe('exact preimage transaction status persistence', () => {
      const db = () => DatabaseActionMock.testDatabase;
      let expected: SigningRowPreimage;
      let notify: MockInstance<PublicStatusHandler['updatePublicTxStatus']>;

      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        const payment = new PaymentTransaction(
          'ergo',
          'status-fixture',
          'event-fixture',
          Buffer.from('abcd', 'hex'),
          TransactionType.payment,
        );
        await DatabaseActionMock.insertTxRecord(
          payment,
          TransactionStatus.inSign,
          0,
          undefined,
          false,
          2,
          3,
        );
        expected = {
          txId: payment.txId,
          txJson: payment.toJson(),
          chain: payment.network,
          type: payment.txType,
          status: TransactionStatus.inSign,
          requiredSign: 3,
          eventId: null,
          orderId: null,
        };
        notify = vi
          .spyOn(PublicStatusHandler.getInstance(), 'updatePublicTxStatus')
          .mockResolvedValue(undefined);
      });

      afterEach(() => vi.restoreAllMocks());
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'accepts the known target status %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'accepts the known target status %s'; rejected mutations preserve state and do not notify.
       */

      it.each(Object.values(TransactionStatus))(
        'accepts the known target status %s',
        async (status) => {
          await expect(
            db().setTxStatusIfUnchanged(expected, status),
          ).resolves.toBe(true);
          expect(await db().getTxById(expected.txId)).toMatchObject({
            status,
            txJson: expected.txJson,
            requiredSign: 3,
            failedInSign: status === TransactionStatus.signFailed,
            signFailedCount: status === TransactionStatus.signFailed ? 3 : 2,
          });
          expect(notify).toHaveBeenCalledExactlyOnceWith(expected.txId, status);
        },
      );
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'accepts the known starting status %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'accepts the known starting status %s'; rejected mutations preserve state and do not notify.
       */

      it.each(Object.values(TransactionStatus))(
        'accepts the known starting status %s',
        async (status) => {
          await db().TransactionRepository.update(
            { txId: expected.txId },
            { status },
          );
          await expect(
            db().setTxStatusIfUnchanged(
              { ...expected, status },
              TransactionStatus.sent,
            ),
          ).resolves.toBe(true);
          expect((await db().getTxById(expected.txId))!.status).toBe(
            TransactionStatus.sent,
          );
        },
      );
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'rejects an isolated mismatch in %s without any write'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects an isolated mismatch in %s without any write'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['txId', 'other-id'],
        ['txJson', 'different-json'],
        ['chain', 'ethereum'],
        ['type', TransactionType.reward],
        ['status', TransactionStatus.approved],
        ['requiredSign', 4],
        ['eventId', 'other-event'],
        ['orderId', 'other-order'],
      ] as const)(
        'rejects an isolated mismatch in %s without any write',
        async (field, value) => {
          const before = await db().getTxById(expected.txId);
          await expect(
            db().setTxStatusIfUnchanged(
              { ...expected, [field]: value },
              TransactionStatus.sent,
            ),
          ).resolves.toBe(false);
          expect(await db().getTxById(expected.txId)).toEqual(before);
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'rejects undefined %s before issuing an update'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects undefined %s before issuing an update'; rejected mutations preserve state and do not notify.
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
      ] as const)(
        'rejects undefined %s before issuing an update',
        async (field) => {
          const update = vi.spyOn(db().TransactionRepository, 'update');
          await expect(
            db().setTxStatusIfUnchanged(
              {
                ...expected,
                [field]: undefined,
              } as unknown as SigningRowPreimage,
              TransactionStatus.sent,
            ),
          ).rejects.toThrow('preimage');
          expect(update).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'rejects invalid %s=%s before issuing an update'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid %s=%s before issuing an update'; rejected mutations preserve state and do not notify.
       */

      it.each([
        ['txId', ''],
        ['txJson', ''],
        ['chain', ''],
        ['type', ''],
        ['status', 'unknown'],
        ['requiredSign', 0],
        ['requiredSign', 1.5],
        ['requiredSign', Number.MAX_SAFE_INTEGER + 1],
        ['eventId', ''],
        ['orderId', ''],
      ] as const)(
        'rejects invalid %s=%s before issuing an update',
        async (field, value) => {
          const update = vi.spyOn(db().TransactionRepository, 'update');
          await expect(
            db().setTxStatusIfUnchanged(
              { ...expected, [field]: value },
              TransactionStatus.sent,
            ),
          ).rejects.toThrow('preimage');
          expect(update).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'rejects invalid target %s before issuing an update'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid target %s before issuing an update'; rejected mutations preserve state and do not notify.
       */

      it.each([undefined, null, '', 'unknown', 0])(
        'rejects invalid target %s before issuing an update',
        async (status) => {
          const update = vi.spyOn(db().TransactionRepository, 'update');
          await expect(
            db().setTxStatusIfUnchanged(expected, status as string),
          ).rejects.toThrow('status transition');
          expect(update).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'rejects signing failure from %s before querying'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects signing failure from %s before querying'; rejected mutations preserve state and do not notify.
       */

      it.each(
        Object.values(TransactionStatus).filter(
          (status) => status !== TransactionStatus.inSign,
        ),
      )('rejects signing failure from %s before querying', async (status) => {
        const update = vi.spyOn(db().TransactionRepository, 'update');
        await expect(
          db().setTxStatusIfUnchanged(
            { ...expected, status },
            TransactionStatus.signFailed,
          ),
        ).rejects.toThrow('status transition');
        expect(update).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'matches explicit populated %s and refuses stale null'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'matches explicit populated %s and refuses stale null'; rejected mutations preserve state and do not notify.
       */

      it.each(['event', 'order'] as const)(
        'matches explicit populated %s and refuses stale null',
        async (relation) => {
          let id: string;
          if (relation === 'event') {
            const event = mockEventTrigger().event;
            await DatabaseActionMock.insertEventRecord(
              event,
              EventStatus.inPayment,
            );
            id = Utils.txIdToEventId(event.sourceTxId);
          } else {
            id = 'status-order';
            await DatabaseActionMock.insertOrderRecord(
              id,
              'ergo',
              '[]',
              OrderStatus.inProcess,
            );
          }
          await db().TransactionRepository.update(
            { txId: expected.txId },
            { [relation]: { id } },
          );
          await expect(
            db().setTxStatusIfUnchanged(expected, TransactionStatus.sent),
          ).resolves.toBe(false);
          expect(notify).not.toHaveBeenCalled();
          await expect(
            db().setTxStatusIfUnchanged(
              {
                ...expected,
                [relation === 'event' ? 'eventId' : 'orderId']: id,
              },
              TransactionStatus.sent,
            ),
          ).resolves.toBe(true);
          expect((await db().getTxById(expected.txId))![relation]?.id).toBe(id);
          expect(notify).toHaveBeenCalledTimes(1);
        },
      );
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'increments signing failure exactly once across concurrent stale callbacks'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'increments signing failure exactly once across concurrent stale callbacks'; rejected mutations preserve state and do not notify.
       */

      it('increments signing failure exactly once across concurrent stale callbacks', async () => {
        const results = await Promise.all([
          db().setTxStatusIfUnchanged(expected, TransactionStatus.signFailed),
          db().setTxStatusIfUnchanged(expected, TransactionStatus.signFailed),
        ]);
        expect(results.sort()).toEqual([false, true]);
        expect(await db().getTxById(expected.txId)).toMatchObject({
          status: TransactionStatus.signFailed,
          failedInSign: true,
          signFailedCount: 3,
        });
        expect(notify).toHaveBeenCalledTimes(1);
      });
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'does not recreate a removed row or notify'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'does not recreate a removed row or notify'; rejected mutations preserve state and do not notify.
       */

      it('does not recreate a removed row or notify', async () => {
        await db().TransactionRepository.delete({ txId: expected.txId });
        await expect(
          db().setTxStatusIfUnchanged(expected, TransactionStatus.sent),
        ).resolves.toBe(false);
        expect(await db().getTxById(expected.txId)).toBeNull();
        expect(notify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.setTxStatusIfUnchanged 'preserves every column when SQLite rejects the atomic failure update'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.setTxStatusIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'preserves every column when SQLite rejects the atomic failure update'; rejected mutations preserve state and do not notify.
       */

      it('preserves every column when SQLite rejects the atomic failure update', async () => {
        const before = await db().getTxById(expected.txId);
        await db().dataSource.query(
          `CREATE TEMP TRIGGER reject_status_update BEFORE UPDATE ON transaction_entity BEGIN SELECT RAISE(ABORT, 'fixture update rejected'); END`,
        );
        try {
          await expect(
            db().setTxStatusIfUnchanged(expected, TransactionStatus.signFailed),
          ).rejects.toThrow('fixture update rejected');
          expect(await db().getTxById(expected.txId)).toEqual(before);
          expect(notify).not.toHaveBeenCalled();
        } finally {
          await db().dataSource.query('DROP TRIGGER reject_status_update');
        }
      });
    });
  });
  describe('insertSynchronizedPaymentIfUnchanged', () => {
    describe('atomic synchronized payment persistence', () => {
      const db = () => DatabaseActionMock.testDatabase;
      let expected: ConfirmedEventEntity;
      let payment: PaymentTransaction;
      const txNotify = vi.fn();
      const eventNotify = vi.fn();
      const prepare = async (
        network = 'ethereum',
        firstTry: string | undefined = 'first',
      ) => {
        const event = mockEventTrigger().event;
        event.fromChain = 'ergo';
        event.toChain = network;
        await DatabaseActionMock.insertEventRecord(
          event,
          EventStatus.pendingPayment,
          undefined,
          undefined,
          firstTry,
        );
        const eventId = Utils.txIdToEventId(event.sourceTxId);
        await db().ConfirmedEventRepository.update(
          { id: eventId },
          { unexpectedFails: 4 },
        );
        expected = (await db().getEventById(eventId))!;
        payment =
          network === 'ergo'
            ? new ErgoTransaction(
                'sync-payment',
                eventId,
                Buffer.from('abcd', 'hex'),
                TransactionType.payment,
                [Buffer.from('dcba', 'hex')],
                [],
              )
            : new PaymentTransaction(
                network,
                'sync-payment',
                eventId,
                Buffer.from('abcd', 'hex'),
                TransactionType.payment,
              );
      };
      const state = async () => ({
        events: await db().ConfirmedEventRepository.find({
          relations: ['eventData'],
        }),
        transactions: await db().TransactionRepository.find({
          relations: ['event', 'order'],
        }),
      });
      const sync = () =>
        db().insertSynchronizedPaymentIfUnchanged(payment, expected, 3, 123);
      beforeEach(async () => {
        await DatabaseActionMock.clearTables();
        txNotify.mockReset().mockResolvedValue(undefined);
        eventNotify.mockReset().mockResolvedValue(undefined);
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicTxStatus',
        ).mockImplementation(txNotify);
        vi.spyOn(
          PublicStatusHandler.getInstance(),
          'updatePublicEventStatus',
        ).mockImplementation(eventNotify);
      });
      afterEach(() => vi.restoreAllMocks());
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'atomically inserts completed %s payment and updates its event'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'atomically inserts completed %s payment and updates its event'; rejected mutations preserve state and do not notify.
       */

      it.each(['ethereum', 'binance', 'ergo'])(
        'atomically inserts completed %s payment and updates its event',
        async (network) => {
          await prepare(network);
          const before = await state();
          vi.spyOn(Date, 'now').mockReturnValue(1730000000000);
          const transaction = db().dataSource.transaction.bind(db().dataSource);
          let committed = false;
          vi.spyOn(db().dataSource, 'transaction').mockImplementation(
            async (...args: Parameters<typeof transaction>) => {
              const result = await transaction(...args);
              committed = true;
              return result;
            },
          );
          txNotify.mockImplementation(() => expect(committed).toBe(true));
          eventNotify.mockImplementation(() => expect(committed).toBe(true));
          await expect(sync()).resolves.toBe(true);
          const after = await state();
          const status =
            network === 'ergo'
              ? EventStatus.completed
              : EventStatus.pendingReward;
          expect(after.events).toEqual([
            {
              ...before.events[0],
              status,
              firstTry: network === 'ergo' ? 'first' : '1730000000',
            },
          ]);
          expect(after.transactions).toHaveLength(1);
          expect(after.transactions[0]).toMatchObject({
            txId: payment.txId,
            txJson: payment.toJson(),
            chain: network,
            type: TransactionType.payment,
            status: TransactionStatus.completed,
            requiredSign: 3,
            lastCheck: 123,
            lastStatusUpdate: '1730000000',
            failedInSign: false,
            signFailedCount: 0,
            event: { id: expected.id },
            order: null,
          });
          expect(txNotify).toHaveBeenCalledExactlyOnceWith(
            payment.txId,
            TransactionStatus.completed,
          );
          expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
            expected.id,
            status,
          );
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'accepts an explicit null firstTry and preserves it for Ergo'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'accepts an explicit null firstTry and preserves it for Ergo'; rejected mutations preserve state and do not notify.
       */

      it('accepts an explicit null firstTry and preserves it for Ergo', async () => {
        await prepare('ergo');
        await db().ConfirmedEventRepository.update(
          { id: expected.id },
          { firstTry: null as unknown as string },
        );
        expected = (await db().getEventById(expected.id))!;
        await expect(sync()).resolves.toBe(true);
        expect((await db().getEventById(expected.id))?.firstTry).toBeNull();
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects noneligible event phase %s before query'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects noneligible event phase %s before query'; rejected mutations preserve state and do not notify.
       */

      it.each(
        Object.values(EventStatus).filter(
          (status) => status !== EventStatus.pendingPayment,
        ),
      )('rejects noneligible event phase %s before query', async (status) => {
        await prepare();
        expected.status = status;
        const transaction = vi.spyOn(db().dataSource, 'transaction');
        await expect(sync()).rejects.toThrow('preimage');
        expect(transaction).not.toHaveBeenCalled();
        expect(txNotify).not.toHaveBeenCalled();
      });
      const protocolFields = [
        'height',
        'fromChain',
        'toChain',
        'fromAddress',
        'toAddress',
        'amount',
        'bridgeFee',
        'networkFee',
        'sourceChainTokenId',
        'targetChainTokenId',
        'sourceTxId',
        'sourceChainHeight',
        'sourceBlockId',
        'WIDsHash',
        'WIDsCount',
        'txId',
        'eventId',
      ] as const;
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'compares persisted protocol field %s independently'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'compares persisted protocol field %s independently'; rejected mutations preserve state and do not notify.
       */

      it.each(protocolFields)(
        'compares persisted protocol field %s independently',
        async (field) => {
          await prepare();
          const original = expected.eventData[field];
          await db().EventRepository.update(
            { id: expected.eventData.id },
            {
              [field]:
                typeof original === 'number'
                  ? original + 1
                  : original + '-changed',
            },
          );
          const before = await state();
          await expect(sync()).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'compares persisted confirmed field %s independently'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'compares persisted confirmed field %s independently'; rejected mutations preserve state and do not notify.
       */

      it.each(['status', 'firstTry', 'unexpectedFails'] as const)(
        'compares persisted confirmed field %s independently',
        async (field) => {
          await prepare();
          await db().ConfirmedEventRepository.update(
            { id: expected.id },
            { [field]: field === 'unexpectedFails' ? 5 : 'changed' },
          );
          const before = await state();
          await expect(sync()).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'binds the exact eventData row even with identical protocol fields'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'binds the exact eventData row even with identical protocol fields'; rejected mutations preserve state and do not notify.
       */

      it('binds the exact eventData row even with identical protocol fields', async () => {
        await prepare();
        const original = expected.eventData;
        const copy = { ...original, id: undefined };
        const duplicate = await db().EventRepository.save(
          db().EventRepository.create({ ...copy, identifier: 'other-box' }),
        );
        await db().ConfirmedEventRepository.update(
          { id: expected.id },
          { eventData: { id: duplicate.id } },
        );
        const before = await state();
        await expect(sync()).resolves.toBe(false);
        expect(await state()).toEqual(before);
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'returns false for a missing confirmed event'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'returns false for a missing confirmed event'; rejected mutations preserve state and do not notify.
       */

      it('returns false for a missing confirmed event', async () => {
        await prepare();
        await db().ConfirmedEventRepository.delete({ id: expected.id });
        await expect(sync()).resolves.toBe(false);
        expect(await db().TransactionRepository.count()).toBe(0);
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects absent confirmed input %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects absent confirmed input %s'; rejected mutations preserve state and do not notify.
       */

      it.each([
        'id',
        'status',
        'firstTry',
        'unexpectedFails',
        'eventData',
      ] as const)('rejects absent confirmed input %s', async (field) => {
        await prepare();
        Object.assign(expected, { [field]: undefined });
        const transaction = vi.spyOn(db().dataSource, 'transaction');
        await expect(sync()).rejects.toThrow('preimage');
        expect(transaction).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects undefined eventData input %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects undefined eventData input %s'; rejected mutations preserve state and do not notify.
       */

      it.each([...protocolFields, 'id'] as const)(
        'rejects undefined eventData input %s',
        async (field) => {
          await prepare();
          Object.assign(expected.eventData, { [field]: undefined });
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(sync()).rejects.toThrow('preimage');
          expect(transaction).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects mismatched serialized %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects mismatched serialized %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['network', 'txId', 'eventId', 'txType', 'txBytes'] as const)(
        'rejects mismatched serialized %s',
        async (field) => {
          await prepare();
          const model = JSON.parse(payment.toJson());
          model[field] = 'different';
          vi.spyOn(payment, 'toJson').mockReturnValue(JSON.stringify(model));
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(sync()).rejects.toThrow('preimage');
          expect(transaction).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects mismatched serialized Ergo %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects mismatched serialized Ergo %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['inputBoxes', 'dataInputs'] as const)(
        'rejects mismatched serialized Ergo %s',
        async (field) => {
          await prepare('ergo');
          const model = JSON.parse(payment.toJson());
          model[field] = ['cafe'];
          vi.spyOn(payment, 'toJson').mockReturnValue(JSON.stringify(model));
          await expect(sync()).rejects.toThrow('auxiliary');
          expect(await db().TransactionRepository.count()).toBe(0);
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects internally consistent wrong payment route %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects internally consistent wrong payment route %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['network', 'eventId', 'txType'] as const)(
        'rejects internally consistent wrong payment route %s',
        async (field) => {
          await prepare();
          if (field === 'network') payment.network = 'binance';
          else if (field === 'eventId') payment.eventId = '00'.repeat(32);
          else payment.txType = TransactionType.reward;
          await expect(sync()).rejects.toThrow('preimage');
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects broken event digest binding %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects broken event digest binding %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['id', 'sourceTxId', 'eventId'] as const)(
        'rejects broken event digest binding %s',
        async (field) => {
          await prepare();
          if (field === 'id') expected.id = '00'.repeat(32);
          else expected.eventData[field] = '00'.repeat(32);
          await expect(sync()).rejects.toThrow('preimage');
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects invalid currentHeight %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid currentHeight %s'; rejected mutations preserve state and do not notify.
       */

      it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined])(
        'rejects invalid currentHeight %s',
        async (height) => {
          await prepare();
          await expect(
            db().insertSynchronizedPaymentIfUnchanged(
              payment,
              expected,
              3,
              height as number,
            ),
          ).rejects.toThrow('preimage');
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects invalid requiredSign %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects invalid requiredSign %s'; rejected mutations preserve state and do not notify.
       */

      it.each([
        0,
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        undefined,
      ])('rejects invalid requiredSign %s', async (requiredSign) => {
        await prepare();
        await expect(
          db().insertSynchronizedPaymentIfUnchanged(
            payment,
            expected,
            requiredSign as number,
            123,
          ),
        ).rejects.toThrow('preimage');
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects duplicate candidate ID already %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects duplicate candidate ID already %s'; rejected mutations preserve state and do not notify.
       */

      it.each(Object.values(TransactionStatus))(
        'rejects duplicate candidate ID already %s',
        async (status) => {
          await prepare();
          const sameId = new PaymentTransaction(
            'ergo',
            payment.txId,
            '',
            Buffer.from('cafe', 'hex'),
            TransactionType.manual,
          );
          await DatabaseActionMock.insertTxRecord(sameId, status, 0);
          const before = await state();
          await expect(sync()).resolves.toBe(false);
          expect(await state()).toEqual(before);
          expect(txNotify).not.toHaveBeenCalled();
          expect(eventNotify).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects another event payment already %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects another event payment already %s'; rejected mutations preserve state and do not notify.
       */

      it.each(
        Object.values(TransactionStatus).filter(
          (status) => status !== TransactionStatus.invalid,
        ),
      )('rejects another event payment already %s', async (status) => {
        await prepare();
        const previous = new PaymentTransaction(
          payment.network,
          'previous-payment',
          payment.eventId,
          Buffer.from('cafe', 'hex'),
          TransactionType.payment,
        );
        await DatabaseActionMock.insertTxRecord(previous, status, 0);
        const before = await state();
        await expect(sync()).resolves.toBe(false);
        expect(await state()).toEqual(before);
        expect(txNotify).not.toHaveBeenCalled();
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'allows a different invalid previous payment'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'allows a different invalid previous payment'; rejected mutations preserve state and do not notify.
       */

      it('allows a different invalid previous payment', async () => {
        await prepare();
        const previous = new PaymentTransaction(
          payment.network,
          'invalid-payment',
          payment.eventId,
          Buffer.from('cafe', 'hex'),
          TransactionType.payment,
        );
        await DatabaseActionMock.insertTxRecord(
          previous,
          TransactionStatus.invalid,
          0,
        );
        await expect(sync()).resolves.toBe(true);
        expect((await db().getTxById(previous.txId))?.status).toBe(
          TransactionStatus.invalid,
        );
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'admits one concurrent candidate (differentID=%s)'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'admits one concurrent candidate (differentID=%s)'; rejected mutations preserve state and do not notify.
       */

      it.each([false, true])(
        'admits one concurrent candidate (differentID=%s)',
        async (differentId) => {
          await prepare();
          const other = new PaymentTransaction(
            payment.network,
            differentId ? 'other-payment' : payment.txId,
            payment.eventId,
            payment.txBytes,
            payment.txType,
          );
          const results = await Promise.all([
            sync(),
            db().insertSynchronizedPaymentIfUnchanged(other, expected, 3, 123),
          ]);
          expect(results.sort()).toEqual([false, true]);
          expect(await db().TransactionRepository.count()).toBe(1);
          expect(txNotify).toHaveBeenCalledTimes(1);
          expect(eventNotify).toHaveBeenCalledTimes(1);
        },
      );
      for (const table of ['transaction_entity', 'confirmed_event_entity']) {
        /**
         * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged `rolls back ${table} %s`
         * @dependencies Existing production DAO/chain ports and synthetic fixtures.
         * @scenario Prepare the suite fixture, apply the named input or concurrent change,
         * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
         * @expected `rolls back ${table} %s`; rejected mutations preserve state and do not notify.
         */

        it.each(['ABORT', 'IGNORE'])(`rolls back ${table} %s`, async (mode) => {
          await prepare();
          const before = await state();
          await db().dataSource.query(
            `CREATE TEMP TRIGGER reject_sync BEFORE ${table === 'transaction_entity' ? 'INSERT' : 'UPDATE'} ON ${table} BEGIN SELECT RAISE(${mode === 'ABORT' ? "ABORT, 'sync SQL failed'" : 'IGNORE'}); END`,
          );
          try {
            if (mode === 'ABORT')
              await expect(sync()).rejects.toThrow('sync SQL failed');
            else await expect(sync()).resolves.toBe(false);
            expect(await state()).toEqual(before);
            expect(txNotify).not.toHaveBeenCalled();
            expect(eventNotify).not.toHaveBeenCalled();
          } finally {
            await db().dataSource.query('DROP TRIGGER reject_sync');
          }
        });
      }
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'event CAS detects %s drift caused by insert trigger and rolls everything back'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'event CAS detects %s drift caused by insert trigger and rolls everything back'; rejected mutations preserve state and do not notify.
       */

      it.each(['amount', 'txId'] as const)(
        'event CAS detects %s drift caused by insert trigger and rolls everything back',
        async (field) => {
          await prepare();
          const before = await state();
          await db().dataSource.query(
            `CREATE TEMP TRIGGER drift_sync AFTER INSERT ON transaction_entity BEGIN UPDATE event_trigger_entity SET "${field}" = 'changed' WHERE id = ${expected.eventData.id}; END`,
          );
          try {
            await expect(sync()).resolves.toBe(false);
            expect(await state()).toEqual(before);
            expect(txNotify).not.toHaveBeenCalled();
          } finally {
            await db().dataSource.query('DROP TRIGGER drift_sync');
          }
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'ignores mutable spend metadata while preserving exact protocol fields'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'ignores mutable spend metadata while preserving exact protocol fields'; rejected mutations preserve state and do not notify.
       */

      it('ignores mutable spend metadata while preserving exact protocol fields', async () => {
        await prepare();
        await db().EventRepository.update(
          { id: expected.eventData.id },
          {
            spendHeight: 456,
            spendBlock: 'spent',
            spendTxId: 'spent',
            result: 'paid',
            paymentTxId: payment.txId,
          },
        );
        await expect(sync()).resolves.toBe(true);
        expect(
          (await db().getEventById(expected.id))?.eventData.spendHeight,
        ).toBe(456);
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects non-object or malformed transaction JSON %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects non-object or malformed transaction JSON %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['null', '[]', '"text"', '{'])(
        'rejects non-object or malformed transaction JSON %s',
        async (json) => {
          await prepare();
          vi.spyOn(payment, 'toJson').mockReturnValue(json);
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          await expect(sync()).rejects.toThrow();
          expect(transaction).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects malformed numeric trigger %s before querying'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects malformed numeric trigger %s before querying'; rejected mutations preserve state and do not notify.
       */

      it.each(['height', 'sourceChainHeight', 'WIDsCount', 'id'] as const)(
        'rejects malformed numeric trigger %s before querying',
        async (field) => {
          await prepare();
          const transaction = vi.spyOn(db().dataSource, 'transaction');
          for (const invalid of [
            -1,
            0.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            '1',
          ]) {
            Object.assign(expected.eventData, { [field]: invalid });
            await expect(sync()).rejects.toThrow('preimage');
          }
          expect(transaction).not.toHaveBeenCalled();
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects malformed chain name %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects malformed chain name %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['fromChain', 'toChain'] as const)(
        'rejects malformed chain name %s',
        async (field) => {
          await prepare();
          for (const invalid of ['', 'Avalanche', 'avalanche ']) {
            expected.eventData[field] = invalid;
            if (field === 'toChain') payment.network = invalid;
            await expect(sync()).rejects.toThrow('preimage');
          }
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'rejects malformed confirmed field %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'rejects malformed confirmed field %s'; rejected mutations preserve state and do not notify.
       */

      it.each(['firstTry', 'unexpectedFails'] as const)(
        'rejects malformed confirmed field %s',
        async (field) => {
          await prepare();
          const values =
            field === 'firstTry'
              ? [0, {}]
              : [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4'];
          for (const invalid of values) {
            Object.assign(expected, { [field]: invalid });
            await expect(sync()).rejects.toThrow('preimage');
          }
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'accepts exact currentHeight boundary %s'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'accepts exact currentHeight boundary %s'; rejected mutations preserve state and do not notify.
       */

      it.each([0, Number.MAX_SAFE_INTEGER])(
        'accepts exact currentHeight boundary %s',
        async (height) => {
          await prepare();
          await expect(
            db().insertSynchronizedPaymentIfUnchanged(
              payment,
              expected,
              1,
              height,
            ),
          ).resolves.toBe(true);
          expect((await db().getTxById(payment.txId))?.lastCheck).toBe(height);
        },
      );
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'requires the full Ergo auxiliary model'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'requires the full Ergo auxiliary model'; rejected mutations preserve state and do not notify.
       */

      it('requires the full Ergo auxiliary model', async () => {
        await prepare('ergo');
        payment = new PaymentTransaction(
          'ergo',
          payment.txId,
          payment.eventId,
          payment.txBytes,
          payment.txType,
        );
        await expect(sync()).rejects.toThrow('auxiliary');
        expect(await db().TransactionRepository.count()).toBe(0);
      });
      /**
       * @target DatabaseAction.insertSynchronizedPaymentIfUnchanged 'captures mutable payment, bytes and event inputs before yielding'
       * @dependencies Existing production DAO/chain ports and synthetic fixtures.
       * @scenario Prepare the suite fixture, apply the named input or concurrent change,
       * invoke DatabaseAction.insertSynchronizedPaymentIfUnchanged, and inspect the returned result and resulting state.
       * @expected 'captures mutable payment, bytes and event inputs before yielding'; rejected mutations preserve state and do not notify.
       */

      it('captures mutable payment, bytes and event inputs before yielding', async () => {
        await prepare('ergo');
        const id = expected.id;
        const txId = payment.txId;
        const json = payment.toJson();
        const pending = sync();
        payment.txId = 'changed';
        payment.txBytes[0] = 0;
        payment.network = 'other';
        (payment as ErgoTransaction).inputBoxes[0][0] = 0;
        expected.id = 'changed';
        expected.eventData.amount = 'changed';
        expected.firstTry = 'changed';
        await expect(pending).resolves.toBe(true);
        expect((await db().getTxById(txId))?.txJson).toBe(json);
        expect(eventNotify).toHaveBeenCalledExactlyOnceWith(
          id,
          EventStatus.completed,
        );
      });
    });
  });
});
