/**
 * Type layer: everything response-shaped comes from the bridge package
 * (type-only imports — erased at build, so no Node code reaches the browser).
 * The only types defined here describe the host server's own wire protocol.
 */

export type {
  RateLimitBudget,
  ChannelMessage,
  RoomSnapshot,
  RoomTerrain,
  TerrainTile,
  CpuStats,
  ConsoleMessage,
  ConsoleError,
  RoomObject,
  RoomObjectsResponse,
  Capability,
  ColonyState,
  Directives,
  DirectiveAck,
  MeProfile,
  Branch,
  CodeResponse,
  MarketOrder,
  ServerPreset,
} from 'screeps-web-api-bridge';

import type { Directives, MeProfile, RateLimitBudget } from 'screeps-web-api-bridge';

/** Screeps live-socket state as reported by the host. */
export type GameSocketState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth-failed';

/** GET /api/status response. */
export interface BridgeStatus {
  connected: boolean;
  account: MeProfile | null;
  userId: string | null;
  shard: string | null;
  server: string | null;
  host: string | null;
  socket: GameSocketState;
  budgets: RateLimitBudget[];
  envTokenPresent: boolean;
}

/** POST /api/connect body. */
export interface ConnectForm {
  server?: 'official' | 'ptr' | 'private';
  host?: string;
  token?: string;
  shard?: string;
}

/** Typed error info surfaced by the host (mapped from the bridge's classes). */
export interface ApiErrorInfo {
  kind: 'rate_limit' | 'auth' | 'not_found' | 'server' | 'bridge' | 'state' | 'params' | 'unknown';
  message: string;
  retryAfterSec?: number;
  resetAt?: number;
  rateLimitClass?: string;
  status?: number;
  body?: unknown;
}

/* ------------------------------------------------------------------ */
/* AI Strategist (proxied via /api/strategist/* to the strategist service) */
/* ------------------------------------------------------------------ */

export type DeciderKind = 'rules' | 'ollama';

export type StrategistStatusKind =
  | 'starting'
  | 'idle'
  | 'live'
  | 'dry-run'
  | 'kill-switch'
  | 'awaiting-executor'
  | 'executor-stalled'
  | 'budget-capped'
  | 'error';

export type DecisionOutcome =
  | 'written'
  | 'dry-run'
  | 'no-change'
  | 'blocked'
  | 'budget-capped'
  | 'skipped'
  | 'error';

export interface StrategistDecision {
  id: number;
  ts: number;
  tick: number | null;
  decider: DeciderKind;
  outcome: DecisionOutcome;
  patch: Directives | null;
  rev?: number;
  appliedConfirmed?: boolean;
  blocked?: string[];
  note?: string;
  trigger?: string;
}

/** GET /api/strategist/state response (the strategist's StatusSnapshot). */
export interface StrategistState {
  status: StrategistStatusKind;
  decider: DeciderKind;
  dryRun: boolean;
  killSwitch: boolean;
  connected: boolean;
  tick: number | null;
  heartbeat: number | null;
  budget: { writesThisHour: number; maxPerHour: number };
  ollamaCalls: number;
  currentDirectives: Directives;
  digest: unknown | null;
  steering: { shortTerm: string | null; longTerm: string | null };
  latestWritten: StrategistDecision | null;
  history: StrategistDecision[];
}

/** Frames the host pushes over /bridge-ws. */
export type HostFrame =
  | { type: 'hello'; status: BridgeStatus }
  | { type: 'status'; status: BridgeStatus }
  | { type: 'channel'; channel: string; data: unknown; isError?: boolean }
  | { type: 'socket'; state: GameSocketState }
  | { type: 'budgets'; budgets: RateLimitBudget[] }
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | { type: 'error'; message: string; channel?: string };
