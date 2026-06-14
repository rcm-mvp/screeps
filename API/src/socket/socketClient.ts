/**
 * WebSocket client for the Screeps live API.
 *
 * Handles SockJS framing, the `auth`/`subscribe` protocol, automatic
 * reconnection with backoff (re-auth + re-subscribe to all active channels),
 * incremental room-state merging, gz-decoding of memory frames, and the
 * `err@<channel>` rate-limit variant. Exposes a per-channel event emitter.
 *
 * Lifecycle events emitted on the instance:
 *   `open`        – SockJS connection opened
 *   `auth`        – authenticated (payload: token)
 *   `authFailed`  – authentication rejected
 *   `subscribed`  / `unsubscribed` – (payload: channel)
 *   `message`     – every channel message (payload: ChannelMessage)
 *   `close`       – connection closed (payload: { code?, reason? })
 *   `reconnect`   – a reconnect attempt is scheduled (payload: { attempt, delayMs })
 *   `error`       – transport / protocol error (payload: Error)
 * Plus one event named after each channel string, carrying ChannelMessage.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { decodeMemory } from '../core/gz';
import { AuthError, RateLimitError } from '../errors';
import type { Logger } from '../core/logger';
import type { ChannelMessage, RoomSnapshot } from '../types/socket';
import {
  isChannelError,
  isMemoryChannel,
  parseRoomChannel,
} from './channels';
import { RoomState } from './roomMerge';
import { decodeSockJsFrame, parseAppMessage, sockjsPath } from './sockjs';

export interface SocketOptions {
  /** WebSocket origin, e.g. `wss://screeps.com`. */
  wsOrigin: string;
  /** Returns the current auth token. */
  getToken: () => string | undefined;
  /** Called when the socket receives a rotated token (`auth ok <token>`). */
  setToken: (token: string) => void;
  logger: Logger;
  /** Max reconnect backoff in ms (default 30s). */
  maxBackoffMs?: number;
}

export class SocketClient extends EventEmitter {
  private ws?: WebSocket;
  private authed = false;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private firstAuthResolvers: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  /** Channels the caller wants subscribed (re-applied on reconnect). */
  private desired = new Set<string>();
  /** Merged room state per `room:` channel. */
  private rooms = new Map<string, RoomState>();

  constructor(private opts: SocketOptions) {
    super();
    this.setMaxListeners(0);
  }

  isAuthenticated(): boolean {
    return this.authed;
  }

