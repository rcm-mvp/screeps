/**
 * Traffic manager — flow-based collision resolution for creep movement.
 *
 * Naive `creep.moveTo` lets creeps deadlock around sources, controllers and
 * spawns (the #1 day-to-day efficiency killer). This resolves every creep's
 * desired next tile into a conflict-free assignment, shoving lower-priority
 * (and idle) creeps out of higher-priority lanes instead of stalling.
 *
 * REIMPLEMENTED — not vendored. The technique (model each tick as a bipartite
 * graph of creeps↔tiles and solve it with a Ford-Fulkerson / DFS augmenting-
 * path search) is from sy-harabi's "Screeps Traffic Manager" and his writeup
 * "Journey to Solving the Traffic Management Problem". That repo ships with no
 * license (all-rights-reserved), so none of its code is copied — this is an
 * independent implementation of the documented approach.
 *   https://github.com/sy-harabi/Screeps-Traffic-Manager
 *   https://sy-harabi.github.io/Journey-to-Solving-the-Traffic-Management-Problem/
 *
 * Usage (all inside the operational layer; the contract/bridge never see it):
 *   installTraffic()                      once per global (idempotent)
 *   registerMove(creep, target, prio)     record intent instead of moving
 *   setWorkingArea(creep, pos, range)     pin a roughly-stationary creep
 *   runTraffic(room, costs?, threshold?)  resolve + issue real moves, loop end
 *
 * `travelTo` (lib/movement) routes through this automatically: it calls
 * `creep.moveTo`, whose internal `.move` is intercepted here to register the
 * intended step rather than execute it. `runTraffic` then issues the real moves.
 */

interface Coord {
  x: number;
  y: number;
}

interface TrafficData {
  /** Desired next tile this tick (from an intercepted move / registerMove). */
  intended?: Coord;
  /** Higher wins contested tiles and displaces lower; idle creeps count as 0. */
  priority: number;
  /** True once the creep registered a move this tick. */
  moveIntent: boolean;
  /** Optional zone a stationary creep is held within when displaced. */
  workArea?: { x: number; y: number; range: number };
  /** Memoised candidate tiles (preference order) for this tick. */
  possible?: Coord[];
  /** Tile the resolver assigned for next tick. */
  assigned?: Coord;
}

interface TrafficCreep extends Creep {
  _traffic?: TrafficData;
}

interface PatchedCreepProto {
  __trafficPatched?: boolean;
  move: (dir: DirectionConstant | Creep) => ScreepsReturnCode;
  _origMove?: (dir: DirectionConstant | Creep) => ScreepsReturnCode;
}

const pack = (x: number, y: number): number => x * 50 + y;

function data(creep: Creep): TrafficData {
  const c = creep as TrafficCreep;
  if (!c._traffic) c._traffic = { priority: 1, moveIntent: false };
  return c._traffic;
}

/** Effective contest weight: idle creeps (no registered move) yield to movers. */
function weight(creep: Creep): number {
  const d = data(creep);
  return d.moveIntent ? d.priority : 0;
}

const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

/** Tile reached by stepping `dir` (1=TOP..8=TOP_LEFT) from (x,y). */
function coordInDir(x: number, y: number, dir: DirectionConstant): Coord {
  return { x: x + DX[dir - 1], y: y + DY[dir - 1] };
}

/** Call the unpatched `Creep.prototype.move` (the real intent). */
function originalMove(creep: Creep, dir: DirectionConstant): ScreepsReturnCode {
  const proto = Creep.prototype as unknown as PatchedCreepProto;
  const orig = proto._origMove;
  return orig ? orig.call(creep, dir) : OK;
}

/**
 * Install the move interceptor once per global. After a global reset the
 * prototype is fresh, so the flag lives on the prototype itself (not the heap).
 */
