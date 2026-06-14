/**
 * Shared run context. Vitest's globalSetup runs in a separate process from
 * the test files, so the bootstrap result is handed over via a JSON file in
 * `.runtime/` (gitignored; also handy when debugging a failed run).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ScreepsBridge } from 'screeps-web-api-bridge';
import { HarnessEnv } from './env';
import { ServerCli } from './serverCli';
import { RoomLayout } from './bootstrap';

export interface HarnessContext extends HarnessEnv {
  userId: string;
  room: string;
  layout: RoomLayout;
  targetRooms: string[];
}

const RUNTIME_DIR = path.join(__dirname, '..', '.runtime');
const CONTEXT_FILE = path.join(RUNTIME_DIR, 'context.json');

export function saveContext(ctx: HarnessContext): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
}

export function loadContext(): HarnessContext {
  if (!fs.existsSync(CONTEXT_FILE)) {
    throw new Error(
      `${CONTEXT_FILE} not found — the global setup did not run. Run the suite via vitest ` +
        '(npm test) or the one-command runner (npm run itest), not by importing test files directly.',
    );
  }
  return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) as HarnessContext;
}

/** CLI client for the context's server. */
export function cliFor(ctx: HarnessContext): ServerCli {
  return new ServerCli({ host: ctx.cliHost, port: ctx.cliPort });
}

/**
 * Construct a bridge against the private server and authenticate via the
 * private-server signin path (`POST /api/auth/signin`) — the same flow any
 * real consumer of the bridge uses. Never hand-rolls HTTP.
 */
export async function connectBridge(ctx: HarnessContext): Promise<ScreepsBridge> {
  const bridge = new ScreepsBridge({
    server: 'private',
    host: ctx.host,
    shard: ctx.shard,
    log: process.env.SCREEPS_LOG === 'true',
  });
  await bridge.auth.signin(ctx.username, ctx.password);
  return bridge;
}
