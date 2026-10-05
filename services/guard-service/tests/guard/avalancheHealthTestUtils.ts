import { HealthCheck } from '@rosen-bridge/health-check';

import { readAvalancheHealthConfig } from '../../src/configs/avalancheHealthConfig';

/** Finds one registered parameter in an actual health status snapshot. */
export const param = async (health: HealthCheck, id: string) =>
  (await health.getHealthStatus()).find((item) => item.id === id);

/** Creates independent exact-wei and scanner-age thresholds. */
export const config = () =>
  readAvalancheHealthConfig({
    nativeWarnWei: '9007199254740993',
    nativeCriticalWei: '9007199254740992',
    scannerWarnAgeSeconds: 10,
    scannerCriticalAgeSeconds: 20,
  });
