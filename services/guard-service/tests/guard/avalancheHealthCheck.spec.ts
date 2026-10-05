import {
  HealthCheck,
  HealthStatusLevel as Status,
} from '@rosen-bridge/health-check';

import { readAvalancheHealthConfig } from '../../src/configs/avalancheHealthConfig';
import {
  AvalancheNativeBalanceHealthCheckParam,
  AvalancheScannerHealthCheckParam,
} from '../../src/guard/avalancheHealthCheck';
import { config } from './avalancheHealthTestUtils';

describe('AvalancheNativeBalanceHealthCheckParam', () => {
  describe('updateStatus', () => {
    /**
     * @target AvalancheNativeBalanceHealthCheckParam.updateStatus classifies exact wei %s
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Read each exact balance at, below or above inclusive wei thresholds.
     * @expected Classify status exactly and expose safe update metadata.
     */
    it.each([
      [9007199254740994n, Status.HEALTHY],
      [9007199254740993n, Status.UNSTABLE],
      [9007199254740992n, Status.BROKEN],
      [0n, Status.BROKEN],
      [(1n << 256n) - 1n, Status.HEALTHY],
    ] as const)('classifies exact wei %s', async (balance, expected) => {
      const param = new AvalancheNativeBalanceHealthCheckParam(
        config(),
        async () => balance,
      );
      expect(param.getHealthStatus()).toEqual(Status.BROKEN);
      await param.update();
      expect(param.getHealthStatus()).toEqual(expected);
      expect(param.getLastTrialErrorMessage()).toBeUndefined();
      expect(param.getLastUpdatedTime()).toBeInstanceOf(Date);
      if (expected === Status.HEALTHY)
        expect(param.getDetails()).toBeUndefined();
      else expect(param.getDetails()).toBeTypeOf('string');
    });
    /**
     * @target AvalancheNativeBalanceHealthCheckParam.updateStatus records malformed read %s as Broken
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Return each malformed balance type or uint256 bound.
     * @expected Record BROKEN with sanitized failure and no successful observation.
     */
    it.each([-1n, 1n << 256n, 1, '1', undefined, null, NaN, Infinity])(
      'records malformed read %s as Broken',
      async (value) => {
        const param = new AvalancheNativeBalanceHealthCheckParam(
          config(),
          async () => value as bigint,
        );
        await param.update();
        expect(param.getHealthStatus()).toEqual(Status.BROKEN);
        expect(param.getLastTrialErrorMessage()).toEqual(
          'Unable to read Avalanche native balance.',
        );
        expect(Number.isFinite(param.getLastUpdatedTime().valueOf())).toEqual(
          true,
        );
        expect(param.getLastSuccessfulObservationTime()).toEqual(undefined);
      },
    );
    /**
     * @target AvalancheNativeBalanceHealthCheckParam.updateStatus gives critical precedence at equal zero thresholds
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Read zero and one with equal zero thresholds.
     * @expected Give critical precedence at equality and recover above it.
     */
    it('gives critical precedence at equal zero thresholds', async () => {
      const cfg = readAvalancheHealthConfig({
        nativeWarnWei: '0',
        nativeCriticalWei: '0',
        scannerWarnAgeSeconds: 1,
        scannerCriticalAgeSeconds: 1,
      });
      let value = 0n;
      const param = new AvalancheNativeBalanceHealthCheckParam(
        cfg,
        async () => value,
      );
      await param.update();
      expect(param.getHealthStatus()).toEqual(Status.BROKEN);
      value = 1n;
      await param.update();
      expect(param.getHealthStatus()).toEqual(Status.HEALTHY);
    });
  });
  describe('constructor', () => {
    /**
     * @target AvalancheNativeBalanceHealthCheckParam.constructor retains an independent validated config snapshot
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Mutate the captured policy and construct with an invalid raw threshold.
     * @expected Retain independent parsed thresholds and reject the malformed contract.
     */
    it('retains an independent validated config snapshot', async () => {
      const mutable = { ...config() },
        param = new AvalancheNativeBalanceHealthCheckParam(
          mutable,
          async () => 9007199254740993n,
        );
      mutable.nativeWarnWei = 0n;
      await param.update();
      expect(param.getHealthStatus()).toEqual(Status.UNSTABLE);
      expect(
        () =>
          new AvalancheNativeBalanceHealthCheckParam(
            { ...config(), nativeWarnWei: '1' } as never,
            async () => 1n,
          ),
      ).toThrow();
    });
  });
  describe('update', () => {
    /**
     * @target AvalancheNativeBalanceHealthCheckParam.update uses real HealthCheck8 aggregation and safe JSON serialization
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Aggregate real native and scanner parameters across failure and recovery.
     * @expected Serialize sanitized failures and clear aggregate errors after recovery.
     */
    it('uses real HealthCheck8 aggregation and safe JSON serialization', async () => {
      let failing = true;
      const native = new AvalancheNativeBalanceHealthCheckParam(
          config(),
          async () => {
            if (failing) throw Error('https://secret.invalid/key');
            return (1n << 256n) - 1n;
          },
        ),
        scanner = new AvalancheScannerHealthCheckParam(
          config(),
          async () => ({ height: 1, timestamp: 100 }),
          () => 100,
        ),
        health = new HealthCheck(undefined);
      health.register(native);
      health.register(scanner);
      expect(await health.getOverallHealthStatus()).toEqual(Status.BROKEN);
      await health.update();
      expect(await health.getOverallHealthStatus()).toEqual(Status.BROKEN);
      const serialized = JSON.stringify(health.getHealthStatus());
      expect(serialized).not.toContain('secret');
      expect(serialized).toContain('Unable to read Avalanche native balance.');
      expect(await health.getTrialErrors()).toEqual([
        'Unable to read Avalanche native balance.',
      ]);
      failing = false;
      await health.update();
      expect(await health.getOverallHealthStatus()).toEqual(Status.HEALTHY);
      expect(await health.getTrialErrors()).toEqual([]);
      expect(() => JSON.stringify(health.getHealthStatus())).not.toThrow();
    });
  });
});

