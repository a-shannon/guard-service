import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import configShared from '../../vitest.shared';

const projectSpecific = defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/tests/localService/**'],
    setupFiles: [
      './tests/setup/setupTests.ts',
      './tests/setup/mockChainHandler.ts',
    ],
    coverage: {
      include: ['src'],
    },
  },
  plugins: [wasm(), topLevelAwait()],
});

export default mergeConfig(configShared, projectSpecific);
