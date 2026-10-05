import { hooks } from './mocked/avalancheBalanceScheduling.mock';

let runProcessors: typeof import('../../src/jobs/runProcessors').runProcessors;

beforeAll(async () => {
  ({ runProcessors } = await import('../../src/jobs/runProcessors'));
});
describe('runProcessors', () => {
  describe('balanceUpdateJob', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      hooks.schedule = [{ chain: 'ethereum', intervalMs: 1000 }];
      hooks.timers.length = 0;
      hooks.update.mockReset().mockResolvedValue(undefined);
    });
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });
    /**
     * @target runProcessors uses the validated balance schedule, enabled=%s
     * @dependencies Mocked balance handler and interval timer; real job wiring.
     * @scenario Supply enabled/disabled schedules, start jobs and invoke captured callbacks.
     * @expected Create one timer per entry and update precisely those configured chains.
     */
    it.each([true, false])(
      'uses the validated balance schedule, enabled=%s',
      async (enabled) => {
        if (enabled)
          hooks.schedule.push({ chain: 'avalanche', intervalMs: 12000 });
        runProcessors();
        expect(hooks.timers.map((timer) => timer.intervalMs)).toEqual(
          enabled ? [1000, 12000] : [1000],
        );
        for (const timer of hooks.timers) await timer.callback();
        expect(hooks.update.mock.calls.map(([chain]) => chain)).toEqual(
          enabled ? ['ethereum', 'avalanche'] : ['ethereum'],
        );
      },
    );
  });
});
