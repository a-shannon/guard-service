import { vi } from 'vitest';

/** Retains the explicit state and spies for this startup fixture. */
export const hooks = {
  prepare: vi.fn<() => Promise<void>>(),
  initialize: vi.fn<() => Promise<void>>(),
  scanner: { marker: 'canonical-scanner' },
  legacy: vi.fn(),
  start: vi.fn(),
};

/** Supplies the controlled avalancheScannerStartup dependency for this fixture. */
export const mockAvalancheScannerStartup1 = () => ({
  AvalancheScannerStartup: class {
    prepare = hooks.prepare;
    initialize = hooks.initialize;
    getScanner = () => hooks.scanner;
    getPreparedInputs = () => undefined;
    start = hooks.start;
  },
});

/** Supplies the controlled ergo-scanner dependency for this fixture. */
export const mockErgoScanner2 = async (
  importOriginal: <T = unknown>() => Promise<T>,
) => ({
  ...(await importOriginal<typeof import('@rosen-bridge/ergo-scanner')>()),
  ErgoScanner: class {
    constructor() {
      hooks.legacy();
      throw new Error('legacy constructor reached');
    }
  },
});
