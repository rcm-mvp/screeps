/**
 * Bootstrap + isolation utilities. Everything here goes through the server
 * CLI (db/env god mode) — never through the player HTTP API — so it consumes
 * no rate-limit budget and works before any user exists.
 *
 * The test user is bootstrapped at RCL 3 with a spawn, 10 extensions and one
 * tower (mirroring screeps-server-mockup's `addBot` db shape). Rationale:
 *  - energyCapacity 300+10*50 = 800 ≥ 650, so claimers are spawnable
 *    (scenario G asserts a real claimer dispatch);
 *  - a tower makes "defense persists while paused" (scenario E) observable
 *    as hostiles actually dying, not just a quota twiddle.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ServerCli } from './serverCli';

const execAsync = promisify(exec);

export interface RoomLayout {
  room: string;
  spawn: { x: number; y: number };
  tower: { x: number; y: number };
  extensions: Array<{ x: number; y: number }>;
  sources: number;
}

export interface BootstrapResult {
  userId: string;
  room: string;
  layout: RoomLayout;
  /** Unowned controller rooms usable as flag/claim targets. */
  targetRooms: string[];
}

// ---------------------------------------------------------------------------
// Server readiness + official-server runtime probe
// ---------------------------------------------------------------------------

/** Poll `/api/version` until the HTTP API responds. */
export async function waitForHttpReady(host: string, timeoutMs = 300_000): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastErr = 'no attempt made';
  let nextProgressAt = start + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    // A cold boot yarn-installs the server mods (~2-3 min) before the API
    // listens. Emit a heartbeat so a silent wait doesn't look like a hang.
    if (Date.now() >= nextProgressAt) {
      const secs = Math.round((Date.now() - start) / 1000);
      console.log(`[harness]   ...still waiting (${secs}s, normal on first cold boot; last: ${lastErr})`);
      nextProgressAt += 15_000;
    }
    await sleep(2000);
  }
  throw new Error(`private server at ${host} not ready after ${timeoutMs}ms (last error: ${lastErr})`);
}

/**
 * Second safety layer (after the hostname guard in env.ts): fingerprint the
 * live server and refuse anything that looks like the official MMO.
 */
export async function probeNotOfficial(host: string): Promise<void> {
  const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as {
    users?: number;
    serverData?: { shards?: unknown[] };
  };
  const shards = body.serverData?.shards;
  if (Array.isArray(shards) && shards.length > 1) {
    throw new Error(
      `SAFETY: ${host}/api/version reports ${shards.length} shards — that is the official ` +
        'server fingerprint. Refusing to run the destructive suite here.',
    );
  }
  if (typeof body.users === 'number' && body.users > 500) {
    throw new Error(
      `SAFETY: ${host}/api/version reports ${body.users} active users — far too many for a ` +
        'test server. Refusing to run the destructive suite here.',
    );
  }
}

// ---------------------------------------------------------------------------
// Simulation controls
// ---------------------------------------------------------------------------

/**
 * Set a fast tick so scenarios complete in seconds. Tries the vanilla CLI
 * helper, then screepsmod-admin-utils variants, then the raw env key the
 * driver actually reads — whichever this server build supports.
 */
export async function setTickDuration(cli: ServerCli, ms: number): Promise<string> {
  return cli.runJson<string>(`(function () {
    try { if (typeof system !== 'undefined' && system.setTickDuration) { system.setTickDuration(${ms}); return 'system.setTickDuration'; } } catch (e) {}
    try { if (typeof utils !== 'undefined' && utils.setTickDuration) { utils.setTickDuration(${ms}); return 'utils.setTickDuration'; } } catch (e) {}
    try { if (typeof utils !== 'undefined' && utils.setTickRate) { utils.setTickRate(${ms}); return 'utils.setTickRate'; } } catch (e) {}
    return storage.env.set('mainLoopMinDuration', ${ms}).then(function () { return 'env:mainLoopMinDuration'; });
  })()`);
}

export function pauseSimulation(cli: ServerCli): Promise<unknown> {
  return cli.runJson(`system.pauseSimulation()`);
}

