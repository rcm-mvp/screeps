/**
 * Scenario H — resilience across resets.
 *
 * Part 1 (always runs): a code re-push forces the server to rebuild the
 * user's VM — a real global reset for the executor. It must rebuild its heap
 * ("global reset detected"), keep its creeps, and resume writing state.
 *
 * Part 2 (needs SCREEPS_RESTART_CMD, e.g. `docker compose restart screeps`):
 * the whole server process restarts. The bridge's WebSocket must reconnect
 * and re-subscribe BY ITSELF, and live state messages must resume on the
 * already-registered watchState subscription — no manual re-wiring. (One
 * nuance: private-server auth tokens may not survive a restart, so the
 * harness re-signs in when the API is back; the socket reads the token live
 * on its next reconnect attempt.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, collectConsole, ticksMs, waitFor } from '../src/poll';
import { waitForHttpReady } from '../src/bootstrap';
import { readBotBundle } from '../src/globalSetup';
import { half } from '../src/report';

const execAsync = promisify(exec);

describe('H. resilience: global reset + server restart', () => {
  let s: Scenario;
  let watcher: StateWatcher;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before forcing resets'),
    });
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('survives a global reset (code re-push) and resumes state writes', async () => {
    const consoleFeed = await collectConsole(s.bridge);
    try {
      const creepsBefore = watcher.latest?.creeps.total ?? 0;
      const beatBefore = watcher.latest?.heartbeat ?? 0;

      // Re-pushing the (trivially watermarked) real bundle rebuilds the VM.
      const bundle = readBotBundle() + `\n// integration global-reset probe ${Date.now()}\n`;
      await s.bridge.code.push('default', { main: bundle });

      // The executor must notice the reset and rebuild its heap...
      const resetSeen = async () =>
        consoleFeed.lines.some((l) => l.includes('global reset detected'));
      await watcher.next((st) => st.heartbeat > beatBefore + 10, {
        timeoutMs: ticksMs(60),
        what: half('bot-write', 'heartbeat to keep advancing across the code re-push (global reset)'),
      });
      expect(
        await resetSeen(),
        'executor should log "global reset detected" after the VM rebuild',
      ).toBe(true);

      // ...without losing its creeps (Memory + world state persist).
      const creepsAfter = watcher.latest?.creeps.total ?? 0;
      expect(
        creepsAfter,
        `creeps must survive a global reset (before: ${creepsBefore}, after: ${creepsAfter})`,
      ).toBeGreaterThanOrEqual(Math.max(0, creepsBefore - 1));
    } finally {
      consoleFeed.stop();
    }
  });

  it.skipIf(!process.env.SCREEPS_RESTART_CMD)(
    'WS auto-reconnects + re-subscribes across a server restart',
    async () => {
      const events: string[] = [];
      s.bridge.socket.on('reconnect', () => events.push('reconnect'));
      s.bridge.socket.on('close', () => events.push('close'));

      // Establish a live WS subscription (console — a channel the real backend
      // streams intact) BEFORE the restart, so recovery means it resumes
      // WITHOUT us re-subscribing it by hand.
      const consoleFeed = await collectConsole(s.bridge);
      try {
        await waitFor(async () => consoleFeed.lines.length > 0, {
          timeoutMs: ticksMs(40),
          intervalMs: 500,
          what: 'baseline console output before the restart',
        });
        const linesBefore = consoleFeed.lines.length;
        const beatBefore = watcher.latest?.heartbeat ?? 0;

        // Kill the server out from under the live socket + subscription.
        await execAsync(process.env.SCREEPS_RESTART_CMD as string, {
          cwd: path.join(__dirname, '..'),
        });
        await waitForHttpReady(s.ctx.host, 240_000);

        // Private-server tokens die with the process; refresh ours. The socket
        // reads the token live (getToken) on its next backoff attempt, so the
        // reconnect + re-subscription of the console channel stays automatic.
        await s.bridge.auth.signin(s.ctx.username, s.ctx.password);

        // 1) The bot itself recovered: state advances again (HTTP).
        await watcher.next((st) => st.heartbeat > beatBefore, {
          timeoutMs: 180_000,
          what: half('bot-write', 'the executor to resume writing state after the server restart'),
        });

        // 2) The WS auto-reconnected and re-subscribed: console output resumes
        //    on the SAME subscription, with no manual re-subscribe.
        await waitFor(async () => consoleFeed.lines.length > linesBefore, {
          timeoutMs: 180_000,
          intervalMs: 1000,
          what: half(
            'bridge-read',
            'live console output to resume on the pre-restart subscription (WS auto-reconnect + re-subscribe)',
          ),
        });

        expect(
          events,
          'the socket should have observed the drop and scheduled a reconnect',
        ).toContain('reconnect');
      } finally {
        consoleFeed.stop();
      }
    },
    300_000,
  );
});
