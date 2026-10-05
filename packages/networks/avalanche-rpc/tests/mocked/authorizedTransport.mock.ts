import { vi } from 'vitest';

import { ok } from '../authorizedSubmissionTestUtils';

/** Return a synthetic successful JSON-RPC response without a socket. */
export const mockResponseTransport = () => vi.fn(async () => ok());
