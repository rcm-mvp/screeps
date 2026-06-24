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
import { Planner, type PlannerPort } from './planner';

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

  // Server-side base planner (STAMP.md §12): a sibling loop that watches the same
  // live ColonyState and, for rooms the bot flagged `needsPlan` (too closed for
  // the rigid stamp), computes the adaptive plan on the box's CPU and writes it to
  // RawMemory segment 90. Independent of the directive write loop above — it does
  // not consume the directive budget or honour dry-run (it writes a base plan, not
  // a directive), but it does back off on the kill switch.
  if (config.planner.enabled) {
    const plannerPort: PlannerPort = {
      terrain: (room) => bridge.rooms.terrain(room),
      objects: (room) => bridge.rooms.objects(room),
      getSegment: (segment) => bridge.memory.getSegment(segment),
      setSegment: (segment, data) => bridge.memory.setSegment(segment, data),
    };
    const planner = new Planner({
      bridge: plannerPort,
      config: config.planner,
      logger,
      killSwitch: () => strategist.isKilled(),
    });
    bridge.control.watchState((s) => planner.onState(s));
    // Kick an immediate first pass off the startup snapshot rather than waiting
    // for the next live state change.
    try {
      const snap = await bridge.commander.snapshot();
      if (snap.state) planner.onState(snap.state);
    } catch {
      /* rely on watchState */
    }
    logger.info(`base planner ON — segment ${90} (recompute cooldown ${config.planner.recomputeCooldownMs}ms)`);
  } else {
    logger.info('base planner OFF (PLANNER_ENABLED=false)');
  }

  const server = createServer(strategist, logger);
  // Bind to loopback by default: the control API is reached via the UI proxy
  // (localhost) or an SSH tunnel, never directly from the internet. Override
  // with STRATEGIST_HOST=0.0.0.0 to expose it deliberately.
  const bindHost = process.env.STRATEGIST_HOST ?? '127.0.0.1';
  server.listen(config.port, bindHost, () => logger.info(`HTTP API on http://${bindHost}:${config.port}`));

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