export function installTraffic(): void {
  if (typeof Creep === 'undefined') return; // smoke harness has no Creep
  const proto = Creep.prototype as unknown as PatchedCreepProto;
  if (proto.__trafficPatched) return;
  proto.__trafficPatched = true;
  proto._origMove = proto.move;
  proto.move = function (this: Creep, dir: DirectionConstant | Creep): ScreepsReturnCode {
    if (typeof dir !== 'number') return originalMove(this, dir as unknown as DirectionConstant); // swap move
    const next = coordInDir(this.pos.x, this.pos.y, dir);
    // Stepping off the edge is a room transition — let it happen immediately.
    if (next.x < 0 || next.x > 49 || next.y < 0 || next.y > 49) return originalMove(this, dir);
    const d = data(this);
    d.intended = next;
    d.moveIntent = true;
    return OK;
  };
}

/** Record a creep's desired next tile without moving it. `target` is a tile or a direction. */
export function registerMove(creep: Creep, target: RoomPosition | Coord | DirectionConstant, priority = 1): void {
  const d = data(creep);
  d.priority = priority;
  d.moveIntent = true;
  d.intended = typeof target === 'number' ? coordInDir(creep.pos.x, creep.pos.y, target) : { x: target.x, y: target.y };
}

/** Set the movement priority for a creep that will move via `creep.moveTo` this tick. */
export function setMovePriority(creep: Creep, priority: number): void {
  data(creep).priority = priority;
}

/** Hold a roughly-stationary creep within `range` of `pos` when it gets displaced. */
export function setWorkingArea(creep: Creep, pos: RoomPosition | Coord, range: number): void {
  data(creep).workArea = { x: pos.x, y: pos.y, range };
}

/** Per-tick obstacle bitmap (blocking structures + my obstacle construction sites). */
function obstacles(room: Room): Uint8Array {
  const r = room as Room & { _trafficObstacles?: Uint8Array };
  if (r._trafficObstacles) return r._trafficObstacles;
  const blocked = new Uint8Array(2500);
  for (const s of room.find(FIND_STRUCTURES)) {
    if (
      (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(s.structureType) ||
      (s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my && !(s as StructureRampart).isPublic)
    ) {
      blocked[pack(s.pos.x, s.pos.y)] = 1;
    }
  }
  for (const cs of room.find(FIND_MY_CONSTRUCTION_SITES)) {
    if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(cs.structureType)) blocked[pack(cs.pos.x, cs.pos.y)] = 1;
  }
  r._trafficObstacles = blocked;
  return blocked;
}

interface Ctx {
  map: Map<number, Creep>;
  visited: Set<number>;
  terrain: RoomTerrain;
  obstacles: Uint8Array;
  costs?: CostMatrix;
  threshold: number;
}

