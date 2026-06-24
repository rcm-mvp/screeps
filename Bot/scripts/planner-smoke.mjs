// Base-planner unit smoke: bundles src/lib/planner/index.ts standalone and
// exercises the pure pipeline pieces (distance transform, anchor, stamp,
// min-cut) plus the RCL/cap-gated placement helper against tiny mocks. The
// empty-world smoke can't reach this code (construction needs an owned room),
// so the planner's algorithms are checked here. Usage: node scripts/planner-smoke.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- minimal Screeps constant sandbox (must exist before the bundle loads) ---
globalThis.TERRAIN_MASK_WALL = 1;
globalThis.TERRAIN_MASK_SWAMP = 2;
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
  EXTRACTOR: 'extractor',
  CONSTRUCTED_WALL: 'constructedWall',
};
for (const [k, v] of Object.entries(STRUCT)) globalThis[`STRUCTURE_${k}`] = v;

// FIND_* ids the computePlan path touches. PathFinder/RoomPosition stay
// undefined here, so reachability short-circuits true and road planning yields
// [] — computePlan runs against a plain Room mock with no game runtime.
globalThis.FIND_SOURCES = 105;
globalThis.FIND_MINERALS = 117;
globalThis.FIND_MY_SPAWNS = 112;
globalThis.FIND_STRUCTURES = 107;
globalThis.FIND_EXIT_TOP = 1;
globalThis.FIND_EXIT_RIGHT = 3;
globalThis.FIND_EXIT_BOTTOM = 5;
globalThis.FIND_EXIT_LEFT = 7;

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
  extractor: expand({ 0: 0, 6: 1 }),
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

// === 3b. tileFits per-tile validity (SF1) ===================================
{
  const clear = () => false; // nothing blocked
  // A terrain with a single interior wall at (25,25).
  const wallAt2525 = { get: (x, y) => (x === 25 && y === 25 ? 1 : 0) };

  check('tileFits: clear in-bounds tile is valid', P.tileFits(10, 10, openTerrain, clear) === true);
  check('tileFits: a wall tile is invalid', P.tileFits(25, 25, wallAt2525, clear) === false);
  check('tileFits: out-of-bounds (edge margin) is invalid', P.tileFits(1, 10, openTerrain, clear) === false && P.tileFits(48, 10, openTerrain, clear) === false);
  check('tileFits: a blocked tile is invalid', P.tileFits(10, 10, openTerrain, (x, y) => x === 10 && y === 10) === false);

  // stampFits must be unchanged: all-or-nothing over the full footprint.
  check('stampFits: an all-open region fits', P.stampFits(25, 25, openTerrain, clear) === true);
  // A wall inside the footprint rejects the whole anchor. The anchor tile is the
  // first structure, so a wall there is the simplest in-footprint failure.
  const wallAtAnchor = { get: (x, y) => (x === 25 && y === 25 ? 1 : 0) };
  check('stampFits: a wall inside the footprint rejects the anchor', P.stampFits(25, 25, wallAtAnchor, clear) === false);
  // A blocked tile inside the footprint also rejects the whole anchor.
  check('stampFits: a blocked tile inside the footprint rejects the anchor', P.stampFits(25, 25, openTerrain, (x, y) => x === 25 && y === 25) === false);
  // An anchor too close to the edge fails the bounds check.
  check('stampFits: an anchor too close to the edge is rejected', P.stampFits(3, 3, openTerrain, clear) === false);
}

