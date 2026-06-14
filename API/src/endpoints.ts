/**
 * Single source of truth for every raw Screeps Web API path and its rate-limit
 * class. When the (undocumented, reverse-engineered) API changes, this is the
 * only file that should need editing.
 *
 * Paths are relative to the server origin + optional prefix; the HTTP client
 * prepends `${origin}${prefix}` and the leading `/api` lives in the path here.
 */

/** A rate-limit budget: at most `max` requests per `windowMs` window. */
export interface RateLimitClassDef {
  /** Human label, used in logs / the manifest. */
  label: string;
  max: number;
  windowMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINUTE = 60 * 1000;

/**
 * Per-endpoint rate-limit classes. The official server enforces a separate
 * budget per class on top of the global 120/min cap. `default` is used for
 * endpoints with no documented per-endpoint cap (still subject to global).
 */
export const RATE_LIMITS = {
  global: { label: 'global', max: 120, windowMs: MINUTE },
  default: { label: 'default', max: 120, windowMs: MINUTE },
  'GET user/code': { label: 'GET user/code', max: 60, windowMs: HOUR },
  'POST user/code': { label: 'POST user/code', max: 240, windowMs: DAY },
  'POST user/set-active-branch': { label: 'POST user/set-active-branch', max: 240, windowMs: DAY },
  'GET user/memory': { label: 'GET user/memory', max: 1440, windowMs: DAY },
  'POST user/memory': { label: 'POST user/memory', max: 240, windowMs: DAY },
  'GET user/memory-segment': { label: 'GET user/memory-segment', max: 360, windowMs: HOUR },
  'POST user/memory-segment': { label: 'POST user/memory-segment', max: 60, windowMs: HOUR },
  'POST user/console': { label: 'POST user/console', max: 360, windowMs: HOUR },
  'GET game/room-terrain': { label: 'GET game/room-terrain', max: 360, windowMs: HOUR },
  'POST game/map-stats': { label: 'POST game/map-stats', max: 60, windowMs: HOUR },
  market: { label: 'market', max: 60, windowMs: HOUR },
} as const satisfies Record<string, RateLimitClassDef>;

export type RateLimitClass = keyof typeof RATE_LIMITS;

/** The always-applied global budget class name. */
export const GLOBAL_CLASS: RateLimitClass = 'global';

/**
 * Named endpoint catalogue. Static paths are strings; path-parameterised
 * endpoints are template functions. Every entry records its HTTP method and
 * rate-limit class for the manifest and the rate-limit manager.
 */
export interface EndpointDef {
  method: 'GET' | 'POST';
  path: string | ((p: Record<string, string | number>) => string);
  rateLimitClass: RateLimitClass;
  /** Whether a token is required (vs. public/anonymous-capable). */
  auth: boolean;
  /** One-line description for the capability manifest. */
  description: string;
}

export const ENDPOINTS = {
  // ---- Auth / account ----
  'auth/signin': { method: 'POST', path: '/api/auth/signin', rateLimitClass: 'default', auth: false, description: 'Sign in with username/email + password (private servers); returns a token.' },
  'auth/me': { method: 'GET', path: '/api/auth/me', rateLimitClass: 'default', auth: true, description: 'Current authenticated account profile.' },
  'auth/query-token': { method: 'GET', path: '/api/auth/query-token', rateLimitClass: 'default', auth: true, description: 'Exchange a session for a query token (used for some sub-resources).' },
  'user/name': { method: 'GET', path: '/api/user/name', rateLimitClass: 'default', auth: true, description: 'Current user display name + id.' },
  'user/find': { method: 'GET', path: '/api/user/find', rateLimitClass: 'default', auth: true, description: 'Look up a user by username (?username=) or id (?id=).' },
  'user/world-status': { method: 'GET', path: '/api/user/world-status', rateLimitClass: 'default', auth: true, description: 'World status (normal / lost / empty).' },
  'user/world-start-room': { method: 'GET', path: '/api/user/world-start-room', rateLimitClass: 'default', auth: true, description: 'Suggested respawn start room(s).' },
  'user/world-size': { method: 'GET', path: '/api/user/world-size', rateLimitClass: 'default', auth: true, description: 'World dimensions per shard.' },
  'user/respawn-prohibited-rooms': { method: 'GET', path: '/api/user/respawn-prohibited-rooms', rateLimitClass: 'default', auth: true, description: 'Rooms where respawn is currently prohibited.' },
  'user/rooms': { method: 'GET', path: '/api/user/rooms', rateLimitClass: 'default', auth: true, description: 'Rooms owned by a user (?id=).' },
  'user/stats': { method: 'GET', path: '/api/user/stats', rateLimitClass: 'default', auth: true, description: 'User statistics over an interval.' },
  'user/overview': { method: 'GET', path: '/api/user/overview', rateLimitClass: 'default', auth: true, description: 'GCL/room/stat overview for the dashboard.' },
  'user/badge': { method: 'POST', path: '/api/user/badge', rateLimitClass: 'default', auth: true, description: 'Get or set the account badge.' },
  'user/notify-prefs': { method: 'POST', path: '/api/user/notify-prefs', rateLimitClass: 'default', auth: true, description: 'Get or update notification preferences.' },

  // ---- Code / branches ----
  'GET user/code': { method: 'GET', path: '/api/user/code', rateLimitClass: 'GET user/code', auth: true, description: 'Pull the full codebase of a branch (?branch=).' },
  'POST user/code': { method: 'POST', path: '/api/user/code', rateLimitClass: 'POST user/code', auth: true, description: 'Push a full codebase (modules map) to a branch.' },
  'user/branches': { method: 'GET', path: '/api/user/branches', rateLimitClass: 'default', auth: true, description: 'List code branches.' },
  'user/set-active-branch': { method: 'POST', path: '/api/user/set-active-branch', rateLimitClass: 'POST user/set-active-branch', auth: true, description: 'Set the active branch for the world or simulation.' },
  'user/clone-branch': { method: 'POST', path: '/api/user/clone-branch', rateLimitClass: 'default', auth: true, description: 'Clone an existing branch to a new name.' },
  'user/delete-branch': { method: 'POST', path: '/api/user/delete-branch', rateLimitClass: 'default', auth: true, description: 'Delete a branch.' },

  // ---- Memory ----
  'GET user/memory': { method: 'GET', path: '/api/user/memory', rateLimitClass: 'GET user/memory', auth: true, description: 'Read Memory at a path (?path=); auto-decodes gz: payloads.' },
  'POST user/memory': { method: 'POST', path: '/api/user/memory', rateLimitClass: 'POST user/memory', auth: true, description: 'Write a value to Memory at a path.' },
  'GET user/memory-segment': { method: 'GET', path: '/api/user/memory-segment', rateLimitClass: 'GET user/memory-segment', auth: true, description: 'Read a raw memory segment (?segment=0..99).' },
  'POST user/memory-segment': { method: 'POST', path: '/api/user/memory-segment', rateLimitClass: 'POST user/memory-segment', auth: true, description: 'Write a raw memory segment (0..99).' },

  // ---- Console ----
  'user/console': { method: 'POST', path: '/api/user/console', rateLimitClass: 'POST user/console', auth: true, description: 'Run an arbitrary expression in the live runtime console.' },

  // ---- Room data ----
  'game/room-overview': { method: 'GET', path: '/api/game/room-overview', rateLimitClass: 'default', auth: true, description: 'Room overview stats (?room=&shard=&interval=).' },
  'game/room-terrain': { method: 'GET', path: '/api/game/room-terrain', rateLimitClass: 'GET game/room-terrain', auth: false, description: 'Room terrain; pass encoded=1 for the digit-string form.' },
  'game/room-status': { method: 'GET', path: '/api/game/room-status', rateLimitClass: 'default', auth: true, description: 'Room ownership/novice/respawn status (?room=&shard=).' },
  'game/room-objects': { method: 'GET', path: '/api/game/room-objects', rateLimitClass: 'default', auth: true, description: 'All objects + users in a room (?room=&shard=).' },
  'experimental/pvp': { method: 'GET', path: '/api/experimental/pvp', rateLimitClass: 'default', auth: true, description: 'Rooms with recent PvP activity (?interval= or ?start=).' },
  'experimental/nukes': { method: 'GET', path: '/api/experimental/nukes', rateLimitClass: 'default', auth: true, description: 'In-flight nukes across shards.' },
  'game/room-history': { method: 'GET', path: (p) => `/room-history/${p.shard}/${p.room}/${p.tick}.json`, rateLimitClass: 'default', auth: false, description: 'Replay tick data for a room (static JSON; ticks are multiples of 100).' },

  // ---- World manipulation ----
  'game/gen-unique-object-name': { method: 'POST', path: '/api/game/gen-unique-object-name', rateLimitClass: 'default', auth: true, description: 'Generate a unique creature/spawn name (?type=).' },
  'game/check-unique-object-name': { method: 'POST', path: '/api/game/check-unique-object-name', rateLimitClass: 'default', auth: true, description: 'Check whether an object name is free.' },
  'game/gen-unique-flag-name': { method: 'POST', path: '/api/game/gen-unique-flag-name', rateLimitClass: 'default', auth: true, description: 'Generate a unique flag name.' },
  'game/create-flag': { method: 'POST', path: '/api/game/create-flag', rateLimitClass: 'default', auth: true, description: 'Create a flag at room/x/y with colours.' },
  'game/change-flag': { method: 'POST', path: '/api/game/change-flag', rateLimitClass: 'default', auth: true, description: 'Move a flag to a new room/x/y.' },
  'game/change-flag-color': { method: 'POST', path: '/api/game/change-flag-color', rateLimitClass: 'default', auth: true, description: 'Change a flag colour / secondary colour.' },
  'game/remove-flag': { method: 'POST', path: '/api/game/remove-flag', rateLimitClass: 'default', auth: true, description: 'Remove a flag by name + room.' },
  'game/add-object-intent': { method: 'POST', path: '/api/game/add-object-intent', rateLimitClass: 'default', auth: true, description: 'Low-level overloaded intent (suicide/unclaim/destroy/remove-site/remove-flag).' },
  'game/set-notify-when-attacked': { method: 'POST', path: '/api/game/set-notify-when-attacked', rateLimitClass: 'default', auth: true, description: 'Toggle attack notifications for an object.' },
  'game/create-construction': { method: 'POST', path: '/api/game/create-construction', rateLimitClass: 'default', auth: true, description: 'Place a construction site.' },
  'game/place-spawn': { method: 'POST', path: '/api/game/place-spawn', rateLimitClass: 'default', auth: true, description: 'Place the initial spawn (respawn / new room).' },

  // ---- Market ----
  'market/orders-index': { method: 'GET', path: '/api/game/market/orders-index', rateLimitClass: 'market', auth: true, description: 'Index of resource types with active orders.' },
  'market/orders': { method: 'GET', path: '/api/game/market/orders', rateLimitClass: 'market', auth: true, description: 'All orders for a resource type (?resourceType=).' },
  'market/my-orders': { method: 'GET', path: '/api/game/market/my-orders', rateLimitClass: 'market', auth: true, description: 'The current user\'s market orders.' },
  'market/stats': { method: 'GET', path: '/api/game/market/stats', rateLimitClass: 'market', auth: true, description: 'Historical price stats for a resource (?resourceType=).' },
  'user/money-history': { method: 'GET', path: '/api/user/money-history', rateLimitClass: 'market', auth: true, description: 'Credit transaction history (?page=).' },

  // ---- Map / meta ----
  'game/map-stats': { method: 'POST', path: '/api/game/map-stats', rateLimitClass: 'POST game/map-stats', auth: true, description: 'Batched per-room stats for a list of rooms (?statName=).' },
  'game/time': { method: 'GET', path: '/api/game/time', rateLimitClass: 'default', auth: false, description: 'Current game tick for a shard (?shard=).' },
  'game/shards/info': { method: 'GET', path: '/api/game/shards/info', rateLimitClass: 'default', auth: false, description: 'List of shards with metadata.' },
  version: { method: 'GET', path: '/api/version', rateLimitClass: 'default', auth: false, description: 'Server version + protocol info.' },
  'servers/list': { method: 'POST', path: '/api/servers/list', rateLimitClass: 'default', auth: false, description: 'Community server list (official only).' },

  // ---- Messaging ----
  'user/messages/index': { method: 'GET', path: '/api/user/messages/index', rateLimitClass: 'default', auth: true, description: 'Conversation index (most-recent message per correspondent).' },
  'user/messages/list': { method: 'GET', path: '/api/user/messages/list', rateLimitClass: 'default', auth: true, description: 'Message thread with a user (?respondent=).' },
  'user/messages/send': { method: 'POST', path: '/api/user/messages/send', rateLimitClass: 'default', auth: true, description: 'Send a private message to a user.' },
  'user/messages/unread-count': { method: 'GET', path: '/api/user/messages/unread-count', rateLimitClass: 'default', auth: true, description: 'Count of unread messages.' },
  'user/messages/mark-read': { method: 'POST', path: '/api/user/messages/mark-read', rateLimitClass: 'default', auth: true, description: 'Mark a message as read.' },

  // ---- Misc ----
  'decorations/inventory': { method: 'GET', path: '/api/decorations/inventory', rateLimitClass: 'default', auth: true, description: 'Owned decorations inventory.' },
  'decorations/themes': { method: 'GET', path: '/api/decorations/themes', rateLimitClass: 'default', auth: true, description: 'Available decoration themes.' },
  'decorations/convert': { method: 'POST', path: '/api/decorations/convert', rateLimitClass: 'default', auth: true, description: 'Convert decorations to resources.' },
  'decorations/pixelize': { method: 'POST', path: '/api/decorations/pixelize', rateLimitClass: 'default', auth: true, description: 'Convert credits to pixels (or related decoration op).' },
  'decorations/activate': { method: 'POST', path: '/api/decorations/activate', rateLimitClass: 'default', auth: true, description: 'Activate/deactivate a decoration in a room.' },
  'leaderboard/list': { method: 'GET', path: '/api/leaderboard/list', rateLimitClass: 'default', auth: true, description: 'Leaderboard page (?mode=world|power&season=).' },
  'leaderboard/find': { method: 'GET', path: '/api/leaderboard/find', rateLimitClass: 'default', auth: true, description: 'A user\'s leaderboard rank (?username=&mode=&season=).' },
  'leaderboard/seasons': { method: 'GET', path: '/api/leaderboard/seasons', rateLimitClass: 'default', auth: true, description: 'List of leaderboard seasons.' },
  'user/activate-ptr': { method: 'POST', path: '/api/user/activate-ptr', rateLimitClass: 'default', auth: true, description: 'Activate the PTR for the account (PTR host only).' },
  scoreboard: { method: 'GET', path: '/api/scoreboard', rateLimitClass: 'default', auth: true, description: 'Seasonal scoreboard (?season=&limit=&offset=).' },
} as const satisfies Record<string, EndpointDef>;

export type EndpointName = keyof typeof ENDPOINTS;
