import { Interface, getAddress } from 'ethers';

import { HealthStatusLevel as Status } from '@rosen-bridge/health-check';
import { PartialERC20ABI } from '@rosen-chains/evm';

import {
  createAssetHealthFixture,
  critical,
  deferred,
  joe,
  warn,
} from './avalancheAssetHealthTestUtils';
import { param } from './avalancheHealthTestUtils';

describe('getHealthCheck', () => {
  let f: Awaited<ReturnType<typeof createAssetHealthFixture>>;
  beforeAll(async () => {
    f = await createAssetHealthFixture();
  });
  beforeEach(async () => await f.reset());
  afterAll(async () => {
    if (f) await f.close();
    vi.restoreAllMocks();
  });

  /**
   * @target getHealthCheck classifies raw %s balance %s through real RPC and persisted scanner safety
   * @dependencies Actual Guard/shared health, RPC readers, TokenMap and migrated SQLite scanner; synthetic provider replies.
   * @scenario
   * - Set one raw balance above, at warning, or at critical, all above Number.MAX_SAFE_INTEGER.
   * - Update its registered parameter through the real persisted safety exclusion.
   * - Inspect status and finalized RPC arguments.
   * @expected Preserve inclusive uint256 thresholds and exact native/JOE custody calls on chain 43114.
   */
  it.each([
    ['native', warn + 1n, Status.HEALTHY],
    ['native', warn, Status.UNSTABLE],
    ['native', critical, Status.BROKEN],
    ['token', warn + 1n, Status.HEALTHY],
    ['token', warn, Status.UNSTABLE],
    ['token', critical, Status.BROKEN],
  ] as const)(
    'classifies raw %s balance %s through real RPC and persisted scanner safety',
    async (asset, balance, status) => {
      f.state[asset] = balance;
      const id = asset === 'native' ? 'avalanche-native-balance' : f.tokenId;
      await f.health.updateParam(id);
      expect((await param(f.health, id))?.status).toEqual(status);
      expect(f.network.expectedChainId).toEqual(43114n);
      expect(
        await f.repository.findOneByOrFail({ scanner: 'avalanche' }),
      ).toMatchObject({
        chainId: '43114',
        sourceId: 'synthetic-processor-source',
        finalizedHeight: 2,
        holdReason: null,
      });
      expect(f.blocks).toHaveBeenCalledWith('finalized');
      expect(f.send).toHaveBeenCalledWith('eth_getBlockByNumber', [
        '0x2',
        false,
      ]);
      if (asset === 'native') {
        expect(f.native).toHaveBeenCalledExactlyOnceWith(f.lock);
        expect(f.token).not.toHaveBeenCalled();
        expect(f.send).toHaveBeenCalledWith('eth_getBalance', [
          getAddress(f.lock),
          '0x2',
        ]);
      } else {
        expect(f.token).toHaveBeenCalledExactlyOnceWith(f.lock, joe);
        expect(f.native).not.toHaveBeenCalled();
        expect(f.send).toHaveBeenCalledWith('eth_call', [
          {
            to: getAddress(joe),
            data: new Interface(PartialERC20ABI).encodeFunctionData(
              'balanceOf',
              [getAddress(f.lock)],
            ),
          },
          '0x2',
        ]);
      }
    },
  );

  /**
   * @target getHealthCheck refuses %s health after isolated %s identity drift
   * @dependencies Actual health, RPC reader and scanner safety; one synthetic network/header fault per case.
   * @scenario
   * - First obtain a healthy observation with unchanged replies.
   * - Change only the chain ID, finalized numeric hash, or post-balance canonical hash.
   * - Update the same parameter and inspect which balance RPC could run.
   * @expected Mark BROKEN and reject each specific stale identity without an incidental second fault.
   */
  it.each([
    ['native', 'network'],
    ['native', 'frontier'],
    ['native', 'state'],
    ['token', 'network'],
    ['token', 'frontier'],
    ['token', 'state'],
  ] as const)(
    'refuses %s health after isolated %s identity drift',
    async (asset, fault) => {
      const id = asset === 'native' ? 'avalanche-native-balance' : f.tokenId;
      await f.health.updateParam(id);
      expect((await param(f.health, id))?.status).toEqual(Status.HEALTHY);
      f.send.mockClear();
      f.state.fault = fault;
      await f.health.updateParam(id);
      expect((await param(f.health, id))?.status).toEqual(Status.BROKEN);
      const balanceCalls = f.send.mock.calls.filter(
        ([method]) => method === 'eth_getBalance' || method === 'eth_call',
      );
      expect(balanceCalls).toHaveLength(fault === 'state' ? 1 : 0);
      expect(
        (await f.repository.findOneByOrFail({ scanner: 'avalanche' }))
          .holdReason,
      ).toBeNull();
    },
  );

  /**
   * @target getHealthCheck refuses both custody readers under a persisted scanner hold
   * @dependencies Actual migrated SQLite safety state and scanner withSafety; retained real balance readers.
   * @scenario
   * - Persist a hold in the scanner's SQL row and reload it.
   * - Update the native and JOE health parameters.
   * - Inspect both statuses and reader/provider call counts.
   * @expected Both monitors become BROKEN before either custody reader or balance RPC executes.
   */
  it('refuses both custody readers under a persisted scanner hold', async () => {
    await f.repository.update(
      { scanner: 'avalanche' },
      { holdReason: 'synthetic-health-hold' },
    );
    expect(
      (await f.repository.findOneByOrFail({ scanner: 'avalanche' })).holdReason,
    ).toEqual('synthetic-health-hold');
    await f.health.updateParam('avalanche-native-balance');
    await f.health.updateParam(f.tokenId);
    expect((await param(f.health, 'avalanche-native-balance'))?.status).toEqual(
      Status.BROKEN,
    );
    expect((await param(f.health, f.tokenId))?.status).toEqual(Status.BROKEN);
    expect(f.native).not.toHaveBeenCalled();
    expect(f.token).not.toHaveBeenCalled();
    expect(
      f.send.mock.calls.filter(
        ([method]) => method === 'eth_getBalance' || method === 'eth_call',
      ),
    ).toHaveLength(0);
  });

  /**
   * @target getHealthCheck excludes a real scanner update throughout a deferred %s custody read
   * @dependencies Actual persisted scanner, health and RPC reader; manually released synthetic balance response.
   * @scenario
   * - Pause the balance RPC after the health consumer acquires scanner safety.
   * - Attempt actual scanner.update while the balance response is pending.
   * - Release the response and update the scanner again.
   * @expected Concurrent update rejects already running; the health read completes and exclusion is released.
   */
  it.each(['native', 'token'] as const)(
    'excludes a real scanner update throughout a deferred %s custody read',
    async (asset) => {
      const entered = deferred();
      const release = deferred();
      f.state.beforeBalance = async () => {
        entered.resolve();
        await release.promise;
      };
      const id = asset === 'native' ? 'avalanche-native-balance' : f.tokenId;
      const pending = f.health.updateParam(id);
      await entered.promise;
      try {
        await expect(f.scanner.update()).rejects.toThrow('already running');
      } finally {
        release.resolve();
        await pending;
      }
      expect((await param(f.health, id))?.status).toEqual(Status.HEALTHY);
      await expect(f.scanner.update()).resolves.toBeUndefined();
      expect(
        (await f.repository.findOneByOrFail({ scanner: 'avalanche' }))
          .holdReason,
      ).toBeNull();
    },
  );
});
