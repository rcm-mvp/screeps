/**
 * God-mode seeding + readback helpers for the mineral-pipeline scenarios
 * (scenario-l / scenario-m). Everything goes through the server CLI
 * (`storage.db` / `storage.env`), never the player HTTP API, so it consumes no
 * rate-limit budget and can rewrite the world arbitrarily.
 *
 * These let the harness assert the A2 mineral feature end-to-end without
 * waiting for the bot to organically reach RCL6 + build an extractor (which is
 * not feasible inside a scenario's time budget): we seed the structures the bot
 * operates and observe its real, bundled behaviour.
 *
 * runJson constraint reminder (see serverCli.ts): scripts are collapsed onto a
 * single line, so NO `//` comments, statements separated by `;`, and only small
 * summaries crossing the wire.
 */
import type { ServerCli } from './serverCli';
import { pauseSimulation, resumeSimulation } from './bootstrap';

export interface SeededMineral {
  x: number;
  y: number;
  mineralType: string;
}

/** Set the test room's controller level (storage needs >=4; extractor >=6). */
export async function setControllerLevel(cli: ServerCli, room: string, level: number): Promise<void> {
  await cli.runJson(
    `storage.db['rooms.objects'].update({ $and: [{ room: ${JSON.stringify(room)} }, { type: 'controller' }] },` +
      ` { $set: { level: ${level} } }).then(function () { return 'level-set'; })`,
  );
}

/**
 * Ensure the room has a mineral deposit and return it. Real reseeded rooms have
 * one; a `map.generateRoom` fallback room may not, so insert one in the known
 * wall-free core near the spawn if absent. mineralAmount is set high so it never
 * depletes mid-scenario.
 */
export async function ensureRoomMineral(
  cli: ServerCli,
  room: string,
  spawn: { x: number; y: number },
): Promise<SeededMineral> {
  return cli.runJson<SeededMineral>(`(async function () {
    var room = ${JSON.stringify(room)};
    var m = await storage.db['rooms.objects'].findOne({ $and: [{ room: room }, { type: 'mineral' }] });
    if (m) {
      await storage.db['rooms.objects'].update({ _id: m._id },
        { $set: { mineralAmount: 100000, density: 3 } });
      return { x: m.x, y: m.y, mineralType: m.mineralType };
    }
    var mx = ${spawn.x} - 1, my = ${spawn.y} - 1;
    await storage.db['rooms.objects'].insert({ type: 'mineral', room: room, x: mx, y: my,
      mineralType: 'H', mineralAmount: 100000, density: 3 });
    return { x: mx, y: my, mineralType: 'H' };
  })()`);
}

/** Insert a STRUCTURE_EXTRACTOR (owned by the user) on the mineral tile. */
export async function seedExtractor(cli: ServerCli, userId: string, mineral: SeededMineral, room: string): Promise<void> {
  await cli.runJson(`(async function () {
    var room = ${JSON.stringify(room)};
    var ex = await storage.db['rooms.objects'].findOne({ $and: [{ room: room }, { type: 'extractor' }] });
    if (ex) return 'extractor-exists';
    await storage.db['rooms.objects'].insert({ type: 'extractor', room: room,
      x: ${mineral.x}, y: ${mineral.y}, user: ${JSON.stringify(userId)},
      hits: 500, hitsMax: 500, notifyWhenAttacked: false });
    return 'extractor-seeded';
  })()`);
}

/**
 * Insert a STRUCTURE_CONTAINER on the first walkable 8-neighbour of the mineral
 * and return its tile. Throws (server-side) if the mineral is fully walled in,
 * which never happens for a real deposit.
 */
export async function seedMineralContainer(
  cli: ServerCli,
  room: string,
  mineral: SeededMineral,
): Promise<{ x: number; y: number }> {
  return cli.runJson<{ x: number; y: number }>(`(async function () {
    var room = ${JSON.stringify(room)};
    var td = await storage.db['rooms.terrain'].findOne({ room: room });
    var t = td && td.terrain ? td.terrain : '';
    var wall = function (x, y) { return (parseInt(t.charAt(y * 50 + x), 10) & 1) === 1; };
    var objs = await storage.db['rooms.objects'].find({ room: room });
    var blockers = { spawn: 1, extension: 1, tower: 1, storage: 1, source: 1, controller: 1, mineral: 1, wall: 1, link: 1, terminal: 1, lab: 1 };
    var occupied = function (x, y) {
      for (var i = 0; i < objs.length; i++) { if (objs[i].x === x && objs[i].y === y && blockers[objs[i].type]) return true; }
      return false;
    };
    var mx = ${mineral.x}, my = ${mineral.y};
    var pick = null;
    for (var dy = -1; dy <= 1 && !pick; dy++) for (var dx = -1; dx <= 1 && !pick; dx++) {
      if (dx === 0 && dy === 0) continue;
      var x = mx + dx, y = my + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (!wall(x, y) && !occupied(x, y)) pick = { x: x, y: y };
    }
    if (!pick) throw new Error('mineral has no free walkable neighbour for a container');
    var existing = await storage.db['rooms.objects'].findOne(
      { $and: [{ room: room }, { type: 'container' }, { x: pick.x }, { y: pick.y }] });
    if (!existing) {
      await storage.db['rooms.objects'].insert({ type: 'container', room: room, x: pick.x, y: pick.y,
        store: {}, storeCapacity: 2000, hits: 250000, hitsMax: 250000, notifyWhenAttacked: false });
    }
    return pick;
  })()`);
}