export function resumeSimulation(cli: ServerCli): Promise<unknown> {
  return cli.runJson(`system.resumeSimulation()`);
}

export function getGameTime(cli: ServerCli): Promise<number> {
  return cli.runJson<number>(
    `storage.env.get('gameTime').then(function (t) { return parseInt(t) || 0; })`,
  );
}

// ---------------------------------------------------------------------------
// World + user bootstrap
// ---------------------------------------------------------------------------

/**
 * Reset the whole world to a clean, deterministic baseline for the run.
 *
 * `system.resetAllData()` reseeds the standard map (a full grid of rooms with
 * controllers, sources and terrain) and a set of NPC/demo bots;
 * `utils.removeBots()` then clears the competing demo AIs while KEEPING the
 * engine's system users — Invader (id '2', used by scenario E) and Source
 * Keeper (id '3'). The result: dozens of free rooms and a quiet world, every
 * run, with no dependency on whatever a prior run left behind.
 */
export async function resetWorld(cli: ServerCli): Promise<{ freeRooms: number }> {
  await cli.runJson(`system.resetAllData().then(function () { return 'reset'; })`);
  await cli.runJson(
    `Promise.resolve(utils.removeBots()).then(function () { return 'bots-removed'; }, function () { return 'no-bots'; })`,
  );
  // Regenerate the aggregate terrain blob (env key TERRAIN_DATA) the runtime
  // reads as `staticTerrainData`. The runner caches this for its whole
  // lifetime (see restartServer), so it must be correct before the runner
  // (re)starts.
  await cli.runJson(
    `Promise.resolve(map.updateTerrainData()).then(function () { return 'terrain'; }, function () { return 'no-terrain-fn'; })`,
  );
  const freeRooms = await cli.runJson<number>(
    `storage.db['rooms.objects'].find({ type: 'controller' })` +
      `.then(function (c) { return c.filter(function (x) { return !x.user; }).length; })`,
  );
  return { freeRooms };
}

/**
 * Restart the server process and wait for it to come back.
 *
 * Why this is mandatory after a world reset: the runner caches the whole-map
 * terrain blob (`staticTerrainData` in driver `make.js`) ONCE per process
 * lifetime — `if (staticTerrainData) return`. A runner that already cached
 * terrain for a different/empty world builds every user's `Game.map`
 * (`WorldMapGrid`) from stale room offsets and throws
 * `Cannot read properties of undefined` in `_start`, BEFORE the user's loop
 * runs — so no state is ever written. Restarting forces the runner to rebuild
 * terrain from the freshly-provisioned world.
 *
 * `restartCmd` empty → skipped (a freshly-booted server hasn't cached yet, so
 * it's only unsafe on reruns against a long-lived process).
 */
export async function restartServer(args: {
  restartCmd: string;
  cwd: string;
  host: string;
  cli: ServerCli;
}): Promise<boolean> {
  const { restartCmd, cwd, host, cli } = args;
  if (!restartCmd) return false;
  try {
    await execAsync(restartCmd, { cwd });
  } catch (err) {
    // A failed restart command (e.g. non-docker server, wrong cwd) is not
    // fatal: on a freshly-booted server the runner hasn't cached terrain yet,
    // so provisioning can still succeed. globalSetup warns when this happens.
    console.warn(`[harness] restart command "${restartCmd}" failed: ${String(err)}`);
    return false;
  }
  await waitForHttpReady(host, 240_000);
  // CLI may lag the HTTP API by a few seconds after a restart.
  await waitFor(() => cli.ping(), {
    timeoutMs: 60_000,
    intervalMs: 1000,
    what: 'server CLI to respond after restart',
  });
  return true;
}

/** Minimal local poll helper (kept here so bootstrap has no test-only deps). */
async function waitFor(
  probe: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number; what: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await sleep(opts.intervalMs);
  }
  throw new Error(`timed out after ${opts.timeoutMs}ms waiting for ${opts.what}`);
}

