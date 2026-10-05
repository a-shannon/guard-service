import { vi } from 'vitest';

import { DataSource } from '@rosen-bridge/extended-typeorm';

/** Mock constructor repository access so validation order can be observed. */
export const mockConstructorDatabase = () => {
  const getRepository = vi.fn(() => ({}));
  const database = { getRepository } as unknown as DataSource;
  return { getRepository, database };
};
