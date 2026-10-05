import type { QueryRunner } from '@rosen-bridge/extended-typeorm';

/** Captures migration SQL with a controlled unsafe-row result. */
export const mockQueryRunner = (unsafe = false) => {
  const query = vi.fn().mockResolvedValue([]);
  if (unsafe) query.mockResolvedValueOnce([{ invalid: 1 }]);
  return { query, runner: { query } as unknown as QueryRunner };
};
