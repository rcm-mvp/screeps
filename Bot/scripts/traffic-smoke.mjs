// Traffic-manager unit smoke: bundles src/lib/traffic.ts standalone and drives
// the resolver against a tiny Game/Room/Creep mock. The empty-world smoke can't
// reach this code (no creeps), so the collision/priority/pin logic is checked
// here. Usage: node scripts/traffic-smoke.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- direction helpers (must match traffic.ts DX/DY) ---
const DIR = { T: 1, TR: 2, R: 3, BR: 4, B: 5, BL: 6, L: 7, TL: 8 };
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];
function dirTo(fx, fy, tx, ty) {
  const dx = Math.sign(tx - fx);
  const dy = Math.sign(ty - fy);
  if (dx === 0 && dy === 0) return 0;
  if (dx === 0) return dy < 0 ? DIR.T : DIR.B;
  if (dx > 0) return dy < 0 ? DIR.TR : dy > 0 ? DIR.BR : DIR.R;
  return dy < 0 ? DIR.TL : dy > 0 ? DIR.BL : DIR.L;
}

// --- minimal sandbox ---
globalThis.OK = 0;
globalThis.TERRAIN_MASK_WALL = 1;
globalThis.FIND_MY_CREEPS = 101;
globalThis.FIND_STRUCTURES = 107;
globalThis.FIND_MY_CONSTRUCTION_SITES = 114;
globalThis.STRUCTURE_RAMPART = 'rampart';
globalThis.OBSTACLE_OBJECT_TYPES = ['spawn', 'extension', 'tower', 'wall', 'storage'];
globalThis.Game = { time: 1234 };

class MockPos {
  constructor(x, y, roomName) {
    this.x = x;
    this.y = y;
    this.roomName = roomName;
  }
  getDirectionTo(x, y) {
    return dirTo(this.x, this.y, x, y);
  }
}
class Creep {
  constructor(name, x, y) {
    this.name = name;
    this.pos = new MockPos(x, y, 'W1N1');
    this.fatigue = 0;
    this.spawning = false;
    this.executed = null; // direction issued by the *original* move
  }
  move(dir) {
    this.executed = dir; // this is the original; traffic patches the prototype copy
    return OK;
  }
}
globalThis.Creep = Creep;

const room = {
  name: 'W1N1',
  getTerrain: () => ({ get: () => 0 }), // open room
  find(type) {
    if (type === FIND_MY_CREEPS) return room._creeps;
    return [];
  },
  _creeps: [],
};

// --- bundle traffic.ts to CJS and load it ---
const dir = mkdtempSync(join(tmpdir(), 'traffic-'));
const out = join(dir, 'traffic.cjs');
await build({ entryPoints: ['src/lib/traffic.ts'], outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error' });
const require = createRequire(import.meta.url);
const traffic = require(out);
traffic.installTraffic();

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
function resolved(c) {
  if (c.executed === null || c.executed === 0) return { x: c.pos.x, y: c.pos.y };
  return { x: c.pos.x + DX[c.executed - 1], y: c.pos.y + DY[c.executed - 1] };
}
function run(creeps) {
  // Note: registerMove/setWorkingArea were already called this "tick"; the
  // per-tick reset in the real game is the fresh creep object each tick, which
  // the per-scenario `new Creep(...)` mirrors here — so don't clear _traffic.
  room._creeps = creeps;
  delete room._trafficObstacles;
  traffic.runTraffic(room);
}
function noCollisions(creeps) {
  const seen = new Set();
  for (const c of creeps) {
    const r = resolved(c);
    const k = r.x * 50 + r.y;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

// Scenario 1: head-on swap in a corridor — both must move past each other.
{
  const a = new Creep('A', 5, 5);
  const b = new Creep('B', 6, 5);
  traffic.registerMove(a, { x: 6, y: 5 }, 1);
  traffic.registerMove(b, { x: 5, y: 5 }, 1);
  run([a, b]);
  const ra = resolved(a);
  const rb = resolved(b);
  check('swap: no collision', noCollisions([a, b]));
  check('swap: A reaches its tile', ra.x === 6 && ra.y === 5);
  check('swap: B reaches its tile', rb.x === 5 && rb.y === 5);
}

// Scenario 2: a mover displaces an idle creep sitting in its lane.
{
  const mover = new Creep('M', 5, 5);
  const idle = new Creep('I', 6, 5); // no registerMove → idle
  traffic.registerMove(mover, { x: 6, y: 5 }, 1);
  run([mover, idle]);
  check('displace: mover gets the tile', resolved(mover).x === 6 && resolved(mover).y === 5);
  check('displace: idle stepped aside', resolved(idle).x !== 6 || resolved(idle).y !== 5);
  check('displace: no collision', noCollisions([mover, idle]));
}

// Scenario 3: priority — both want the same tile, higher priority wins it.
{
  const lo = new Creep('LO', 5, 5);
  const hi = new Creep('HI', 7, 5);
  traffic.registerMove(lo, { x: 6, y: 5 }, 1);
  traffic.registerMove(hi, { x: 6, y: 5 }, 2);
  run([lo, hi]);
  check('priority: higher wins the contested tile', resolved(hi).x === 6 && resolved(hi).y === 5);
  check('priority: lower does not take it', !(resolved(lo).x === 6 && resolved(lo).y === 5));
  check('priority: no collision', noCollisions([lo, hi]));
}

// Scenario 4: a pinned creep (workingArea range 0) is never pushed off its tile.
{
  const miner = new Creep('MINER', 5, 5);
  traffic.setWorkingArea(miner, { x: 5, y: 5 }, 0); // idle + pinned
  const hauler = new Creep('HAUL', 4, 5);
  traffic.registerMove(hauler, { x: 5, y: 5 }, 2); // wants to path through the miner
  run([miner, hauler]);
  check('pin: miner stays on its tile', resolved(miner).x === 5 && resolved(miner).y === 5);
  check('pin: hauler did not take the miner tile', !(resolved(hauler).x === 5 && resolved(hauler).y === 5));
  check('pin: no collision', noCollisions([miner, hauler]));
}

// Scenario 5: a LONE creep must still be issued its registered move — every
// move is deferred to runTraffic, so an early-return on low count would freeze
// the bootstrap harvester (regression guard).
{
  const solo = new Creep('SOLO', 10, 10);
  traffic.registerMove(solo, { x: 11, y: 10 }, 1);
  run([solo]);
  check('solo: lone creep still moves', resolved(solo).x === 11 && resolved(solo).y === 10);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall traffic checks passed');
process.exit(failures ? 1 : 0);
