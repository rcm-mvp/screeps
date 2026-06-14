/**
 * Machine-readable capability manifest.
 *
 * Every discrete, individually-callable capability of the bridge is described
 * here with a JSON-schema for its params and a short description, so an AI
 * agent (or the MCP wrapper) can introspect and call any one of them via
 * {@link ScreepsBridge.invoke}. The `run` handler is the implementation; the
 * serialisable {@link CAPABILITIES} projection omits it.
 */

import type { ScreepsBridge } from './bridge';
import type { RateLimitClass } from './endpoints';

/* ------------------------------------------------------------------ */
/* JSON-schema helpers                                                 */
/* ------------------------------------------------------------------ */

type JsonSchema = Record<string, unknown>;

const str = (description: string): JsonSchema => ({ type: 'string', description });
const num = (description: string): JsonSchema => ({ type: 'number', description });
const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
const arr = (items: JsonSchema, description: string): JsonSchema => ({ type: 'array', items, description });
const obj = (description: string): JsonSchema => ({ type: 'object', description, additionalProperties: true });

const shardParam = str('Shard name (defaults to the configured shard).');

function params(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const noParams = params({});

/* ------------------------------------------------------------------ */
/* Capability definition types                                         */
/* ------------------------------------------------------------------ */

/** Serialisable capability metadata (what an agent introspects). */
export interface Capability {
  name: string;
  description: string;
  rateLimitClass: RateLimitClass | 'subscription' | 'none';
  params: JsonSchema;
  returns: JsonSchema;
}

/** Full definition including the runtime handler. */
export interface CapabilityDef extends Capability {
  run: (bridge: ScreepsBridge, p: Record<string, unknown>) => Promise<unknown> | unknown;
}

const S = (p: Record<string, unknown>) => p.shard as string | undefined;

/* ------------------------------------------------------------------ */
/* The capability catalogue                                            */
/* ------------------------------------------------------------------ */

export const CAPABILITY_DEFS: CapabilityDef[] = [
  // ---- Auth / account ----
  {
    name: 'auth.signin',
    description: 'Sign in with email/username + password (private servers); stores the returned token.',
    rateLimitClass: 'default',
    params: params({ email: str('Email or username'), password: str('Password') }, ['email', 'password']),
    returns: obj('Object with the auth token.'),
    run: (b, p) => b.auth.signin(p.email as string, p.password as string),
  },
  {
    name: 'auth.me',
    description: 'Current authenticated account profile (id, username, gcl, credits, …).',
    rateLimitClass: 'default',
    params: noParams,
    returns: obj('Account profile.'),
    run: (b) => b.auth.me(),
  },
  {
    name: 'auth.name',
    description: 'Current user display name + id.',
    rateLimitClass: 'default',
    params: noParams,
    returns: obj('Username + id.'),
    run: (b) => b.auth.name(),
  },
  {
    name: 'auth.findUser',
    description: 'Look up a user by username or id.',
    rateLimitClass: 'default',
    params: params({ username: str('Username'), id: str('User id') }),
    returns: obj('User document.'),
    run: (b, p) => b.auth.findUser({ username: p.username as string, id: p.id as string }),
  },
  {
    name: 'account.worldStatus',
    description: 'World status: normal | lost | empty.',
    rateLimitClass: 'default',
    params: noParams,
    returns: obj('Status.'),
    run: (b) => b.auth.worldStatus(),
  },
  {
    name: 'account.worldSize',
    description: 'World dimensions for a shard.',
    rateLimitClass: 'default',
    params: params({ shard: shardParam }),
    returns: obj('Width + height.'),
    run: (b, p) => b.auth.worldSize(S(p)),
  },
  {
    name: 'account.overview',
    description: 'GCL/room/stat overview for the dashboard.',
    rateLimitClass: 'default',
    params: params({ interval: num('Interval (8/180/1440)'), statName: str('Stat name'), shard: shardParam }, ['interval', 'statName']),
    returns: obj('Overview document.'),
    run: (b, p) => b.auth.overview(p.interval as number, p.statName as string, S(p)),
  },
  {
    name: 'account.stats',
    description: 'User statistics over an interval.',
    rateLimitClass: 'default',
    params: params({ interval: num('Interval (8/180/1440)') }, ['interval']),
    returns: obj('Stats.'),
    run: (b, p) => b.auth.stats(p.interval as number),
  },
  {
    name: 'account.rooms',
    description: 'Rooms owned by a user.',
    rateLimitClass: 'default',
    params: params({ userId: str('User id') }, ['userId']),
    returns: obj('Owned rooms.'),
    run: (b, p) => b.auth.rooms(p.userId as string),
  },
  {
    name: 'account.badge',
    description: 'Get (no arg) or set the account badge.',
    rateLimitClass: 'default',
    params: params({ badge: obj('Badge object to set; omit to read.') }),
    returns: obj('Badge.'),
    run: (b, p) => b.auth.badge(p.badge as Record<string, unknown> | undefined),
  },
  {
    name: 'account.notifyPrefs',
    description: 'Get or update notification preferences.',
    rateLimitClass: 'default',
    params: params({ prefs: obj('Preferences to set; omit to read.') }),
    returns: obj('Preferences.'),
    run: (b, p) => b.auth.notifyPrefs(p.prefs as Record<string, unknown> | undefined),
  },

  // ---- Code / branches ----
  {
    name: 'code.get',
    description: 'Pull the full codebase of a branch (defaults to active).',
    rateLimitClass: 'GET user/code',
    params: params({ branch: str('Branch name') }),
    returns: obj('Branch + modules map.'),
    run: (b, p) => b.code.get(p.branch as string | undefined),
  },
  {
    name: 'code.push',
    description: 'Push a full codebase (modules map) to a branch.',
    rateLimitClass: 'POST user/code',
    params: params({ branch: str('Branch name'), modules: obj('Map of module name -> source string.') }, ['branch', 'modules']),
    returns: obj('Push result (hash).'),
    run: (b, p) => b.code.push(p.branch as string, p.modules as Record<string, string>),
  },
  {
    name: 'code.branches',
    description: 'List code branches.',
    rateLimitClass: 'default',
    params: noParams,
    returns: obj('Branch list.'),
    run: (b) => b.code.branches(),
  },
  {
    name: 'code.setActiveBranch',
    description: 'Set the active branch for world or sim.',
    rateLimitClass: 'POST user/set-active-branch',
    params: params({ branch: str('Branch name'), activeName: str('"activeWorld" | "activeSim"') }, ['branch']),
    returns: obj('Result.'),
    run: (b, p) => b.code.setActiveBranch(p.branch as string, (p.activeName as 'activeWorld' | 'activeSim') ?? 'activeWorld'),
  },
  {
    name: 'code.cloneBranch',
    description: 'Clone a branch to a new name.',
    rateLimitClass: 'default',
    params: params({ branch: str('Source branch'), newName: str('New branch name') }, ['branch', 'newName']),
    returns: obj('Result.'),
    run: (b, p) => b.code.cloneBranch(p.branch as string, p.newName as string),
  },
  {
    name: 'code.deleteBranch',
    description: 'Delete a branch.',
    rateLimitClass: 'default',
    params: params({ branch: str('Branch name') }, ['branch']),
    returns: obj('Result.'),
    run: (b, p) => b.code.deleteBranch(p.branch as string),
  },

  // ---- Memory ----
  {
    name: 'memory.get',
    description: 'Read Memory at a path (gz-decoded automatically).',
    rateLimitClass: 'GET user/memory',
    params: params({ path: str('Dotted memory path (empty = whole Memory)'), shard: shardParam }),
    returns: obj('Decoded memory value.'),
    run: (b, p) => b.memory.get((p.path as string) ?? '', S(p)),
  },
  {
    name: 'memory.set',
    description: 'Write a value to Memory at a path.',
    rateLimitClass: 'POST user/memory',
    params: params({ path: str('Dotted memory path'), value: {} as JsonSchema, shard: shardParam }, ['path', 'value']),
    returns: obj('Result.'),
    run: (b, p) => b.memory.set(p.path as string, p.value, S(p)),
  },
  {
    name: 'memory.getSegment',
    description: 'Read a raw memory segment (0..99).',
    rateLimitClass: 'GET user/memory-segment',
    params: params({ segment: num('Segment id 0..99'), shard: shardParam }, ['segment']),
    returns: obj('Segment data.'),
    run: (b, p) => b.memory.getSegment(p.segment as number, S(p)),
  },
  {
    name: 'memory.setSegment',
    description: 'Write a raw memory segment (0..99).',
    rateLimitClass: 'POST user/memory-segment',
    params: params({ segment: num('Segment id 0..99'), data: str('Segment string data'), shard: shardParam }, ['segment', 'data']),
    returns: obj('Result.'),
    run: (b, p) => b.memory.setSegment(p.segment as number, p.data as string, S(p)),
  },

  // ---- Console ----
  {
    name: 'console.run',
    description: 'Run an expression in the live console runtime (output arrives on the console WS channel).',
    rateLimitClass: 'POST user/console',
    params: params({ expression: str('JavaScript expression'), shard: shardParam }, ['expression']),
    returns: obj('Submission result.'),
    run: (b, p) => b.console.run(p.expression as string, S(p)),
  },

  // ---- Rooms ----
  {
    name: 'rooms.overview',
    description: 'Room overview stats over an interval.',
    rateLimitClass: 'default',
    params: params({ room: str('Room name'), interval: num('8/180/1440'), shard: shardParam }, ['room']),
    returns: obj('Overview.'),
    run: (b, p) => b.rooms.overview(p.room as string, (p.interval as number) ?? 8, S(p)),
  },
  {
    name: 'rooms.terrain',
    description: 'Room terrain as raw encoded string + decoded grid[y][x].',
    rateLimitClass: 'GET game/room-terrain',
    params: params({ room: str('Room name'), encoded: bool('Use encoded form (default true)'), shard: shardParam }, ['room']),
    returns: obj('Terrain (encoded + grid).'),
    run: (b, p) => b.rooms.terrain(p.room as string, { encoded: p.encoded as boolean | undefined, shard: S(p) }),
  },
  {
    name: 'rooms.status',
    description: 'Room ownership / novice / respawn status.',
    rateLimitClass: 'default',
    params: params({ room: str('Room name'), shard: shardParam }, ['room']),
    returns: obj('Status.'),
    run: (b, p) => b.rooms.status(p.room as string, S(p)),
  },
  {
    name: 'rooms.objects',
    description: 'All objects + referenced users in a room.',
    rateLimitClass: 'default',
    params: params({ room: str('Room name'), shard: shardParam }, ['room']),
    returns: obj('Objects + users.'),
    run: (b, p) => b.rooms.objects(p.room as string, S(p)),
  },
  {
    name: 'rooms.pvp',
    description: 'Rooms with recent PvP activity.',
    rateLimitClass: 'default',
    params: params({ interval: num('Lookback interval'), start: num('Start tick'), shard: shardParam }),
    returns: obj('PvP activity.'),
    run: (b, p) => b.rooms.pvp({ interval: p.interval as number, start: p.start as number, shard: S(p) }),
  },
  {
    name: 'rooms.nukes',
    description: 'In-flight nukes across shards.',
    rateLimitClass: 'default',
    params: params({ shard: shardParam }),
    returns: obj('Nukes.'),
    run: (b, p) => b.rooms.nukes(S(p)),
  },
  {
    name: 'rooms.history',
    description: 'Replay data for a room at a tick (multiple of 100).',
    rateLimitClass: 'default',
    params: params({ room: str('Room name'), tick: num('Tick (multiple of 100)'), shard: shardParam }, ['room', 'tick']),
    returns: obj('Tick history JSON.'),
    run: (b, p) => b.rooms.history(p.room as string, p.tick as number, S(p)),
  },

  // ---- World manipulation ----
  {
    name: 'world.genUniqueObjectName',
    description: 'Generate a unique object name for a type.',
    rateLimitClass: 'default',
    params: params({ type: str('Object type e.g. creep/spawn/flag'), shard: shardParam }, ['type']),
    returns: obj('{ name }.'),
    run: (b, p) => b.world.genUniqueObjectName(p.type as string, S(p)),
  },
  {
    name: 'world.createFlag',
    description: 'Create a flag at room/x/y with colours.',
    rateLimitClass: 'default',
    params: params({ room: str('Room'), x: num('x 0..49'), y: num('y 0..49'), name: str('Flag name'), color: num('Colour 1..10'), secondaryColor: num('Secondary colour 1..10'), shard: shardParam }, ['room', 'x', 'y', 'name']),
    returns: obj('Result.'),
    run: (b, p) => b.world.createFlag({ room: p.room as string, x: p.x as number, y: p.y as number, name: p.name as string, color: p.color as number, secondaryColor: p.secondaryColor as number, shard: S(p) }),
  },
  {
    name: 'world.changeFlag',
    description: 'Move a flag to a new position.',
    rateLimitClass: 'default',
    params: params({ name: str('Flag name'), room: str('Room'), x: num('x'), y: num('y'), shard: shardParam }, ['name', 'room', 'x', 'y']),
    returns: obj('Result.'),
    run: (b, p) => b.world.changeFlag({ name: p.name as string, room: p.room as string, x: p.x as number, y: p.y as number, shard: S(p) }),
  },
  {
    name: 'world.changeFlagColor',
    description: 'Change a flag\'s colours.',
    rateLimitClass: 'default',
    params: params({ name: str('Flag name'), room: str('Room'), color: num('Colour'), secondaryColor: num('Secondary colour'), shard: shardParam }, ['name', 'room', 'color', 'secondaryColor']),
    returns: obj('Result.'),
    run: (b, p) => b.world.changeFlagColor({ name: p.name as string, room: p.room as string, color: p.color as number, secondaryColor: p.secondaryColor as number, shard: S(p) }),
  },
  {
    name: 'world.removeFlag',
    description: 'Remove a flag by name + room.',
    rateLimitClass: 'default',
    params: params({ name: str('Flag name'), room: str('Room'), shard: shardParam }, ['name', 'room']),
    returns: obj('Result.'),
    run: (b, p) => b.world.removeFlag(p.name as string, p.room as string, S(p)),
  },
  {
    name: 'world.createConstruction',
    description: 'Place a construction site.',
    rateLimitClass: 'default',
    params: params({ room: str('Room'), x: num('x'), y: num('y'), structureType: str('Structure type'), name: str('Optional name (spawn)'), shard: shardParam }, ['room', 'x', 'y', 'structureType']),
    returns: obj('Result.'),
    run: (b, p) => b.world.createConstruction({ room: p.room as string, x: p.x as number, y: p.y as number, structureType: p.structureType as string, name: p.name as string, shard: S(p) }),
  },
  {
    name: 'world.placeSpawn',
    description: 'Place the initial spawn (respawn / new room).',
    rateLimitClass: 'default',
    params: params({ room: str('Room'), x: num('x'), y: num('y'), name: str('Spawn name'), shard: shardParam }, ['room', 'x', 'y', 'name']),
    returns: obj('Result.'),
    run: (b, p) => b.world.placeSpawn({ room: p.room as string, x: p.x as number, y: p.y as number, name: p.name as string, shard: S(p) }),
  },
  {
    name: 'world.suicideCreep',
    description: 'Suicide a creep by id.',
    rateLimitClass: 'default',
    params: params({ id: str('Creep id'), room: str('Room'), shard: shardParam }, ['id', 'room']),
    returns: obj('Result.'),
    run: (b, p) => b.world.suicideCreep(p.id as string, p.room as string, S(p)),
  },
  {
    name: 'world.unclaimController',
    description: 'Unclaim a controller by id.',
    rateLimitClass: 'default',
    params: params({ id: str('Controller id'), room: str('Room'), shard: shardParam }, ['id', 'room']),
    returns: obj('Result.'),
    run: (b, p) => b.world.unclaimController(p.id as string, p.room as string, S(p)),
  },
  {
    name: 'world.destroyStructures',
    description: 'Destroy a structure by id.',
    rateLimitClass: 'default',
    params: params({ id: str('Structure id'), room: str('Room'), shard: shardParam }, ['id', 'room']),
    returns: obj('Result.'),
    run: (b, p) => b.world.destroyStructures(p.id as string, p.room as string, S(p)),
  },
  {
    name: 'world.removeConstructionSite',
    description: 'Remove a construction site by id.',
    rateLimitClass: 'default',
    params: params({ id: str('Site id'), room: str('Room'), shard: shardParam }, ['id', 'room']),
    returns: obj('Result.'),
    run: (b, p) => b.world.removeConstructionSite(p.id as string, p.room as string, S(p)),
  },
  {
    name: 'world.setNotifyWhenAttacked',
    description: 'Toggle attack notifications for an object.',
    rateLimitClass: 'default',
    params: params({ id: str('Object id'), enabled: bool('Enable notifications'), shard: shardParam }, ['id', 'enabled']),
    returns: obj('Result.'),
    run: (b, p) => b.world.setNotifyWhenAttacked(p.id as string, p.enabled as boolean, S(p)),
  },

  // ---- Market ----
  {
    name: 'market.ordersIndex',
    description: 'Index of resource types with active orders.',
    rateLimitClass: 'market',
    params: params({ shard: shardParam }),
    returns: obj('Orders index.'),
    run: (b, p) => b.market.ordersIndex(S(p)),
  },
  {
    name: 'market.orders',
    description: 'All orders for a resource type.',
    rateLimitClass: 'market',
    params: params({ resourceType: str('Resource type e.g. energy/H'), shard: shardParam }, ['resourceType']),
    returns: obj('Orders.'),
    run: (b, p) => b.market.orders(p.resourceType as string, S(p)),
  },
  {
    name: 'market.myOrders',
    description: 'The current user\'s market orders.',
    rateLimitClass: 'market',
    params: noParams,
    returns: obj('My orders.'),
    run: (b) => b.market.myOrders(),
  },
  {
    name: 'market.stats',
    description: 'Historical price stats for a resource.',
    rateLimitClass: 'market',
    params: params({ resourceType: str('Resource type'), shard: shardParam }, ['resourceType']),
    returns: obj('Stats.'),
    run: (b, p) => b.market.stats(p.resourceType as string, S(p)),
  },
  {
    name: 'market.moneyHistory',
    description: 'Credit transaction history (paginated).',
    rateLimitClass: 'market',
    params: params({ page: num('Page (0-based)') }),
    returns: obj('Money history.'),
    run: (b, p) => b.market.moneyHistory((p.page as number) ?? 0),
  },

  // ---- Map / meta ----
  {
    name: 'map.mapStats',
    description: 'Batched per-room stats for a list of rooms.',
    rateLimitClass: 'POST game/map-stats',
    params: params({ rooms: arr(str('Room name'), 'Room names'), statName: str('Stat name e.g. owner0'), shard: shardParam }, ['rooms']),
    returns: obj('Per-room stats.'),
    run: (b, p) => b.map.mapStats(p.rooms as string[], (p.statName as string) ?? 'owner0', S(p)),
  },
  {
    name: 'map.time',
    description: 'Current game tick for a shard.',
    rateLimitClass: 'default',
    params: params({ shard: shardParam }),
    returns: obj('{ time }.'),
    run: (b, p) => b.map.time(S(p)),
  },
  {
    name: 'map.shards',
    description: 'List of shards with metadata.',
    rateLimitClass: 'default',
    params: noParams,
    returns: obj('Shards.'),
    run: (b) => b.map.shards(),
  },
  {
    name: 'map.version',
    description: 'Server version + protocol info.',
    rateLimitClass: 'default',
    params: noParams,
    returns: obj('Version.'),
    run: (b) => b.map.version(),
  },

  // ---- Messaging ----
  {
    name: 'messaging.index',
    description: 'Conversation index (latest per correspondent).',
    rateLimitClass: 'default',
    params: noParams,
    returns: obj('Index.'),
    run: (b) => b.messaging.index(),
  },
  {
    name: 'messaging.list',
    description: 'Full message thread with a user.',
    rateLimitClass: 'default',
    params: params({ respondent: str('User id') }, ['respondent']),
    returns: obj('Messages.'),
    run: (b, p) => b.messaging.list(p.respondent as string),
  },
  {
    name: 'messaging.send',
    description: 'Send a private message to a user.',
    rateLimitClass: 'default',
    params: params({ respondent: str('User id'), text: str('Message text') }, ['respondent', 'text']),
    returns: obj('Result.'),
    run: (b, p) => b.messaging.send(p.respondent as string, p.text as string),
  },
  {
    name: 'messaging.unreadCount',
    description: 'Count of unread messages.',
    rateLimitClass: 'default',
    params: noParams,
    returns: obj('{ count }.'),
    run: (b) => b.messaging.unreadCount(),
  },
  {
    name: 'messaging.markRead',
    description: 'Mark a message as read.',
    rateLimitClass: 'default',
    params: params({ id: str('Message id') }, ['id']),
    returns: obj('Result.'),
    run: (b, p) => b.messaging.markRead(p.id as string),
  },

  // ---- Misc ----
  {
    name: 'misc.leaderboardList',
    description: 'Leaderboard page (world/power).',
    rateLimitClass: 'default',
    params: params({ mode: str('"world" | "power"'), season: str('Season'), limit: num('Limit'), offset: num('Offset') }),
    returns: obj('Leaderboard.'),
    run: (b, p) => b.misc.leaderboardList({ mode: p.mode as 'world' | 'power', season: p.season as string, limit: p.limit as number, offset: p.offset as number }),
  },
  {
    name: 'misc.leaderboardFind',
    description: 'A user\'s leaderboard rank.',
    rateLimitClass: 'default',
    params: params({ username: str('Username'), mode: str('"world" | "power"'), season: str('Season') }, ['username']),
    returns: obj('Rank.'),
    run: (b, p) => b.misc.leaderboardFind(p.username as string, { mode: p.mode as 'world' | 'power', season: p.season as string }),
  },
  {
    name: 'misc.scoreboard',
    description: 'Seasonal scoreboard.',
    rateLimitClass: 'default',
    params: params({ season: str('Season'), limit: num('Limit'), offset: num('Offset') }),
    returns: obj('Scoreboard.'),
    run: (b, p) => b.misc.scoreboard({ season: p.season as string, limit: p.limit as number, offset: p.offset as number }),
  },

  // ---- Live socket ----
  {
    name: 'socket.subscribeRoom',
    description: 'Subscribe to live incremental room updates; returns the channel. Read snapshots via socket.getRoomSnapshot.',
    rateLimitClass: 'subscription',
    params: params({ room: str('Room name'), shard: shardParam }, ['room']),
    returns: obj('{ channel }.'),
    run: async (b, p) => {
      await b.connectSocket();
      const channel = b.subscribeRoom(p.room as string, () => undefined, S(p));
      return { channel };
    },
  },
  {
    name: 'socket.getRoomSnapshot',
    description: 'Current merged snapshot for a subscribed room channel.',
    rateLimitClass: 'none',
    params: params({ channel: str('room:<shard>/<room> channel') }, ['channel']),
    returns: obj('Room snapshot or null.'),
    run: (b, p) => b.socket.getRoomSnapshot(p.channel as string) ?? null,
  },
  {
    name: 'socket.unsubscribe',
    description: 'Unsubscribe from a channel.',
    rateLimitClass: 'none',
    params: params({ channel: str('Channel string') }, ['channel']),
    returns: obj('null.'),
    run: (b, p) => {
      b.socket.unsubscribe(p.channel as string);
      return null;
    },
  },

  // ---- Control channel (shared Memory contract) ----
  {
    name: 'control.getState',
    description: 'Read the executor-written ColonyState from Memory.bridge.state (null if absent).',
    rateLimitClass: 'GET user/memory',
    params: noParams,
    returns: obj('ColonyState or null.'),
    run: (b) => b.control.getState(),
  },
  {
    name: 'control.getDirectives',
    description: 'Read the current Directives from Memory.bridge.directives.',
    rateLimitClass: 'GET user/memory',
    params: noParams,
    returns: obj('Directives.'),
    run: (b) => b.control.getDirectives(),
  },
  {
    name: 'control.setDirectives',
    description: 'Merge a directive patch, auto-increment rev, write to Memory.bridge.directives; returns the new rev.',
    rateLimitClass: 'POST user/memory',
    params: params({ patch: obj('Partial Directives to merge') }, ['patch']),
    returns: num('New directive rev.'),
    run: (b, p) => b.control.setDirectives(p.patch as Record<string, unknown>),
  },
  {
    name: 'control.getAck',
    description: 'Read the executor acknowledgement from Memory.bridge.ack (null if none).',
    rateLimitClass: 'GET user/memory',
    params: noParams,
    returns: obj('DirectiveAck or null.'),
    run: (b) => b.control.getAck(),
  },
  {
    name: 'control.pushAndConfirm',
    description: 'Write a directive patch and wait (via WS) for the executor to ack it; returns applied boolean.',
    rateLimitClass: 'POST user/memory',
    params: params({ patch: obj('Partial Directives'), timeoutMs: num('Ack timeout ms (default 30000)') }, ['patch']),
    returns: bool('Whether the executor acked.'),
    run: (b, p) => b.control.pushAndConfirm(p.patch as Record<string, unknown>, { timeoutMs: p.timeoutMs as number | undefined }),
  },
  {
    name: 'control.pause',
    description: 'Set directives.paused = true.',
    rateLimitClass: 'POST user/memory',
    params: noParams,
    returns: num('New rev.'),
    run: (b) => b.control.pause(),
  },
  {
    name: 'control.resume',
    description: 'Set directives.paused = false.',
    rateLimitClass: 'POST user/memory',
    params: noParams,
    returns: num('New rev.'),
    run: (b) => b.control.resume(),
  },
  {
    name: 'control.setPosture',
    description: 'Set strategic posture: economy | expand | defend | war.',
    rateLimitClass: 'POST user/memory',
    params: params({ posture: str('economy | expand | defend | war') }, ['posture']),
    returns: num('New rev.'),
    run: (b, p) => b.control.setPosture(p.posture as 'economy' | 'expand' | 'defend' | 'war'),
  },
  {
    name: 'control.setTargetRooms',
    description: 'Set the list of target rooms.',
    rateLimitClass: 'POST user/memory',
    params: params({ rooms: arr(str('Room name'), 'Target rooms') }, ['rooms']),
    returns: num('New rev.'),
    run: (b, p) => b.control.setTargetRooms(p.rooms as string[]),
  },
  {
    name: 'control.setQuota',
    description: 'Set a single role quota (merged into existing quotas).',
    rateLimitClass: 'POST user/memory',
    params: params({ role: str('Role name'), n: num('Quota') }, ['role', 'n']),
    returns: num('New rev.'),
    run: (b, p) => b.control.setQuota(p.role as string, p.n as number),
  },
  {
    name: 'commander.snapshot',
    description: 'One call: { state, directives, ack } — everything an AI needs to decide.',
    rateLimitClass: 'GET user/memory',
    params: noParams,
    returns: obj('{ state, directives, ack }.'),
    run: (b) => b.commander.snapshot(),
  },
  {
    name: 'commander.propose',
    description: 'Write a directive patch and report { rev, applied } once the executor acks (or times out).',
    rateLimitClass: 'POST user/memory',
    params: params({ patch: obj('Partial Directives'), timeoutMs: num('Ack timeout ms') }, ['patch']),
    returns: obj('{ rev, applied }.'),
    run: (b, p) => b.commander.propose(p.patch as Record<string, unknown>, { timeoutMs: p.timeoutMs as number | undefined }),
  },

  // ---- Introspection / escape hatch ----
  {
    name: 'rateLimits.budgets',
    description: 'Current remaining budget for every rate-limit class.',
    rateLimitClass: 'none',
    params: noParams,
    returns: obj('Array of budgets.'),
    run: (b) => b.getRateLimitBudgets(),
  },
  {
    name: 'http.request',
    description: 'Escape hatch: call any raw API path so nothing is unreachable.',
    rateLimitClass: 'default',
    params: params({ method: str('"GET" | "POST"'), path: str('Path e.g. /api/...'), query: obj('Query params'), body: obj('JSON body'), auth: bool('Requires auth (default true)') }, ['method', 'path']),
    returns: obj('Raw response.'),
    run: (b, p) =>
      b.http.request(p.method as 'GET' | 'POST', p.path as string, {
        query: p.query as Record<string, string | number | boolean | undefined> | undefined,
        body: p.body,
        auth: p.auth as boolean | undefined,
      }),
  },
];

/** Serialisable manifest (handlers stripped). */
export const CAPABILITIES: Capability[] = CAPABILITY_DEFS.map(({ run, ...meta }) => meta);