// === 3c. bunkerFragments partition the shopping list (SF1) ==================
{
  const fragments = P.bunkerFragments();
  const stamp = P.bunkerStructures(25, 25); // same shopping list, expanded

  // Tiers present, with the documented coupling/splittability flags.
  const byTier = Object.fromEntries(fragments.map((f) => [f.tier, f]));
  check('fragments: exactly the three tiers labs/core/extensions', fragments.length === 3 && !!byTier.labs && !!byTier.core && !!byTier.extensions);
  check('fragments: labs not splittable, tight maxSpread (<=2)', byTier.labs.splittable === false && byTier.labs.maxSpread <= 2);
  check('fragments: core not splittable, modest maxSpread', byTier.core.splittable === false && byTier.core.maxSpread > 0);
  check('fragments: extensions splittable, larger maxSpread than core', byTier.extensions.splittable === true && byTier.extensions.maxSpread > byTier.core.maxSpread);

  // Correct tier assignment: labs→labs, extension→extensions, the rest→core.
  check('fragments: labs tier holds only labs', byTier.labs.specs.every((s) => s.type === STRUCTURE_LAB));
  check('fragments: extensions tier holds only extensions', byTier.extensions.specs.every((s) => s.type === STRUCTURE_EXTENSION));
  check('fragments: core tier holds no labs or extensions', byTier.core.specs.every((s) => s.type !== STRUCTURE_LAB && s.type !== STRUCTURE_EXTENSION));

  // Per-type counts over all fragments must match the shopping list exactly —
  // every spec appears in exactly one fragment, no duplicates or omissions.
  const countByType = (specs) => specs.reduce((m, s) => ((m[s.type] = (m[s.type] ?? 0) + 1), m), {});
  const stampCounts = countByType(stamp);
  const fragCounts = countByType(fragments.flatMap((f) => f.specs));
  const allTypes = new Set([...Object.keys(stampCounts), ...Object.keys(fragCounts)]);
  let countsMatch = true;
  let detail = '';
  for (const t of allTypes) {
    if ((stampCounts[t] ?? 0) !== (fragCounts[t] ?? 0)) {
      countsMatch = false;
      detail = `${t}: stamp ${stampCounts[t] ?? 0} != frag ${fragCounts[t] ?? 0}`;
    }
  }
  check(`fragments: per-type counts match the shopping list exactly${detail ? ` (${detail})` : ''}`, countsMatch);

  const totalFragSpecs = fragments.reduce((n, f) => n + f.specs.length, 0);
  check('fragments: total spec count equals STAMP_STRUCTURE_COUNT (no dup/omit)', totalFragSpecs === P.STAMP_STRUCTURE_COUNT && totalFragSpecs === stamp.length);
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

// === 6. Role-tagged links (energy network, item A1) =========================
{
  // A plain Room mock over open terrain. Sources and the controller sit well
  // clear of the bunker footprint so each keeps open neighbours for a container
  // + a link. PathFinder/RoomPosition are undefined → reachability is true and
  // roads come back empty, so computePlan exercises only the stamp + link logic.
  const sources = [
    { pos: { x: 5, y: 5 } },
    { pos: { x: 44, y: 44 } },
  ];
  const controller = { pos: { x: 5, y: 44 } };
  const room = {
    name: 'W1N1',
    getTerrain: () => openTerrain,
    controller,
    find: (type) => {
      if (type === FIND_SOURCES) return sources;
      if (type === FIND_MINERALS) return [];
      if (type === FIND_MY_SPAWNS) return [];
      return []; // exits + anything else
    },
  };

  const plan = P.computePlan(room);
  check('links: computePlan produced a plan', !!plan);

  const links = plan ? plan.structures.filter((s) => s.type === STRUCTURE_LINK) : [];
  const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  const controllerLinks = links.filter((s) => s.role === 'controller');
  check(
    'links: exactly one controller link, adjacent to the controller',
    controllerLinks.length === 1 && cheb(controllerLinks[0], controller.pos) === 1,
  );

  const sourceLinks = links.filter((s) => s.role === 'source');
  check(
    'links: one source link adjacent to each source',
    sourceLinks.length === sources.length && sources.every((src) => sourceLinks.some((l) => cheb(l, src.pos) === 1)),
  );

  const coreLinks = links.filter((s) => s.role === 'core');
  check('links: exactly one core link', coreLinks.length === 1);

  // Role-tagged links must lead the LINK entries so the per-RCL cap builds them
  // first: [core, controller, source(s), …surplus untagged bunker links].
  check('links: core link is the first LINK entry', links.length > 0 && links[0].role === 'core');
  check('links: controller link is the second LINK entry', links.length > 1 && links[1].role === 'controller');
  check(
    'links: untagged surplus links come after the tagged ones',
    (() => {
      const firstUntagged = links.findIndex((s) => !s.role);
      if (firstUntagged === -1) return true; // no surplus is fine
      return links.slice(0, firstUntagged).every((s) => s.role); // everything before it is tagged
    })(),
  );

  // The per-RCL cap + ordering (not the rcl tag) decides which links build first.
  const ctx = (over = {}) => ({
    rcl: 5,
    has: () => false,
    countOf: () => 0,
    limitOf: (t, r) => CONTROLLER_STRUCTURES[t]?.[r] ?? 0,
    budget: 50,
    ...over,
  });
  const onlyLinks = (sites) => sites.filter((s) => s.type === STRUCTURE_LINK);

  const rcl5 = onlyLinks(P.nextSites(plan, ctx({ rcl: 5 })));
  check('links: RCL5 yields exactly 2 link sites (the cap)', rcl5.length === 2);
  const tagAt = (site) => {
    const m = links.find((l) => l.x === site.x && l.y === site.y);
    return m ? m.role : undefined;
  };
  const rcl5Roles = rcl5.map(tagAt);
  check(
    'links: RCL5 link sites are the core + controller links',
    rcl5Roles.includes('core') && rcl5Roles.includes('controller'),
  );

  const rcl6 = onlyLinks(P.nextSites(plan, ctx({ rcl: 6 })));
  check('links: RCL6 yields exactly 3 link sites (the cap)', rcl6.length === 3);
  check(
    'links: RCL6 adds a source link on top of core + controller',
    rcl6.map(tagAt).filter((r) => r === 'source').length === 1,
  );

  // Encode/decode round-trips the role tags (4th packed element, 3-tuple safe).
  const decoded = P.decodePlan(P.encodePlan(plan));
  const decodedLinks = decoded.structures.filter((s) => s.type === STRUCTURE_LINK);
  check(
    'links: encode/decode preserves link roles',
    decodedLinks.length === links.length && decodedLinks.every((s, i) => s.role === links[i].role),
  );
  check(
    'links: non-link structures decode with no role',
    decoded.structures.filter((s) => s.type !== STRUCTURE_LINK).every((s) => s.role === undefined),
  );
}

// === 7. Mineral extractor + container (item A2.1) ===========================
{
  // A Room mock with a mineral well clear of the bunker footprint. One source +
  // the controller sit clear of both the footprint and the mineral so each keeps
  // open neighbours. PathFinder/RoomPosition undefined → reachability true, roads
  // empty; computePlan exercises the mineral block.
  const mineral = { pos: { x: 44, y: 5 } };
  const sources = [{ pos: { x: 5, y: 5 } }];
  const controller = { pos: { x: 5, y: 44 } };
  const room = {
    name: 'W1N1',
    getTerrain: () => openTerrain,
    controller,
    find: (type) => {
      if (type === FIND_MINERALS) return [mineral];
      if (type === FIND_SOURCES) return sources;
      if (type === FIND_MY_SPAWNS) return [];
      return []; // exits + anything else
    },
  };

  const plan = P.computePlan(room);
  check('mineral: computePlan produced a plan', !!plan);

  const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  const extractors = plan ? plan.structures.filter((s) => s.type === STRUCTURE_EXTRACTOR) : [];
  check(
    'mineral: exactly one extractor, on the mineral tile, role+rcl correct',
    extractors.length === 1 &&
      extractors[0].x === mineral.pos.x &&
      extractors[0].y === mineral.pos.y &&
      extractors[0].role === 'extractor' &&
      extractors[0].rcl === 6,
  );

  const minContainers = plan ? plan.structures.filter((s) => s.type === STRUCTURE_CONTAINER && s.role === 'mineral') : [];
  check(
    'mineral: exactly one mineral container, adjacent to the mineral, rcl 6',
    minContainers.length === 1 && cheb(minContainers[0], mineral.pos) === 1 && minContainers[0].rcl === 6,
  );

  // RCL gating: the extractor unlocks at RCL6 (cap 1), so RCL5 places none. The
  // extractor sits low in TYPE_PRIORITY (after lab), so the budget must be large
  // enough to reach its tier past the full RCL6 stamp (40 extensions, etc.).
  const ctx = (over = {}) => ({
    rcl: 6,
    has: () => false,
    countOf: () => 0,
    limitOf: (t, r) => CONTROLLER_STRUCTURES[t]?.[r] ?? 0,
    budget: 1000,
    ...over,
  });
  const onlyExtractors = (sites) => sites.filter((s) => s.type === STRUCTURE_EXTRACTOR);
  check('mineral: RCL5 yields no extractor site', onlyExtractors(P.nextSites(plan, ctx({ rcl: 5 }))).length === 0);
  check('mineral: RCL6 yields exactly one extractor site', onlyExtractors(P.nextSites(plan, ctx({ rcl: 6 }))).length === 1);

  // Encode/decode round-trips the extractor + mineral-container role tags.
  const d = P.decodePlan(P.encodePlan(plan));
  const dExtractor = d.structures.filter((s) => s.type === STRUCTURE_EXTRACTOR);
  const dMinContainer = d.structures.filter((s) => s.type === STRUCTURE_CONTAINER && s.role === 'mineral');
  check('mineral: encode/decode preserves the extractor role', dExtractor.length === 1 && dExtractor[0].role === 'extractor');
  check('mineral: encode/decode preserves the mineral container role', dMinContainer.length === 1 && dMinContainer[0].role === 'mineral');
}

// === 8. Adaptive fitter on the REAL W52S13 fixture (SF2 + SF3) ==============
{
  const here = fileURLToPath(new URL('.', import.meta.url));
  const fxDir = join(here, '..', 'test', 'fixtures');
  const terrainFx = JSON.parse(readFileSync(join(fxDir, 'w52s13.terrain.json'), 'utf8'));
  const objFx = JSON.parse(readFileSync(join(fxDir, 'w52s13.objects.json'), 'utf8'));

  // TerrainLike from the grid: wall→TERRAIN_MASK_WALL, swamp→2, plain→0.
  const grid = terrainFx.grid; // grid[y][x]
  const terrain = {
    get: (x, y) => {
      if (x < 0 || x > 49 || y < 0 || y > 49) return TERRAIN_MASK_WALL;
      const t = grid[y][x];
      return t === 'wall' ? TERRAIN_MASK_WALL : t === 'swamp' ? 2 : 0;
    },
  };
  const openness = P.distanceTransform(terrain);

  // Map the fixture's structure type strings to BuildableStructureConstant. The
  // fixture includes constructedWall/road/container/spawn/storage/tower/extension.
  const TYPE_MAP = {
    spawn: STRUCTURE_SPAWN,
    extension: STRUCTURE_EXTENSION,
    tower: STRUCTURE_TOWER,
    container: STRUCTURE_CONTAINER,
    storage: STRUCTURE_STORAGE,
    link: STRUCTURE_LINK,
    terminal: STRUCTURE_TERMINAL,
    lab: STRUCTURE_LAB,
    factory: STRUCTURE_FACTORY,
    powerSpawn: STRUCTURE_POWER_SPAWN,
    nuker: STRUCTURE_NUKER,
    observer: STRUCTURE_OBSERVER,
    road: STRUCTURE_ROAD,
    rampart: STRUCTURE_RAMPART,
    constructedWall: STRUCTURE_CONSTRUCTED_WALL,
    extractor: STRUCTURE_EXTRACTOR,
  };
  const existing = objFx.structures.map((s) => ({ x: s.x, y: s.y, type: TYPE_MAP[s.type] ?? s.type }));
  const storage = objFx.structures.find((s) => s.type === 'storage');

  const input = {
    terrain,
    openness,
    spawn: objFx.spawns[0] ?? null,
    existing,
    sources: objFx.sources.map((s) => ({ x: s.x, y: s.y })),
    controller: objFx.controller ? { x: objFx.controller.x, y: objFx.controller.y } : null,
    mineral: objFx.mineral ? { x: objFx.mineral.x, y: objFx.mineral.y } : null,
    storagePos: storage ? { x: storage.x, y: storage.y } : null,
  };

  const res = P.fitStructures(input);
  check('fit/W52S13: produced a result', !!res);

  if (res) {
    const { anchor, structures } = res;
    const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

    // --- Invariant: anchor is the existing spawn, in bounds. ---
    check(
      'fit/W52S13: anchor is the existing spawn',
      anchor.x === objFx.spawns[0].x && anchor.y === objFx.spawns[0].y,
    );
    check('fit/W52S13: anchor in bounds 2..47', anchor.x >= 2 && anchor.x <= 47 && anchor.y >= 2 && anchor.y <= 47);

    // --- Invariant: no two output structures share a tile. ---
    const tiles = new Set();
    let dup = false;
    for (const s of structures) {
      const k = s.x * 50 + s.y;
      if (tiles.has(k)) dup = true;
      tiles.add(k);
    }
    check('fit/W52S13: no two structures share a tile', !dup);

    // --- Invariant: no NEWLY-placed structure on a natural wall tile. ---
    // (Existing structures are kept as-is even if their terrain reads as wall.)
    const existingKeys = new Set(existing.map((s) => s.x * 50 + s.y));
    const newlyPlaced = structures.filter((s) => !existingKeys.has(s.x * 50 + s.y));
    check(
      'fit/W52S13: no newly-placed structure on a wall',
      newlyPlaced.every((s) => terrain.get(s.x, s.y) !== TERRAIN_MASK_WALL),
    );

    // --- Invariant: no NEWLY-placed structure on a blocked (key ± adjacency) tile. ---
    const blocked = new Set();
    const addRing = (p) => {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) blocked.add((p.x + dx) * 50 + (p.y + dy));
    };
    for (const s of input.sources) addRing(s);
    if (input.controller) addRing(input.controller);
    if (input.mineral) addRing(input.mineral);
    check(
      'fit/W52S13: no newly-placed structure on a key/blocked tile',
      newlyPlaced.every((s) => !blocked.has(s.x * 50 + s.y)),
    );

    // --- Invariant: every newly-placed structure is in bounds 2..47. ---
    check(
      'fit/W52S13: all newly-placed structures in bounds',
      newlyPlaced.every((s) => s.x >= 2 && s.x <= 47 && s.y >= 2 && s.y <= 47),
    );

    // --- Invariant: every existing EMITTABLE structure appears in the output
    // unchanged. Roads/ramparts/constructed-walls aren't emitted into
    // plan.structures (they'd break encodePlan / belong in plan.roads|ramparts),
    // but they MUST stay occupied — checked separately below. ---
    const EMITTABLE = new Set([
      STRUCTURE_SPAWN, STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_TOWER,
      STRUCTURE_LINK, STRUCTURE_POWER_SPAWN, STRUCTURE_FACTORY, STRUCTURE_NUKER,
      STRUCTURE_OBSERVER, STRUCTURE_LAB, STRUCTURE_EXTENSION, STRUCTURE_CONTAINER,
      STRUCTURE_EXTRACTOR,
    ]);
    const outByTile = new Map(structures.map((s) => [s.x * 50 + s.y, s]));
    check(
      'fit/W52S13: every existing EMITTABLE structure preserved (position + type)',
      existing.filter((e) => EMITTABLE.has(e.type)).every((e) => {
        const m = outByTile.get(e.x * 50 + e.y);
        return m && m.type === e.type;
      }),
    );
    // --- Invariant: NON-emittable existing tiles (roads/walls) are NOT in
    // plan.structures, AND no newly-placed structure was built on ANY existing
    // tile (occupancy respected for roads/walls too, not just emitted types). ---
    check(
      'fit/W52S13: roads/constructed-walls excluded from plan.structures',
      existing.filter((e) => !EMITTABLE.has(e.type)).every((e) => !outByTile.has(e.x * 50 + e.y)),
    );
    check(
      'fit/W52S13: no newly-placed structure overlaps an existing tile (roads/walls occupied)',
      newlyPlaced.every((s) => !existingKeys.has(s.x * 50 + s.y)),
    );

    // --- Invariant: WALKABILITY. A packed base can trap creeps; floodfill
    // (8-directional, like Screeps movement) over non-wall, non-obstacle tiles
    // from the anchor must still reach a tile adjacent to every source,
    // controller and mineral — otherwise the colony can't service them. ---
    {
      const WALKABLE_STRUCT = new Set([STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_RAMPART]);
      const obstacle = new Set();
      for (const s of structures) if (!WALKABLE_STRUCT.has(s.type)) obstacle.add(s.x * 50 + s.y);
      // Existing constructed walls block movement too (not emitted into structures).
      for (const e of existing) if (e.type === STRUCTURE_CONSTRUCTED_WALL) obstacle.add(e.x * 50 + e.y);
      const passable = (x, y) =>
        x >= 0 && x <= 49 && y >= 0 && y <= 49 &&
        terrain.get(x, y) !== TERRAIN_MASK_WALL && !obstacle.has(x * 50 + y);
      // Seed from a passable tile next to the anchor (the anchor itself holds a spawn).
      const seeds = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (passable(anchor.x + dx, anchor.y + dy)) seeds.push([anchor.x + dx, anchor.y + dy]);
      }
      const seen = new Set();
      const stack = [...seeds.map(([x, y]) => x * 50 + y)];
      for (const s of stack) seen.add(s);
      while (stack.length) {
        const k = stack.pop();
        const x = Math.floor(k / 50), y = k % 50;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy, nk = nx * 50 + ny;
          if (!seen.has(nk) && passable(nx, ny)) { seen.add(nk); stack.push(nk); }
        }
      }
      const reachableAdj = (p) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (seen.has((p.x + dx) * 50 + (p.y + dy))) return true;
        }
        return false;
      };
      const keys = [...input.sources, ...(input.controller ? [input.controller] : []), ...(input.mineral ? [input.mineral] : [])];
      check(
        'fit/W52S13: walkable — every source/controller/mineral reachable through the placed base',
        keys.every(reachableAdj),
      );
    }

    // --- Invariant: per-type output count never exceeds the bunker target. ---
    // Targets = bunkerStructures' per-type counts. Existing non-bunker types
    // (road/container/constructedWall) have no target → not capped.
    const stamp = P.bunkerStructures(25, 25);
    const target = {};
    for (const s of stamp) target[s.type] = (target[s.type] ?? 0) + 1;
    const outCount = {};
    for (const s of structures) outCount[s.type] = (outCount[s.type] ?? 0) + 1;
    let overCap = '';
    for (const t of Object.keys(target)) {
      if ((outCount[t] ?? 0) > target[t]) overCap = `${t}: ${outCount[t]} > ${target[t]}`;
    }
    check(`fit/W52S13: per-type output within bunker target${overCap ? ` (${overCap})` : ''}`, !overCap);

    // --- Invariant: non-splittable fragments (labs, core) stay clustered. ---
    // Their NEW placements must fit in a bounding box <= (2*maxSpread+1) per side.
    const fragments = P.bunkerFragments();
    const byTier = Object.fromEntries(fragments.map((f) => [f.tier, f]));
    const newByTier = (typesInTier) => newlyPlaced.filter((s) => typesInTier.has(s.type));
    const labTypes = new Set([STRUCTURE_LAB]);
    const coreTypes = new Set(byTier.core.specs.map((s) => s.type));
    const bbox = (arr) => {
      if (!arr.length) return { w: 0, h: 0 };
      let x1 = 50, x2 = -1, y1 = 50, y2 = -1;
      for (const s of arr) {
        if (s.x < x1) x1 = s.x;
        if (s.x > x2) x2 = s.x;
        if (s.y < y1) y1 = s.y;
        if (s.y > y2) y2 = s.y;
      }
      return { w: x2 - x1 + 1, h: y2 - y1 + 1 };
    };
    const labBox = bbox(newByTier(labTypes));
    const coreBox = bbox(newByTier(coreTypes));
    const labMax = 2 * byTier.labs.maxSpread + 1;
    const coreMax = 2 * byTier.core.maxSpread + 1;
    check(
      `fit/W52S13: new labs clustered within ${labMax}x${labMax} (got ${labBox.w}x${labBox.h})`,
      labBox.w <= labMax && labBox.h <= labMax,
    );
    check(
      `fit/W52S13: new core clustered within ${coreMax}x${coreMax} (got ${coreBox.w}x${coreBox.h})`,
      coreBox.w <= coreMax && coreBox.h <= coreMax,
    );

    // --- Invariant: determinism (run twice, deep-equal output). ---
    const res2 = P.fitStructures(input);
    check('fit/W52S13: deterministic (identical output on re-run)', JSON.stringify(res) === JSON.stringify(res2));

    // --- Diagnostic summary (printed, not asserted) ---
    const existCount = {};
    for (const s of existing) existCount[s.type] = (existCount[s.type] ?? 0) + 1;
    const placedCount = {};
    for (const s of newlyPlaced) placedCount[s.type] = (placedCount[s.type] ?? 0) + 1;
    const fmt = (t) =>
      `${t}: existing ${existCount[t] ?? 0} + placed ${placedCount[t] ?? 0} = ${(existCount[t] ?? 0) + (placedCount[t] ?? 0)}/${target[t] ?? '-'}`;
    console.log('  --- W52S13 placement summary ---');
    console.log(`  anchor (${anchor.x},${anchor.y}); total structures ${structures.length} (existing ${existing.length}, placed ${newlyPlaced.length})`);
    for (const t of Object.keys(target)) console.log('  ' + fmt(t));
    console.log(`  labs new bbox ${labBox.w}x${labBox.h}; core new bbox ${coreBox.w}x${coreBox.h}`);

    // Report which targets couldn't be fully placed (cramped-room reality).
    const short = Object.keys(target).filter((t) => (outCount[t] ?? 0) < target[t]);
    if (short.length) console.log('  under target: ' + short.map((t) => `${t} ${outCount[t] ?? 0}/${target[t]}`).join(', '));
  }
}

