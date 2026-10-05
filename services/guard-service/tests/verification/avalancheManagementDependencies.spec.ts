import { TransactionType } from '@rosen-chains/abstract-chain';

import { createAvalancheManagementDependencies } from '../../src/verification/avalancheManagementDependencies';
import { contracts } from '../utils/avalancheChainTestUtils';
import { createManagementAuthorizationFixture } from './avalancheManagementAuthorizationTestUtils';

describe('createAvalancheManagementDependencies', () => {
  const fixtures: Awaited<
    ReturnType<typeof createManagementAuthorizationFixture>
  >[] = [];

  /** Builds current native policy, DAO and asset-accounting ports for the dependency factory. */
  const setup = async (type = TransactionType.coldStorage, token = false) => {
    const f = await createManagementAuthorizationFixture(type, token);
    fixtures.push(f);
    vi.spyOn(f.chain, 'getLockAddressAssets').mockResolvedValue(f.cold.locked);
    const database = {
      getTxById: f.getTx,
      getOrderById: f.getOrder,
      getOrderValidTxs: vi.fn(async () => [f.row]),
      getActiveColdStorageTxsInChain: vi.fn(async () => [f.row]),
    };
    const ports: Parameters<typeof createAvalancheManagementDependencies>[0] = {
      getInputs: vi.fn(() => ({
        config: f.policy.config,
        contracts: {
          ...contracts(),
          addresses: {
            ...contracts().addresses,
            ...f.chain.getChainConfigs().addresses,
          },
        },
      })),
      getChain: vi.fn(() => f.chain),
      getDatabase: vi.fn(() => database),
      decode: (json) => f.chain.PaymentTransactionFromJson(json),
      getThresholds: vi.fn(() => ({
        avalanche: {
          tokens: token
            ? {
                avax: { low: 100000n, high: 1000000n },
                [f.tx.to!.toLowerCase()]: { low: 1250000n, high: 1500000n },
              }
            : { avax: { ...f.policy.cold! } },
          maxNativeTransfer: 0n,
        },
      })),
      getWaitingTokens: vi.fn(async () => ['waiting-token']),
      manualRequests: () => true,
      arbitraryRequests: () => true,
      guardsCount: () => 3,
    };
    return {
      f,
      ports,
      database,
      dependencies: createAvalancheManagementDependencies(ports),
    };
  };

  afterEach(() => {
    fixtures.splice(0).forEach((f) => f.close());
    vi.restoreAllMocks();
  });

  /**
   * @target createAvalancheManagementDependencies resolves JOE threshold and separate AVAX low
   * @dependencies Actual mainnet token envelope, existing per-token config and qualified accounting
   * @scenario Resolve a cold JOE intent and detached balance/input state
   * @expected Selected token thresholds and native gas floor are retained without replacing native configuration
   */
  it('resolves JOE threshold and separate AVAX low', async () => {
    const { f, dependencies } = await setup(TransactionType.coldStorage, true);
    expect(dependencies.getPolicy(f.intent())?.cold).toEqual(f.policy.cold);
    expect((await dependencies.getColdState(f.payment())).required).toEqual(
      f.cold.required,
    );
  });

  /**
   * @target createAvalancheManagementDependencies refuses JOE cold with %s thresholds
   * @dependencies Current actual token selection and mutable threshold resolver
   * @scenario Remove or corrupt one selected/native threshold or add an unknown asset
   * @expected No usable cold policy is returned
   */
  it.each([
    'missing native',
    'missing token',
    'unknown asset',
    'invalid native low',
    'invalid token high',
  ])('refuses JOE cold with %s thresholds', async (fault) => {
    const { f, ports, dependencies } = await setup(
      TransactionType.coldStorage,
      true,
    );
    const thresholds = ports.getThresholds();
    if (fault === 'missing native') delete thresholds.avalanche.tokens.avax;
    if (fault === 'missing token')
      delete thresholds.avalanche.tokens[f.tx.to!.toLowerCase()];
    if (fault === 'unknown asset')
      thresholds.avalanche.tokens.other = { low: 1n, high: 2n };
    if (fault === 'invalid native low')
      thresholds.avalanche.tokens.avax.low = -1n;
    if (fault === 'invalid token high')
      thresholds.avalanche.tokens[f.tx.to!.toLowerCase()].high = 1250000n;
    vi.mocked(ports.getThresholds).mockReturnValue(thresholds);
    expect(() => dependencies.getPolicy(f.intent())).toThrow('threshold');
  });

  /**
   * @target createAvalancheManagementDependencies connects actual native asset accounting to Guard ports
   * @dependencies
   * - Real AvalancheChain transaction accounting/order codec and synthetic native envelope.
   * - Mocked balance, threshold, waiting-token and current DAO ports.
   * @scenario
   * - Resolve captured startup policy and the current cold transfer input requirements.
   * @expected
   * - Value plus maximum gas fee and active transaction IDs are preserved without aliasing.
   */
  it('connects actual native asset accounting to Guard ports', async () => {
    const { f, ports, database, dependencies } = await setup();
    const policy = dependencies.getPolicy(f.intent())!;
    expect(policy).toMatchObject({ guardsCount: 3, cold: f.policy.cold });
    expect(policy.config).not.toBe(f.policy.config);
    const state = await dependencies.getColdState(f.payment());
    expect(state.required.nativeToken).toEqual(1590000n);
    expect(state.activeTxIds).toEqual([f.row.txId]);
    expect(state.forbiddenTokens).toEqual(['waiting-token']);
    expect(state.locked).not.toBe(f.cold.locked);
    expect(database.getActiveColdStorageTxsInChain).toHaveBeenCalledWith(
      'avalanche',
    );
    expect(await dependencies.getOrderTxIds(f.intent().eventId)).toEqual([
      f.row.txId,
    ]);
    expect(await dependencies.getTx(f.row.txId)).toBe(f.row);
    expect(ports.getThresholds).toHaveBeenCalledOnce();
  });

  /**
   * @target createAvalancheManagementDependencies leaves irrelevant thresholds unread for %s
   * @dependencies
   * - Captured route policy and mock threshold/adapter ports.
   * @scenario
   * - Resolve manual, arbitrary or disabled cold policy before runtime effects.
   * @expected
   * - Manual/arbitrary do not require a cold threshold file; disabled cold returns no authority.
   */
  it.each([
    TransactionType.manual,
    TransactionType.arbitrary,
    TransactionType.coldStorage,
  ])('leaves irrelevant thresholds unread for %s', async (type) => {
    const { f, ports, dependencies } = await setup(type);
    if (type === TransactionType.coldStorage)
      f.policy.config.routes.cold = false;
    const policy = dependencies.getPolicy(f.intent());
    if (type === TransactionType.coldStorage) expect(policy).toBeUndefined();
    else expect(policy?.cold).toBeUndefined();
    expect(ports.getThresholds).not.toHaveBeenCalled();
    expect(ports.getChain).not.toHaveBeenCalled();
  });

  /**
   * @target createAvalancheManagementDependencies rejects a changed DAO during asynchronous cold preflight
   * @dependencies
   * - Actual native input accounting and mocked current DAO/balance ports.
   * @scenario
   * - Replace the DAO resolver while a balance read yields.
   * @expected
   * - The mixed dependency snapshot refuses before returning usable reserve state.
   */
  it('rejects a changed DAO during asynchronous cold preflight', async () => {
    const { f, ports, database, dependencies } = await setup();
    vi.mocked(f.chain.getLockAddressAssets).mockImplementation(async () => {
      vi.mocked(ports.getDatabase).mockReturnValue({
        ...database,
      });
      return f.cold.locked;
    });
    await expect(dependencies.getColdState(f.payment())).rejects.toThrow(
      'dependency changed',
    );
  });
});
