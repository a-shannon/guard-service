import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SolanaRpcAssetHealthCheckParam } from '@rosen-bridge/asset-check';
import { HealthCheck, HealthStatusLevel } from '@rosen-bridge/health-check';
import type { Axios } from '@rosen-clients/rate-limited-axios';

import { createHealthApi } from './guardHealthDbTestUtils';

const state = vi.hoisted(() => ({
  health: undefined as unknown,
  lamports: '2000000000',
  malformed: false,
  transportError: false,
}));

vi.mock('../../src/guard/healthCheck', () => ({
  getHealthCheck: async () => state.health,
}));
// The health route does not depend on chain names; keep unrelated network packages
// outside this focused installed producer-to-route composition.
vi.mock('../../src/utils/constants', () => ({
  DefaultAddressApiLimit: 50,
  DefaultApiLimit: 100,
  DefaultAssetApiLimit: 10,
  DefaultRevenueApiCount: 10,
  RevenuePeriod: { year: 'year', month: 'month', week: 'week' },
  SUPPORTED_CHAINS: ['ergo', 'cardano', 'bitcoin', 'ethereum', 'binance'],
}));

const address = 'SyntheticSolanaReserveAddress11111111111111111111';
const paramId = `asset_sol_${address}`;
const warnThreshold = 1_000_000_000n;
const criticalThreshold = 100_000_000n;
const initialMilliseconds = 1_800_000_000_000;

