import {
  AbstractHealthCheckParam,
  HealthStatusLevel,
} from '@rosen-bridge/health-check';

import {
  AvalancheHealthConfig,
  captureAvalancheHealthConfig,
} from '../configs/avalancheHealthConfig';

type HealthResult = { status: HealthStatusLevel; details?: string };

/** The latest attempt owns status and metadata; health never grants authority. */
abstract class AvalancheHealthParam extends AbstractHealthCheckParam {
  #generation = 0n;
  #status = HealthStatusLevel.BROKEN;
  #details: string | undefined;
  #assessedAt = Date.now();
  #observedAt: number | undefined;
  readonly #failure: string;

  /** Captures sanitized failure and initial status descriptions. */
  constructor(failure: string, initial: string) {
    super();
    this.#failure = failure;
    this.#details = initial;
  }

  /** Lets the latest started sample own status, assessment time and failure metadata. */
  protected check = async (
    sample: () => Promise<HealthResult>,
  ): Promise<void> => {
    const generation = ++this.#generation;
    this.#status = HealthStatusLevel.BROKEN;
    this.#details = 'Avalanche health observation is pending.';
    this.#assessedAt = Date.now();
    this.lastTrialErrorMessage = undefined;
    this.lastTrialErrorTime = undefined;
    try {
      const result = await sample();
      if (generation !== this.#generation) return;
      this.#status = result.status;
      this.#details = result.details;
      this.#assessedAt = Date.now();
      this.#observedAt = this.#assessedAt;
      this.lastTrialErrorMessage = undefined;
      this.lastTrialErrorTime = undefined;
    } catch {
      if (generation !== this.#generation) return;
      this.#status = HealthStatusLevel.BROKEN;
      this.#details = this.#failure;
      this.#assessedAt = Date.now();
      this.lastTrialErrorMessage = this.#failure;
      this.lastTrialErrorTime = new Date();
      throw new Error(this.#failure);
    }
  };

  // Base update clears metadata after await without attempt ownership; keep it here.
  /** Updates status while retaining attempt-owned, sanitized failure metadata. */
  update = async (): Promise<void> => {
    try {
      await this.updateStatus();
    } catch {
      /* check has recorded a sanitized failure */
    }
  };
  /** Returns the current assessment, including BROKEN while a sample is pending. */
  getHealthStatus = () => this.#status;
  /** Returns the current assessment's sanitized explanation when one is present. */
  getDetails = () => this.#details;
  /** Local status assessment time, including initial and pending BROKEN status. */
  getLastUpdatedTime = (): Date => new Date(this.#assessedAt);
  /** Local completion time of a successful qualified read, not its block timestamp. */
  getLastSuccessfulObservationTime = (): Date | undefined =>
    this.#observedAt === undefined ? undefined : new Date(this.#observedAt);
}

export class AvalancheNativeBalanceHealthCheckParam extends AvalancheHealthParam {
  readonly #config: AvalancheHealthConfig;
  readonly #readBalance: () => Promise<bigint>;

  /** Captures native-balance thresholds and the supplied qualified balance reader. */
  constructor(
    config: AvalancheHealthConfig,
    readBalance: () => Promise<bigint>,
  ) {
    super(
      'Unable to read Avalanche native balance.',
      'No Avalanche native balance has been observed.',
    );
    this.#config = captureAvalancheHealthConfig(config);
    if (typeof readBalance !== 'function')
      throw new Error('Invalid Avalanche balance reader');
    this.#readBalance = readBalance;
  }
  /** Returns the stable identifier for the native-balance health parameter. */
  getId = () => 'avalanche-native-balance';
  /** Returns the native-balance title for health consumers. */
  getTitle = () => 'Avalanche native balance';
  /** Describes the raw-wei comparison performed by this parameter. */
  getDescription = () => 'Native AVAX balance compared in raw wei.';
  /** Validates a uint256 balance and compares it with the captured thresholds. */
  updateStatus = () =>
    this.check(async () => {
      const balance = await this.#readBalance();
      if (
        typeof balance !== 'bigint' ||
        balance < 0n ||
        balance > (1n << 256n) - 1n
      )
        throw new Error('Invalid balance');
      if (balance <= this.#config.nativeCriticalWei)
        return {
          status: HealthStatusLevel.BROKEN,
          details: 'Native AVAX balance is at or below the critical threshold.',
        };
      if (balance <= this.#config.nativeWarnWei)
        return {
          status: HealthStatusLevel.UNSTABLE,
          details: 'Native AVAX balance is at or below the warning threshold.',
        };
      return { status: HealthStatusLevel.HEALTHY };
    });
}

export interface AvalancheScannerHealthSnapshot {
  readonly height: number;
  /** Unix timestamp in seconds from the same qualified scanner observation. */
  readonly timestamp: number;
}

export class AvalancheScannerHealthCheckParam extends AvalancheHealthParam {
  readonly #config: AvalancheHealthConfig;
  readonly #readSnapshot: () => Promise<AvalancheScannerHealthSnapshot>;
  readonly #nowSeconds: () => number;

  /** Captures age thresholds, the coherent snapshot reader and the seconds clock. */
  constructor(
    config: AvalancheHealthConfig,
    readSnapshot: () => Promise<AvalancheScannerHealthSnapshot>,
    nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super(
      'Unable to read qualified Avalanche scanner health.',
      'No qualified Avalanche scanner observation is available.',
    );
    this.#config = captureAvalancheHealthConfig(config);
    if (typeof readSnapshot !== 'function' || typeof nowSeconds !== 'function')
      throw new Error('Invalid Avalanche scanner health reader');
    this.#readSnapshot = readSnapshot;
    this.#nowSeconds = nowSeconds;
  }
  /** Returns the stable identifier for scanner observation-age health. */
  getId = () => 'avalanche-scanner-age';
  /** Returns the scanner observation-age title for health consumers. */
  getTitle = () => 'Avalanche scanner observation age';
  /** Describes the age of a coherent qualified scanner observation. */
  getDescription = () =>
    'Age in seconds of a coherent qualified scanner observation.';
  /** Rejects malformed or future snapshots and compares their age with policy. */
  updateStatus = () =>
    this.check(async () => {
      const snapshot = await this.#readSnapshot();
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
        throw new Error('Missing snapshot');
      const { height, timestamp } = snapshot,
        now = this.#nowSeconds();
      for (const value of [height, timestamp, now])
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < 0
        )
          throw new Error('Invalid scanner value');
      if (timestamp > now) throw new Error('Future scanner timestamp');
      const age = now - timestamp;
      if (age >= this.#config.scannerCriticalAgeSeconds)
        return {
          status: HealthStatusLevel.BROKEN,
          details:
            'Qualified Avalanche scanner observation age reached the critical threshold.',
        };
      if (age >= this.#config.scannerWarnAgeSeconds)
        return {
          status: HealthStatusLevel.UNSTABLE,
          details:
            'Qualified Avalanche scanner observation age reached the warning threshold.',
        };
      return { status: HealthStatusLevel.HEALTHY };
    });
}
