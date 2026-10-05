import type { DataSource } from '@rosen-bridge/extended-typeorm';
import type { EvmChainSignMediator } from '@rosen-chains/evm';

// Service setup imports this factory through ChainHandler before test mocks.
vi.hoisted(() => vi.resetModules());

const captured = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@rosen-chains/avalanche-rpc', async (original) => {
  const actual = await original<typeof import('@rosen-chains/avalanche-rpc')>();
  return {
    ...actual,
    AvalancheRpcNetwork: class extends actual.AvalancheRpcNetwork {
      /** Captures constructor inputs while retaining the actual network behavior. */
      constructor(
        ...args: ConstructorParameters<typeof actual.AvalancheRpcNetwork>
      ) {
        captured.calls.push(args);
        super(...args);
      }
    },
  };
});

export { captured };

/** Inert repository port for construction tests; no database is opened. */
export const dataSource = {
  getRepository: () => ({ find: vi.fn() }),
} as unknown as DataSource;
/** Synthetic EVM signing port; no signature is produced. */
const mediator = { sign: vi.fn(), isInSign: vi.fn() };
/** Returns the captured signing port for exact chain-code/path assertions. */
export const createSignMediator = vi.fn<
  (chainCode: string, path: number[]) => EvmChainSignMediator
>(() => mediator);
