/**
 * Condition-based waiting + live colony-state observation.
 *
 * Observation goes through the bridge's HTTP read path (`control.getState()` /
 * `control.getAck()`), NOT the WS `watchState`. The WS live-read path now works
 * (the executor mirrors state/ack through the `bridge.stateJson`/`bridge.ackJson`
 * string leaf paths, since the screeps memory pubsub String()-coerces object
 * paths to "[object Object]" — scenario B verifies the mirror). The harness
 * keeps observing over HTTP on purpose: it is a simple, independent ground-truth
 * source that doesn't depend on the very WS mirror some scenarios are verifying.
 *
 * Ticks advance in wall-clock time on a private server, so timeouts are
 * expressed in ticks and converted via the configured tick duration with a
 * generous safety factor. Polls are condition-based, never fixed sleeps that
 * outlast the condition.
 */

import { Channels } from 'screeps-web-api-bridge';
import type { ColonyState, DirectiveAck, ScreepsBridge } from 'screeps-web-api-bridge';
import { loadContext } from './context';

/** Wall-clock budget for `n` ticks (x3 safety factor, min 5s). */
export function ticksMs(n: number, tickMs?: number): number {
  const ms = tickMs ?? loadContext().tickMs;
  return Math.max(5_000, n * ms * 3);
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** What is being waited for — included verbatim in the timeout error. */
  what: string;
}

/**
 * Poll `probe` until it returns a truthy value. The timeout error includes
 * `what` and the last observed value, so failures are self-describing.
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  opts: WaitOptions,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 500;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last as T;
    await sleep(interval);
  }
  throw new Error(
    `timed out after ${opts.timeoutMs}ms waiting for: ${opts.what} (last observed: ${safeJson(last)})`,
  );
}

/**
 * Live ColonyState feed. Polls `control.getState()` over HTTP at `pollMs` and
 * records every distinct state (by tick). `next(predicate)` resolves on the
 * first matching state (buffered or future); `collect(n)` waits for n distinct
 * states. Always `stop()` in a finally block.
 *
 * Polling cadence is comfortably slower than the tick rate — the harness only
 * needs to observe state transitions, not every tick — so it stays well inside
 * the GET-memory budget even though private servers don't enforce one.
 */
export class StateWatcher {
  readonly states: ColonyState[] = [];
  private waiters: Array<{
    predicate: (s: ColonyState) => boolean;
    resolve: (s: ColonyState) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastTick = -1;

  constructor(
    private readonly bridge: ScreepsBridge,
    private readonly pollMs = 500,
  ) {
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let state: ColonyState | null;
    try {
      state = await this.bridge.control.getState();
    } catch {
      return; // transient read error; next interval retries
    }
    if (!state || this.stopped) return;
    // Only record well-formed ColonyState snapshots. A read can momentarily
    // land between the executor bootstrapping Memory.bridge and its first
    // writeState (or just after a reset), yielding a partial object; skip
    // those rather than feed undefined fields to predicates.
    if (
      typeof state.tick !== 'number' ||
      typeof state.heartbeat !== 'number' ||
      !state.creeps ||
      typeof state.creeps.byRole !== 'object' ||
      !state.colonies ||
      typeof state.colonies !== 'object'
    ) {
      return;
    }
    // Dedupe: only record genuinely new ticks.
    if (state.tick === this.lastTick) return;
    this.lastTick = state.tick;
    this.states.push(state);
    this.waiters = this.waiters.filter((w) => {
      if (!w.predicate(state!)) return true;
      clearTimeout(w.timer);
      w.resolve(state!);
      return false;
    });
  }

  /** Latest state seen so far (undefined before the first successful read). */
  get latest(): ColonyState | undefined {
    return this.states[this.states.length - 1];
  }

  /** First state matching `predicate` (checks buffered states first). */
  next(predicate: (s: ColonyState) => boolean, opts: WaitOptions): Promise<ColonyState> {
    const buffered = this.states.find(predicate);
    if (buffered) return Promise.resolve(buffered);
    return new Promise<ColonyState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(
          new Error(
            `timed out after ${opts.timeoutMs}ms waiting for state where: ${opts.what}` +
              ` (${this.states.length} states seen, latest: ${safeJson(summarize(this.latest))})`,
          ),
        );
      }, opts.timeoutMs);
      timer.unref?.();
      const waiter = { predicate, resolve, timer };
      this.waiters.push(waiter);
    });
  }

  /** Collect states until at least `n` distinct ticks are buffered. */
  async collect(n: number, opts: Omit<WaitOptions, 'what'>): Promise<ColonyState[]> {
    await waitFor(async () => this.states.length >= n, {
      ...opts,
      what: `${n} distinct colony states (got ${this.states.length})`,
    });
    return this.states.slice(0, n);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
  }
}

/** Wait until the live creep count for `role` reaches `n`. */
export function waitForCreepCount(
  watcher: StateWatcher,
  role: string,
  n: number,
  timeoutMs: number,
): Promise<ColonyState> {
  return watcher.next((s) => (s.creeps.byRole[role] ?? 0) >= n, {
    timeoutMs,
    what: `creeps.byRole.${role} >= ${n}`,
  });
}

/**
 * Wait until the executor acks a directive revision `>= rev`, observed over
 * the HTTP read path (`control.getAck()`). This is the authoritative ground
 * truth of the ack handshake — independent of the bridge's WS `awaitAck`
 * (which scenario C verifies separately via the `bridge.ackJson` mirror).
 */
export function waitForAck(bridge: ScreepsBridge, rev: number, timeoutMs: number): Promise<DirectiveAck> {
  return waitFor(
    async () => {
      const ack = await bridge.control.getAck();
      return ack && ack.directiveVersion >= rev ? ack : null;
    },
    { timeoutMs, intervalMs: 500, what: `Memory.bridge.ack.directiveVersion >= ${rev}` },
  );
}

/**
 * Collector for the bot's console output (its live telemetry: [hb]/[inf]/
 * [wrn]/[err] lines) over the WS console channel. The console channel streams
 * string arrays, which the real backend delivers intact (unlike object memory
 * paths), so this is a genuine WS read.
 */
export async function collectConsole(
  bridge: ScreepsBridge,
): Promise<{ lines: string[]; stop: () => void }> {
  const lines: string[] = [];
  await bridge.connectSocket();
  const channel = Channels.console(await bridge.getUserId());
  const stop = bridge.subscribeChannel(channel, (m) => {
    const data = m.data as { messages?: { log?: string[] } } | undefined;
    for (const line of data?.messages?.log ?? []) lines.push(line);
  });
  return { lines, stop };
}

function summarize(s: ColonyState | undefined): unknown {
  if (!s) return undefined;
  return {
    tick: s.tick,
    heartbeat: s.heartbeat,
    creeps: s.creeps,
    colonies: s.colonies ? Object.keys(s.colonies) : [],
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
