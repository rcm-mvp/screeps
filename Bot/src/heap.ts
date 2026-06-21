/**
 * Heap cache on `global`. The global heap MAY survive ticks but resets
 * unpredictably — everything here must be rebuildable from scratch in one
 * tick, and nothing correctness-critical may live only here.
 */
import { log } from './lib/log';
import type { RoomPlan, PackedPlan } from './lib/planner/types';

export interface LogisticsPickup {
  id: string;
  amount: number;
  resourceType: ResourceConstant;
}

/** Decoded base plan cached on the heap (re-decoded from the segment on reset). */
export interface PlanCacheEntry {
  v: number;
  decoded: RoomPlan;
}

/** Per-room scratch data, valid for exactly one tick. */
export interface RoomHeapEntry {
  tick: number;
  /** Written by the defense manager, read by spawn/state/defender. */
  hostiles: number;
  towers: number;
  /** Written by the logistics manager, consumed by haulers. */
  pickups: LogisticsPickup[];
  fillsCore: string[];
  fillsTower: string[];
  sink: string | null;
  /** Energy already claimed per pickup id by haulers this tick. */
  claimed: Record<string, number>;
  /**
   * Non-energy pickups (mineral container + dropped minerals) — hauled to
   * storage only when no energy pickup is viable; energy always wins.
   */
  mineralPickups: LogisticsPickup[];
  /**
   * Written by the link manager (runs before logistics), read by haulers and
   * upgraders. `controllerLink` is the controller-adjacent receiver link id
   * (regardless of fill); upgraders drain it. `senderLinks` are core/source
   * sender link ids that currently hold energy worth forwarding; haulers top
   * them up as a delivery tier below spawn/extensions/towers.
   */
  controllerLink: string | null;
  senderLinks: string[];
}

export interface Heap {
  bornAt: number;
  rooms: Record<string, RoomHeapEntry>;
  /** Decoded base plans, keyed by room. Rebuilt from the segment after a reset. */
  plans: Record<string, PlanCacheEntry>;
  /** Packed plan map mirroring the RawMemory segment; undefined until loaded. */
  planMap?: Record<string, PackedPlan>;
}

export function ensureHeap(): Heap {
  const g = global as unknown as { __heap?: Heap };
  if (!g.__heap) {
    g.__heap = { bornAt: Game.time, rooms: {}, plans: {} };
    log.info('global reset detected — heap rebuilt');
  }
  return g.__heap;
}

/** Current-tick scratch entry for a room (auto-resets when the tick changes). */
export function roomHeap(name: string): RoomHeapEntry {
  const h = ensureHeap();
  let entry = h.rooms[name];
  if (!entry || entry.tick !== Game.time) {
    entry = {
      tick: Game.time,
      hostiles: 0,
      towers: 0,
      pickups: [],
      fillsCore: [],
      fillsTower: [],
      sink: null,
      claimed: {},
      mineralPickups: [],
      controllerLink: null,
      senderLinks: [],
    };
    h.rooms[name] = entry;
  }
  return entry;
}
