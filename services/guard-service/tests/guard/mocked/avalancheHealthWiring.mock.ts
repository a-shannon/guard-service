const hooks = vi.hoisted(() => ({
  enabled: true,
  registered: true,
  raw: undefined as unknown,
  rawReads: vi.fn(),
  balance: vi.fn<() => Promise<bigint>>(),
  tokenBalance: vi.fn<(address: string, tokenId: string) => Promise<bigint>>(),
  supportedTokens: [] as string[],
  lastBlock: vi.fn<() => Promise<{ height: number; timestamp: number }>>(),
  safety: vi.fn<(action: () => Promise<unknown>) => Promise<unknown>>(),
}));
vi.mock('config', async (original) => {
  const actual = await original<{ default: typeof import('config') }>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      get(target, key) {
        if (key === 'has')
          return (path: string) =>
            path === 'avalanche.healthCheck'
              ? hooks.raw !== undefined
              : target.has(path);
        if (key === 'get')
          return (path: string) => {
            if (path === 'avalanche.healthCheck') {
              hooks.rawReads();
              return hooks.raw;
            }
            return target.get(path);
          };
        return Reflect.get(target, key);
      },
    }),
  };
});
vi.mock('../../../src/jobs/initScanner', () => {
  const scanner = { withSafety: hooks.safety, withHealthRead: hooks.safety };
  return {
    getPreparedAvalancheInputs: () =>
      hooks.enabled
        ? {
            config: {
              chainId: 43113,
              sourceId: 'synthetic-health',
              rpc: { timeout: 8 },
            },
            contracts: { addresses: { lock: '0x' + '12'.repeat(20) } },
          }
        : undefined,
    getAvalancheScanner: () => (hooks.registered ? scanner : undefined),
  };
});
vi.mock('../../../src/handlers/chainHandler', () => {
  const chain = {
    get supportedTokens() {
      return hooks.supportedTokens;
    },
    network: {
      expectedChainId: 43113n,
      assertNetwork: async () => {},
      getAddressBalanceForNativeToken: hooks.balance,
      getAddressBalanceForERC20Asset: hooks.tokenBalance,
    },
  };
  const handler = {
    getAvalancheLockBalance: hooks.balance,
    getChain: () => chain,
  };
  return {
    default: {
      getInstance: () => handler,
    },
  };
});
vi.mock('../../../src/handlers/notificationHandler', () => ({
  NotificationHandler: { getInstance: () => ({ notify: vi.fn() }) },
}));
vi.mock('../../../src/db/databaseAction', () => {
  const database = { getLastSavedBlockForScanner: hooks.lastBlock };
  return { DatabaseAction: { getInstance: () => database } };
});

export { hooks };