/**
 * Server-side room finder: an unowned room with a controller, ≥1 source and
 * an open 5x5 area for the base; also returns other unowned controller rooms
 * to use as flag targets. Runs entirely in the CLI sandbox — only the small
 * summary crosses the wire.
 */
const FIND_ROOM_SCRIPT = `(async function () {
    var controllers = await storage.db['rooms.objects'].find({ type: 'controller' });
    var free = controllers.filter(function (c) { return !c.user; });
    var candidates = [];
    for (var i = 0; i < free.length; i++) {
      var room = free[i].room;
      var sources = await storage.db['rooms.objects'].find({ $and: [{ room: room }, { type: 'source' }] });
      if (sources.length >= 1) candidates.push({ room: room, sources: sources.length });
    }
    candidates.sort(function (a, b) { return b.sources - a.sources; });
    var layout = null;
    var used = null;
    for (var c = 0; c < candidates.length && !layout; c++) {
      var name = candidates[c].room;
      var tdoc = await storage.db['rooms.terrain'].findOne({ room: name });
      if (!tdoc || !tdoc.terrain) continue;
      var t = tdoc.terrain;
      var wall = function (x, y) { return (parseInt(t.charAt(y * 50 + x), 10) & 1) === 1; };
      for (var y = 8; y < 40 && !layout; y++) {
        for (var x = 8; x < 40 && !layout; x++) {
          var ok = true;
          for (var dy = -2; dy <= 2 && ok; dy++) for (var dx = -2; dx <= 2 && ok; dx++) {
            if (wall(x + dx, y + dy)) ok = false;
          }
          if (!ok) continue;
          var ext = [];
          for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) {
            if (dx2 === 0 && dy2 === 0) continue;
            if (Math.abs(dx2) === 2 || Math.abs(dy2) === 2) {
              if (ext.length < 10) ext.push({ x: x + dx2, y: y + dy2 });
            }
          }
          if (ext.length < 10) continue;
          layout = { room: name, spawn: { x: x, y: y }, tower: { x: x + 1, y: y },
                     extensions: ext.slice(0, 10), sources: candidates[c].sources };
          used = name;
        }
      }
    }
    var targets = candidates.map(function (c2) { return c2.room; })
      .filter(function (r) { return r !== used; }).slice(0, 4);
    return { layout: layout, targetRooms: targets };
  })()`;

/**
 * Find a home room for the test user. Falls back to `map.generateRoom` when
 * the map has nothing usable (fresh screepsmod-mongo worlds can be blank).
 */
export async function findHomeRoom(cli: ServerCli): Promise<{ layout: RoomLayout; targetRooms: string[] }> {
  type Pick = { layout: RoomLayout | null; targetRooms: string[] };
  let pick = await cli.runJson<Pick>(FIND_ROOM_SCRIPT);
  if (!pick.layout) {
    await cli.runJson(`(async function () {
      var names = ['W5N5', 'W5N6', 'W6N5'];
      for (var i = 0; i < names.length; i++) {
        try { await map.generateRoom(names[i], { sources: 2, controller: true, keepers: false }); } catch (e) {}
        try { await map.openRoom(names[i]); } catch (e) {}
      }
      try { await map.updateTerrainData(); } catch (e) {}
      return 'generated';
    })()`);
    pick = await cli.runJson<Pick>(FIND_ROOM_SCRIPT);
  }
  if (!pick.layout) {
    throw new Error(
      'bootstrap: no usable room with a controller + open base area found, even after map.generateRoom',
    );
  }
  return { layout: pick.layout, targetRooms: pick.targetRooms };
}

/**
 * Create the test account + base (db shape mirrors screeps-server-mockup's
 * addBot) and set its password via screepsmod-auth's `setPassword` CLI.
 * GCL points are set high so claim directives have headroom (scenario G).
 */
