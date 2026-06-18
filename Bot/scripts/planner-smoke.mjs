// Base-planner unit smoke: bundles src/lib/planner/index.ts standalone and
// exercises the pure pipeline pieces (distance transform, anchor, stamp,
// min-cut) plus the RCL/cap-gated placement helper against tiny mocks. The
// empty-world smoke can't reach this code (construction needs an owned room),
// so the planner's algorithms are checked here. Usage: node scripts/planner-smoke.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- minimal Screeps constant sandbox (must exist before the bundle loads) ---
globalThis.TERRAIN_MASK_WALL = 1;
const STRUCT = {
  SPAWN: 'spawn',
  EXTENSION: 'extension',
  TOWER: 'tower',
  CONTAINER: 'container',
  STORAGE: 'storage',
  LINK: 'link',
  TERMINAL: 'terminal',
  LAB: 'lab',
  FACTORY: 'factory',
  POWER_SPAWN: 'powerSpawn',
  NUKER: 'nuker',
  OBSERVER: 'observer',
  ROAD: 'road',
  RAMPART: 'rampart',
};
for (const [k, v] of Object.entries(STRUCT)) globalThis[`STRUCTURE_${k}`] = v;

// Expand a sparse {level:count} schedule to all RCL 0–8 (carry the last value).
function expand(sparse) {
  const o = {};
  let last = 0;
  for (let l = 0; l <= 8; l++) {
    if (sparse[l] !== undefined) last = sparse[l];
    o[l] = last;
  }
  return o;
}
globalThis.CONTROLLER_STRUCTURES = {
  spawn: expand({ 0: 0, 1: 1, 7: 2, 8: 3 }),
  extension: expand({ 0: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 }),
  tower: expand({ 0: 0, 3: 1, 5: 2, 7: 3, 8: 6 }),
  link: expand({ 0: 0, 5: 2, 6: 3, 7: 4, 8: 6 }),
  storage: expand({ 0: 0, 4: 1 }),
  terminal: expand({ 0: 0, 6: 1 }),
  lab: expand({ 0: 0, 6: 3, 7: 6, 8: 10 }),
  factory: expand({ 0: 0, 7: 1 }),
  powerSpawn: expand({ 0: 0, 8: 1 }),
  nuker: expand({ 0: 0, 8: 1 }),
  observer: expand({ 0: 0, 8: 1 }),
  container: expand({ 0: 5 }),
  road: expand({ 0: 2500 }),
  rampart: expand({ 0: 0, 2: 2500 }),
  constructedWall: expand({ 0: 0, 2: 2500 }),
};
globalThis.Game = { time: 1 };

