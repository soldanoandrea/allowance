import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['sdk/test/**/*.test.ts', 'demo-api/test/**/*.test.ts', 'risk/test/**/*.test.ts'],
    testTimeout: 20_000,
    // The sandbox end-to-end test starts a real node: give it room.
    hookTimeout: 240_000,
  },
});
