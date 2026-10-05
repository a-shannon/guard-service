import type { EntityManager } from '@rosen-bridge/extended-typeorm';

/** Exact database values for a caller-owned compare-and-swap, not a write lock. */
export interface SigningRowPreimage {
  readonly txId: string;
  readonly txJson: string;
  readonly chain: string;
  readonly type: string;
  readonly status: string;
  readonly requiredSign: number;
  readonly eventId: string | null;
  readonly orderId: string | null;
}

/** RPC-free checks, used only with the DAO's owned transaction manager. */
export interface SigningPersistenceAuthorization {
  assertActive(): void;
  assertBefore(
    manager: EntityManager,
    expected: SigningRowPreimage,
  ): Promise<void>;
  assertAfter(
    manager: EntityManager,
    expected: SigningRowPreimage,
    transition?: { unexpected: boolean },
  ): Promise<void>;
}