// === 9. Adaptive fitter — synthetic link tagging (SF2) ======================
{
  // A tiny open room: a link adjacent to the controller, a link near a fake
  // storage, and a link adjacent to a source — assert role tagging.
  const terrain = { get: () => 0 };
  const openness = P.distanceTransform(terrain);
  const controller = { x: 40, y: 40 };
  const source = { x: 10, y: 10 };
  const storage = { x: 25, y: 25 };

  const existing = [
    { x: 24, y: 25, type: STRUCTURE_SPAWN }, // anchor seed via spawn
    { x: storage.x, y: storage.y, type: STRUCTURE_STORAGE },
    { x: 26, y: 25, type: STRUCTURE_LINK }, // adjacent to storage (range 1) → core
    { x: 39, y: 40, type: STRUCTURE_LINK }, // adjacent to controller → controller
    { x: 11, y: 10, type: STRUCTURE_LINK }, // adjacent to source → source
  ];

  const res = P.fitStructures({
    terrain,
    openness,
    spawn: { x: 24, y: 25 },
    existing,
    sources: [source],
    controller,
    mineral: null,
    storagePos: storage,
  });
  check('fit/synth: produced a result', !!res);

  const linkAt = (x, y) => res.structures.find((s) => s.type === STRUCTURE_LINK && s.x === x && s.y === y);
  check('fit/synth: controller-adjacent link tagged role:controller', linkAt(39, 40)?.role === 'controller');
  check('fit/synth: source-adjacent link tagged role:source', linkAt(11, 10)?.role === 'source');
  check('fit/synth: storage-nearest link tagged role:core', linkAt(26, 25)?.role === 'core');

  // No-links graceful path: same room without any existing links still fits.
  const res2 = P.fitStructures({
    terrain,
    openness,
    spawn: { x: 24, y: 25 },
    existing: [{ x: 24, y: 25, type: STRUCTURE_SPAWN }],
    sources: [source],
    controller,
    mineral: null,
    storagePos: null,
  });
  check('fit/synth: no-links case still produces a result', !!res2);
  check(
    'fit/synth: no-links case places fresh (untagged) links toward the target',
    res2 && res2.structures.filter((s) => s.type === STRUCTURE_LINK).length === 6,
  );
}

