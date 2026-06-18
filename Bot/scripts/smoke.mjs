// Smoke test: runs the bundled loop in Node against a minimal Game/Memory
// mock (an empty world). Verifies the loop never throws, bootstraps the
// contract block, survives malformed directives, and acks revisions.
//
// Usage: npm run build && node scripts/smoke.mjs
import { createRequire } from 'node:module';

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
  RESOURCE_ENERGY: 'energy',
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

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
