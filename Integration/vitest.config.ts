import { defineConfig } from 'vitest/config';

/**
 * Scenarios run strictly one at a time, in file order (a, b, c, ...): they
 * share one private server and one test user, and each begins by resetting
 * the user's world state. Parallelism would let scenarios poison each other.
 *
 * Timeouts are generous on purpose: ticks advance in wall-clock time on a
 * private server, so every wait is expressed in "ticks worth of wall-clock"
 * (see src/poll.ts) and must never be cut short by the runner.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./src/globalSetup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    testTimeout: 240_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
    reporters: 'verbose',
  },
});
