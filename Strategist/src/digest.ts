/**
 * Two derived views of colony state:
 *
 *  - `buildDigest(snapshot)` — a compact, human/LLM-readable summary fed into the
 *    Ollama prompt (small prompts are cheaper and sharper than raw Memory).
 *  - `digestHash(state)` — a stable fingerprint of the *materially relevant* fields,
 *    with noisy values (tick, exact CPU, spawn energy, controller progress) excluded
 *    or coarsely bucketed. Used to decide whether anything changed enough to warrant
 *    a new decision — and, for the LLM decider, whether to spend an Ollama call at all.
 */

import type { ColonyState, Directives } from 'screeps-web-api-bridge';
import type { CommanderSnapshot } from 'screeps-web-api-bridge';

/** Bucket steps for the change-detection hash (coarse on purpose). */
const STORAGE_BUCKET = 10_000;
const CPU_BUCKET_BUCKET = 1_000;

export interface ColonyDigest {
  room: string;
  rcl: number;
  energyAvailable: number;
  energyCapacity: number;
  storageEnergy: number;
  creeps: number;
  constructionSites: number;
  hostiles: number;
  safeMode: boolean;
}

export interface Digest {
  tick: number;
  cpu: { used: number; limit: number; bucket: number };
  gcl: { level: number; progress: number; progressTotal: number };
  credits: number;
  ownedRooms: number;
  storageTotal: number;
  hostilesTotal: number;
  creeps: { total: number; byRole: Record<string, number> };
  colonies: ColonyDigest[];
  lastError: string | null;
  directives: Directives;
}

function bucket(n: number, step: number): number {
  return Math.round((n ?? 0) / step);
}

/** Sum of all colonies' stored energy. */
export function totalStorageEnergy(state: ColonyState): number {
  return Object.values(state.colonies).reduce((sum, c) => sum + (c.storageEnergy ?? 0), 0);
}

/** Total hostiles seen across owned rooms. */
export function totalHostiles(state: ColonyState): number {
  return Object.values(state.colonies).reduce((sum, c) => sum + (c.threats?.hostiles ?? 0), 0);
}

/** A colony has an *active* threat when hostiles are present and safe mode is off. */
export function hasActiveHomeThreat(state: ColonyState): boolean {
  return Object.values(state.colonies).some(
    (c) => (c.threats?.hostiles ?? 0) > 0 && !c.threats?.safeMode,
  );
}

export function buildDigest(snap: CommanderSnapshot): Digest {
  const state = snap.state;
  if (!state) {
    return {
      tick: 0,
      cpu: { used: 0, limit: 0, bucket: 0 },
      gcl: { level: 0, progress: 0, progressTotal: 0 },
      credits: 0,
      ownedRooms: 0,
      storageTotal: 0,
      hostilesTotal: 0,
      creeps: { total: 0, byRole: {} },
      colonies: [],
      lastError: null,
      directives: snap.directives ?? {},
    };
  }

  const colonies: ColonyDigest[] = Object.entries(state.colonies).map(([room, c]) => ({
    room,
    rcl: c.rcl,
    energyAvailable: c.energyAvailable,
    energyCapacity: c.energyCapacity,
    storageEnergy: c.storageEnergy ?? 0,
    creeps: Object.values(c.creeps ?? {}).reduce((a, b) => a + (b ?? 0), 0),
    constructionSites: c.constructionSites,
    hostiles: c.threats?.hostiles ?? 0,
    safeMode: c.threats?.safeMode ?? false,
  }));

  return {
    tick: state.tick,
    cpu: state.cpu,
    gcl: state.gcl,
    credits: state.credits,
    ownedRooms: colonies.length,
    storageTotal: totalStorageEnergy(state),
    hostilesTotal: totalHostiles(state),
    creeps: state.creeps,
    colonies,
    lastError: state.lastError?.message ?? null,
    directives: snap.directives ?? {},
  };
}

/**
 * Stable fingerprint of material state. Excludes tick, exact CPU usage, spawn
 * energy and controller progress (all noisy per-tick); buckets storage and the
 * CPU bucket. Two states with the same hash are "the same situation" for
 * strategic purposes — no new decision (and no LLM call) is warranted.
 */
export function digestHash(state: ColonyState | null): string {
  if (!state) return 'null';
  const colonies = Object.entries(state.colonies)
    .map(([room, c]) => ({
      room,
      rcl: c.rcl,
      hostiles: (c.threats?.hostiles ?? 0) > 0 ? 1 : 0,
      safeMode: c.threats?.safeMode ? 1 : 0,
      creeps: Object.values(c.creeps ?? {}).reduce((a, b) => a + (b ?? 0), 0),
      sites: c.constructionSites,
      storage: bucket(c.storageEnergy ?? 0, STORAGE_BUCKET),
    }))
    .sort((a, b) => a.room.localeCompare(b.room));

  const material = {
    gclLevel: state.gcl.level,
    bucket: bucket(state.cpu.bucket, CPU_BUCKET_BUCKET),
    creeps: state.creeps,
    hostilesTotal: totalHostiles(state) > 0 ? 1 : 0,
    storageTotal: bucket(totalStorageEnergy(state), STORAGE_BUCKET),
    colonies,
  };
  return JSON.stringify(material);
}