  /**
   * Emit `error` without crashing the process when no listener is attached.
   * (Node's EventEmitter throws on an unhandled `error` event.)
   */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this.opts.logger.warn('socket: error (no listener attached)', { err: String(err) });
  }

  /** Open the connection and resolve once authenticated. */
  connect(): Promise<void> {
    this.closedByUser = false;
    const promise = new Promise<void>((resolve, reject) => {
      this.firstAuthResolvers.push({ resolve, reject });
    });
    this.open();
    return promise;
  }

  private open(): void {
    const token = this.opts.getToken();
    if (!token) {
      this.failFirstAuth(new AuthError('Cannot open socket: no auth token configured.'));
      return;
    }
    const url = `${this.opts.wsOrigin}/socket${sockjsPath()}/websocket`;
    this.opts.logger.debug('socket: connecting', { url });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('message', (raw: WebSocket.RawData) => this.onRaw(raw.toString()));
    ws.on('error', (err: Error) => {
      this.opts.logger.warn('socket: error', { err: String(err) });
      this.emitError(err);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      this.authed = false;
      this.emit('close', { code, reason: reason.toString() });
      this.opts.logger.info('socket: closed', { code });
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  private onRaw(raw: string): void {
    for (const ev of decodeSockJsFrame(raw)) {
      switch (ev.type) {
        case 'open':
          this.emit('open');
          this.sendRaw(`["auth ${this.opts.getToken()}"]`);
          break;
        case 'heartbeat':
          break;
        case 'close':
          // SockJS-level close; the ws 'close' handler drives reconnect.
          break;
        case 'message':
          this.onAppMessage(ev.payload);
          break;
      }
    }
  }

  private onAppMessage(payload: string): void {
    const msg = parseAppMessage(payload);

    if (msg.kind === 'control') {
      this.onControl(msg.text);
      return;
    }
    this.onChannel(msg.channel, msg.data);
  }

  private onControl(text: string): void {
    if (text.startsWith('auth ok')) {
      const newToken = text.slice('auth ok'.length).trim();
      if (newToken) this.opts.setToken(newToken);
      this.authed = true;
      this.reconnectAttempt = 0;
      this.opts.logger.info('socket: authenticated');
      this.emit('auth', newToken);
      // (Re)subscribe to everything the caller wants.
      for (const channel of this.desired) this.sendSubscribe(channel);
      this.resolveFirstAuth();
      return;
    }
    if (text.startsWith('auth failed')) {
      this.authed = false;
      const err = new AuthError('Socket authentication failed.');
      this.emit('authFailed');
      this.emitError(err);
      this.failFirstAuth(err);
      // Don't auto-reconnect on bad credentials.
      this.closedByUser = true;
      this.ws?.close();
      return;
    }
    // Other control strings (e.g. "time <n>") are surfaced raw.
    this.emit('control', text);
  }

  private onChannel(channel: string, data: unknown): void {
    // Rate-limit error variant: `err@<channel>`.
    if (isChannelError(channel)) {
      const realChannel = channel.slice('err@'.length);
      const err = new RateLimitError(`Socket channel rate-limited: ${realChannel}`, {
        rateLimitClass: 'subscription',
        body: data,
      });
      const message: ChannelMessage = { channel: realChannel, data, isError: true };
      this.emit('message', message);
      this.emit(realChannel, message);
      this.emitError(err);
      return;
    }

    let outData = data;

    // Memory channel frames may be gz-encoded.
    if (isMemoryChannel(channel)) {
      outData = decodeMemory(data);
    }

    // Room channel: maintain merged state, emit both delta + snapshot.
    const roomInfo = parseRoomChannel(channel);
    if (roomInfo) {
      let state = this.rooms.get(channel);
      if (!state) {
        state = new RoomState(roomInfo.shard, roomInfo.room);
        this.rooms.set(channel, state);
      }
      state.apply(data);
      const message: ChannelMessage<RoomSnapshot> = {
        channel,
        data: state.snapshot(),
      };
      // Raw delta is available via the `delta` event for advanced callers.
      this.emit('delta', { channel, data });
      this.emit('message', message);
      this.emit(channel, message);
      return;
    }

    const message: ChannelMessage = { channel, data: outData };
    this.emit('message', message);
    this.emit(channel, message);
  }

  /** Subscribe to a channel (idempotent). Sends immediately if authenticated. */
  subscribe(channel: string): void {
    this.desired.add(channel);
    if (this.authed) this.sendSubscribe(channel);
  }

  /** Unsubscribe from a channel. */
  unsubscribe(channel: string): void {
    this.desired.delete(channel);
    this.rooms.delete(channel);
    if (this.authed) {
      this.sendRaw(`["unsubscribe ${channel}"]`);
      this.emit('unsubscribed', channel);
    }
  }

  /** Current merged snapshot for a subscribed `room:` channel, if any. */
  getRoomSnapshot(channel: string): RoomSnapshot | undefined {
    return this.rooms.get(channel)?.snapshot();
  }

  /** Active (desired) channel subscriptions. */
  subscriptions(): string[] {
    return [...this.desired];
  }

  /** Close the connection and stop reconnecting. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private sendSubscribe(channel: string): void {
    this.sendRaw(`["subscribe ${channel}"]`);
    this.emit('subscribed', channel);
  }

  private sendRaw(frame: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const max = this.opts.maxBackoffMs ?? 30000;
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), max) + Math.random() * 500;
    this.opts.logger.info('socket: scheduling reconnect', {
      attempt: this.reconnectAttempt,
      delayMs: Math.round(delay),
    });
    this.emit('reconnect', { attempt: this.reconnectAttempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private resolveFirstAuth(): void {
    const resolvers = this.firstAuthResolvers;
    this.firstAuthResolvers = [];
    for (const r of resolvers) r.resolve();
  }

  private failFirstAuth(err: Error): void {
    const resolvers = this.firstAuthResolvers;
    this.firstAuthResolvers = [];
    for (const r of resolvers) r.reject(err);
  }
}
