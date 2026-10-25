import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/daemon/test/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
