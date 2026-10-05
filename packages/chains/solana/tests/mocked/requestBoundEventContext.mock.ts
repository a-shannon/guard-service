import { vi } from 'vitest';

import type {
  SolanaResolvedProfile,
  SolanaRosenExtractor,
} from '@rosen-bridge/rosen-extractor';

import { createTestProfile } from '../testData';

/** Build a narrow runtime double for the concrete extractor boundary. */
export const createMockSolanaExtractor = (
  outcome: unknown = {
    type: 'not-deposit',
    reason: 'NO_ROSEN_MEMO',
  },
  profile: SolanaResolvedProfile = createTestProfile(),
): SolanaRosenExtractor =>
  ({
    getResolvedProfile: vi.fn(() => profile),
    getWithContext: vi.fn(() => outcome),
  }) as unknown as SolanaRosenExtractor;
