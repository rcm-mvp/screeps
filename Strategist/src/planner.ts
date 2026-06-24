/**
 * Server-side base planner (STAMP.md §12, SV4).
 *
 * The whole point of this module is to move the heavy adaptive base-fit OFF the
 * in-game CPU and onto the box. The in-game bot computes the cheap rigid stamp
 * itself; rooms too closed for it raise `needsPlan` in ColonyState (SV3). This
 * loop watches that flag and, for each flagged room, pulls the room's terrain +
 * objects over the API, runs the SAME pure planner the bot would (vendored from
 * Bot/src/lib/planner/server.ts), and writes the packed plan to RawMemory
 * segment 90 — which the bot then decodes via getCachedPlan and builds from.
 *
 * Safe + idempotent by construction:
 *  - a room with a current-version plan already in segment 90 is skipped;
 *  - a freshly-planned room is debounced for `recomputeCooldownMs` so the steady
 *    stream of state updates (the flag lingers until the bot picks the plan up)
 *    can't trigger repeated recomputes / writes;
 *  - every write re-reads segment 90 first and MERGES (never blind-overwrites),
 *    so the bot's own stamp-plan entries for other rooms are preserved;
 *  - a failed segment READ aborts the write (we never clobber on a bad read);
 *  - honours the kill switch (no writes when the strategist is killed).
 */

import type { ColonyState } from 'screeps-web-api-bridge';
import { planForServer, PLAN_VERSION, type BuildPlanInput, type PackedPlan } from '../vendor/planner';
import type { Logger } from './strategist';

/** RawMemory segment holding the roomName→PackedPlan map (must match the bot's
 *  SETTINGS.PLAN_SEGMENT). */
export const PLAN_SEGMENT = 90;

/** Object `type` strings that occupy a tile for planning purposes — mirrors the
 *  bot's `FIND_STRUCTURES` minus ramparts. Sources/controller/mineral/creeps etc.
 *  are handled separately or ignored. */
const STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  'spawn', 'extension', 'tower', 'container', 'storage', 'link', 'terminal',
  'lab', 'factory', 'powerSpawn', 'nuker', 'observer', 'extractor', 'road',
  'constructedWall',
]);

type TerrainTile = 'plain' | 'wall' | 'swamp';

interface RoomObject {
  type: string;
  x: number;
  y: number;
  [k: string]: unknown;
}

/** The slice of the bridge the planner needs — easy to mock in tests. */
export interface PlannerPort {
  terrain(room: string): Promise<{ grid?: TerrainTile[][] }>;
  objects(room: string): Promise<{ objects: RoomObject[] }>;
  getSegment(segment: number): Promise<{ data: string }>;
  setSegment(segment: number, data: string): Promise<unknown>;
}

export interface PlannerConfig {
  /** Master switch (PLANNER_ENABLED). When false the loop is inert. */
  enabled: boolean;
  /** Don't recompute the same room within this window, even while it stays
   *  flagged (the flag lingers until the bot reads the new plan). */
  recomputeCooldownMs: number;
}

export interface PlannerDeps {
  bridge: PlannerPort;
  config: PlannerConfig;
  logger?: Logger;
  now?: () => number;
  /** True when the strategist kill switch is engaged — suppresses all writes. */
  killSwitch?: () => boolean;
}

const noopLogger: Logger = { info() {}, warn() {}, error() {} };

export class Planner {
  private inFlight = false;
  private lastPlannedAt = new Map<string, number>();

