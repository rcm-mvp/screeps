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

import type { MeProfile, RateLimitBudget } from 'screeps-web-api-bridge';

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