describe('AvalancheScannerHealthCheckParam', () => {
  describe('updateStatus', () => {
    /**
     * @target AvalancheScannerHealthCheckParam.updateStatus classifies age %s seconds
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Read a qualified snapshot at each age boundary.
     * @expected Apply inclusive warning and critical thresholds.
     */
    it.each([
      [0, Status.HEALTHY],
      [9, Status.HEALTHY],
      [10, Status.UNSTABLE],
      [19, Status.UNSTABLE],
      [20, Status.BROKEN],
      [21, Status.BROKEN],
    ] as const)('classifies age %s seconds', async (age, expected) => {
      const param = new AvalancheScannerHealthCheckParam(
        config(),
        async () => ({ height: 0, timestamp: 100 - age }),
        () => 100,
      );
      await param.update();
      expect(param.getHealthStatus()).toEqual(expected);
      expect(param.getLastTrialErrorMessage()).toBeUndefined();
    });
    /**
     * @target AvalancheScannerHealthCheckParam.updateStatus accepts zero height/timestamp/clock and critical takes precedence on equality
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Use zero height, timestamp and clock then advance to an equal threshold.
     * @expected Accept zero observation data and give critical precedence at equality.
     */
    it('accepts zero height/timestamp/clock and critical takes precedence on equality', async () => {
      let now = 0;
      const param = new AvalancheScannerHealthCheckParam(
        { ...config(), scannerCriticalAgeSeconds: 10 },
        async () => ({ height: 0, timestamp: 0 }),
        () => now,
      );
      await param.update();
      expect(param.getHealthStatus()).toEqual(Status.HEALTHY);
      now = 10;
      await param.update();
      expect(param.getHealthStatus()).toEqual(Status.BROKEN);
    });
    for (const field of ['height', 'timestamp', 'now'] as const) {
      /**
       * @target AvalancheScannerHealthCheckParam.updateStatus 'rejects invalid ' + field + ' %s'
       * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
       * @scenario Replace height, timestamp or local clock independently with each invalid value.
       * @expected Record BROKEN with a sanitized qualified-scanner error.
       */
      it.each([
        -1,
        NaN,
        Infinity,
        0.1,
        '0',
        undefined,
        Number.MAX_SAFE_INTEGER + 1,
      ])('rejects invalid ' + field + ' %s', async (value) => {
        const snapshot = { height: 1, timestamp: 90 };
        if (field !== 'now') Reflect.set(snapshot, field, value);
        const param = new AvalancheScannerHealthCheckParam(
          config(),
          async () => snapshot,
          () => (field === 'now' ? (value as number) : 100),
        );
        await param.update();
        expect(param.getHealthStatus()).toEqual(Status.BROKEN);
        expect(param.getLastTrialErrorMessage()).toEqual(
          'Unable to read qualified Avalanche scanner health.',
        );
      });
    }
    /**
     * @target AvalancheScannerHealthCheckParam.updateStatus rejects absent/future observation %s
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Return an absent, malformed or future snapshot.
     * @expected Record BROKEN without qualifying the observation.
     */
    it.each([null, undefined, [], 1, { height: 0, timestamp: 101 }])(
      'rejects absent/future observation %s',
      async (value) => {
        const param = new AvalancheScannerHealthCheckParam(
          config(),
          async () => value as never,
          () => 100,
        );
        await param.update();
        expect(param.getHealthStatus()).toEqual(Status.BROKEN);
        expect(param.getLastTrialErrorMessage()).toBeDefined();
      },
    );
    /**
     * @target AvalancheScannerHealthCheckParam.updateStatus sanitizes a throwing clock
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Throw sensitive data from the local clock.
     * @expected Reject with the sanitized error and retain no private message.
     */
    it('sanitizes a throwing clock', async () => {
      const param = new AvalancheScannerHealthCheckParam(
        config(),
        async () => ({ height: 1, timestamp: 90 }),
        () => {
          throw Error('private-url');
        },
      );
      await expect(async () => await param.updateStatus()).rejects.toThrow(
        'Unable to read qualified',
      );
      expect(param.getLastTrialErrorMessage()).not.toContain('private');
    });
  });
  describe('getLastUpdatedTime', () => {
    /**
     * @target AvalancheScannerHealthCheckParam.getLastUpdatedTime exposes an initial assessment without inventing an observation
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Construct before a read and mutate the returned assessment Date.
     * @expected Expose a finite defensive assessment without inventing an observation.
     */
    it('exposes an initial assessment without inventing an observation', () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      try {
        const read = vi.fn(async () => ({ height: 1, timestamp: 100 }));
        const param = new AvalancheScannerHealthCheckParam(
          config(),
          read,
          () => 100,
        );
        expect(param.getLastUpdatedTime().valueOf()).toEqual(1700000000000);
        expect(param.getLastSuccessfulObservationTime()).toEqual(undefined);
        expect(param.getHealthStatus()).toEqual(Status.BROKEN);
        param.getLastUpdatedTime().setTime(NaN);
        expect(param.getLastUpdatedTime().valueOf()).toEqual(1700000000000);
        expect(read).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    });
  });
  describe('update', () => {
    /**
     * @target AvalancheScannerHealthCheckParam.update records old failure=%s with newest failure=%s
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Complete older and newer reads through real HealthCheck history and notifications.
     * @expected Retain pending BROKEN ownership, finite history and only the newest observation.
     */
    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])(
      'records old failure=%s with newest failure=%s',
      async (oldFails, newestFails) => {
        const deferred = () => {
          let resolve!: (value: { height: number; timestamp: number }) => void;
          let reject!: (error: Error) => void;
          const promise = new Promise<{ height: number; timestamp: number }>(
            (done, fail) => {
              resolve = done;
              reject = fail;
            },
          );
          return { promise, resolve, reject };
        };
        const old = deferred(),
          newest = deferred();
        const read = vi
          .fn<() => Promise<{ height: number; timestamp: number }>>()
          .mockReturnValueOnce(old.promise)
          .mockReturnValueOnce(newest.promise);
        const param = new AvalancheScannerHealthCheckParam(
          config(),
          read,
          () => 100,
        );
        const notify = vi.fn(async () => {});
        const service = new HealthCheck(notify);
        service.register(param);
        const first = service.updateParam(param.getId());
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        const second = service.updateParam(param.getId());
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        const pendingAt = param.getLastUpdatedTime();
        if (oldFails) old.reject(Error('sensitive credential'));
        else old.resolve({ height: 1, timestamp: 100 });
        await first;
        expect(param.getHealthStatus()).toEqual(Status.BROKEN);
        expect(param.getLastUpdatedTime()).toEqual(pendingAt);
        expect(param.getLastSuccessfulObservationTime()).toEqual(undefined);
        expect(param.getLastTrialErrorMessage()).toEqual(undefined);
        expect(notify).toHaveBeenCalled();
        if (newestFails) newest.reject(Error('sensitive credential'));
        else newest.resolve({ height: 2, timestamp: 100 });
        await second;
        expect(param.getHealthStatus()).toEqual(
          newestFails ? Status.BROKEN : Status.HEALTHY,
        );
        expect(param.getLastSuccessfulObservationTime() === undefined).toEqual(
          newestFails,
        );
        const history = (
          service as unknown as {
            healthHistory: {
              getHistory: () => Record<
                string,
                { timestamp: number; result: string }[]
              >;
            };
          }
        ).healthHistory.getHistory()[param.getId()];
        expect(history).toHaveLength(2);
        expect(history[0].result).toEqual(Status.BROKEN);
        expect(history[1].result).toEqual(
          newestFails ? 'unknown' : Status.HEALTHY,
        );
        expect(
          history.every((entry) => Number.isFinite(entry.timestamp)),
        ).toEqual(true);
        expect(JSON.stringify(notify.mock.calls)).not.toContain(
          'sensitive credential',
        );
      },
    );

    /**
     * @target AvalancheScannerHealthCheckParam.update records first failure without a manufactured snapshot
     * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
     * @scenario Fail the first qualified read through real HealthCheck aggregation.
     * @expected Expose finite sanitized assessment metadata without a fabricated snapshot.
     */
    it('records first failure without a manufactured snapshot', async () => {
      const param = new AvalancheScannerHealthCheckParam(
        config(),
        async () => {
          throw Error('credential');
        },
        () => 100,
      );
      const service = new HealthCheck(vi.fn(async () => {}));
      service.register(param);
      await service.update();
      expect(Number.isFinite(param.getLastUpdatedTime().valueOf())).toEqual(
        true,
      );
      expect(Number.isFinite(param.getLastTrialErrorTime()?.valueOf())).toEqual(
        true,
      );
      expect(param.getLastSuccessfulObservationTime()).toEqual(undefined);
      expect(param.getHealthStatus()).toEqual(Status.BROKEN);
    });
  });
});