export async function createTestUser(
  cli: ServerCli,
  args: { username: string; password: string; layout: RoomLayout },
): Promise<string> {
  const { username, password, layout } = args;
  const userId = await cli.runJson<string>(`(async function () {
    var user = await storage.db.users.insert({
      username: ${JSON.stringify(username)},
      usernameLower: ${JSON.stringify(username.toLowerCase())},
      cpu: 100, cpuAvailable: 10000, registeredDate: new Date(),
      active: 10000, gcl: 30000000, credits: 0, password: false,
      badge: { type: 1, color1: '#33ff33', color2: '#115511', color3: '#000000', param: 0, flip: false }
    });
    var id = user._id;
    var room = ${JSON.stringify(layout.room)};
    await storage.env.set('memory:' + id, '{}');
    await storage.db.rooms.update({ _id: room }, { $set: { active: true, status: 'normal' } });
    await storage.db['users.code'].insert({
      user: id, branch: 'default', activeWorld: true, activeSim: true,
      modules: { main: 'module.exports.loop = function () {};' }
    });
    await storage.db['rooms.objects'].update(
      { $and: [{ room: room }, { type: 'controller' }] },
      { $set: { user: id, level: 3, progress: 0, downgradeTime: null, safeMode: null, safeModeAvailable: 0 } });
    await storage.db['rooms.objects'].insert({
      type: 'spawn', room: room, x: ${layout.spawn.x}, y: ${layout.spawn.y},
      user: id, name: 'Spawn1', store: { energy: 300 }, storeCapacityResource: { energy: 300 },
      hits: 5000, hitsMax: 5000, spawning: null, notifyWhenAttacked: false, off: false });
    await storage.db['rooms.objects'].insert({
      type: 'tower', room: room, x: ${layout.tower.x}, y: ${layout.tower.y},
      user: id, store: { energy: 1000 }, storeCapacityResource: { energy: 1000 },
      hits: 3000, hitsMax: 3000, notifyWhenAttacked: false,
      actionLog: { attack: null, heal: null, repair: null } });
    var ext = ${JSON.stringify(layout.extensions)};
    for (var i = 0; i < ext.length; i++) {
      await storage.db['rooms.objects'].insert({
        type: 'extension', room: room, x: ext[i].x, y: ext[i].y,
        user: id, store: { energy: 50 }, storeCapacityResource: { energy: 50 },
        hits: 1000, hitsMax: 1000, notifyWhenAttacked: false, off: false });
    }
    return id;
  })()`);

  // screepsmod-auth's CLI hook writes { salt, password } onto the user;
  // without it /api/auth/signin returns 401. setPassword() RETURNS A PROMISE
  // (the db update) — it must be awaited, or signin races the write. runJson
  // awaits whatever the expression resolves to, so hand it the promise.
  // screepsmod-auth >=2.9.0 namespaced the CLI helper under `auth.setPassword`
  // (it was a bare `setPassword` global before); the mod is pulled at
  // `:latest` with no version pinning, so support both shapes.
  await cli.runJson(
    `Promise.resolve((typeof auth !== 'undefined' ? auth.setPassword : setPassword)` +
      `(${JSON.stringify(username)}, ${JSON.stringify(password)}))` +
      `.then(function () { return 'password-set'; })`,
  );

  // Confirm the credential actually landed before any signin is attempted.
  const ready = await cli.runJson<boolean>(
    `storage.db.users.findOne({ username: ${JSON.stringify(username)} })` +
      `.then(function (u) { return !!(u && u.salt && u.password); })`,
  );
  if (!ready) {
    throw new Error(`bootstrap: setPassword did not persist salt/password for "${username}"`);
  }
  return userId;
}

// ---------------------------------------------------------------------------
// Per-scenario isolation
// ---------------------------------------------------------------------------

/**
 * Reset the test user's slice of the world between scenarios: kill all creeps
 * (the user's and any NPC hostiles), drop flags + construction sites, refill
 * base energy, and wipe the user's Memory (Memory.bridge, Memory.plan, ...).
 * Runs with the simulation paused so a tick can't interleave with the writes.
 */
