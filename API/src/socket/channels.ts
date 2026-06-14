/**
 * Typed channel-name builders for the Screeps WebSocket protocol.
 *
 * User-scoped channels require the account's user id (fetch it once via
 * `auth/me` or `user/name`). Room channels are shard + room scoped.
 */

export const Channels = {
  /** CPU + memory bytes per tick. */
  cpu: (userId: string) => `user:${userId}/cpu`,
  /** Console log + command results per tick. */
  console: (userId: string) => `user:${userId}/console`,
  /** A Memory path's value per tick (data may be gz-encoded). */
  memory: (userId: string, path: string) => `user:${userId}/memory/${path}`,
  /** Notification of a new incoming private message. */
  newMessage: (userId: string) => `user:${userId}/newMessage`,
  /** A live conversation thread with another user. */
  message: (userId: string, otherUserId: string) => `user:${userId}/message:${otherUserId}`,
  /** Notification when the active branch changes. */
  setActiveBranch: (userId: string) => `user:${userId}/set-active-branch`,
  /** Low-detail per-tick map data. */
  roomMap2: (shard: string, room: string) => `roomMap2:${shard}/${room}`,
  /** Full incremental room updates. */
  room: (shard: string, room: string) => `room:${shard}/${room}`,
  /** Global server broadcast messages. */
  serverMessage: () => 'server-message',
} as const;

/** True when a channel string is a `room:` channel. */
export function isRoomChannel(channel: string): boolean {
  return channel.startsWith('room:');
}

/** True when a channel string is a user memory channel. */
export function isMemoryChannel(channel: string): boolean {
  return /^user:[^/]+\/memory\//.test(channel);
}

/** Parse a `room:<shard>/<room>` channel into its parts. */
export function parseRoomChannel(channel: string): { shard: string; room: string } | null {
  const m = /^room:([^/]+)\/(.+)$/.exec(channel);
  return m ? { shard: m[1], room: m[2] } : null;
}

/** The rate-limit error variant for a channel is `err@<channel>`. */
export function isChannelError(channel: string): boolean {
  return channel.startsWith('err@');
}
