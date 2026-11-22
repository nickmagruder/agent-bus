import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // `npm run test:coverage` (and CI) report coverage. No thresholds yet:
    // once the numbers settle, pin them at the current values so coverage
    // can only go up (a ratchet, not a target).
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
    },
  },
});
