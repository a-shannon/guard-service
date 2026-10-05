const hooks = vi.hoisted(() => ({
  factory: vi.fn(),
  legacyConstruction: vi.fn(),
  invariant: vi.fn(),
  balance: vi.fn<() => Promise<bigint>>(),
  chain: { CHAIN: 'avalanche' },
  mediator: vi.fn(() => ({ sign: vi.fn(), isInSign: vi.fn() })),
}));
vi.mock('../../../src/utils/avalancheChain', () => ({
  createAvalancheChain: hooks.factory,
}));
vi.mock('../../../src/handlers/tssHandler', () => ({
  default: {
    getInstance: () => ({
      wrapCurveSignMediator: hooks.mediator,
      wrapEdwardSignMediator: hooks.mediator,
    }),
  },
}));
vi.mock('../../../src/handlers/multiSigHandler', () => ({
  default: {
    getInstance: () => ({
      getErgoMultiSig: () => ({ sign: vi.fn(), isInSign: vi.fn() }),
    }),
  },
}));
vi.mock('@rosen-chains/ergo-node-network', async (original) => ({
  ...(await original<typeof import('@rosen-chains/ergo-node-network')>()),
  default: class {
    constructor() {
      hooks.legacyConstruction();
    }
  },
}));
vi.mock('@rosen-chains/ergo-explorer-network', async (original) => ({
  ...(await original<typeof import('@rosen-chains/ergo-explorer-network')>()),
  default: class {
    constructor() {
      hooks.legacyConstruction();
    }
  },
}));
vi.mock('@rosen-chains/cardano-koios-network', async (original) => ({
  ...(await original<typeof import('@rosen-chains/cardano-koios-network')>()),
  default: class {},
}));
vi.mock('@rosen-chains/cardano-blockfrost-network', async (original) => ({
  ...(await original<
    typeof import('@rosen-chains/cardano-blockfrost-network')
  >()),
  default: class {},
}));
vi.mock('@rosen-chains/bitcoin-esplora', async (original) => ({
  ...(await original<typeof import('@rosen-chains/bitcoin-esplora')>()),
  default: class {},
}));
vi.mock('@rosen-chains/doge-esplora', async (original) => ({
  ...(await original<typeof import('@rosen-chains/doge-esplora')>()),
  DogeEsploraNetwork: class {},
}));
vi.mock('@rosen-chains/doge-rpc', async (original) => ({
  ...(await original<typeof import('@rosen-chains/doge-rpc')>()),
  DogeRpcNetwork: class {},
}));
vi.mock('@rosen-chains/doge-blockcypher', async (original) => ({
  ...(await original<typeof import('@rosen-chains/doge-blockcypher')>()),
  DogeBlockcypherNetwork: class {},
}));
vi.mock('@rosen-chains/doge', async (original) => ({
  ...(await original<typeof import('@rosen-chains/doge')>()),
  CombinedDogeNetwork: class {},
  DogeChain: class {
    CHAIN = 'doge';
  },
}));
vi.mock('@rosen-chains/firo', async (original) => ({
  ...(await original<typeof import('@rosen-chains/firo')>()),
  FiroChain: class {
    CHAIN = 'firo';
  },
}));
vi.mock('@rosen-chains/handshake', async (original) => ({
  ...(await original<typeof import('@rosen-chains/handshake')>()),
  HandshakeChain: class {
    CHAIN = 'handshake';
  },
}));
vi.mock('@rosen-chains/firo-electrumx', async (original) => ({
  ...(await original<typeof import('@rosen-chains/firo-electrumx')>()),
  FiroElectrumXNetwork: class {},
}));
vi.mock('@rosen-chains/handshake-rpc', async (original) => ({
  ...(await original<typeof import('@rosen-chains/handshake-rpc')>()),
  HandshakeRpcNetwork: class {},
}));
vi.mock('@rosen-chains/evm-rpc', async (original) => ({
  ...(await original<typeof import('@rosen-chains/evm-rpc')>()),
  default: class {},
}));
vi.mock('@rosen-chains/bitcoin-runes-rpc', async (original) => ({
  ...(await original<typeof import('@rosen-chains/bitcoin-runes-rpc')>()),
  BitcoinRunesRpcNetwork: class {},
}));

export { hooks };