describe('AvalancheHealthParam', () => {
  describe('update', () => {
    for (const kind of ['native', 'scanner'] as const) {
      describe(`${kind} latest attempt ownership`, () => {
        const healthy =
          kind === 'native' ? 9007199254740994n : { height: 1, timestamp: 100 };
        const create = (read: () => Promise<unknown>) =>
          kind === 'native'
            ? new AvalancheNativeBalanceHealthCheckParam(
                config(),
                read as () => Promise<bigint>,
              )
            : new AvalancheScannerHealthCheckParam(
                config(),
                read as () => Promise<{ height: number; timestamp: number }>,
                () => 100,
              );
        /**
         * @target AvalancheHealthParam.update does not let older success erase a newer failure or report healthy while pending
         * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
         * @scenario Complete an older successful read after a newer failure.
         * @expected Keep BROKEN while pending and retain the latest failure metadata.
         */
        it('does not let older success erase a newer failure or report healthy while pending', async () => {
          let resolve!: (value: unknown) => void;
          const read = vi
            .fn<() => Promise<unknown>>()
            .mockResolvedValueOnce(healthy)
            .mockImplementationOnce(
              () =>
                new Promise((done) => {
                  resolve = done;
                }),
            )
            .mockRejectedValueOnce(
              Error('https://private.invalid/?secret=hidden'),
            );
          const param = create(read);
          await param.update();
          expect(param.getHealthStatus()).toEqual(Status.HEALTHY);
          const old = param.update();
          expect(param.getHealthStatus()).toEqual(Status.BROKEN);
          await param.update();
          const error = param.getLastTrialErrorMessage(),
            time = param.getLastTrialErrorTime();
          resolve(healthy);
          await old;
          expect(param.getHealthStatus()).toEqual(Status.BROKEN);
          expect(param.getLastTrialErrorMessage()).toEqual(error);
          expect(param.getLastTrialErrorTime()).toBe(time);
          expect(error).not.toContain('secret');
        });
        /**
         * @target AvalancheHealthParam.update does not let older failure overwrite a newer success
         * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
         * @scenario Complete an older failure after a newer success.
         * @expected Retain the latest healthy result and update time.
         */
        it('does not let older failure overwrite a newer success', async () => {
          let reject!: (reason: unknown) => void;
          const read = vi
            .fn<() => Promise<unknown>>()
            .mockImplementationOnce(
              () =>
                new Promise((_done, fail) => {
                  reject = fail;
                }),
            )
            .mockResolvedValueOnce(healthy);
          const param = create(read);
          const old = param.update();
          await param.update();
          const time = param.getLastUpdatedTime();
          reject(Error('secret'));
          await old;
          expect(param.getHealthStatus()).toEqual(Status.HEALTHY);
          expect(param.getLastTrialErrorMessage()).toBeUndefined();
          expect(param.getLastTrialErrorTime()).toBeUndefined();
          expect(param.getLastUpdatedTime()).toEqual(time);
        });
        /**
         * @target AvalancheHealthParam.update recovers after a current failure without retaining stale error metadata
         * @dependencies Real Guard health parameters and HealthCheck; controlled reads and clocks.
         * @scenario Complete a current failure followed by a current success.
         * @expected Clear stale failure details and timestamps on recovery.
         */
        it('recovers after a current failure without retaining stale error metadata', async () => {
          const read = vi
              .fn<() => Promise<unknown>>()
              .mockRejectedValueOnce('private token')
              .mockResolvedValueOnce(healthy),
            param = create(read);
          await param.update();
          expect(param.getHealthStatus()).toEqual(Status.BROKEN);
          await param.update();
          expect(param.getHealthStatus()).toEqual(Status.HEALTHY);
          expect(param.getDetails()).toBeUndefined();
          expect(param.getLastTrialErrorMessage()).toBeUndefined();
          expect(param.getLastTrialErrorTime()).toBeUndefined();
        });
      });
    }
  });
});
