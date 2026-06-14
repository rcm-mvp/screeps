/** WebSocket channel + frame types. */

import type { RoomName, Shard } from './common';
import type { ConsoleError, ConsoleMessage, CpuStats } from './game';

/** Names of the supported subscribe channels (templated by id/room/path). */
export type ChannelKind =
  | 'cpu'
  | 'console'
  | 'memory'
  | 'newMessage'
  | 'message'
  | 'set-active-branch'
  | 'roomMap2'
  | 'room'
  | 'server-message';

/** A parsed message arriving on a subscribed channel. */
export interface ChannelMessage<T = unknown> {
  /** Full channel string, e.g. `room:shard3/W1N1`. */
  channel: string;
  /** Payload for the channel. */
  data: T;
  /** True when this is a rate-limit error frame (`err@...`). */
  isError?: boolean;
}

/** Low-detail per-tick map data from `roomMap2:<shard>/<room>`. */
export interface RoomMap2Data {
  /** Arrays of [x, y] positions keyed by object category (w=wall, etc). */
  [category: string]: Array<[number, number]> | unknown;
}

/**
 * A merged room snapshot maintained by the bridge from the incremental
 * `room:<shard>/<room>` channel. `objects` holds the current full state of
 * every object id seen so far.
 */
export interface RoomSnapshot {
  shard: Shard;
  room: RoomName;
  /** Game tick of the latest applied update, when present. */
  gameTime?: number;
  /** Current merged state of every object, keyed by object id. */
  objects: Record<string, Record<string, unknown>>;
  /** User documents referenced by the objects. */
  users: Record<string, Record<string, unknown>>;
  /** Visual / info payloads passed through as-is. */
  info?: Record<string, unknown>;
}

/** Typed payload map for the strongly-known channels. */
export interface ChannelPayloads {
  cpu: CpuStats;
  console: ConsoleMessage | ConsoleError;
  memory: unknown;
  roomMap2: RoomMap2Data;
  room: RoomSnapshot;
  'server-message': unknown;
  newMessage: unknown;
  'set-active-branch': unknown;
}
