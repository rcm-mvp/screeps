/**
 * Typed configuration resolved from the environment. Every value has a safe
 * default; the only thing you must supply for a live run is a Screeps token
 * (SCREEPS_TOKEN) and — for the LLM decider — an OLLAMA_API_KEY.
 *
 * The defaults are deliberately conservative: rule-based decider, dry-run ON,
 * a tiny write budget. The strategist must degrade to "do nothing" safely.
 */

import { SERVER_PRESETS, type ServerPreset } from 'screeps-web-api-bridge';

export type DeciderKind = 'rules' | 'ollama';

export interface Thresholds {
  /** Min total stored energy (across colonies) before expand/war is allowed. */
  minStoredEnergyForExpand: number;
  /** CPU bucket at/below which the colony is under CPU pressure. */
  bucketFloor: number;
  /** Stored energy at/above which an RCL plateau is treated as a surplus. */
  plateauStorageEnergy: number;
  /** Ceiling the rule decider will bump the `upgrader` quota to on surplus. */
  maxUpgraderQuota: number;
}

export interface OllamaConfig {
  host: string;
  model: string;
  apiKey?: string;
  retries: number;
}

export interface ScreepsConfig {
  server: ServerPreset;
  token?: string;
  shard?: string;
  host?: string;
  username?: string;
  password?: string;
}

export interface StrategistConfig {
  port: number;
  decider: DeciderKind;
  dryRun: boolean;
  killSwitch: boolean;
  maxWritesPerHour: number;
  minEvalIntervalMs: number;
  slowTickMs: number;
  stallEvalThreshold: number;
  historyMax: number;
  /** Candidate rooms the rule decider may pick as expand targets. */
  expandCandidates: string[];
  thresholds: Thresholds;
  ollama: OllamaConfig;
  screeps: ScreepsConfig;
  planner: PlannerSettings;
}

export interface PlannerSettings {
  /** Run the server-side base planner loop (writes RawMemory segment 90). */
  enabled: boolean;
  /** Don't recompute the same flagged room within this window (ms). */
  recomputeCooldownMs: number;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function optional(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function int(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

function list(env: Env, key: string): string[] {
  const v = env[key];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): StrategistConfig {
  const decider = str(env, 'DECIDER', 'rules').toLowerCase() === 'ollama' ? 'ollama' : 'rules';
  const server = (str(env, 'SCREEPS_SERVER', 'official') as ServerPreset) ?? 'official';
  // host/username/password are private-server settings. On official/ptr we pass the
  // preset origin EXPLICITLY so a stray SCREEPS_HOST (e.g. left in from .env.example)
  // can't hijack the connection — the bridge's resolveConfig falls back to
  // process.env.SCREEPS_HOST otherwise, even when we omit it.
  const isPrivate = server === 'private';
  const presetHost = (server === 'ptr' ? SERVER_PRESETS.ptr : SERVER_PRESETS.official).http;

  return {
    port: int(env, 'STRATEGIST_PORT', 4100),
    decider,
    dryRun: bool(env, 'DRY_RUN', true),
    killSwitch: bool(env, 'KILL_SWITCH', false),
    maxWritesPerHour: int(env, 'MAX_WRITES_PER_HOUR', 6),
    minEvalIntervalMs: int(env, 'MIN_EVAL_INTERVAL_MS', 60_000),
    slowTickMs: int(env, 'SLOW_TICK_MS', 300_000),
    stallEvalThreshold: int(env, 'STALL_EVAL_THRESHOLD', 3),
    historyMax: int(env, 'HISTORY_MAX', 200),
    expandCandidates: list(env, 'EXPAND_CANDIDATES'),
    thresholds: {
      minStoredEnergyForExpand: int(env, 'MIN_STORED_ENERGY_FOR_EXPAND', 50_000),
      bucketFloor: int(env, 'BUCKET_FLOOR', 2_000),
      plateauStorageEnergy: int(env, 'PLATEAU_STORAGE_ENERGY', 100_000),
      maxUpgraderQuota: int(env, 'MAX_UPGRADER_QUOTA', 8),
    },
    ollama: {
      host: str(env, 'OLLAMA_HOST', 'https://ollama.com'),
      model: str(env, 'OLLAMA_MODEL', 'kimi-k2.6:cloud'),
      apiKey: optional(env, 'OLLAMA_API_KEY'),
      retries: int(env, 'OLLAMA_RETRIES', 2),
    },
    screeps: {
      server,
      token: optional(env, 'SCREEPS_TOKEN'),
      shard: optional(env, 'SCREEPS_SHARD'),
      host: isPrivate ? optional(env, 'SCREEPS_HOST') : presetHost,
      username: isPrivate ? optional(env, 'SCREEPS_USERNAME') : undefined,
      password: isPrivate ? optional(env, 'SCREEPS_PASSWORD') : undefined,
    },
    planner: {
      enabled: bool(env, 'PLANNER_ENABLED', true),
      recomputeCooldownMs: int(env, 'PLANNER_RECOMPUTE_COOLDOWN_MS', 120_000),
    },
  };
}