  constructor(private readonly deps: PlannerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(): Logger {
    return this.deps.logger ?? noopLogger;
  }

  /** Feed a fresh ColonyState; plans any newly-flagged rooms. Never overlaps. */
  onState(state: ColonyState): void {
    void this.planFlagged(state);
  }

  /** One pass: plan every flagged room that needs it. Guarded against overlap. */
  async planFlagged(state: ColonyState): Promise<void> {
    if (!this.deps.config.enabled) return;
    if (this.deps.killSwitch?.()) return;
    if (this.inFlight) return;
    const flagged = Object.keys(state.colonies ?? {}).filter(
      (room) => (state.colonies[room] as { needsPlan?: boolean }).needsPlan,
    );
    if (!flagged.length) return;

    this.inFlight = true;
    try {
      // Snapshot the segment once for the cheap skip-check; re-read before each
      // actual write to keep the merge fresh.
      let map: Record<string, PackedPlan>;
      try {
        map = await this.readSegment();
      } catch (e) {
        this.log().warn('planner: segment read failed — skipping this pass', { err: String(e) });
        return;
      }

      for (const room of flagged) {
        if (map[room]?.v === PLAN_VERSION) continue; // already planned (idempotent)
        const last = this.lastPlannedAt.get(room);
        if (last !== undefined && this.now() - last < this.deps.config.recomputeCooldownMs) continue;

        const input = await this.buildInput(room);
        this.lastPlannedAt.set(room, this.now()); // debounce regardless of outcome
        if (!input) continue;

        const packed = planForServer(input, state.tick);
        if (!packed) {
          this.log().warn(`planner: ${room} admits no plan (no anchor even with the fitter)`);
          continue;
        }

        // Re-read + merge right before writing so we never clobber the bot's
        // entries for other rooms written since our snapshot.
        try {
          map = await this.readSegment();
        } catch (e) {
          this.log().warn(`planner: segment re-read failed for ${room} — not writing`, { err: String(e) });
          continue;
        }
        map[room] = packed;
        await this.deps.bridge.setSegment(PLAN_SEGMENT, JSON.stringify(map));
        const ax = Math.floor(packed.a / 50);
        const ay = packed.a % 50;
        this.log().info(
          `planner: wrote ${room} -> segment ${PLAN_SEGMENT} ` +
            `(anchor ${ax},${ay}; ${packed.s.length} structures, ${packed.r.length} ramparts, ${packed.d.length} roads)`,
        );
      }
    } catch (e) {
      this.log().error('planner: pass failed', { err: e instanceof Error ? e.stack : String(e) });
    } finally {
      this.inFlight = false;
    }
  }

  /** Read + parse segment 90. Empty segment → {}; a non-empty but unparseable
   *  segment THROWS (caller aborts the write rather than risk a clobber). */
  private async readSegment(): Promise<Record<string, PackedPlan>> {
    const res = await this.deps.bridge.getSegment(PLAN_SEGMENT);
    const raw = res?.data;
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, PackedPlan>;
    } catch {
      throw new Error(`segment ${PLAN_SEGMENT} is not valid JSON`);
    }
  }

  /** Assemble the pure BuildPlanInput from the room's terrain + objects. Returns
   *  null when the room can't be planned (no terrain grid, or no spawn AND no
   *  controller to anchor/orient around). */
  private async buildInput(room: string): Promise<BuildPlanInput | null> {
    let terrainRes: { grid?: TerrainTile[][] };
    let objRes: { objects: RoomObject[] };
    try {
      [terrainRes, objRes] = await Promise.all([
        this.deps.bridge.terrain(room),
        this.deps.bridge.objects(room),
      ]);
    } catch (e) {
      this.log().warn(`planner: fetch failed for ${room}`, { err: String(e) });
      return null;
    }

    const grid = terrainRes.grid;
    if (!grid) {
      this.log().warn(`planner: no terrain grid for ${room}`);
      return null;
    }
    const terrain = {
      get: (x: number, y: number): number => {
        if (x < 0 || x > 49 || y < 0 || y > 49) return 1; // TERRAIN_MASK_WALL
        const t = grid[y]?.[x];
        return t === 'wall' ? 1 : t === 'swamp' ? 2 : 0;
      },
    };

    const objs = objRes.objects ?? [];
    const pick = (type: string): RoomObject | undefined => objs.find((o) => o.type === type);
    const controllerObj = pick('controller');
    const mineralObj = pick('mineral');
    const spawnObj = pick('spawn');
    const storageObj = pick('storage');

    if (!spawnObj && !controllerObj) {
      this.log().warn(`planner: ${room} has neither spawn nor controller — skipping`);
      return null;
    }

    return {
      terrain,
      sources: objs.filter((o) => o.type === 'source').map((o) => ({ x: o.x, y: o.y })),
      controller: controllerObj ? { x: controllerObj.x, y: controllerObj.y } : null,
      mineral: mineralObj
        ? { x: mineralObj.x, y: mineralObj.y, mineralType: mineralObj.mineralType as string | undefined }
        : null,
      spawn: spawnObj ? { x: spawnObj.x, y: spawnObj.y } : null,
      existing: objs
        .filter((o) => STRUCTURE_TYPES.has(o.type))
        .map((o) => ({ x: o.x, y: o.y, type: o.type })),
      storagePos: storageObj ? { x: storageObj.x, y: storageObj.y } : null,
    };
  }
}