describe('Guard SOL health producer and route composition', () => {
  let api: Awaited<ReturnType<typeof createHealthApi>>;
  let client: Axios;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(initialMilliseconds);
    state.health = undefined;
    state.lamports = '2000000000';
    state.malformed = false;
    state.transportError = false;

    client = {
      post: vi.fn(async (_url: string, body: unknown) => {
        if (state.transportError) throw new Error('synthetic RPC unavailable');
        const id = (body as { id: string }).id;
        return {
          data: state.malformed
            ? '{malformed'
            : `{"jsonrpc":"2.0","result":{"context":{"slot":123},"value":${state.lamports}},"id":"${id}"}`,
        };
      }),
    } as unknown as Axios;

    const health = new HealthCheck();
    health.register(
      new SolanaRpcAssetHealthCheckParam(
        address,
        warnThreshold,
        criticalThreshold,
        'http://127.0.0.1:8899/synthetic',
        client,
      ),
    );
    state.health = health;
    api = await createHealthApi();
  });

  afterEach(async () => {
    if (api) await api.close();
    vi.useRealTimers();
  });

  /** Checks both read routes and confirms that they do not refresh the RPC state. */
  const expectRouteViewsToMatch = async (
    expected: unknown,
    expectedPostCalls: number,
  ) => {
    const single = await api.inject({
      method: 'GET',
      url: `/health/parameter/${paramId}`,
    });
    expect(single.statusCode).toEqual(200);
    expect(single.json()).toEqual(expected);

    const all = await api.inject({ method: 'GET', url: '/health/status' });
    expect(all.statusCode).toEqual(200);
    expect(all.json()).toEqual([expected]);
    expect(client.post).toHaveBeenCalledTimes(expectedPostCalls);
  };

  /**
   * @target healthRoutes refreshes SolanaRpcAssetHealthCheckParam.updateStatus through HealthCheck.updateParam
   * @dependencies actual HealthCheck, Solana RPC asset check and Fastify inject
   * @scenario update the parameter above, at and between both thresholds, and below critical
   * @expected route payload reports the matching Rosen health enum and details
   */
  it.each([
    { lamports: '2000000000', status: HealthStatusLevel.HEALTHY },
    { lamports: '1000000000', status: HealthStatusLevel.HEALTHY },
    { lamports: '500000000', status: HealthStatusLevel.UNSTABLE },
    { lamports: '100000000', status: HealthStatusLevel.UNSTABLE },
    { lamports: '50000000', status: HealthStatusLevel.BROKEN },
  ])(
    'serves $status SOL balance status through the real routes',
    async ({ lamports, status }) => {
      state.lamports = lamports;
      const updated = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });

      expect(updated.statusCode).toEqual(200);
      expect(client.post).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'getBalance',
          params: [address, { commitment: 'finalized' }],
        }),
        { responseType: 'text' },
      );
      expect(updated.json()).toMatchObject({
        id: paramId,
        title: '[Solana] Available SOL Balance',
        status,
        lastCheck: expect.any(String),
      });
      expect(updated.json().lastCheck).toEqual(
        new Date(initialMilliseconds).toISOString(),
      );
      expect(updated.json().lastTrialErrorMessage).toBeUndefined();
      expect(updated.json().lastTrialErrorTime).toBeUndefined();
      const formattedBalance =
        status === HealthStatusLevel.HEALTHY
          ? lamports === '1000000000'
            ? '1'
            : '2'
          : status === HealthStatusLevel.UNSTABLE
            ? lamports === '100000000'
              ? '0.1'
              : '0.5'
            : '0.05';
      expect(updated.json().description).toContain(
        `The current balance is ${formattedBalance}.`,
      );
      if (status === HealthStatusLevel.HEALTHY)
        expect(updated.json().details).toBeUndefined();
      else expect(updated.json().details).toContain('balance');
      await expectRouteViewsToMatch(updated.json(), 1);
    },
  );

  /**
   * @target healthRoutes exposes errors and recovery from AbstractHealthCheckParam.update
   * @dependencies prior valid SOL update, malformed RPC response and Fastify inject
   * @scenario fail a refresh after a valid balance, then recover on a later update
   * @expected route preserves last successful status/time, reports trial error, then clears it
   */
  it.each([
    { failure: 'malformed RPC response', mode: 'malformed' as const },
    { failure: 'RPC transport rejection', mode: 'transport' as const },
  ])(
    'preserves the last successful state after $failure and recovers',
    async ({ mode }) => {
      const initial = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });
      expect(initial.statusCode).toEqual(200);
      const lastCheck = initial.json().lastCheck;
      await expectRouteViewsToMatch(initial.json(), 1);

      vi.setSystemTime(initialMilliseconds + 1000);
      state.lamports = '50000000';
      if (mode === 'malformed') state.malformed = true;
      else state.transportError = true;
      const failed = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });

      expect(failed.statusCode).toEqual(200);
      expect(failed.json()).toMatchObject({
        id: paramId,
        status: HealthStatusLevel.HEALTHY,
        lastCheck,
        lastTrialErrorMessage:
          mode === 'malformed'
            ? 'INVALID_SOLANA_RPC_JSON'
            : 'synthetic RPC unavailable',
        lastTrialErrorTime: new Date(initialMilliseconds + 1000).toISOString(),
      });
      expect(failed.json().description).toEqual(initial.json().description);
      expect(failed.json().details).toEqual(initial.json().details);
      await expectRouteViewsToMatch(failed.json(), 2);

      state.malformed = false;
      state.transportError = false;
      vi.setSystemTime(initialMilliseconds + 2000);
      const recovered = await api.inject({
        method: 'PUT',
        url: `/health/parameter/${paramId}`,
      });
      expect(recovered.statusCode).toEqual(200);
      expect(recovered.json()).toMatchObject({
        id: paramId,
        status: HealthStatusLevel.BROKEN,
      });
      expect(recovered.json().lastTrialErrorMessage).toBeUndefined();
      expect(recovered.json().lastTrialErrorTime).toBeUndefined();
      expect(recovered.json().lastCheck).toEqual(
        new Date(initialMilliseconds + 2000).toISOString(),
      );
      expect(recovered.json().lastCheck).not.toEqual(lastCheck);
      expect(recovered.json().description).toContain(
        'The current balance is 0.05.',
      );
      await expectRouteViewsToMatch(recovered.json(), 3);
    },
  );
});
