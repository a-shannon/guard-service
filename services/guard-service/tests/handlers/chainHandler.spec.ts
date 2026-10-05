import { Address, NetworkPrefix } from 'ergo-lib-wasm-nodejs';

import { hooks } from './mocked/avalancheChainRegistration.mock';

describe('ChainHandler', () => {
  let Handler: typeof import('../../src/handlers/chainHandler').default;
  let inputs: import('../../src/jobs/avalancheScannerStartup').PreparedAvalancheInputs;
  beforeEach(async () => {
    vi.resetModules();
    const { TokenHandler } = await import('../../src/handlers/tokenHandler');
    const { default: Configs } = await import('../../src/configs/configs');
    await TokenHandler.init(Configs.tokensPath);
    await TokenHandler.getInstance().sealForAvalanche();
    const { readAvalancheBridgeContracts } = await import(
      '../../src/configs/rosenConfig'
    );
    const ergo = Address.p2pk_from_pk_bytes(
      Buffer.from(
        '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        'hex',
      ),
    ).to_base58(NetworkPrefix.Testnet);
    inputs = Object.freeze({
      config: Object.freeze({
        enabled: true,
        chainNetworkName: 'rpc',
        chainId: 43113,
        sourceId: 'fixture',
        rpc: {
          url: 'http://127.0.0.1:1',
          timeout: 1,
          scannerInterval: 1,
          initialHeight: 0,
        },
        blockTime: 1,
        maxParallelTx: 1,
        gasPriceSlippage: 0n,
        gasLimitSlippage: 0n,
        gasLimitMultiplier: 1n,
        gasLimitCap: 50000n,
        confirmations: {
          observation: 1,
          payment: 1,
          cold: 3,
          manual: 4,
          arbitrary: 5,
        },
        routes: { cold: false, manual: false, arbitrary: false },
        tssChainCode: 'fixture',
        derivationPath: [44],
      }) as import('../../src/configs/guardsAvalancheConfigs').GuardsAvalancheConfig,
      contracts: readAvalancheBridgeContracts({
        addresses: {
          lock: '0x' + '12'.repeat(20),
          cold: '0x' + '34'.repeat(20),
          WatcherPermit: ergo,
          Fraud: ergo,
          WatcherTriggerEvent: ergo,
          Commitment: ergo,
        },
        tokens: { RWTId: 'ab'.repeat(32) },
      }),
    });
    hooks.invariant.mockReset();
    hooks.legacyConstruction.mockReset();
    hooks.balance.mockReset().mockResolvedValue(9007199254740993n);
    hooks.factory.mockReset().mockResolvedValue({
      chain: hooks.chain,
      network: { getAddressBalanceForNativeToken: hooks.balance },
      assertTokenMapUnchanged: hooks.invariant,
    });
    Handler = (await import('../../src/handlers/chainHandler')).default;
  });
  describe('initialize', () => {
    /**
     * @target ChainHandler.initialize publishes one complete handler using the same captured inputs
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Prepare captured inputs and construct the complete handler.
     * @expected Publish one handler with identical chain, configuration, contracts and mediator objects.
     */
    it('publishes one complete handler using the same captured inputs', async () => {
      Handler.prepareStartup(inputs);
      expect(() => Handler.getInstance()).toThrow('not initialized');
      await Handler.initialize();
      const handler = Handler.getInstance();
      expect(handler.getChain('avalanche')).toBe(hooks.chain);
      expect(handler.getChain('ethereum').CHAIN).toEqual('ethereum');
      expect(handler.getErgoChain().CHAIN).toEqual('ergo');
      expect(Handler.getInstance()).toBe(handler);
      expect(hooks.factory.mock.calls[0][0]).toBe(inputs.config);
      expect(hooks.factory.mock.calls[0][1]).toBe(inputs.contracts);
      expect(hooks.factory.mock.calls[0][2].createSignMediator).toBe(
        hooks.mediator,
      );
      expect(hooks.invariant).toHaveBeenCalled();
      expect(hooks.legacyConstruction).toHaveBeenCalledTimes(1);
    });
    /**
     * @target ChainHandler.initialize keeps enabled factory pending without a half-initialized handler
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Hold the enabled factory and attempt duplicate initialization.
     * @expected Keep the handler unpublished until completion and reject concurrent registration.
     */
    it('keeps enabled factory pending without a half-initialized handler', async () => {
      let resolve!: (value: unknown) => void;
      hooks.factory.mockReturnValue(
        new Promise((yes) => {
          resolve = yes;
        }),
      );
      Handler.prepareStartup(inputs);
      const pending = Handler.initialize();
      expect(hooks.legacyConstruction).not.toHaveBeenCalled();
      expect(() => Handler.getInstance()).toThrow('not initialized');
      await expect(async () => await Handler.initialize()).rejects.toThrow(
        'already attempted',
      );
      resolve({
        chain: hooks.chain,
        network: {},
        assertTokenMapUnchanged: hooks.invariant,
      });
      await pending;
      expect(hooks.legacyConstruction).toHaveBeenCalledTimes(1);
      expect(Handler.getInstance().getChain('avalanche')).toBe(hooks.chain);
    });
    /**
     * @target ChainHandler.initialize keeps factory failure terminal and unpublished
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Reject the factory and attempt initialization again.
     * @expected Keep the failure terminal and the handler unpublished.
     */
    it('keeps factory failure terminal and unpublished', async () => {
      hooks.factory.mockRejectedValue(new Error('bad factory'));
      Handler.prepareStartup(inputs);
      await expect(async () => await Handler.initialize()).rejects.toThrow(
        'bad factory',
      );
      expect(() => Handler.getInstance()).toThrow('not initialized');
      expect(hooks.legacyConstruction).not.toHaveBeenCalled();
      await expect(async () => await Handler.initialize()).rejects.toThrow(
        'already attempted',
      );
    });
    /**
     * @target ChainHandler.initialize rejects token-map drift before constructing legacy chains
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Complete the Avalanche factory then reject its captured token-map invariant.
     * @expected Keep the handler unpublished and construct no legacy network.
     */
    it('rejects token-map drift before constructing legacy chains', async () => {
      hooks.invariant.mockImplementation(() => {
        throw new Error('token map changed');
      });
      Handler.prepareStartup(inputs);
      await expect(async () => await Handler.initialize()).rejects.toThrow(
        'token map changed',
      );
      expect(hooks.factory).toHaveBeenCalledTimes(1);
      expect(hooks.legacyConstruction).not.toHaveBeenCalled();
      expect(() => Handler.getInstance()).toThrow('not initialized');
    });
    /**
     * @target ChainHandler.initialize preserves disabled legacy chains without constructing Avalanche
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Prepare a disabled startup and retrieve legacy chains.
     * @expected Preserve Ethereum while never constructing Avalanche.
     */
    it('preserves disabled legacy chains without constructing Avalanche', async () => {
      Handler.prepareStartup();
      await Handler.initialize();
      expect(hooks.factory).not.toHaveBeenCalled();
      expect(Handler.getInstance().getChain('ethereum').CHAIN).toEqual(
        'ethereum',
      );
      expect(() => Handler.getInstance().getChain('avalanche')).toThrow(
        'not enabled',
      );
    });
    /**
     * @target ChainHandler.initialize requires startup preparation for the explicit initialization path
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Initialize without explicit startup preparation.
     * @expected Reject before any Avalanche factory call.
     */
    it('requires startup preparation for the explicit initialization path', async () => {
      await expect(async () => await Handler.initialize()).rejects.toThrow(
        'not prepared',
      );
      expect(hooks.factory).not.toHaveBeenCalled();
    });
  });

  describe('getAvalancheLockBalance', () => {
    /**
     * @target ChainHandler.getAvalancheLockBalance reads raw settled wei using the captured Avalanche lock address
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Read the settled balance then introduce token-map drift.
     * @expected Use the captured lock and reject drift before a second balance read.
     */
    it('reads raw settled wei using the captured Avalanche lock address', async () => {
      Handler.prepareStartup(inputs);
      await Handler.initialize();
      await expect(
        Handler.getInstance().getAvalancheLockBalance(),
      ).resolves.toEqual(9007199254740993n);
      expect(hooks.balance).toHaveBeenCalledExactlyOnceWith(
        inputs.contracts.addresses.lock,
      );
      hooks.invariant.mockImplementation(() => {
        throw new Error('token drift');
      });
      await expect(
        async () => await Handler.getInstance().getAvalancheLockBalance(),
      ).rejects.toThrow('token drift');
      expect(hooks.balance).toHaveBeenCalledTimes(1);
    });
    /**
     * @target ChainHandler.getAvalancheLockBalance rejects raw Avalanche balances when disabled
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Initialize with Avalanche disabled.
     * @expected Reject the native balance read without calling its provider.
     */
    it('rejects raw Avalanche balances when disabled', async () => {
      Handler.prepareStartup();
      await Handler.initialize();
      await expect(
        async () => await Handler.getInstance().getAvalancheLockBalance(),
      ).rejects.toThrow('not enabled');
      expect(hooks.balance).not.toHaveBeenCalled();
    });
  });

  describe('prepareStartup', () => {
    /**
     * @target ChainHandler.prepareStartup rejects duplicate preparation and registration
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Prepare and initialize once then repeat both operations.
     * @expected Reject duplicate preparation and registration with one factory call.
     */
    it('rejects duplicate preparation and registration', async () => {
      Handler.prepareStartup(inputs);
      expect(() => Handler.prepareStartup(inputs)).toThrow('already attempted');
      await Handler.initialize();
      await expect(async () => await Handler.initialize()).rejects.toThrow(
        'already attempted',
      );
      expect(() => Handler.prepareStartup(inputs)).toThrow('already attempted');
      expect(hooks.factory).toHaveBeenCalledOnce();
    });
  });

  describe('getChain', () => {
    /**
     * @target ChainHandler.getChain checks token identity on both generic and Ergo chain retrieval
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Introduce token-map drift after initialization.
     * @expected Reject Avalanche, Ethereum and Ergo retrieval on drift.
     */
    it('checks token identity on both generic and Ergo chain retrieval', async () => {
      Handler.prepareStartup(inputs);
      await Handler.initialize();
      hooks.invariant.mockImplementation(() => {
        throw new Error('token drift');
      });
      expect(() => Handler.getInstance().getChain('avalanche')).toThrow(
        'token drift',
      );
      expect(() => Handler.getInstance().getChain('ethereum')).toThrow(
        'token drift',
      );
      expect(() => Handler.getInstance().getErgoChain()).toThrow('token drift');
    });
  });

  describe('getInstance', () => {
    /**
     * @target ChainHandler.getInstance retains legacy lazy initialization but refuses later startup takeover
     * @dependencies Real ChainHandler; mocked provider constructors, signing mediators and factory.
     * @scenario Use legacy lazy initialization then attempt prepared startup.
     * @expected Preserve lazy Ethereum retrieval and reject later takeover.
     */
    it('retains legacy lazy initialization but refuses later startup takeover', () => {
      expect(Handler.getInstance().getChain('ethereum').CHAIN).toEqual(
        'ethereum',
      );
      expect(() => Handler.prepareStartup(inputs)).toThrow('already attempted');
    });
  });
});
