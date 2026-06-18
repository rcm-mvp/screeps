/**
 * Strategist entrypoint. Loads config, builds its own ScreepsBridge (the strategist
 * is an external commander — it owns its connection), wires the decider + loop, and
 * serves the control/observability HTTP API.
 *
 * Safe by default: dry-run ON, rule-based decider, tiny write budget. Nothing is
 * written to the colony until you flip DRY_RUN=false (or toggle it live in the UI).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ScreepsBridge } from 'screeps-web-api-bridge';
import type { ColonyState, Directives, AwaitAckOptions } from 'screeps-web-api-bridge';
import { loadConfig } from './config';
import { makeDecider } from './decider';
import { History, SteeringStore } from './history';
import { createServer } from './server';
import { Strategist, type BridgePort, type Logger } from './strategist';

/** Minimal .env loader (Node 18 has no --env-file). Real env vars win. */
function loadDotEnv(): void {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  console.log(`[strategist] loaded env from ${file}`);
}

const logger: Logger = {
  info: (msg, meta) => console.log(`[strategist] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[strategist] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[strategist] ${msg}`, meta ?? ''),
};

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const bridge = new ScreepsBridge({
    server: config.screeps.server,
    token: config.screeps.token,
    shard: config.screeps.shard,
    host: config.screeps.host,
    username: config.screeps.username,
    password: config.screeps.password,
  });

  // Private servers without a token sign in for a (rotating) session token.
  if (!config.screeps.token && config.screeps.username && config.screeps.password) {
    try {
      await bridge.auth.signin(config.screeps.username, config.screeps.password);
      logger.info('signed in to private server');
    } catch (e) {
      logger.warn('signin failed (continuing; reads/writes may fail)', { err: String(e) });
    }
  }

  const port: BridgePort = {
    snapshot: () => bridge.commander.snapshot(),
    propose: (patch: Partial<Directives>, opts?: AwaitAckOptions) => bridge.commander.propose(patch, opts),
    watchState: (cb: (s: ColonyState) => void) => bridge.control.watchState(cb),
  };

  const history = new History(config.historyMax);
  const steering = new SteeringStore();

  let ollamaCalls = 0;
  const onOllamaCall = () => {
    ollamaCalls += 1;
  };
  const deciderFactory = (kind: typeof config.decider) =>
    makeDecider({ ...config, decider: kind }, { steering, onOllamaCall });

  const decider = makeDecider(config, { steering, onOllamaCall });

  const strategist = new Strategist({
    bridge: port,
    decider,
    history,
    steering,
    config,
    logger,
    getOllamaCalls: () => ollamaCalls,
    deciderFactory,
  });

  await strategist.start();
  logger.info(
    `started — decider=${config.decider} dryRun=${config.dryRun} killSwitch=${config.killSwitch} ` +
      `budget=${config.maxWritesPerHour}/hr`,
  );

  const server = createServer(strategist, logger);
  server.listen(config.port, () => logger.info(`HTTP API on http://localhost:${config.port}`));

  const shutdown = () => {
    logger.info('shutting down');
    strategist.stop();
    server.close();
    try {
      bridge.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('fatal', { err: e instanceof Error ? e.stack : String(e) });
  process.exit(1);
});
