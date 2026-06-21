// Smoke test: runs the bundled loop in Node against a minimal Game/Memory
// mock (an empty world). Verifies the loop never throws, bootstraps the
// contract block, survives malformed directives, and acks revisions.
//
// Usage: npm run build && node scripts/smoke.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- minimal Screeps sandbox mock (only what an empty-world tick touches) ---
const C = {
  OK: 0,
  ERR_NOT_IN_RANGE: -9,
  ERR_NOT_ENOUGH_ENERGY: -6,
  ERR_BUSY: -4,
  ERR_GCL_NOT_ENOUGH: -15,
  TOUGH: 'tough',
  WORK: 'work',
  CARRY: 'carry',
  ATTACK: 'attack',
  RANGED_ATTACK: 'ranged_attack',
  HEAL: 'heal',
  CLAIM: 'claim',
  MOVE: 'move',
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_STORAGE: 'storage',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_WALL: 'constructedWall',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_CONTROLLER: 'controller',
  STRUCTURE_LINK: 'link',
  STRUCTURE_TERMINAL: 'terminal',
  STRUCTURE_LAB: 'lab',
  STRUCTURE_FACTORY: 'factory',
  STRUCTURE_POWER_SPAWN: 'powerSpawn',
  STRUCTURE_NUKER: 'nuker',
  STRUCTURE_OBSERVER: 'observer',
  STRUCTURE_EXTRACTOR: 'extractor',
  RESOURCE_ENERGY: 'energy',
  RESOURCE_HYDROGEN: 'H',
  LINK_CAPACITY: 800,
  FIND_SOURCES: 105,
  FIND_SOURCES_ACTIVE: 104,
  FIND_DROPPED_RESOURCES: 106,
  FIND_STRUCTURES: 107,
  FIND_MY_STRUCTURES: 108,
  FIND_MY_SPAWNS: 112,
  FIND_MY_CREEPS: 101,
  FIND_HOSTILE_CREEPS: 103,
  FIND_MY_CONSTRUCTION_SITES: 114,
  FIND_CONSTRUCTION_SITES: 111,
  FIND_HOSTILE_STRUCTURES: 109,
  FIND_TOMBSTONES: 118,
  FIND_RUINS: 123,
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite',
  TERRAIN_MASK_WALL: 1,
  BODYPART_COST: { move: 50, work: 100, carry: 50, attack: 80, ranged_attack: 150, heal: 250, claim: 600, tough: 10 },
  CONTROLLER_STRUCTURES: { extension: { 1: 0, 2: 5, 3: 10 }, tower: { 1: 0, 2: 0, 3: 1 } },
};
Object.assign(globalThis, C);
globalThis.RoomPosition = class RoomPosition {};
globalThis.Resource = class Resource {};

let cpuUsed = 0;
function freshGame(time, opts = {}) {
  cpuUsed = 0;
  globalThis.Game = {
    time,
    creeps: {},
    rooms: {},
    spawns: {},
    flags: {},
    cpu: { limit: 20, bucket: opts.bucket ?? 9500, getUsed: () => (cpuUsed += 0.05) },
    gcl: { level: 1, progress: 0, progressTotal: 1000 },
    market: { credits: 0 },
    notify: () => 0,
    getObjectById: () => null,
  };
}

const require = createRequire(import.meta.url);
const { loop } = require('../dist/main.js');

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

// Tick 1: fresh world, no Memory at all
globalThis.Memory = {};
freshGame(1000);
loop();
check('tick survives an empty world', true);
check('contract block bootstrapped', typeof Memory.bridge === 'object');
check('state heartbeat written', Memory.bridge.state.heartbeat === 1000);
check('ack initialised to rev 0', Memory.bridge.ack.directiveVersion === 0);

// Tick 2: garbage directives must not crash or leak through
Memory.bridge.directives = {
  paused: 'yes',
  posture: 'zerg-rush',
  targetRooms: ['W1N1', 'not-a-room', 42],
  roleQuotas: { harvester: 9999, hauler: 'three', '': 5 },
  rev: 7,
};
freshGame(1001);
loop();
check('tick survives malformed directives', true);
check('malformed rev still acked', Memory.bridge.ack.directiveVersion === 7);
check('state keeps flowing', Memory.bridge.state.tick === 1001);

