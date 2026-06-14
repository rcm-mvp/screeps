/**
 * Screeps Web API Bridge — public entry point.
 *
 * A pure transport + access layer exposing the complete Screeps external Web
 * API (HTTP + WebSocket) behind one typed facade. No game/bot logic.
 */

export { ScreepsBridge } from './bridge';

export type { BridgeConfig, ResolvedConfig, ServerPreset, ServerEndpoints } from './config';
export { resolveConfig, SERVER_PRESETS } from './config';

export {
  BridgeError,
  AuthError,
  RateLimitError,
  NotFoundError,
  ServerError,
} from './errors';

export { ENDPOINTS, RATE_LIMITS } from './endpoints';
export type { EndpointName, RateLimitClass, EndpointDef } from './endpoints';

export { CAPABILITIES } from './manifest';
export type { Capability } from './manifest';

// Shared Memory contract (executor + UI import these exact types)
export { CONTRACT_PATHS } from './contract';
export type {
  BridgeMemory,
  Directives,
  ColonyState,
  DirectiveAck,
} from './contract';
export { ControlChannel } from './control';
export type { AwaitAckOptions } from './control';
export { Commander } from './commander';
export type { CommanderSnapshot } from './commander';

export { Channels } from './socket/channels';
export { SocketClient } from './socket/socketClient';
export { RoomState, deepMerge } from './socket/roomMerge';
export { decodeMemory, encodeMemory } from './core/gz';
export { decodeTerrain } from './modules/rooms';

// Types
export type { RateLimitBudget, OkEnvelope, RoomName, Shard, FlagColor } from './types/common';
export type {
  RoomObject,
  RoomTerrain,
  RoomOverview,
  RoomStatus,
  RoomObjectsResponse,
  CpuStats,
  ConsoleMessage,
  ConsoleError,
  TerrainTile,
} from './types/game';
export { TerrainMask } from './types/game';
export type { MarketOrder, MarketStatPoint, MoneyHistoryEntry } from './types/market';
export type {
  ChannelMessage,
  RoomSnapshot,
  RoomMap2Data,
  ChannelKind,
  ChannelPayloads,
} from './types/socket';

// Module types (for advanced typed usage)
export type { MeProfile, SigninResult } from './modules/auth';
export type { CodeResponse, Branch } from './modules/code';
export type { Message } from './modules/messaging';
