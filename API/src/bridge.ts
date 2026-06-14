/**
 * ScreepsBridge — the single facade that composes every module + the socket.
 *
 * Construct once with `{ server, token, shard }` (or rely on env vars) and you
 * have typed access to the entire Screeps Web API: HTTP modules, the live
 * WebSocket, the rate-limit budget view, and the machine-readable capability
 * manifest + `invoke()` dispatcher for AI-agent use.
 */

import { BridgeConfig, resolveConfig } from './config';
import { HttpClient } from './core/httpClient';
import { Logger } from './core/logger';
import { RateLimiter } from './core/rateLimiter';
import type { RateLimitBudget } from './types/common';
import type { ChannelMessage, RoomSnapshot } from './types/socket';

import { ModuleDefaults } from './modules/base';
import { AuthModule } from './modules/auth';
import { CodeModule } from './modules/code';
import { MemoryModule } from './modules/memory';
import { ConsoleModule } from './modules/console';
import { RoomsModule } from './modules/rooms';
import { WorldModule } from './modules/world';
import { MarketModule } from './modules/market';
import { MapModule } from './modules/map';
import { MessagingModule } from './modules/messaging';
import { MiscModule } from './modules/misc';

import { Channels } from './socket/channels';
import { SocketClient } from './socket/socketClient';

import { CAPABILITIES, Capability } from './manifest';
import { buildDispatch } from './dispatch';
import { ControlChannel } from './control';
import { Commander } from './commander';

export class ScreepsBridge {
  readonly logger: Logger;
  readonly limiter: RateLimiter;
  readonly http: HttpClient;

  readonly auth: AuthModule;
  readonly code: CodeModule;
  readonly memory: MemoryModule;
  readonly console: ConsoleModule;
  readonly rooms: RoomsModule;
  readonly world: WorldModule;
  readonly market: MarketModule;
  readonly map: MapModule;
  readonly messaging: MessagingModule;
  readonly misc: MiscModule;

  /** Typed access to the shared Memory contract (directives/state/ack). */
  readonly control: ControlChannel;
  /** Minimal read-contract / write-directive surface for an AI strategist. */
  readonly commander: Commander;

  private defaults: ModuleDefaults;
  private _socket?: SocketClient;
  private _userId?: string;
  private dispatch: ReturnType<typeof buildDispatch>;

  constructor(config: BridgeConfig = {}) {
    const cfg = resolveConfig(config);
    this.logger = new Logger(cfg.log);
    this.limiter = new RateLimiter(this.logger);
    this.http = new HttpClient(cfg, this.limiter, this.logger);
    this.defaults = { shard: cfg.shard };

    const d = this.defaults;
    this.auth = new AuthModule(this.http, d);
    this.code = new CodeModule(this.http, d);
    this.memory = new MemoryModule(this.http, d);
    this.console = new ConsoleModule(this.http, d);
    this.rooms = new RoomsModule(this.http, d);
    this.world = new WorldModule(this.http, d);
    this.market = new MarketModule(this.http, d);
    this.map = new MapModule(this.http, d);
    this.messaging = new MessagingModule(this.http, d);
    this.misc = new MiscModule(this.http, d);

    this.control = new ControlChannel(this);
    this.commander = new Commander(this);

    this.dispatch = buildDispatch(this);

    // Keep the WS-issued config in sync with the http origin/ws.
    this._wsOrigin = cfg.endpoints.ws;
  }

  private _wsOrigin: string;

  /** The active default shard. */
  get shard(): string {
    return this.defaults.shard;
  }
  set shard(value: string) {
    this.defaults.shard = value;
  }

  /** Enable/disable structured logging at runtime. */
  setLogging(enabled: boolean): void {
    this.logger.setEnabled(enabled);
  }

  // ---- Rate-limit introspection ----

  /** Current budget for every tracked rate-limit class (for a UI/agent). */
  getRateLimitBudgets(): RateLimitBudget[] {
    return this.limiter.getAllBudgets();
  }

  // ---- Identity ----

  /** The authenticated account's user id (cached after first lookup). */
  async getUserId(): Promise<string> {
    if (this._userId) return this._userId;
    const me = await this.auth.me();
    this._userId = me._id;
    return this._userId;
  }