// --- bundle the planner to CJS and load it ---
const dir = mkdtempSync(join(tmpdir(), 'planner-'));
const out = join(dir, 'planner.cjs');
await build({ entryPoints: ['src/lib/planner/index.ts'], outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error' });
const require = createRequire(import.meta.url);
const P = require(out);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

const openTerrain = { get: () => 0 };
const idx = P.idx;

// === 1. Distance transform ==================================================
{
  const dt = P.distanceTransform(openTerrain);
  check('dt: edge tile is 0', dt[idx(0, 0)] === 0 && dt[idx(49, 25)] === 0);
  check('dt: tile next to edge is 1', dt[idx(1, 1)] === 1 && dt[idx(1, 25)] === 1);
  check('dt: grows inward (2,2)=2', dt[idx(2, 2)] === 2);
  check('dt: open-room centre is 24', dt[idx(24, 24)] === 24);

  // A single interior wall pulls nearby distances down to it.
  const wallTerrain = { get: (x, y) => (x === 25 && y === 25 ? 1 : 0) };
  const dt2 = P.distanceTransform(wallTerrain);
  check('dt: wall tile is 0', dt2[idx(25, 25)] === 0);
  check('dt: tile diagonal to wall is 1', dt2[idx(24, 24)] === 1);
}

// === 2. Anchor selection honours constraints ================================
{
  const openness = P.distanceTransform(openTerrain);
  const keyPositions = [
    { x: 10, y: 10 },
    { x: 40, y: 40 },
  ];
  const ok = P.selectAnchor({ openness, terrain: openTerrain, keyPositions, reachable: () => true }, { minClearance: 5 });
  const lo = P.STAMP_RADIUS + 1;
  const hi = 48 - P.STAMP_RADIUS;
  check('anchor: returns a tile in an open room', !!ok);
  check('anchor: respects footprint bounds', ok && ok.x >= lo && ok.x <= hi && ok.y >= lo && ok.y <= hi);
  check('anchor: meets the clearance/exit margin', ok && openness[idx(ok.x, ok.y)] >= 5);

  const tooTight = P.selectAnchor({ openness, terrain: openTerrain, keyPositions, reachable: () => true }, { minClearance: 40 });
  check('anchor: rejects when no tile has the clearance', tooTight === null);

  const unreachable = P.selectAnchor({ openness, terrain: openTerrain, keyPositions, reachable: () => false }, { minClearance: 5 });
  check('anchor: rejects when key positions are unreachable', unreachable === null);
}

// === 3. Stamp stays within per-RCL structure limits ========================
{
  const structures = P.bunkerStructures(25, 25);
  let withinLimits = true;
  let detail = '';
  for (let rcl = 1; rcl <= 8; rcl++) {
    const counts = {};
    for (const s of structures) if (s.rcl <= rcl) counts[s.type] = (counts[s.type] ?? 0) + 1;
    for (const type of Object.keys(counts)) {
      const limit = CONTROLLER_STRUCTURES[type]?.[rcl] ?? 0;
      if (counts[type] > limit) {
        withinLimits = false;
        detail = `${type} ${counts[type]}>${limit} @rcl${rcl}`;
      }
    }
  }
  check(`stamp: within per-RCL limits at every RCL${detail ? ` (${detail})` : ''}`, withinLimits);
  check('stamp: anchor tile is the first spawn', structures[0].type === STRUCTURE_SPAWN && structures[0].x === 25 && structures[0].y === 25);
  // Every structure on the anchor's parity → its orthogonal gaps stay walkable.
  check('stamp: all structures on one checkerboard parity', structures.every((s) => ((s.x + s.y) & 1) === 0));
}

// === 4. Min-cut actually seals the interior =================================
{
  const rect = { x1: 20, y1: 20, x2: 30, y2: 30 };
  const ramparts = P.minCutRamparts(openTerrain, rect);
  check('mincut: produced a non-empty cut in an open room', ramparts.length > 0);

  // BFS from inside the rect over passable tiles; ramparts and walls block.
  const blocked = new Set(ramparts.map((r) => r.x * 50 + r.y));
  const passable = (x, y) => x >= 1 && x <= 48 && y >= 1 && y <= 48 && openTerrain.get(x, y) !== 1 && !blocked.has(x * 50 + y);
  const seen = new Set();
  const queue = [[25, 25]];
  seen.add(25 * 50 + 25);
  let escaped = false;
  const N = [-1, 0, 1];
  while (queue.length) {
    const [x, y] = queue.pop();
    if (x === 1 || x === 48 || y === 1 || y === 48) {
      escaped = true; // reached the frame → one step from an exit
      break;
    }
    for (const dx of N) for (const dy of N) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      const key = nx * 50 + ny;
      if (passable(nx, ny) && !seen.has(key)) {
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
  }
  check('mincut: interior cannot reach an exit except through a rampart', !escaped);
}

// === 5. Incremental placement respects RCL + caps ===========================
{
  const structures = P.bunkerStructures(25, 25);
  const plan = {
    v: 1,
    at: 0,
    anchor: { x: 25, y: 25 },
    structures,
    ramparts: [{ x: 18, y: 25 }],
    roads: [{ x: 24, y: 25 }],
  };
  const ctx = (over = {}) => ({
    rcl: 2,
    has: () => false,
    countOf: () => 0,
    limitOf: (t, r) => CONTROLLER_STRUCTURES[t]?.[r] ?? 0,
    budget: 5,
    ...over,
  });

  const atRcl1 = P.nextSites(plan, ctx({ rcl: 1 }));
  check('place: RCL1 yields only the single spawn', atRcl1.length === 1 && atRcl1[0].type === STRUCTURE_SPAWN);

  const atRcl2 = P.nextSites(plan, ctx({ rcl: 2 }));
  check('place: per-tick budget (5) is respected', atRcl2.length === 5);
  check('place: spawn is placed before extensions', atRcl2[0].type === STRUCTURE_SPAWN);
  check('place: nothing above the current RCL is queued', atRcl2.every((s) => s.type === STRUCTURE_SPAWN || s.type === STRUCTURE_EXTENSION));

  const zeroBudget = P.nextSites(plan, ctx({ budget: 0 }));
  check('place: a spent site cap (0) places nothing', zeroBudget.length === 0);

  // Extensions already at the RCL cap → none queued, even with budget to spare.
  const capped = P.nextSites(plan, ctx({ rcl: 2, countOf: (t) => (t === STRUCTURE_EXTENSION ? 5 : 0) }));
  check('place: per-RCL cap blocks over-placement', capped.every((s) => s.type !== STRUCTURE_EXTENSION));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall planner checks passed');
process.exit(failures ? 1 : 0);