// === 10. computePlan end-to-end fallback on the real closed room (SF6) ======
// The stamp can't anchor in W52S13, so computePlan must fall back to the fitter
// and still emit a complete, ENCODABLE plan (links, extractor, ramparts) built
// around the legacy base. This is the full integration, not just fitStructures.
{
  const here = fileURLToPath(new URL('.', import.meta.url));
  const fxDir = join(here, '..', 'test', 'fixtures');
  const terrainFx = JSON.parse(readFileSync(join(fxDir, 'w52s13.terrain.json'), 'utf8'));
  const objFx = JSON.parse(readFileSync(join(fxDir, 'w52s13.objects.json'), 'utf8'));
  const grid = terrainFx.grid;
  const openTerrainGet = (x, y) => {
    if (x < 0 || x > 49 || y < 0 || y > 49) return TERRAIN_MASK_WALL;
    const t = grid[y][x];
    return t === 'wall' ? TERRAIN_MASK_WALL : t === 'swamp' ? 2 : 0;
  };
  const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  const sources = objFx.sources.map((s) => ({ pos: { x: s.x, y: s.y } }));
  const controller = objFx.controller ? { pos: { x: objFx.controller.x, y: objFx.controller.y } } : undefined;
  const mineral = objFx.mineral ? { pos: { x: objFx.mineral.x, y: objFx.mineral.y }, mineralType: objFx.mineral.mineralType } : undefined;
  const spawnObj = { pos: { x: objFx.spawns[0].x, y: objFx.spawns[0].y } };
  const storageObj = objFx.structures.find((s) => s.type === 'storage');
  const findStructures = objFx.structures.map((s) => ({ pos: { x: s.x, y: s.y }, structureType: s.type }));
  const room = {
    name: 'W52S13',
    getTerrain: () => ({ get: openTerrainGet }),
    controller,
    storage: storageObj ? { pos: { x: storageObj.x, y: storageObj.y } } : undefined,
    find: (type) => {
      if (type === FIND_SOURCES) return sources;
      if (type === FIND_MINERALS) return mineral ? [mineral] : [];
      if (type === FIND_MY_SPAWNS) return [spawnObj];
      if (type === FIND_STRUCTURES) return findStructures;
      return [];
    },
  };

  const plan = P.computePlan(room);
  check('e2e/W52S13: computePlan falls back to the fitter and produces a plan', !!plan);

  if (plan) {
    check('e2e/W52S13: anchor is the existing spawn', plan.anchor.x === spawnObj.pos.x && plan.anchor.y === spawnObj.pos.y);

    // No two plan structures share a tile (incl. derived containers/links/extractor).
    const seen = new Set();
    let dup = false;
    for (const s of plan.structures) { const k = s.x * 50 + s.y; if (seen.has(k)) dup = true; seen.add(k); }
    check('e2e/W52S13: no two plan structures share a tile', !dup);

    // No plan structure on a natural wall tile — EXCEPT the extractor, which by
    // design sits on the mineral, whose terrain reads as wall (Screeps quirk).
    check(
      'e2e/W52S13: no plan structure on a wall (extractor on the mineral excepted)',
      plan.structures.every((s) => s.type === STRUCTURE_EXTRACTOR || openTerrainGet(s.x, s.y) !== TERRAIN_MASK_WALL),
    );

    // Energy network: a controller link adjacent to the controller, a core link,
    // and at least one source link — all derived even with no legacy links.
    const links = plan.structures.filter((s) => s.type === STRUCTURE_LINK);
    check('e2e/W52S13: a controller link adjacent to the controller', links.some((l) => l.role === 'controller' && controller && cheb(l, controller.pos) === 1));
    check('e2e/W52S13: a core link exists', links.some((l) => l.role === 'core'));
    check('e2e/W52S13: at least one source link placed', links.some((l) => l.role === 'source'));
    // Every source must be serviceable — a container OR a link adjacent. In a
    // cramped room a source boxed in by walls (only one open neighbour) gets a
    // container but no link; that's acceptable (its energy is hauled).
    check(
      'e2e/W52S13: every source serviceable (container or link adjacent)',
      sources.every((src) => plan.structures.some((s) => (s.type === STRUCTURE_CONTAINER || s.type === STRUCTURE_LINK) && cheb(s, src.pos) === 1)),
    );

    // Extractor sits on the mineral tile.
    check('e2e/W52S13: extractor on the mineral tile', plan.structures.some((s) => s.type === STRUCTURE_EXTRACTOR && s.x === objFx.mineral.x && s.y === objFx.mineral.y));

    // Min-cut produced a rampart ring around the cluster.
    check('e2e/W52S13: ramparts seal the base cluster (non-empty)', plan.ramparts.length > 0);

    // CRITICAL: the plan must round-trip through encode/decode unchanged. Any
    // non-encodable type (a road or constructedWall leaking into structures)
    // would become a -1 index → undefined type on decode, failing this.
    const decoded = P.decodePlan(P.encodePlan(plan));
    check(
      'e2e/W52S13: encode/decode round-trips structures (no unencodable types leaked in)',
      decoded.structures.length === plan.structures.length &&
        decoded.structures.every((s, i) => s.type === plan.structures[i].type && !!s.type) &&
        decoded.ramparts.length === plan.ramparts.length,
    );
  }
}

