/**
 * Vitest global setup: provision the private server once per run.
 *
 *   1. safety guards (static host check + live official-server fingerprint)
 *   2. wait for HTTP API + server CLI
 *   3. reset the world (clean seed, demo bots removed, terrain regenerated)
 *   4. restart the server so the runner rebuilds its cached terrain
 *   5. fast tick duration → resume sim
 *   6. find a free room, bootstrap a RCL-3 base + password login
 *   7. sign in THROUGH THE BRIDGE and push the REAL Bot bundle
 *      (Bot/dist/main.js) to branch `default` — never a reimplementation
 *   8. hand the context to the test files via .runtime/context.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnv } from './env';
import { ServerCli } from './serverCli';
import {
  createTestUser,
  findHomeRoom,
  probeNotOfficial,
  resetWorld,
  restartServer,
  resumeSimulation,
  setTickDuration,
  waitForHttpReady,
} from './bootstrap';
import { connectBridge, saveContext, HarnessContext } from './context';

const HARNESS_DIR = path.join(__dirname, '..');

export const BOT_BUNDLE = path.join(__dirname, '..', '..', 'Bot', 'dist', 'main.js');

/** Read the built executor bundle — the artifact under test. */
export function readBotBundle(): string {
  if (!fs.existsSync(BOT_BUNDLE)) {
    throw new Error(
      `Bot bundle not found at ${BOT_BUNDLE}. Build the real artifact first: ` +
        'npm --prefix ../Bot run build (the harness must test dist/main.js, not sources).',
    );
  }
  return fs.readFileSync(BOT_BUNDLE, 'utf8');
}

export default async function setup(): Promise<() => Promise<void>> {
  const env = loadEnv();
  const log = (msg: string) => console.log(`[harness] ${msg}`);

  log(`waiting for private server at ${env.host} ...`);
  await waitForHttpReady(env.host);
  await probeNotOfficial(env.host);

  const cli = new ServerCli({ host: env.cliHost, port: env.cliPort });
  if (!(await cli.ping())) {
    throw new Error(
      `server CLI not reachable at ${env.cliHost}:${env.cliPort}. The harness needs the ` +
        'launcher CLI port exposed (see docker-compose.yml / server/config.yml).',
    );
  }

  // Full reset FIRST (reseeds the map, removes demo bots, regenerates the
  // terrain blob). This must happen before the runner caches terrain.
  const { freeRooms } = await resetWorld(cli);
  log(`world reset: ${freeRooms} free rooms, demo bots removed (Invader/SourceKeeper kept)`);

  // MANDATORY: the runner caches the whole-map terrain for its process
  // lifetime, so a reset world only takes effect for code execution after a
  // restart (otherwise every user's Game.map build throws before its loop
  // runs — see restartServer). Skipped only when no restart command is set.
  const restarted = await restartServer({
    restartCmd: env.restartCmd,
    cwd: HARNESS_DIR,
    host: env.host,
    cli,
  });
  if (restarted) log('server restarted (runner terrain cache rebuilt for the fresh world)');
  else
    log(
      'WARNING: no SCREEPS_RESTART_CMD — skipping the post-reset restart. If the bot never ' +
        'writes state, the runner cached stale terrain; restart the server and rerun.',
    );

  const via = await setTickDuration(cli, env.tickMs);
  log(`tick duration set to ${env.tickMs}ms via ${via}`);
  await resumeSimulation(cli);

  const { layout, targetRooms } = await findHomeRoom(cli);
  log(`home room ${layout.room} (spawn @${layout.spawn.x},${layout.spawn.y}, ${layout.sources} sources); targets: ${targetRooms.join(', ') || '(none)'}`);

  const userId = await createTestUser(cli, {
    username: env.username,
    password: env.password,
    layout,
  });
  log(`test user "${env.username}" created (id ${userId})`);

  const ctx: HarnessContext = { ...env, userId, room: layout.room, layout, targetRooms };
  saveContext(ctx);

  // Push the real artifact through the real bridge (signin → POST user/code).
  const bundle = readBotBundle();
  const bridge = await connectBridge(ctx);
  try {
    await bridge.code.push('default', { main: bundle });
    try {
      await bridge.code.setActiveBranch('default', 'activeWorld');
    } catch {
      // users.code was inserted with activeWorld: true; older servers may not
      // expose set-active-branch — that's fine.
    }
    log(`pushed Bot/dist/main.js (${(bundle.length / 1024).toFixed(1)} KiB) to branch "default"`);
  } finally {
    bridge.close();
  }

  return async () => {
    // Leave the world in place for post-mortem inspection; the next run's
    // purge step makes reruns deterministic anyway.
  };
}