// Tick 3: valid directive revision is acked with the applied tick
Memory.bridge.directives = { posture: 'defend', paused: true, rev: 8 };
freshGame(1002);
loop();
check('new rev acked', Memory.bridge.ack.directiveVersion === 8);
check('appliedTick recorded', Memory.bridge.ack.appliedTick === 1002);
check('no lastError on clean ticks', Memory.bridge.state.lastError === null);

// Tick 4: global reset — heap must rebuild without issue
delete globalThis.__heap;
freshGame(1003);
loop();
check('survives global reset', Memory.bridge.state.tick === 1003);

// === Link manager + hauler delivery ladder (energy network, item A1b) =======
// The empty-world loop above never builds a link, so the runtime link logic is
// exercised here against tiny mocks. We bundle the real modules standalone (same
// approach as the planner/traffic smokes) and drive them directly.
{
  // Bundle runLinks + runHauler (and the heap/settings helpers they share) to
  // CJS via a temp re-export entry, so we test the shipping source, not a copy.
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  const entry = join(dir, 'entry.ts');
  const src = join(process.cwd(), 'src'); // absolute → resolvable from the temp dir
  writeFileSync(
    entry,
    [
      `export { runLinks } from '${join(src, 'managers/links')}';`,
      `export { runHauler } from '${join(src, 'roles/hauler')}';`,
      `export { runLogistics } from '${join(src, 'managers/logistics')}';`,
      `export { roomHeap, ensureHeap } from '${join(src, 'heap')}';`,
      `export { SETTINGS } from '${join(src, 'settings')}';`,
    ].join('\n'),
  );
  const out = join(dir, 'entry.cjs');
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error' });
  const L = require(out);

  // A mock link: store with energy, a cooldown, and a transferEnergy that records
  // its target and respects the receiver's free capacity (like the real API).
  let transfers = [];
  class MockLink {
    constructor(id, x, y, energy, cooldown = 0) {
      this.id = id;
      this.structureType = STRUCTURE_LINK;
      this.cooldown = cooldown;
      this.pos = { x, y };
      this._energy = energy;
      this.store = {
        [RESOURCE_ENERGY]: energy,
        getFreeCapacity: () => LINK_CAPACITY - this._energy,
      };
      // Keep store[RESOURCE_ENERGY] in sync with the backing field.
      Object.defineProperty(this.store, RESOURCE_ENERGY, { get: () => this._energy });
    }
    transferEnergy(target) {
      const moved = Math.min(this._energy, LINK_CAPACITY - target._energy);
      transfers.push({ from: this.id, to: target.id, amount: moved });
      this._energy -= moved;
      target._energy += moved;
      return OK;
    }
  }

  // Seed the decoded plan straight onto the heap (getCachedPlan reads it there
  // before ever touching RawMemory), with LINK plan entries tagged by role.
  const PLAN_V = L.SETTINGS.PLAN_VERSION;
  function seedPlan(roomName, planLinks) {
    const heap = L.ensureHeap();
    heap.plans[roomName] = {
      v: PLAN_V,
      decoded: { v: PLAN_V, at: Game.time, anchor: { x: 25, y: 25 }, structures: planLinks, ramparts: [], roads: [] },
    };
  }

  function makeRoom(roomName, builtLinks) {
    return {
      name: roomName,
      find: (type) => (type === FIND_MY_STRUCTURES ? builtLinks : []),
    };
  }

  // --- Scenario A: full core link + empty controller link → forward. ---------
  freshGame(2000);
  globalThis.Memory = {};
  transfers = [];
  {
    const core = new MockLink('core', 24, 25, LINK_CAPACITY); // full sender
    const ctrl = new MockLink('ctrl', 10, 40, 0); // empty receiver
    seedPlan('W1N1', [
      { x: 24, y: 25, type: STRUCTURE_LINK, rcl: 5, role: 'core' },
      { x: 10, y: 40, type: STRUCTURE_LINK, rcl: 5, role: 'controller' },
    ]);
    L.runLinks(makeRoom('W1N1', [core, ctrl]));
    check('links: full core link forwards to the controller link', transfers.some((t) => t.from === 'core' && t.to === 'ctrl' && t.amount > 0));
    const rh = L.roomHeap('W1N1');
    check('links: publishes controllerLink id to the heap', rh.controllerLink === 'ctrl');
    // A FULL sender has no free capacity, so it is NOT advertised for hauler
    // filling (nothing to top up) — it still forwards (asserted above).
    check('links: a full sender is not advertised for hauler filling', !rh.senderLinks.includes('core'));
  }

  // --- Scenario A2 (BUG REGRESSION): an empty/partial sender link MUST be ------
  // advertised in senderLinks so haulers top it up. Publish must filter on FREE
  // CAPACITY (needs filling), not on already-holding >= LINK_MIN_SEND — else an
  // empty sender is never filled, never crosses the threshold, and never
  // forwards, leaving the whole link network inert.
  freshGame(2000);
  globalThis.Memory = {};
  transfers = [];
  {
    const core = new MockLink('core', 24, 25, 0); // empty sender — needs filling
    const ctrl = new MockLink('ctrl', 10, 40, 0);
    seedPlan('W1N1', [
      { x: 24, y: 25, type: STRUCTURE_LINK, rcl: 5, role: 'core' },
      { x: 10, y: 40, type: STRUCTURE_LINK, rcl: 5, role: 'controller' },
    ]);
    L.runLinks(makeRoom('W1N1', [core, ctrl]));
    const rh = L.roomHeap('W1N1');
    check('links: an empty sender IS advertised for hauler filling (network can prime)', rh.senderLinks.includes('core'));
    check('links: an empty sender does not forward (below LINK_MIN_SEND)', transfers.length === 0);
  }

  // --- Scenario B: controller link already full → no transfer. ----------------
  freshGame(2001);
  globalThis.Memory = {};
  transfers = [];
  {
    const core = new MockLink('core', 24, 25, LINK_CAPACITY);
    const ctrl = new MockLink('ctrl', 10, 40, LINK_CAPACITY); // no free capacity
    seedPlan('W1N1', [
      { x: 24, y: 25, type: STRUCTURE_LINK, rcl: 5, role: 'core' },
      { x: 10, y: 40, type: STRUCTURE_LINK, rcl: 5, role: 'controller' },
    ]);
    L.runLinks(makeRoom('W1N1', [core, ctrl]));
    check('links: no transfer when the controller link is full', transfers.length === 0);
  }

  // --- Scenario C: sender on cooldown → no transfer. --------------------------
  freshGame(2002);
  globalThis.Memory = {};
  transfers = [];
  {
    const core = new MockLink('core', 24, 25, LINK_CAPACITY, 5); // cooling down
    const ctrl = new MockLink('ctrl', 10, 40, 0);
    seedPlan('W1N1', [
      { x: 24, y: 25, type: STRUCTURE_LINK, rcl: 5, role: 'core' },
      { x: 10, y: 40, type: STRUCTURE_LINK, rcl: 5, role: 'controller' },
    ]);
    L.runLinks(makeRoom('W1N1', [core, ctrl]));
    check('links: no transfer while the sender is on cooldown', transfers.length === 0);
  }

  // --- Scenario D (REGRESSION GUARD): a hauler with energy and BOTH an open ----
  // spawn and an open sender link must fill the spawn — links never starve
  // spawning (delivery ladder: spawn/extensions → towers → links → storage).
  freshGame(2003);
  globalThis.Memory = {};
  {
    const spawn = {
      id: 'spawn1',
      structureType: STRUCTURE_SPAWN,
      pos: { x: 25, y: 25, findClosestByRange: () => null },
      store: { [RESOURCE_ENERGY]: 0, getFreeCapacity: () => 300 },
    };
    const senderLink = new MockLink('sender1', 24, 25, 0); // open: free capacity 800
    const byId = { spawn1: spawn, sender1: senderLink };
    Game.getObjectById = (id) => byId[id] ?? null;

    let transferTarget = null;
    const creep = {
      name: 'H1',
      memory: { role: 'hauler', home: 'W1N1', working: true },
      store: { [RESOURCE_ENERGY]: 50, getFreeCapacity: () => 0, getUsedCapacity: () => 50 },
      pos: {
        x: 26,
        y: 25,
        roomName: 'W1N1',
        // Closest of the candidate fill structures — only the spawn is offered in
        // the fillsCore tier, so resolveFill never reaches the link tier.
        findClosestByRange: (arr) => (arr && arr.length ? arr[0] : null),
        inRangeTo: () => true,
      },
      room: { name: 'W1N1' },
      transfer: (target) => {
        transferTarget = target;
        return OK; // in range → no travel
      },
    };
    Game.creeps = { H1: creep };

    // Publish the heap classification a runLinks tick would have produced: an
    // open spawn in fillsCore AND an open sender link in senderLinks.
    const rh = L.roomHeap('W1N1');
    rh.fillsCore = ['spawn1'];
    rh.fillsTower = [];
    rh.senderLinks = ['sender1'];
    rh.sink = null;

    L.runHauler(creep, {});
    check('hauler: prefers spawn/extension over an open sender link (spawn never starves)', transferTarget === spawn);
    check('hauler: did not deliver to the sender link', transferTarget !== senderLink);
  }

  // A store mock: resource amounts as own-enumerable props (so Object.keys() sees
  // only resource keys, as in the real game), capacity methods non-enumerable.
  function makeStore(amounts, capacity) {
    const store = { ...amounts };
    const used = (res) =>
      res === undefined ? Object.values(amounts).reduce((a, b) => a + b, 0) : (amounts[res] ?? 0);
    Object.defineProperty(store, 'getUsedCapacity', { enumerable: false, value: used });
    Object.defineProperty(store, 'getFreeCapacity', {
      enumerable: false,
      value: (_res) => (capacity ?? 0) - used(),
    });
    Object.defineProperty(store, 'getCapacity', { enumerable: false, value: () => capacity ?? 0 });
    return store;
  }

  // --- Scenario E (ENERGY REGRESSION — pickup): an empty hauler with BOTH an ----
  // energy container (rh.pickups) and a mineral container (rh.mineralPickups)
  // available MUST pick up energy — energy always wins over minerals.
  freshGame(2004);
  globalThis.Memory = {};
  {
    const energyContainer = {
      id: 'econ',
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 20, y: 20 },
      store: makeStore({ [RESOURCE_ENERGY]: 500 }, 2000),
    };
    const mineralContainer = {
      id: 'mcon',
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 30, y: 30 },
      store: makeStore({ H: 500 }, 2000),
    };
    const byId = { econ: energyContainer, mcon: mineralContainer };
    Game.getObjectById = (id) => byId[id] ?? null;

    let withdrawnFrom = null;
    let withdrawnResource = null;
    const creep = {
      name: 'HE',
      memory: { role: 'hauler', home: 'W1N1', working: false },
      store: makeStore({}, 500),
      pos: {
        x: 25,
        y: 25,
        roomName: 'W1N1',
        findClosestByRange: (arr) => (arr && arr.length ? arr[0] : null),
        inRangeTo: () => true,
      },
      room: { name: 'W1N1' },
      withdraw: (target, resourceType) => {
        withdrawnFrom = target;
        withdrawnResource = resourceType;
        return OK;
      },
      pickup: () => OK,
    };
    Game.creeps = { HE: creep };

    const rh = L.roomHeap('W1N1');
    rh.pickups = [{ id: 'econ', amount: 500, resourceType: RESOURCE_ENERGY }];
    rh.mineralPickups = [{ id: 'mcon', amount: 500, resourceType: 'H' }];
    rh.claimed = {};

    L.runHauler(creep, {});
    check('hauler: energy wins — empty hauler withdraws from the energy container', withdrawnFrom === energyContainer);
    check('hauler: energy wins — withdrew RESOURCE_ENERGY (not the mineral)', withdrawnResource === RESOURCE_ENERGY);
  }

  // --- Scenario F (MINERAL — pickup): an empty hauler with NO energy pickups but -
  // a mineral container available withdraws the mineral ('H') from it.
  freshGame(2005);
  globalThis.Memory = {};
  {
    const mineralContainer = {
      id: 'mcon',
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 30, y: 30 },
      store: makeStore({ H: 500 }, 2000),
    };
    const byId = { mcon: mineralContainer };
    Game.getObjectById = (id) => byId[id] ?? null;

    let withdrawnFrom = null;
    let withdrawnResource = null;
    const creep = {
      name: 'HM',
      memory: { role: 'hauler', home: 'W1N1', working: false },
      store: makeStore({}, 500),
      pos: {
        x: 25,
        y: 25,
        roomName: 'W1N1',
        findClosestByRange: (arr) => (arr && arr.length ? arr[0] : null),
        inRangeTo: () => true,
      },
      room: { name: 'W1N1' },
      withdraw: (target, resourceType) => {
        withdrawnFrom = target;
        withdrawnResource = resourceType;
        return OK;
      },
      pickup: () => OK,
    };
    Game.creeps = { HM: creep };

    const rh = L.roomHeap('W1N1');
    rh.pickups = [];
    rh.mineralPickups = [{ id: 'mcon', amount: 500, resourceType: 'H' }];
    rh.claimed = {};
    rh.sink = 'storage1'; // a sink must exist for a mineral trip to be startable (pickup gate)

    L.runHauler(creep, {});
    check('hauler: with no energy pickup, withdraws from the mineral container', withdrawnFrom === mineralContainer);
    check("hauler: withdrew the mineral ('H')", withdrawnResource === 'H');
  }

  // --- Scenario G (MINERAL — deliver): a hauler carrying ONLY a mineral delivers -
  // it to storage and never targets spawn/extensions/towers/links.
  freshGame(2006);
  globalThis.Memory = {};
  {
    const storage = {
      id: 'storage1',
      structureType: STRUCTURE_STORAGE,
      pos: { x: 25, y: 25 },
      store: makeStore({ [RESOURCE_ENERGY]: 0 }, 1000000),
    };
    const byId = { storage1: storage };
    Game.getObjectById = (id) => byId[id] ?? null;

    let transferTarget = null;
    let transferResource = null;
    const creep = {
      name: 'HMD',
      memory: { role: 'hauler', home: 'W1N1', working: true },
      store: makeStore({ H: 100 }, 100),
      pos: {
        x: 26,
        y: 25,
        roomName: 'W1N1',
        findClosestByRange: (arr) => (arr && arr.length ? arr[0] : null),
        inRangeTo: () => true,
      },
      room: { name: 'W1N1' },
      transfer: (target, resourceType) => {
        transferTarget = target;
        transferResource = resourceType;
        return OK;
      },
    };
    Game.creeps = { HMD: creep };

    const rh = L.roomHeap('W1N1');
    // Populate the energy fill ladder too — a mineral load must ignore all of it.
    rh.fillsCore = ['spawn1'];
    rh.fillsTower = [];
    rh.senderLinks = ['sender1'];
    rh.sink = 'storage1';

    L.runHauler(creep, {});
    check('hauler: mineral load delivers to storage', transferTarget === storage);
    check("hauler: transferred the mineral ('H') to storage", transferResource === 'H');
    check('hauler: mineral load never targets spawn/extensions', transferTarget !== 'spawn1');
  }

  // --- Scenario H (logistics classification): runLogistics splits an energy ------
  // container (→ pickups, resourceType 'energy') from a mineral container
  // (→ mineralPickups, resourceType 'H'); storage is never a mineral source.
  freshGame(2007);
  globalThis.Memory = {};
  {
    const energyContainer = {
      id: 'econ',
      structureType: STRUCTURE_CONTAINER,
      store: makeStore({ [RESOURCE_ENERGY]: 500 }, 2000),
    };
    const mineralContainer = {
      id: 'mcon',
      structureType: STRUCTURE_CONTAINER,
      store: makeStore({ H: 300 }, 2000),
    };
    const storage = {
      id: 'storage1',
      structureType: STRUCTURE_STORAGE,
      store: makeStore({ [RESOURCE_ENERGY]: 0 }, 1000000),
    };
    const room = {
      name: 'W1N1',
      storage,
      find: (type) => {
        if (type === FIND_STRUCTURES) return [energyContainer, mineralContainer, storage];
        if (type === FIND_DROPPED_RESOURCES) return [];
        if (type === FIND_TOMBSTONES) return [];
        if (type === FIND_RUINS) return [];
        if (type === FIND_MY_STRUCTURES) return [];
        return [];
      },
    };

    L.runLogistics(room);
    const rh = L.roomHeap('W1N1');
    const econEntry = rh.pickups.find((p) => p.id === 'econ');
    check('logistics: energy container is in pickups', !!econEntry);
    check("logistics: energy pickup tagged resourceType 'energy'", econEntry && econEntry.resourceType === RESOURCE_ENERGY);
    check('logistics: mineral container is NOT in pickups', !rh.pickups.some((p) => p.id === 'mcon'));
    const mconEntry = rh.mineralPickups.find((p) => p.id === 'mcon');
    check('logistics: mineral container is in mineralPickups', !!mconEntry);
    check("logistics: mineral pickup tagged resourceType 'H'", mconEntry && mconEntry.resourceType === 'H');
    check('logistics: storage is never a mineral source', !rh.mineralPickups.some((p) => p.id === 'storage1'));
  }

  // --- Scenario I (WEDGE FIX — drop): a hauler carrying ONLY a mineral with no ---
  // viable storage sink must DROP its load (freeing itself for energy duty) rather
  // than rally forever and deadlock holding the mineral.
  freshGame(2008);
  globalThis.Memory = {};
  {
    Game.getObjectById = () => null; // no storage object resolvable

    let dropped = null;
    let transferCalled = false;
    let travelCalled = false;
    const creep = {
      name: 'HWED',
      memory: { role: 'hauler', home: 'W1N1', working: true },
      store: makeStore({ H: 100 }, 100),
      pos: {
        x: 26,
        y: 25,
        roomName: 'W1N1',
        findClosestByRange: (arr) => (arr && arr.length ? arr[0] : null),
        inRangeTo: () => true,
      },
      room: { name: 'W1N1' },
      drop: (resourceType) => {
        dropped = resourceType;
        return OK;
      },
      transfer: () => {
        transferCalled = true;
        return OK;
      },
      moveTo: () => {
        travelCalled = true;
        return OK;
      },
    };
    Game.creeps = { HWED: creep };

    const rh = L.roomHeap('W1N1');
    rh.sink = null; // no storage sink → nowhere to put the mineral

    L.runHauler(creep, {});
    check("hauler: wedge fix — drops the mineral ('H') when there is no storage sink", dropped === 'H');
    check('hauler: wedge fix — does NOT transfer/travel (frees itself instead of deadlocking)', !transferCalled && !travelCalled);
  }

  // --- Scenario J (PICKUP GATE): an empty hauler with NO energy pickups and a -----
  // mineral container available but NO sink must NOT withdraw the mineral (it can't
  // store it) — it rallies. Contrast with Scenario F where the sink IS set.
  freshGame(2009);
  globalThis.Memory = {};
  {
    const mineralContainer = {
      id: 'mcon',
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 30, y: 30 },
      store: makeStore({ H: 500 }, 2000),
    };
    const byId = { mcon: mineralContainer };
    Game.getObjectById = (id) => byId[id] ?? null;

    let withdrawCalled = false;
    const creep = {
      name: 'HGATE',
      memory: { role: 'hauler', home: 'W1N1', working: false },
      store: makeStore({}, 500),
      pos: {
        x: 25,
        y: 25,
        roomName: 'W1N1',
        findClosestByRange: (arr) => (arr && arr.length ? arr[0] : null),
        inRangeTo: () => true,
      },
      room: { name: 'W1N1' },
      withdraw: () => {
        withdrawCalled = true;
        return OK;
      },
      pickup: () => OK,
    };
    Game.creeps = { HGATE: creep };

    const rh = L.roomHeap('W1N1');
    rh.pickups = [];
    rh.mineralPickups = [{ id: 'mcon', amount: 500, resourceType: 'H' }];
    rh.claimed = {};
    rh.sink = null; // no sink → mineral pickup is gated off

    L.runHauler(creep, {});
    check('hauler: pickup gate — does NOT withdraw the mineral when there is no sink to store it', !withdrawCalled);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
