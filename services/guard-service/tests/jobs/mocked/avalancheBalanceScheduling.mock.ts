/** Controllable schedule and timer observations for the external scheduler mocks. */
const hooks = vi.hoisted(() => ({
  schedule: [] as { chain: string; intervalMs: number }[],
  timers: [] as { intervalMs: number; callback: () => Promise<void> }[],
  update: vi.fn<(chain: string) => Promise<void>>(),
}));
export { hooks };
vi.mock('../../../src/handlers/balanceHandler', () => ({
  default: {
    getInstance: () => ({
      getUpdateSchedule: () => hooks.schedule,
      updateChainBalances: hooks.update,
    }),
  },
}));
vi.mock('../../../src/utils/intervalTimer', () => ({
  default: class {
    constructor(
      private readonly intervalMs: number,
      private readonly callback: () => Promise<void>,
    ) {}
    start = () => {
      hooks.timers.push({
        intervalMs: this.intervalMs,
        callback: this.callback,
      });
    };
  },
}));
