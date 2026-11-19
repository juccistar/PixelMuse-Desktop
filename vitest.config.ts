import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['apps/desktop/src/renderer/**', 'jsdom']],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
