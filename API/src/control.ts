/**
 * ControlChannel — ergonomic, typed access to the shared Memory contract.
 *
 * This layer sits ON TOP of the raw memory endpoints and the WebSocket memory
 * channel; it does not bypass them, so all calls flow through the rate-limit
 * manager. Budget rules it honours:
 *
 *   - Directive *writes* ride the `POST memory` budget (~240/day) — fine for a
 *     strategic cadence (a write every few minutes).
 *   - Live *reading* of state goes through the WS `memory/<path>` channel
 *     ({@link watchState}), never a polling loop of `GET memory` (~1440/day).
 *
 * It contains no strategy or game logic — only transport of the contract.
 */

import type { ScreepsBridge } from './bridge';
import {
  CONTRACT_PATHS,
  type ColonyState,
  type DirectiveAck,
  type Directives,
} from './contract';
import { Channels } from './socket/channels';
import type { ChannelMessage } from './types/socket';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse a value delivered over the WS memory channel for a string-mirror path
 * (`stateJson`/`ackJson`). The real backend streams the stored JSON string;
 * tolerate a pre-parsed object too (some mocks/tests deliver one). Returns null
 * for empty/unparseable payloads (e.g. the "[object Object]" coercion that this
 * whole mirror exists to avoid, should an old executor still write the object).
 */
function parseJsonLeaf<T>(data: unknown): T | null {
  if (data == null) return null;
  if (typeof data === 'object') return data as T;
  if (typeof data !== 'string') return null;
  if (data === '[object Object]') return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export interface AwaitAckOptions {
  /** Overall timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Poll interval used only when the WebSocket is unavailable (default 15s). */
  pollMs?: number;
}

export class ControlChannel {
  constructor(private readonly bridge: ScreepsBridge) {}

  /**
   * Current colony state written by the executor. Returns `null` when absent
   * (the executor may not be running yet — callers must handle this).
   */
  async getState(): Promise<ColonyState | null> {
    const value = await this.bridge.memory.get(CONTRACT_PATHS.state);
    return (value as ColonyState) ?? null;
  }

  /** Current directives, defaulting to `{}` when unset. */
  async getDirectives(): Promise<Directives> {
    const value = await this.bridge.memory.get(CONTRACT_PATHS.directives);
    return ((value as Directives) ?? {}) as Directives;
  }

  /**
   * Merge `patch` into the current directives, auto-incrementing `rev`, write it
   * back (one `POST memory`), and return the new `rev` the executor should ack.
   */
  async setDirectives(patch: Partial<Directives>): Promise<number> {
    const current = await this.getDirectives();
    const rev = (current.rev ?? 0) + 1;
    const merged: Directives = { ...current, ...patch, rev };
    await this.bridge.memory.set(CONTRACT_PATHS.directives, merged);
    return rev;
  }

  /** The executor's last acknowledgement, or `null` if none yet. */
  async getAck(): Promise<DirectiveAck | null> {
    const value = await this.bridge.memory.get(CONTRACT_PATHS.ack);
    return (value as DirectiveAck) ?? null;
  }

  /**
   * Resolve `true` once the executor acks a directive revision `>= rev`, or
   * `false` on timeout. Prefers the WS `memory/bridge.ack` subscription; falls
   * back to a low-frequency poll only when the socket is unavailable.
   */
  async awaitAck(rev: number, opts: AwaitAckOptions = {}): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 30000;

    // Fast path: it may already be acked.
    const existing = await this.getAck();
    if (existing && existing.directiveVersion >= rev) return true;

    try {
      await this.bridge.connectSocket();
      return await this.awaitAckViaWs(rev, timeoutMs);
    } catch {
      return await this.awaitAckViaPoll(rev, timeoutMs, opts.pollMs ?? 15000);
    }
  }

  private async awaitAckViaWs(rev: number, timeoutMs: number): Promise<boolean> {
    const userId = await this.bridge.getUserId();
    // Subscribe to the string mirror, not the object path: the WS memory pubsub
    // coerces objects to "[object Object]". See CONTRACT_PATHS.ackJson.
    const channel = Channels.memory(userId, CONTRACT_PATHS.ackJson);

    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(ok);
      };
      const handler = (m: ChannelMessage) => {
        const ack = parseJsonLeaf<DirectiveAck>(m.data);
        if (ack && ack.directiveVersion >= rev) finish(true);
      };
      const unsubscribe = this.bridge.subscribeChannel(channel, handler);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private async awaitAckViaPoll(rev: number, timeoutMs: number, pollMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ack = await this.getAck();
      if (ack && ack.directiveVersion >= rev) return true;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
    return false;
  }

  /** Write a directive patch and wait for the executor to confirm it. */
  async pushAndConfirm(patch: Partial<Directives>, opts: AwaitAckOptions = {}): Promise<boolean> {
    const rev = await this.setDirectives(patch);
    return this.awaitAck(rev, opts);
  }

  // ---- Ergonomic wrappers (thin setDirectives calls) ----

  /** Pause executor activity. */
  pause(): Promise<number> {
    return this.setDirectives({ paused: true });
  }

  /** Resume executor activity. */
  resume(): Promise<number> {
    return this.setDirectives({ paused: false });
  }

  /** Set the strategic posture. */
  setPosture(posture: NonNullable<Directives['posture']>): Promise<number> {
    return this.setDirectives({ posture });
  }

  /** Set the list of target rooms. */
  setTargetRooms(rooms: string[]): Promise<number> {
    return this.setDirectives({ targetRooms: rooms });
  }

  /** Set a single role quota (merged into existing quotas). */
  async setQuota(role: string, n: number): Promise<number> {
    const current = await this.getDirectives();
    const roleQuotas = { ...(current.roleQuotas ?? {}), [role]: n };
    return this.setDirectives({ roleQuotas });
  }

  /**
   * Subscribe to live colony state over the WS `memory/bridge.state` channel and
   * invoke `cb` on every change. This is the cheap, real-time read path — do NOT
   * poll {@link getState} in a loop. Returns an unsubscribe function.
   */
  watchState(cb: (state: ColonyState) => void): () => void {
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      await this.bridge.connectSocket();
      const userId = await this.bridge.getUserId();
      if (cancelled) return;
      // Subscribe to the string mirror, not the object path (which the WS memory
      // pubsub would deliver as "[object Object]"). See CONTRACT_PATHS.stateJson.
      const channel = Channels.memory(userId, CONTRACT_PATHS.stateJson);
      const handler = (m: ChannelMessage) => {
        const state = parseJsonLeaf<ColonyState>(m.data);
        if (state) cb(state);
      };
      cleanup = this.bridge.subscribeChannel(channel, handler);
    })().catch((err) => {
      this.bridge.logger.warn('control: watchState setup failed', { err: String(err) });
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }
}
