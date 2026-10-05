import { NetworkPrefix } from 'ergo-lib-wasm-nodejs';
import { JsonRpcProvider } from 'ethers';

import { TokenMap } from '@rosen-bridge/tokens';
import { TransactionType } from '@rosen-chains/abstract-chain';

import { GuardsAvalancheConfig } from '../../src/configs/guardsAvalancheConfigs';
import {
  ARBITRARY_ORDER_CHAINS,
  COLD_STORAGE_CHAINS,
} from '../../src/utils/constants';
import { managementConfirmationFaults } from '../configs/avalancheConfigTestData';
import { address } from '../configs/avalancheConfigTestUtils';
import {
  config,
  contracts,
  ergo,
  mapping,
  tokenMapping,
} from './avalancheChainTestUtils';
import {
  captured,
  dataSource,
  createSignMediator,
} from './mocked/avalancheChain.mock';

describe('createAvalancheChain', () => {
  let createAvalancheChain: typeof import('../../src/utils/avalancheChain').createAvalancheChain;
  let GuardsAvalancheConfigs: typeof import('../../src/configs/guardsAvalancheConfigs').GuardsAvalancheConfigs;

  beforeAll(async () => {
    // Load the real factory after its scoped RPC constructor mock is registered.
    ({ createAvalancheChain } = await import('../../src/utils/avalancheChain'));
    ({ GuardsAvalancheConfigs } = await import(
      '../../src/configs/guardsAvalancheConfigs'
    ));
  });
  let tokens: TokenMap;
  const instances: Awaited<ReturnType<typeof createAvalancheChain>>[] = [];
  const create = async (input = config()) => {
    const instance = await createAvalancheChain(input, contracts(), {
      dataSource,
      tokens,
      createSignMediator,
    });
    instances.push(instance);
    return instance;
  };
  beforeEach(async () => {
    tokens = new TokenMap();
    await tokens.updateConfigByJson(mapping());
    captured.calls.length = 0;
    createSignMediator.mockClear();
    vi.spyOn(JsonRpcProvider.prototype, 'send').mockRejectedValue(
      new Error('Unexpected live RPC'),
    );
  });
  afterEach(() => {
    for (const { network } of instances.splice(0))
      network['provider'].destroy();
    vi.restoreAllMocks();
  });
  /**
   * @target createAvalancheChain constructs mainnet from the contract generator token overlay
   * @dependencies Real factory and TokenMap; mocked provider and synthetic signing mediator.
   * @scenario Load the exact synthetic contract token overlay through the installed TokenMap, then construct chain 43114.
   * @expected Capture canonical JOE support without provider calls or operational activation.
   */
  it('constructs mainnet from the contract generator token overlay', async () => {
    await tokens.updateConfigByJson(tokenMapping());
    const input = config();
    input.chainId = 43114;
    const result = await create(input);
    expect(
      tokens.getRawConfig().map((set) => [set.avalanche.type, set.ergo.type]),
    ).toEqual([
      ['native', 'EIP-004'],
      ['ERC-20', 'EIP-004'],
    ]);
    expect(result.chain.supportedTokens).toEqual([
      tokenMapping()[1].avalanche.tokenId,
    ]);
    expect(result.chain.CHAIN_ID).toEqual(43114n);
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  });
  /**
   * @target createAvalancheChain rejects malformed ERC20 configuration before construction %s
   * @dependencies Real factory and token map; mocked provider and signer constructors.
   * @scenario Corrupt one ERC20 field while keeping native AVAX valid.
   * @expected Reject before creating RPC or signing adapters.
   */
  it.each([
    'address',
    'counterpart',
    'decimals',
    'native-counterpart-type',
    'native-counterpart-residency',
    'token-two-native-origins',
    'intraset-case-alias',
  ])(
    'rejects malformed ERC20 configuration before construction %s',
    async (kind) => {
      const source = tokenMapping();
      if (kind === 'address') source[1].avalanche.tokenId = 'unknown';
      if (kind === 'counterpart') source[1].ergo.tokenId = '00'.repeat(32);
      if (kind === 'decimals') source[1].avalanche.decimals = 256;
      if (kind === 'native-counterpart-type')
        source[0].ergo.type = 'unsupported';
      if (kind === 'native-counterpart-residency')
        source[0].ergo.residency = 'native';
      if (kind === 'token-two-native-origins')
        source[1].ergo.residency = 'native';
      if (kind === 'intraset-case-alias')
        source[1].ethereum = {
          ...source[1].avalanche,
          tokenId: source[1].avalanche.tokenId
            .toUpperCase()
            .replace('0X', '0x'),
          residency: 'wrapped',
        };
      await tokens.updateConfigByJson(source);
      await expect(create()).rejects.toThrow();
      expect(captured.calls).toHaveLength(0);
      expect(createSignMediator).not.toHaveBeenCalled();
      expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
    },
  );
  /**
   * @target createAvalancheChain consumes the config class projection after capturing validated inputs
   * @dependencies Real chain factory and config class; mocked provider send and signing mediator.
   * @scenario Construct a chain while observing the real typed config projection.
   * @expected Pass copied policy and validated contract inputs and consume the exact returned config.
   */
  it('consumes the config class projection after capturing validated inputs', async () => {
    const project = vi.spyOn(GuardsAvalancheConfigs, 'createChainConfigs');
    const input = config();
    const { chain } = await create(input);
    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0][0]).toEqual(input);
    expect(project.mock.calls[0][0]).not.toBe(input);
    expect(project.mock.calls[0][1]).toEqual(contracts());
    expect(chain.getChainConfigs()).toBe(project.mock.results[0].value);
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  });

  /**
   * @target createAvalancheChain captures synthetic route opt-ins without activating operations
   * @dependencies Real chain factory and config class; mocked provider send and signing mediator.
   * @scenario Set only the synthetic cold opt-in in an otherwise valid policy.
   * @expected Capture an immutable route policy and perform no network I/O.
   */
  it('captures synthetic route opt-ins without activating operations', async () => {
    const project = vi.spyOn(GuardsAvalancheConfigs, 'createChainConfigs');
    const input = {
      ...config(),
      routes: { cold: true, manual: false, arbitrary: false },
    } as unknown as GuardsAvalancheConfig;
    await create(input);
    expect(project.mock.calls[0][0].routes).toEqual(input.routes);
    expect(project.mock.calls[0][0].routes).not.toBe(input.routes);
    expect(Object.isFrozen(project.mock.calls[0][0].routes)).toEqual(true);
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  });

  /**
   * @target createAvalancheChain constructs chain %s with exact RPC identity and no network I/O
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Construct each supported network from captured configuration.
   * @expected Pass exact RPC identity and mediator inputs without network I/O.
   */
  it.each([43113, 43114] as const)(
    'constructs chain %s with exact RPC identity and no network I/O',
    async (id) => {
      const input = config();
      input.chainId = id;
      const { chain, network } = await create(input);
      expect(captured.calls[0].slice(0, 7)).toEqual([
        input.rpc.url,
        dataSource,
        contracts().addresses.lock,
        BigInt(id),
        'avalanche-lock-address',
        125,
        'synthetic',
      ]);
      expect(network.expectedChainId).toEqual(BigInt(id));
      expect(chain.CHAIN).toEqual('avalanche');
      expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
      expect(createSignMediator).toHaveBeenCalledWith(
        'synthetic-chain',
        [44, 60],
      );
      expect(Object.isFrozen(createSignMediator.mock.calls[0][1])).toEqual(
        true,
      );
    },
  );
  /**
   * @target createAvalancheChain provides genuine source-event permit, fraud and RWT inputs
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Read the genuine source-event contract and confirmation inputs.
   * @expected Expose permit, fraud, RWT and configured confirmation counts.
   */
  it('provides genuine source-event permit, fraud and RWT inputs', async () => {
    const inputContracts = structuredClone(contracts());
    const permit = address.to_base58(NetworkPrefix.Mainnet);
    (inputContracts.addresses as { WatcherPermit: string }).WatcherPermit =
      permit;
    const instance = await createAvalancheChain(config(), inputContracts, {
      dataSource,
      tokens,
      createSignMediator,
    });
    instances.push(instance);
    const { chain } = instance;
    expect(chain.getChainConfigs().addresses.lock).toEqual(
      inputContracts.addresses.lock,
    );
    expect(chain.getChainConfigs().addresses.cold).toEqual(
      inputContracts.addresses.cold,
    );
    expect(chain.getChainConfigs().addresses.permit).toEqual(permit);
    expect(chain.getChainConfigs().addresses.fraud).toEqual(ergo);
    expect(chain.getRWTToken()).toEqual('ab'.repeat(32));
    expect(chain.getTxRequiredConfirmation(TransactionType.payment)).toEqual(2);
    expect(chain.getTxRequiredConfirmation(TransactionType.lock)).toEqual(1);
  });
  /**
   * @target createAvalancheChain projects explicit management policy with disabled service defaults
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Read the actual factory projection and its default route-policy fixture.
   * @expected Expose all five captured confirmation fields and implemented capabilities while default service flags remain false.
   */
  it('projects explicit management policy with disabled service defaults', async () => {
    const { chain } = await create();
    expect(chain.getChainConfigs().addresses.cold).toEqual(
      contracts().addresses.cold,
    );
    for (const key of [
      'observation',
      'payment',
      'cold',
      'manual',
      'arbitrary',
    ] as const)
      expect(chain.getChainConfigs().confirmations[key]).toEqual(
        config().confirmations[key],
      );
    expect(config().routes).toEqual({
      cold: false,
      manual: false,
      arbitrary: false,
    });
    expect(COLD_STORAGE_CHAINS as readonly string[]).toContain('avalanche');
    expect(ARBITRARY_ORDER_CHAINS as readonly string[]).toContain('avalanche');
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  });
  /**
   * @target createAvalancheChain captures caller configuration before the first await
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Mutate caller configuration immediately after starting construction.
   * @expected Retain its pre-await snapshot and frozen chain configuration.
   */
  it('captures caller configuration before the first await', async () => {
    const input = config();
    const creating = create(input);
    input.chainId = 43114;
    input.rpc.timeout = 9;
    input.confirmations.payment = 99;
    input.confirmations.cold = 99;
    input.confirmations.manual = 99;
    input.confirmations.arbitrary = 99;
    input.derivationPath[0] = 0;
    const { chain, network } = await creating;
    expect(network.expectedChainId).toEqual(43113n);
    expect(captured.calls[0][5]).toEqual(125);
    expect(chain.getTxRequiredConfirmation(TransactionType.payment)).toEqual(2);
    expect(chain.getChainConfigs().confirmations).toEqual({
      observation: 1,
      payment: 2,
      cold: 3,
      manual: 4,
      arbitrary: 5,
    });
    expect(createSignMediator.mock.calls[0][1]).toEqual([44, 60]);
    expect(Object.isFrozen(chain.getChainConfigs())).toEqual(true);
  });
  /**
   * @target createAvalancheChain rejects %s confirmation %s before config projection
   * @dependencies Real factory and TokenMap; mocked provider construction, RPC and signing mediator.
   * @scenario Change only one management confirmation field to one malformed value.
   * @expected Reject before projecting configs, reading token inputs, allocating provider or constructing signer.
   */
  it.each(managementConfirmationFaults)(
    'rejects %s confirmation %s before config projection',
    async (route, _label, value) => {
      const input = config();
      input.confirmations[route as 'cold' | 'manual' | 'arbitrary'] =
        value as number;
      const project = vi.spyOn(GuardsAvalancheConfigs, 'createChainConfigs');
      const readTokens = vi.spyOn(tokens, 'getRawConfig');
      await expect(create(input)).rejects.toThrow(
        'Invalid Avalanche chain configuration',
      );
      expect(project).not.toHaveBeenCalled();
      expect(readTokens).not.toHaveBeenCalled();
      expect(captured.calls).toHaveLength(0);
      expect(createSignMediator).not.toHaveBeenCalled();
      expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
    },
  );
  /**
   * @target createAvalancheChain rejects malformed cold contract %s before dependencies
   * @dependencies Real factory, EVM contract validator and TokenMap; mocked provider and signer.
   * @scenario Replace only the explicit cold address with an absent, zero or malformed address.
   * @expected Reject before config projection, token reads, provider allocation or signing mediator construction.
   */
  it.each([undefined, null, '', 'invalid', '0x' + '0'.repeat(40)])(
    'rejects malformed cold contract %s before dependencies',
    async (cold) => {
      const inputContracts = structuredClone(contracts());
      Object.assign(inputContracts.addresses, { cold });
      const project = vi.spyOn(GuardsAvalancheConfigs, 'createChainConfigs');
      const readTokens = vi.spyOn(tokens, 'getRawConfig');
      await expect(
        createAvalancheChain(config(), inputContracts, {
          dataSource,
          tokens,
          createSignMediator,
        }),
      ).rejects.toThrow('Invalid Avalanche cold address');
      expect(project).not.toHaveBeenCalled();
      expect(readTokens).not.toHaveBeenCalled();
      expect(captured.calls).toHaveLength(0);
      expect(createSignMediator).not.toHaveBeenCalled();
      expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
    },
  );
  /**
   * @target createAvalancheChain captures cold contract before the first await
   * @dependencies Real factory and TokenMap; synthetic contracts, mocked provider and signer.
   * @scenario Mutate the supplied cold address immediately after starting construction.
   * @expected Retain its validated pre-await value in the frozen runtime projection.
   */
  it('captures cold contract before the first await', async () => {
    const inputContracts = structuredClone(contracts());
    const creating = createAvalancheChain(config(), inputContracts, {
      dataSource,
      tokens,
      createSignMediator,
    });
    (inputContracts.addresses as { cold: string }).cold = 'invalid';
    const instance = await creating;
    instances.push(instance);
    expect(instance.chain.getChainConfigs().addresses.cold).toEqual(
      contracts().addresses.cold,
    );
    expect(Object.isFrozen(instance.chain.getChainConfigs().addresses)).toBe(
      true,
    );
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  });
  for (const [name, change] of [
    [
      'disabled',
      (c: GuardsAvalancheConfig) => {
        c.enabled = false as never;
      },
    ],
    [
      'missing node type',
      (c: GuardsAvalancheConfig) => {
        c.chainNetworkName = undefined as never;
      },
    ],
    [
      'missing RPC',
      (c: GuardsAvalancheConfig) => {
        c.rpc = undefined as never;
      },
    ],
    [
      'string timeout',
      (c: GuardsAvalancheConfig) => {
        c.rpc.timeout = '1' as never;
      },
    ],
    [
      'wrong URL protocol',
      (c: GuardsAvalancheConfig) => {
        c.rpc.url = 'ws://localhost';
      },
    ],
    [
      'URL whitespace',
      (c: GuardsAvalancheConfig) => {
        c.rpc.url = ' http://localhost';
      },
    ],
    [
      'wrong auth token type',
      (c: GuardsAvalancheConfig) => {
        c.rpc.authToken = 1 as never;
      },
    ],
    [
      'zero parallel limit',
      (c: GuardsAvalancheConfig) => {
        c.maxParallelTx = 0;
      },
    ],
    [
      'missing observation',
      (c: GuardsAvalancheConfig) => {
        c.confirmations.observation = undefined as never;
      },
    ],
    [
      'wrong gas type',
      (c: GuardsAvalancheConfig) => {
        c.gasPriceSlippage = 1 as never;
      },
    ],
    [
      'unsafe gas multiplier',
      (c: GuardsAvalancheConfig) => {
        c.gasLimitMultiplier = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
      },
    ],
    [
      'uint256 gas overflow',
      (c: GuardsAvalancheConfig) => {
        c.gasLimitCap = 1n << 256n;
      },
    ],
    [
      'missing chain code',
      (c: GuardsAvalancheConfig) => {
        c.tssChainCode = undefined as never;
      },
    ],
    [
      'chain identity',
      (c: GuardsAvalancheConfig) => {
        c.chainId = 1 as never;
      },
    ],
    [
      'fractional milliseconds',
      (c: GuardsAvalancheConfig) => {
        c.rpc.timeout = 0.0001;
      },
    ],
    [
      'timeout overflow',
      (c: GuardsAvalancheConfig) => {
        c.rpc.timeout = 2147484;
      },
    ],
    [
      'missing gas cap',
      (c: GuardsAvalancheConfig) => {
        c.gasLimitCap = undefined as never;
      },
    ],
    [
      'zero gas multiplier',
      (c: GuardsAvalancheConfig) => {
        c.gasLimitMultiplier = 0n;
      },
    ],
    [
      'payment threshold',
      (c: GuardsAvalancheConfig) => {
        c.confirmations.payment = 0;
      },
    ],
    [
      'signer path',
      (c: GuardsAvalancheConfig) => {
        c.derivationPath = [];
      },
    ],
    [
      'management route',
      (c: GuardsAvalancheConfig) => {
        c.routes.cold = 'true' as never;
      },
    ],
  ] as const) {
    /**
     * @target createAvalancheChain `rejects ${name} before allocating a provider`
     * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
     * @scenario Change one configuration field using the named invalid fixture.
     * @expected Reject before allocating a provider.
     */
    it(`rejects ${name} before allocating a provider`, async () => {
      const input = config();
      change(input);
      await expect(async () => await create(input)).rejects.toThrow();
      expect(captured.calls).toHaveLength(0);
    });
  }
  for (const fault of [
    'missing',
    'duplicate',
    'decimals',
    'type',
    'residency',
    'ergo counterpart',
  ]) {
    /**
     * @target createAvalancheChain `rejects ${fault} native token mapping before allocating a provider`
     * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
     * @scenario Change one required native mapping property independently.
     * @expected Reject native AVAX qualification before provider allocation.
     */
    it(`rejects ${fault} native token mapping before allocating a provider`, async () => {
      const input = mapping();
      if (fault === 'missing') input.length = 0;
      if (fault === 'duplicate') input.push(structuredClone(input[0]));
      if (fault === 'decimals') input[0].avalanche.decimals = 9;
      if (fault === 'type') input[0].avalanche.type = 'token';
      if (fault === 'residency') input[0].avalanche.residency = 'wrapped';
      if (fault === 'ergo counterpart') input[0].ergo.tokenId = 'invalid';
      await tokens.updateConfigByJson(input);
      await expect(async () => await create()).rejects.toThrow('native AVAX');
      expect(captured.calls).toHaveLength(0);
    });
  }
  /**
   * @target createAvalancheChain rejects malformed third-chain decimals %s before provider allocation
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Replace third-chain decimals with each malformed value.
   * @expected Reject token-set decimals before provider allocation.
   */
  it.each([
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '9',
    undefined,
  ])(
    'rejects malformed third-chain decimals %s before provider allocation',
    async (decimals) => {
      const input = mapping();
      input[0].ethereum = {
        ...input[0].ergo,
        tokenId: 'third',
        decimals: decimals as number,
      };
      await tokens.updateConfigByJson(input);
      await expect(async () => await create()).rejects.toThrow(
        'token-set decimals',
      );
      expect(captured.calls).toHaveLength(0);
    },
  );
  /**
   * @target createAvalancheChain rejects another set sharing selected identifier %s
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Add another token set sharing the native or Ergo identifier.
   * @expected Reject ambiguous selection before provider allocation.
   */
  it.each(['avax', 'cd'.repeat(32)])(
    'rejects another set sharing selected identifier %s',
    async (tokenId) => {
      const input = mapping();
      input.unshift({
        ethereum: { ...input[0].avalanche, tokenId },
        ergo: { ...input[0].ergo, tokenId: 'ef'.repeat(32) },
      });
      await tokens.updateConfigByJson(input);
      await expect(async () => await create()).rejects.toThrow('Ambiguous');
      expect(captured.calls).toHaveLength(0);
    },
  );
  /**
   * @target createAvalancheChain rejects an unbridgeable set sharing the selected native identifier
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Add an unbridgeable set sharing the selected native identifier.
   * @expected Reject ambiguity before provider allocation.
   */
  it('rejects an unbridgeable set sharing the selected native identifier', async () => {
    const input = mapping();
    input.push({ ethereum: { ...input[0].avalanche, tokenId: 'avax' } });
    await tokens.updateConfigByJson(input);
    await expect(async () => await create()).rejects.toThrow('Ambiguous');
    expect(captured.calls).toHaveLength(0);
  });
  /**
   * @target createAvalancheChain rejects uppercase Ergo counterpart instead of privately normalizing it
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Uppercase the Ergo counterpart identifier.
   * @expected Reject the noncanonical identifier without normalization.
   */
  it('rejects uppercase Ergo counterpart instead of privately normalizing it', async () => {
    const input = mapping();
    input[0].ergo.tokenId = input[0].ergo.tokenId.toUpperCase();
    await tokens.updateConfigByJson(input);
    await expect(async () => await create()).rejects.toThrow('native AVAX');
    expect(captured.calls).toHaveLength(0);
  });
  /**
   * @target createAvalancheChain rejects trailing %s in the Ergo counterpart before provider allocation
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Append each line-ending suffix to the Ergo counterpart.
   * @expected Reject before provider or mediator allocation.
   */
  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
  ])(
    'rejects trailing %s in the Ergo counterpart before provider allocation',
    async (_name, suffix) => {
      const input = mapping();
      input[0].ergo.tokenId += suffix;
      await tokens.updateConfigByJson(input);
      await expect(async () => await create()).rejects.toThrow('native AVAX');
      expect(captured.calls).toHaveLength(0);
      expect(createSignMediator).not.toHaveBeenCalled();
    },
  );
  /**
   * @target createAvalancheChain rejects trailing %s in the RWT contract before provider allocation
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Append each line-ending suffix to the RWT contract identifier.
   * @expected Reject before provider or mediator allocation.
   */
  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
  ])(
    'rejects trailing %s in the RWT contract before provider allocation',
    async (_name, suffix) => {
      const original = contracts();
      const input = {
        ...original,
        tokens: { ...original.tokens, RWTId: original.tokens.RWTId + suffix },
      };
      await expect(
        async () =>
          await createAvalancheChain(config(), input, {
            dataSource,
            tokens,
            createSignMediator,
          }),
      ).rejects.toThrow('RWT');
      expect(captured.calls).toHaveLength(0);
      expect(createSignMediator).not.toHaveBeenCalled();
    },
  );
  /**
   * @target createAvalancheChain preserves all-member scaling with valid third-chain decimals %s
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Add valid third-chain decimals and an unrelated unbridgeable token.
   * @expected Preserve all-member scaling, copied tokens and the unchanged-map check.
   */
  it.each([0, 6, 24])(
    'preserves all-member scaling with valid third-chain decimals %s',
    async (decimals) => {
      const input = mapping();
      input[0].ethereum = { ...input[0].ergo, tokenId: 'third', decimals };
      input.push({ ethereum: { ...input[0].avalanche, tokenId: 'unrelated' } });
      await tokens.updateConfigByJson(input);
      const { chain, assertTokenMapUnchanged } = await create();
      const expected = {
        amount: 10n ** BigInt(18 - Math.min(9, decimals)),
        decimals: 18,
      };
      expect(tokens.unwrapAmount('avax', 1n, 'avalanche')).toEqual(expected);
      expect(chain['tokenMap'].unwrapAmount('avax', 1n, 'avalanche')).toEqual(
        expected,
      );
      expect(chain['tokenMap'].getRawConfig()).toEqual(tokens.getRawConfig());
      expect(assertTokenMapUnchanged).not.toThrow();
    },
  );
  /**
   * @target createAvalancheChain detects drift limited to an unbridgeable entry
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Change only an unbridgeable token-map entry after construction.
   * @expected Expose token-map drift.
   */
  it('detects drift limited to an unbridgeable entry', async () => {
    const { assertTokenMapUnchanged } = await create();
    const input = mapping();
    input.push({ ethereum: { ...input[0].avalanche, tokenId: 'unrelated' } });
    await tokens.updateConfigByJson(input);
    expect(assertTokenMapUnchanged).toThrow('token map changed');
  });
  /**
   * @target createAvalancheChain exposes token-map drift instead of silently sharing later token updates
   * @dependencies Real chain factory and TokenMap; mocked provider send and mediator.
   * @scenario Change native decimals in the caller token map after construction.
   * @expected Expose drift while preserving the chain's captured decimals.
   */
  it('exposes token-map drift instead of silently sharing later token updates', async () => {
    const { chain, assertTokenMapUnchanged } = await create();
    expect(assertTokenMapUnchanged).not.toThrow();
    const changed = mapping();
    changed[0].avalanche.decimals = 9;
    await tokens.updateConfigByJson(changed);
    expect(assertTokenMapUnchanged).toThrow('token map changed');
    expect(chain['tokenMap'].getConfig()[0].avalanche.decimals).toEqual(18);
  });
});
