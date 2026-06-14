import { defineConfig } from 'vitest/config';

/**
 * Hermetic subset: scenario I only (simulated 429s against an in-process
 * mock). Needs no private server, no docker, no global setup — handy as a
 * fast bridge-behaviour smoke on machines that can't run the full suite.
 *
 *   npm run test:hermetic
 */
export default defineConfig({
  test: {
    include: ['test/scenario-i-rate-limit.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    reporters: 'verbose',
  },
});
