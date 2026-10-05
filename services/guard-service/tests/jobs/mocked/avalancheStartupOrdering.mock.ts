import { vi, expect } from 'vitest';

/** Retains the explicit state and spies for this startup fixture. */
export const hooks = {
  calls: [] as string[],
  inputs: undefined as unknown,
  register: vi.fn<() => Promise<void>>(),
  chain: vi.fn<() => Promise<void>>(),
  context: Object.freeze({}),
  reward: vi.fn<() => void>(),
  health: vi.fn<() => Promise<void>>(),
  balancePolicy: vi.fn(),
};

/** Records one initialization boundary in call order. */
const record = (name: string) => {
  hooks.calls.push(name);
};

/** Supplies the controlled txAgreement dependency for this fixture. */
export const mockTxAgreement1 = () => ({
  default: { getInstance: async () => record('agreement') },
});

/** Supplies the controlled arbitraryProcessor dependency for this fixture. */
export const mockArbitraryProcessor2 = () => ({
  default: { getInstance: () => record('arbitrary') },
});

/** Supplies the controlled rosenDialer dependency for this fixture. */
export const mockRosenDialer3 = () => ({
  default: { init: async () => record('dialer') },
});

/** Supplies the controlled detectionHandler dependency for this fixture. */
export const mockDetectionHandler4 = () => ({
  default: { init: async () => record('detection') },
});

/** Supplies the controlled publicStatusHandler dependency for this fixture. */
export const mockPublicStatusHandler5 = () => ({
  default: { init: () => record('public status') },
});

/** Supplies the controlled notificationHandler dependency for this fixture. */
export const mockNotificationHandler6 = () => ({
  NotificationHandler: { setup: () => record('notifications') },
});

/** Supplies the controlled balanceHandler dependency for this fixture. */
export const mockBalanceHandler7 = () => ({
  default: { init: () => record('balance') },
});

/** Supplies the controlled avalancheBalanceConfig dependency for this fixture. */
export const mockAvalancheBalanceConfig8 = () => ({
  readAvalancheBalanceConfig: hooks.balancePolicy,
});

/** Supplies the controlled minimumFeeHandler dependency for this fixture. */
export const mockMinimumFeeHandler9 = () => ({
  default: { init: async () => record('fee init') },
});

/** Supplies the controlled multiSigHandler dependency for this fixture. */
export const mockMultiSigHandler10 = () => ({
  default: { init: async () => record('multisig init') },
});

/** Supplies the controlled tssHandler dependency for this fixture. */
export const mockTssHandler11 = () => ({
  default: { init: async () => record('tss init') },
});

/** Supplies the controlled guardPkHandler dependency for this fixture. */
export const mockGuardPkHandler12 = () => ({
  default: {
    getInstance: () => ({
      update: async () => record('pk'),
      updateDependentModules: () => undefined,
    }),
  },
});

/** Supplies the controlled tokenHandler dependency for this fixture. */
export const mockTokenHandler13 = () => ({
  TokenHandler: {
    init: async () => record('tokens'),
    getInstance: () => ({
      sealForAvalanche: async () => record('seal'),
      getTokenMap: () => ({}),
    }),
  },
});

/** Supplies the controlled chainHandler dependency for this fixture. */
export const mockChainHandler14 = () => ({
  default: {
    prepareStartup: (inputs: unknown) => {
      expect(inputs).toBe(hooks.inputs);
      record('chain prepare');
    },
    initialize: async () => {
      record('chain begin');
      await hooks.chain();
      record('chain ready');
    },
    getInstance: () => ({ getChain: vi.fn(), getErgoChain: vi.fn() }),
  },
});

/** Supplies the controlled databaseAction dependency for this fixture. */
export const mockDatabaseAction15 = () => ({
  DatabaseAction: {
    init: () => record('db handler'),
    getInstance: () => ({ getEventById: vi.fn(), getTxById: vi.fn() }),
  },
});

/** Supplies the controlled dataSource dependency for this fixture. */
export const mockDataSource16 = () => ({ dataSource: {} });

/** Supplies the controlled dataSources dependency for this fixture. */
export const mockDataSources17 = () => ({
  initDataSources: async () => record('db'),
});

/** Supplies the controlled initScanner dependency for this fixture. */
export const mockInitScanner18 = () => ({
  prepareAvalancheScanner: async () => record('prepare'),
  getPreparedAvalancheInputs: () => hooks.inputs,
  getAvalancheScanner: () => undefined,
  initScanner: async () => {
    record('register begin');
    await hooks.register();
    record('register ready');
  },
  startScannerJobs: () => record('scanner jobs'),
});

/** Supplies the controlled apiServer dependency for this fixture. */
export const mockApiServer19 = () => ({
  initApiServer: async () => record('api'),
});

/** Supplies the controlled multiSig dependency for this fixture. */
export const mockMultiSig20 = () => ({
  initializeMultiSigJobs: () => record('multisig jobs'),
});

/** Supplies the controlled tss dependency for this fixture. */
export const mockTss21 = () => ({
  tssUpdateJob: () => record('tss jobs'),
});

/** Supplies the controlled minimumFee dependency for this fixture. */
export const mockMinimumFee22 = () => ({
  minimumFeeUpdateJob: () => record('fee jobs'),
});

/** Supplies the controlled runProcessors dependency for this fixture. */
export const mockRunProcessors23 = () => ({
  runProcessors: () => record('processors'),
});

/** Supplies the controlled healthCheck dependency for this fixture. */
export const mockHealthCheck24 = () => ({
  healthCheckStart: async () => record('health'),
});

/** Supplies the controlled healthCheck dependency for this fixture. */
export const mockHealthCheck25 = () => ({
  getHealthCheck: async () => {
    record('health prepare');
    await hooks.health();
    record('health ready');
  },
});

/** Supplies the controlled revenue dependency for this fixture. */
export const mockRevenue26 = () => ({
  revenueJob: async () => record('revenue'),
});

/** Supplies the controlled guardConfigUpdate dependency for this fixture. */
export const mockGuardConfigUpdate27 = () => ({
  configUpdateJob: () => undefined,
});

/** Supplies the controlled eventReprocess dependency for this fixture. */
export const mockEventReprocess28 = () => ({
  default: { init: async () => record('reprocess') },
});

/** Supplies the controlled eventSynchronization dependency for this fixture. */
export const mockEventSynchronization29 = () => ({
  default: { init: async () => record('sync') },
});

/** Supplies the controlled transactionProcessor dependency for this fixture. */
export const mockTransactionProcessor30 = () => ({
  default: { initSigning: () => record('signing context') },
});

/** Supplies the controlled rewardAuthorization dependency for this fixture. */
export const mockRewardAuthorization31 = () => ({
  default: {
    init: (context: unknown) => {
      expect(context).toBe(hooks.context);
      hooks.reward();
      record('reward authorization');
    },
  },
});

/** Supplies the controlled signingRuntime dependency for this fixture. */
export const mockSigningRuntime32 = () => ({
  createGuardSigningRuntime: () => ({ context: hooks.context, processor: {} }),
});

/** Supplies the controlled ergo-multi-sig dependency for this fixture. */
export const mockErgoMultiSig33 = async (
  original: <T = unknown>() => Promise<T>,
) => ({
  ...(await original<typeof import('@rosen-bridge/ergo-multi-sig')>()),
  MultiSigUtils: class {},
});
