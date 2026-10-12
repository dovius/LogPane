import { defineConfig } from 'vitest/config';

// End-to-end tests: a real Chromium with the built extension. `npm run test:e2e`
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    globalSetup: ['test/e2e/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One browser at a time: timing-sensitive checks (tail, reload, performance) stay stable.
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
