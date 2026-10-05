import { vi } from 'vitest';

/** Retains the explicit state and spies for this startup fixture. */
export const hooks = {
  inputs: undefined as unknown,
  initialize: vi.fn(async () => undefined),
  start: vi.fn(),
  register: vi.fn<(id: string) => Promise<void>>(),
  constructed: [] as { kind: string; args: unknown[] }[],
  updates: [] as string[],
};

/** Supplies the controlled avalancheScannerStartup dependency for this fixture. */
export const mockAvalancheScannerStartup1 = () => ({
  AvalancheScannerStartup: class {
    prepare = async () => undefined;
    initialize = hooks.initialize;
    start = hooks.start;
    getPreparedInputs = () => hooks.inputs;
    getScanner = () => undefined;
  },
});

/** Supplies the controlled ergo-scanner dependency for this fixture. */
export const mockErgoScanner2 = async (
  original: <T = unknown>() => Promise<T>,
) => ({
  ...(await original<typeof import('@rosen-bridge/ergo-scanner')>()),
  ErgoNodeNetwork: class {},
  ErgoExplorerNetwork: class {},
  ErgoScanner: class {
    registerExtractor = (extractor: { id: string }) =>
      hooks.register(extractor.id);
    update = async () => {
      hooks.updates.push('ergo');
    };
  },
});

/** Supplies the controlled evm-scanner dependency for this fixture. */
export const mockEvmScanner3 = async (
  original: <T = unknown>() => Promise<T>,
) => ({
  ...(await original<typeof import('@rosen-bridge/evm-scanner')>()),
  EvmRpcNetwork: class {},
  EvmRpcScanner: class {
    constructor(private chain: string) {}
    registerExtractor = (extractor: { id: string }) =>
      hooks.register(extractor.id);
    update = async () => {
      hooks.updates.push(this.chain);
    };
  },
});

/** Supplies the controlled watcher-data-extractor dependency for this fixture. */
export const mockWatcherDataExtractor4 = async (
  original: <T = unknown>() => Promise<T>,
) => ({
  ...(await original<typeof import('@rosen-bridge/watcher-data-extractor')>()),
  CommitmentExtractor: class {
    id: string;
    constructor(...args: unknown[]) {
      this.id = args[0] as string;
      hooks.constructed.push({ kind: 'commitment', args });
    }
  },
  EventTriggerExtractor: class {
    id: string;
    constructor(...args: unknown[]) {
      this.id = args[0] as string;
      hooks.constructed.push({ kind: 'event', args });
    }
  },
});

/** Supplies the controlled evm-address-tx-extractor dependency for this fixture. */
export const mockEvmAddressTxExtractor5 = async (
  original: <T = unknown>() => Promise<T>,
) => ({
  ...(await original<
    typeof import('@rosen-bridge/evm-address-tx-extractor')
  >()),
  EvmTxExtractor: class {
    id: string;
    constructor(...args: unknown[]) {
      this.id = args[1] as string;
    }
  },
});