  // ---- WebSocket ----

  /** The live socket client, lazily created. */
  get socket(): SocketClient {
    if (!this._socket) {
      this._socket = new SocketClient({
        wsOrigin: this._wsOrigin,
        getToken: () => this.http.getToken(),
        setToken: (t) => this.http.setToken(t),
        logger: this.logger,
      });
      // Propagate HTTP token rotation to the socket's auth on next reconnect.
      this.http.onTokenRotate(() => {
        /* token is read live via getToken; nothing to push */
      });
    }
    return this._socket;
  }

  /** Open + authenticate the socket. Safe to call repeatedly. */
  connectSocket(): Promise<void> {
    return this.socket.connect();
  }

  /** Subscribe to CPU/memory-per-tick for the current user. */
  async subscribeCpu(handler: (m: ChannelMessage) => void): Promise<string> {
    const channel = Channels.cpu(await this.getUserId());
    this.socket.on(channel, handler);
    this.socket.subscribe(channel);
    return channel;
  }

  /** Subscribe to live console output for the current user. */
  async subscribeConsole(handler: (m: ChannelMessage) => void): Promise<string> {
    const channel = Channels.console(await this.getUserId());
    this.socket.on(channel, handler);
    this.socket.subscribe(channel);
    return channel;
  }

  /** Subscribe to a Memory path (data is gz-decoded automatically). */
  async subscribeMemory(path: string, handler: (m: ChannelMessage) => void): Promise<string> {
    const channel = Channels.memory(await this.getUserId(), path);
    this.socket.on(channel, handler);
    this.socket.subscribe(channel);
    return channel;
  }

  /** Subscribe to full incremental room updates; handler gets merged snapshots. */
  subscribeRoom(
    room: string,
    handler: (m: ChannelMessage<RoomSnapshot>) => void,
    shard?: string,
  ): string {
    const channel = Channels.room(shard ?? this.shard, room);
    this.socket.on(channel, handler as (m: ChannelMessage) => void);
    this.socket.subscribe(channel);
    return channel;
  }

  /** Subscribe to low-detail per-tick map data for a room. */
  subscribeRoomMap2(room: string, handler: (m: ChannelMessage) => void, shard?: string): string {
    const channel = Channels.roomMap2(shard ?? this.shard, room);
    this.socket.on(channel, handler);
    this.socket.subscribe(channel);
    return channel;
  }

  /**
   * Generic subscribe helper for any channel string (e.g. those built via
   * {@link Channels} like `newMessage`, `set-active-branch`, `server-message`,
   * or a raw `memory/<path>` channel). Returns an unsubscribe function.
   */
  subscribeChannel(channel: string, handler: (m: ChannelMessage) => void): () => void {
    this.socket.on(channel, handler);
    this.socket.subscribe(channel);
    return () => {
      this.socket.off(channel, handler);
      this.socket.unsubscribe(channel);
    };
  }

  /** Subscribe to new-message notifications for the current user. */
  async subscribeNewMessage(handler: (m: ChannelMessage) => void): Promise<string> {
    const channel = Channels.newMessage(await this.getUserId());
    this.subscribeChannel(channel, handler);
    return channel;
  }

  /** Subscribe to global server broadcast messages. */
  subscribeServerMessages(handler: (m: ChannelMessage) => void): string {
    const channel = Channels.serverMessage();
    this.subscribeChannel(channel, handler);
    return channel;
  }

  // ---- Agent-facing capability surface ----

  /** Machine-readable manifest of every discrete, individually-callable capability. */
  getManifest(): Capability[] {
    return CAPABILITIES;
  }

  /**
   * Invoke a capability by name with a params object (validated loosely against
   * the manifest). Powers the optional MCP wrapper and any AI-agent caller.
   */
  async invoke(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const handler = this.dispatch[name];
    if (!handler) {
      throw new Error(`Unknown capability "${name}". See getManifest() for the list.`);
    }
    return handler(params);
  }

  /** Close the socket and release resources. */
  close(): void {
    this._socket?.close();
  }
}