/** Walkable for staying/intended tiles (allows edge tiles, ignores cost). */
function passable(x: number, y: number, ctx: Ctx): boolean {
  if (x < 0 || x > 49 || y < 0 || y > 49) return false;
  if (ctx.terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
  return ctx.obstacles[pack(x, y)] === 0;
}

/** Acceptable as a *displacement* alternative: avoids edges + costly tiles + work zone. */
function acceptableAlt(x: number, y: number, d: TrafficData, ctx: Ctx): boolean {
  if (x < 1 || x > 48 || y < 1 || y > 48) return false; // don't shove creeps onto exits
  if (!passable(x, y, ctx)) return false;
  if (ctx.costs && ctx.costs.get(x, y) >= ctx.threshold) return false;
  if (d.workArea && Math.max(Math.abs(x - d.workArea.x), Math.abs(y - d.workArea.y)) > d.workArea.range) return false;
  return true;
}

/** Deterministic per-tick shuffle so displacement doesn't always pick the same side. */
function shuffled(creep: Creep): number[] {
  const order = [0, 1, 2, 3, 4, 5, 6, 7];
  let seed = Game.time;
  for (let i = 0; i < creep.name.length; i++) seed = (seed * 31 + creep.name.charCodeAt(i)) | 0;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

/**
 * Candidate tiles for a creep, in preference order, memoised for the tick.
 *   - mover: [intended, ...adjacent alternatives, stay] — alternatives let
 *     head-on creeps swap/sidestep instead of deadlocking.
 *   - idle:  [stay, ...adjacent alternatives] — holds its tile unless a
 *     stronger creep claims it, then steps aside (within any working area).
 */
function candidates(creep: Creep, ctx: Ctx): Coord[] {
  const d = data(creep);
  if (d.possible) return d.possible;
  const here: Coord = { x: creep.pos.x, y: creep.pos.y };

  // Immovable this tick: only its own tile.
  if (creep.spawning || creep.fatigue > 0) return (d.possible = [here]);

  const mover = d.moveIntent && !!d.intended;
  const out: Coord[] = [];
  if (mover && passable(d.intended!.x, d.intended!.y, ctx)) out.push(d.intended!);
  if (!mover) out.push(here); // idle creeps prefer to stay put
  for (const dir of shuffled(creep)) {
    const x = here.x + DX[dir];
    const y = here.y + DY[dir];
    if (d.intended && d.intended.x === x && d.intended.y === y) continue;
    if (acceptableAlt(x, y, d, ctx)) out.push({ x, y });
  }
  if (mover) out.push(here); // a blocked mover stays as a last resort
  return (d.possible = out);
}

/** Augmenting-path search: place `creep` on a tile, displacing weaker occupants. */
function assign(creep: Creep, ctx: Ctx): boolean {
  for (const coord of candidates(creep, ctx)) {
    const key = pack(coord.x, coord.y);
    if (ctx.visited.has(key)) continue;
    ctx.visited.add(key);
    const occ = ctx.map.get(key);
    if (!occ || occ === creep) {
      ctx.map.set(key, creep);
      data(creep).assigned = coord;
      return true;
    }
    // Only relocate an occupant we outrank (or equal — the visited set bounds recursion).
    if (weight(occ) <= weight(creep) && assign(occ, ctx)) {
      ctx.map.set(key, creep);
      data(creep).assigned = coord;
      return true;
    }
  }
  return false;
}

/**
 * Resolve all registered moves in `room` and issue the real `creep.move`s.
 * Call once per room at the END of the loop, after every role has registered.
 * Optional `costs`/`threshold`: tiles at/above `threshold` won't receive
 * displaced creeps (e.g. to keep them off source/controller approach tiles).
 */
export function runTraffic(room: Room, costs?: CostMatrix, threshold = 255): void {
  const creeps = room.find(FIND_MY_CREEPS);
  // Every move is deferred here (travelTo's moveTo only *registers* intent), so
  // even a lone creep must be issued its move — don't early-return on count.
  if (creeps.length === 0) return;

  const ctx: Ctx = {
    map: new Map<number, Creep>(),
    visited: new Set<number>(),
    terrain: room.getTerrain(),
    obstacles: obstacles(room),
    costs,
    threshold,
  };

  // Pre-seed every creep that isn't actively moving (idle, or immovable due to
  // fatigue/spawning) onto its current tile, so a mover matched first knows the
  // tile is occupied. Such a creep is only relocated when a stronger mover's
  // augmenting path runs through it (and only within its working area).
  const movers: Creep[] = [];
  for (const creep of creeps) {
    const d = data(creep);
    if (d.moveIntent && !creep.spawning && creep.fatigue === 0) {
      movers.push(creep);
      continue;
    }
    const here: Coord = { x: creep.pos.x, y: creep.pos.y };
    ctx.map.set(pack(here.x, here.y), creep);
    d.assigned = here;
  }

  // Match movers highest-priority first so they claim contested tiles before
  // weaker ones, and can displace lower-priority occupants.
  movers.sort((a, b) => weight(b) - weight(a));
  for (const creep of movers) {
    if (data(creep).assigned) continue;
    ctx.visited.clear();
    assign(creep, ctx);
  }

  for (const creep of creeps) {
    const a = data(creep).assigned;
    if (!a || (a.x === creep.pos.x && a.y === creep.pos.y)) continue;
    const dir = creep.pos.getDirectionTo(a.x, a.y);
    if (dir) originalMove(creep, dir);
  }
}