export async function resetScenario(cli: ServerCli, userId: string, room: string): Promise<void> {
  await pauseSimulation(cli);
  try {
    await cli.runJson(`(async function () {
      var id = ${JSON.stringify(userId)};
      var room = ${JSON.stringify(room)};
      await storage.db['rooms.objects'].removeWhere({ $and: [{ type: 'creep' }, { user: id }] });
      await storage.db['rooms.objects'].removeWhere({ $and: [{ type: 'creep' }, { user: '2' }] });
      await storage.db['rooms.objects'].removeWhere({ $and: [{ type: 'constructionSite' }, { user: id }] });
      await storage.db['rooms.flags'].removeWhere({ user: id });
      await storage.db['rooms.objects'].update(
        { $and: [{ user: id }, { type: 'spawn' }] },
        { $set: { spawning: null, store: { energy: 300 } } });
      await storage.db['rooms.objects'].update(
        { $and: [{ user: id }, { type: 'extension' }] },
        { $set: { store: { energy: 50 } } });
      await storage.db['rooms.objects'].update(
        { $and: [{ user: id }, { type: 'tower' }] },
        { $set: { store: { energy: 1000 } } });
      await storage.env.set('memory:' + id, '{}');
      return 'reset';
    })()`);
  } finally {
    await resumeSimulation(cli);
  }
}

// ---------------------------------------------------------------------------
// NPC hostiles (scenario E)
// ---------------------------------------------------------------------------

/**
 * Insert invader-NPC creeps (user id '2', the engine's built-in Invader
 * account) near the given position. Body: 5×TOUGH + 2×ATTACK = 700 hits, so
 * a tower needs a few shots — the kill is observable across several ticks.
 */
export async function spawnHostiles(
  cli: ServerCli,
  room: string,
  at: { x: number; y: number },
  count = 2,
): Promise<string[]> {
  return cli.runJson<string[]>(`(async function () {
    var invader = await storage.db.users.findOne({ _id: '2' });
    if (!invader) {
      await storage.db.users.insert({ _id: '2', username: 'Invader', usernameLower: 'invader',
        cpu: 100, cpuAvailable: 10000, gcl: 0, active: 0, badge: { type: 1, color1: '#ff0000', color2: '#ff0000', color3: '#ff0000', param: 0, flip: false } });
    }
    var time = parseInt(await storage.env.get('gameTime')) || 0;
    var body = [];
    for (var b = 0; b < 5; b++) body.push({ type: 'tough', hits: 100 });
    body.push({ type: 'attack', hits: 100 });
    body.push({ type: 'attack', hits: 100 });
    var names = [];
    for (var i = 0; i < ${count}; i++) {
      var name = 'invader_itest_' + time + '_' + i;
      await storage.db['rooms.objects'].insert({
        type: 'creep', user: '2', room: ${JSON.stringify(room)},
        x: ${at.x} + i, y: ${at.y}, name: name, body: body,
        hits: 700, hitsMax: 700, ticksToLive: 1500, ageTime: time + 1500,
        store: {}, storeCapacity: 0, fatigue: 0, spawning: false,
        notifyWhenAttacked: false, actionLog: {} });
      names.push(name);
    }
    return names;
  })()`);
}

/** Count live hostile (Invader) creeps in a room. */
export function countHostiles(cli: ServerCli, room: string): Promise<number> {
  return cli.runJson<number>(
    `storage.db['rooms.objects'].find({ $and: [{ room: ${JSON.stringify(room)} }, { type: 'creep' }, { user: '2' }] })
       .then(function (c) { return c.length; })`,
  );
}

/** Tower energy in the test room (proves the tower actually fired). */
export function getTowerEnergy(cli: ServerCli, room: string): Promise<number> {
  return cli.runJson<number>(
    `storage.db['rooms.objects'].findOne({ $and: [{ room: ${JSON.stringify(room)} }, { type: 'tower' }] })
       .then(function (t) { return t && t.store ? (t.store.energy || 0) : -1; })`,
  );
}

/** Controller progress (scenario A: "RCL progresses"). */
export function getControllerProgress(cli: ServerCli, room: string): Promise<number> {
  return cli.runJson<number>(
    `storage.db['rooms.objects'].findOne({ $and: [{ room: ${JSON.stringify(room)} }, { type: 'controller' }] })
       .then(function (c) { return c ? (c.progress || 0) : -1; })`,
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