// === 11. PURE buildPlan on the W52S13 fixture, NO Screeps runtime (SV1+SV2) ==
// Proves the shared planner CORE runs under Node from a plain BuildPlanInput —
// no Room/Game/PathFinder/RoomPosition mock anywhere — and that the pure roads
// pathfinder (SV2) now yields a connected road network. Same structural
// invariants as the e2e section above, plus roads-now-non-empty + connectivity.
{
  const here = fileURLToPath(new URL('.', import.meta.url));
  const fxDir = join(here, '..', 'test', 'fixtures');
  const terrainFx = JSON.parse(readFileSync(join(fxDir, 'w52s13.terrain.json'), 'utf8'));
  const objFx = JSON.parse(readFileSync(join(fxDir, 'w52s13.objects.json'), 'utf8'));
  const grid = terrainFx.grid; // grid[y][x]
  // Pure TerrainLike (wall→TERRAIN_MASK_WALL, swamp→TERRAIN_MASK_SWAMP, plain→0).
  const terrain = {
    get: (x, y) => {
      if (x < 0 || x > 49 || y < 0 || y > 49) return TERRAIN_MASK_WALL;
      const t = grid[y][x];
      return t === 'wall' ? TERRAIN_MASK_WALL : t === 'swamp' ? TERRAIN_MASK_SWAMP : 0;
    },
  };
  const TYPE_MAP = {
    spawn: STRUCTURE_SPAWN, extension: STRUCTURE_EXTENSION, tower: STRUCTURE_TOWER,
    container: STRUCTURE_CONTAINER, storage: STRUCTURE_STORAGE, link: STRUCTURE_LINK,
    terminal: STRUCTURE_TERMINAL, lab: STRUCTURE_LAB, factory: STRUCTURE_FACTORY,
    powerSpawn: STRUCTURE_POWER_SPAWN, nuker: STRUCTURE_NUKER, observer: STRUCTURE_OBSERVER,
    road: STRUCTURE_ROAD, rampart: STRUCTURE_RAMPART, constructedWall: STRUCTURE_CONSTRUCTED_WALL,
    extractor: STRUCTURE_EXTRACTOR,
  };
  const storage = objFx.structures.find((s) => s.type === 'storage');
  // BuildPlanInput — a PLAIN object, exactly what the Strategist will assemble
  // from the API bridge. Ramparts excluded from `existing` (occupancy ≠ rampart).
  const input = {
    terrain,
    sources: objFx.sources.map((s) => ({ x: s.x, y: s.y })),
    controller: objFx.controller ? { x: objFx.controller.x, y: objFx.controller.y } : null,
    mineral: objFx.mineral ? { x: objFx.mineral.x, y: objFx.mineral.y, mineralType: objFx.mineral.mineralType } : null,
    spawn: objFx.spawns[0] ? { x: objFx.spawns[0].x, y: objFx.spawns[0].y } : null,
    existing: objFx.structures
      .filter((s) => s.type !== 'rampart')
      .map((s) => ({ x: s.x, y: s.y, type: TYPE_MAP[s.type] ?? s.type })),
    storagePos: storage ? { x: storage.x, y: storage.y } : null,
  };

  const plan = P.buildPlan(input);
  check('pure/W52S13: buildPlan returns a plan with no Screeps runtime', !!plan);

  if (plan) {
    const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const spawn = objFx.spawns[0];

    // --- anchor is the existing spawn, in bounds ---
    check('pure/W52S13: anchor is the existing spawn', plan.anchor.x === spawn.x && plan.anchor.y === spawn.y);
    check('pure/W52S13: anchor in bounds 2..47', plan.anchor.x >= 2 && plan.anchor.x <= 47 && plan.anchor.y >= 2 && plan.anchor.y <= 47);

    // --- no two structures share a tile ---
    const seen = new Set();
    let dup = false;
    for (const s of plan.structures) { const k = s.x * 50 + s.y; if (seen.has(k)) dup = true; seen.add(k); }
    check('pure/W52S13: no two plan structures share a tile', !dup);

    // --- no structure on a wall (extractor on the mineral excepted) ---
    check(
      'pure/W52S13: no structure on a wall (extractor excepted)',
      plan.structures.every((s) => s.type === STRUCTURE_EXTRACTOR || terrain.get(s.x, s.y) !== TERRAIN_MASK_WALL),
    );

    // --- energy network: controller/core/source links ---
    const links = plan.structures.filter((s) => s.type === STRUCTURE_LINK);
    check('pure/W52S13: controller link adjacent to the controller', links.some((l) => l.role === 'controller' && input.controller && cheb(l, input.controller) === 1));
    check('pure/W52S13: a core link exists', links.some((l) => l.role === 'core'));
    check('pure/W52S13: at least one source link placed', links.some((l) => l.role === 'source'));

    // --- extractor on the mineral tile ---
    check('pure/W52S13: extractor on the mineral tile', plan.structures.some((s) => s.type === STRUCTURE_EXTRACTOR && s.x === objFx.mineral.x && s.y === objFx.mineral.y));

    // --- min-cut ramparts non-empty ---
    check('pure/W52S13: ramparts seal the cluster (non-empty)', plan.ramparts.length > 0);

    // --- SV2: roads now COMPUTED (non-empty) and CONNECT the cluster ---
    check('pure/W52S13: roads are non-empty (pure pathfinder ran)', plan.roads.length > 0);

    // Road network connectivity: the union {anchor} ∪ roads is one 8-connected
    // blob, and a road tile (or the anchor) sits within Chebyshev 1 of every
    // source / controller / mineral — i.e. the lanes actually reach the targets.
    {
      const roadSet = new Set(plan.roads.map((r) => r.x * 50 + r.y));
      const anchorKey = plan.anchor.x * 50 + plan.anchor.y;
      const nodes = new Set(roadSet);
      nodes.add(anchorKey);
      // Flood from the anchor over the road network (8-directional adjacency).
      const seenR = new Set([anchorKey]);
      const stack = [anchorKey];
      while (stack.length) {
        const k = stack.pop();
        const x = Math.floor(k / 50), y = k % 50;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nk = (x + dx) * 50 + (y + dy);
          if (nodes.has(nk) && !seenR.has(nk)) { seenR.add(nk); stack.push(nk); }
        }
      }
      check('pure/W52S13: road network is fully connected to the anchor', seenR.size === nodes.size);

      const reachesByRoad = (p) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nk = (p.x + dx) * 50 + (p.y + dy);
          if (seenR.has(nk)) return true; // a connected road (or anchor) is adjacent
        }
        return false;
      };
      // A hauler services a source/controller/mineral by standing on a road next to
      // its PICKUP (the derived container/link), not next to the raw resource tile —
      // in a cramped room the resource's only open neighbour IS its container, so the
      // road necessarily ends one tile further out. Assert the pickup is road-served.
      const pickupFor = (p) => {
        let best = null, bestD = Infinity;
        for (const s of plan.structures) {
          if (s.type !== STRUCTURE_CONTAINER && s.type !== STRUCTURE_LINK) continue;
          const d = cheb(s, p);
          if (d <= 1 && d < bestD) { bestD = d; best = { x: s.x, y: s.y }; }
        }
        return best ?? p;
      };
      const keys = [...input.sources, ...(input.controller ? [input.controller] : []), ...(input.mineral ? [input.mineral] : [])];
      check('pure/W52S13: a connected road reaches every source/controller/mineral pickup', keys.map(pickupFor).every(reachesByRoad));
    }

    // --- determinism: identical plan on re-run ---
    const plan2 = P.buildPlan(input);
    check('pure/W52S13: deterministic (identical plan on re-run)', JSON.stringify(plan) === JSON.stringify(plan2));

    // --- SV3: stamp-only mode defers a too-closed room (no fitter fallback) ---
    // W52S13 is too closed for the rigid stamp, so the bot's cheap stamp-only
    // attempt (allowFitter:false) must return null — that's the signal that the
    // room is deferred to the server-side planner. With the fitter on it plans.
    check('pure/W52S13: buildPlan({allowFitter:false}) returns null (stamp deferral)', P.buildPlan({ ...input, allowFitter: false }) === null);
    check('pure/W52S13: buildPlan({allowFitter:true}) still plans (server/grace path)', !!P.buildPlan({ ...input, allowFitter: true }));

    // --- encode/decode round-trips structures, ramparts AND roads ---
    const decoded = P.decodePlan(P.encodePlan(plan));
    check(
      'pure/W52S13: encode/decode round-trips structures/ramparts/roads',
      decoded.structures.length === plan.structures.length &&
        decoded.structures.every((s, i) => s.type === plan.structures[i].type && !!s.type && s.role === plan.structures[i].role) &&
        decoded.ramparts.length === plan.ramparts.length &&
        decoded.roads.length === plan.roads.length &&
        decoded.roads.every((r, i) => r.x === plan.roads[i].x && r.y === plan.roads[i].y),
    );

    // --- parity with the Room adapter: computePlan must delegate to buildPlan ---
    // The same fixture through the Room mock yields an EQUIVALENT plan (structures
    // /ramparts/roads identical; only v/at differ, which the adapter stamps).
    {
      const room = {
        name: 'W52S13',
        getTerrain: () => terrain,
        controller: objFx.controller ? { pos: { x: objFx.controller.x, y: objFx.controller.y } } : undefined,
        storage: storage ? { pos: { x: storage.x, y: storage.y } } : undefined,
        find: (type) => {
          if (type === FIND_SOURCES) return objFx.sources.map((s) => ({ pos: { x: s.x, y: s.y } }));
          if (type === FIND_MINERALS) return objFx.mineral ? [{ pos: { x: objFx.mineral.x, y: objFx.mineral.y } }] : [];
          if (type === FIND_MY_SPAWNS) return [{ pos: { x: spawn.x, y: spawn.y } }];
          if (type === FIND_STRUCTURES) return objFx.structures.map((s) => ({ pos: { x: s.x, y: s.y }, structureType: TYPE_MAP[s.type] ?? s.type }));
          return [];
        },
      };
      const viaRoom = P.computePlan(room);
      const strip = (p) => ({ anchor: p.anchor, structures: p.structures, ramparts: p.ramparts, roads: p.roads });
      check(
        'pure/W52S13: computePlan(room) delegates to buildPlan (equivalent plan)',
        !!viaRoom && JSON.stringify(strip(viaRoom)) === JSON.stringify(strip(plan)),
      );
    }
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall planner checks passed');
process.exit(failures ? 1 : 0);