/**
 * Insert (or overwrite the store of) a user-owned STRUCTURE_STORAGE at a known
 * wall-free, unoccupied core tile near the spawn. `store` is the exact store to
 * set (e.g. { energy: 1000, H: 750 }).
 */
export async function seedUserStorage(
  cli: ServerCli,
  userId: string,
  room: string,
  spawn: { x: number; y: number },
  store: Record<string, number>,
): Promise<{ x: number; y: number }> {
  return cli.runJson<{ x: number; y: number }>(`(async function () {
    var room = ${JSON.stringify(room)}, id = ${JSON.stringify(userId)};
    var sx = ${spawn.x}, sy = ${spawn.y} + 1;
    var store = ${JSON.stringify(store)};
    var existing = await storage.db['rooms.objects'].findOne({ $and: [{ room: room }, { type: 'storage' }] });
    if (existing) {
      await storage.db['rooms.objects'].update({ _id: existing._id }, { $set: { store: store } });
      return { x: existing.x, y: existing.y };
    }
    await storage.db['rooms.objects'].insert({ type: 'storage', room: room, x: sx, y: sy, user: id,
      store: store, storeCapacity: 1000000, hits: 10000, hitsMax: 10000, notifyWhenAttacked: false });
    return { x: sx, y: sy };
  })()`);
}

/** Remove any storage in the room (scenario-m must have no mineral sink). */
export async function removeStorage(cli: ServerCli, room: string): Promise<void> {
  await cli.runJson(
    `Promise.resolve(storage.db['rooms.objects'].removeWhere({ $and: [{ room: ${JSON.stringify(room)} },` +
      ` { type: 'storage' }] })).then(function () { return 'storage-removed'; })`,
  );
}

/** Overwrite the user storage's store (e.g. to change a mineral amount live). */
export async function setStorageStore(cli: ServerCli, room: string, store: Record<string, number>): Promise<void> {
  await cli.runJson(
    `storage.db['rooms.objects'].update({ $and: [{ room: ${JSON.stringify(room)} }, { type: 'storage' }] },` +
      ` { $set: { store: ${JSON.stringify(store)} } }).then(function () { return 'store-set'; })`,
  );
}

/** Read one resource amount from the container at the given tile (-1 if gone). */
export async function getContainerResource(
  cli: ServerCli,
  room: string,
  at: { x: number; y: number },
  resource: string,
): Promise<number> {
  return cli.runJson<number>(
    `storage.db['rooms.objects'].findOne({ $and: [{ room: ${JSON.stringify(room)} }, { type: 'container' },` +
      ` { x: ${at.x} }, { y: ${at.y} }] }).then(function (c) {` +
      ` return c && c.store ? (c.store[${JSON.stringify(resource)}] || 0) : -1; })`,
  );
}

/**
 * Inject a pre-parked mineralMiner creep on `at` (the container tile) with the
 * memory the role needs, while the simulation is paused so the write can't race
 * a tick. The bot runs runMineralMiner on it next tick (adoptCreeps backfills
 * home and won't override the explicit role). Returns the creep name.
 */
export async function injectMineralMiner(
  cli: ServerCli,
  userId: string,
  room: string,
  at: { x: number; y: number },
): Promise<string> {
  await pauseSimulation(cli);
  try {
    return await cli.runJson<string>(`(async function () {
      var id = ${JSON.stringify(userId)}, room = ${JSON.stringify(room)};
      var time = parseInt(await storage.env.get('gameTime')) || 0;
      var name = 'mm_itest_' + time;
      var body = [];
      for (var i = 0; i < 5; i++) body.push({ type: 'work', hits: 100 });
      body.push({ type: 'move', hits: 100 });
      await storage.db['rooms.objects'].insert({ type: 'creep', user: id, room: room,
        x: ${at.x}, y: ${at.y}, name: name, body: body, hits: 600, hitsMax: 600,
        ticksToLive: 1500, ageTime: time + 1500, store: {}, storeCapacity: 0,
        fatigue: 0, spawning: false, notifyWhenAttacked: false, actionLog: {} });
      var raw = await storage.env.get('memory:' + id);
      var mem = {};
      try { mem = JSON.parse(raw || '{}'); } catch (e) { mem = {}; }
      if (!mem.creeps) mem.creeps = {};
      mem.creeps[name] = { role: 'mineralMiner', home: room, working: false };
      await storage.env.set('memory:' + id, JSON.stringify(mem));
      return name;
    })()`);
  } finally {
    await resumeSimulation(cli);
  }
}
