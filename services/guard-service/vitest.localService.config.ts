import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/localService',
  test: {
    globals: false,
    include: ['./tests/localService/*.join.spec.ts'],
    setupFiles: [],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
