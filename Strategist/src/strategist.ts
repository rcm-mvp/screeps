/**
 * The strategist — the observe → decide → diff/gate → propose → await-ack loop,
 * run at strategic cadence (never per tick).
 *
 * Reads are cheap and continuous: state arrives over the WS `watchState` channel.
 * Writes are rare and deliberate: directives ride the POST memory budget, are
 * diff-gated against current directives, and hard-capped per hour. Everything is
 * built to degrade to "do nothing" safely — null state, a stalled executor, an
 * exhausted budget, the kill switch, or a misbehaving LLM all back off rather than
 * ever making the colony worse.
 */

import type {
  AwaitAckOptions,
  ColonyState,
  CommanderSnapshot,
  DirectiveAck,
  Directives,
} from 'screeps-web-api-bridge';
import type { DeciderKind, StrategistConfig } from './config';
import { buildDigest, digestHash, type Digest } from './digest';
import type { Decider } from './decider/types';
import { applyPreconditions } from './guardrails';
import { History, SteeringStore, type DecisionEntry, type SteeringState } from './history';
import { validateAndClamp } from './schema';

/** The slice of the bridge the strategist depends on — easy to mock in tests. */
export interface BridgePort {
  snapshot(): Promise<CommanderSnapshot>;
  propose(patch: Partial<Directives>, opts?: AwaitAckOptions): Promise<{ rev: number; applied: boolean }>;
  watchState(cb: (state: ColonyState) => void): () => void;
}

export type StrategistStatus =
  | 'starting'
  | 'idle'
  | 'live'
  | 'dry-run'
  | 'kill-switch'
  | 'awaiting-executor'
  | 'executor-stalled'
  | 'budget-capped'
  | 'error';

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface StrategistDeps {
  bridge: BridgePort;
  decider: Decider;
  history: History;
  steering: SteeringStore;
  config: StrategistConfig;
  logger?: Logger;
  now?: () => number;
  /** Live Ollama call count for observability. */
  getOllamaCalls?: () => number;
  /** Rebuild the decider when the kind is switched at runtime. */
  deciderFactory?: (kind: DeciderKind) => Decider;
}

const HOUR_MS = 3_600_000;

export interface StatusSnapshot {
  status: StrategistStatus;
  decider: DeciderKind;
  dryRun: boolean;
  killSwitch: boolean;
  connected: boolean;
  tick: number | null;
  heartbeat: number | null;
  budget: { writesThisHour: number; maxPerHour: number };
  ollamaCalls: number;
  currentDirectives: Directives;
  digest: Digest | null;
  steering: SteeringState;
  latestWritten: DecisionEntry | null;
  history: DecisionEntry[];
}

export class Strategist {
  private state: ColonyState | null = null;
  private directives: Directives = {};
  private ack: DirectiveAck | null = null;

  private dryRun: boolean;
  private killSwitch: boolean;
  private decider: Decider;

  private lastDigest: string | null = null;
  private lastEvalAt = 0;
  private inFlight = false;
  private writeTimes: number[] = [];
  private lastHeartbeat: number | null = null;
  private stallCount = 0;
  private lastEntryKey: string | null = null;

  private stopWatch: (() => void) | null = null;
  private slowTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  public status: StrategistStatus = 'starting';

  constructor(private readonly deps: StrategistDeps) {
    this.dryRun = deps.config.dryRun;
    this.killSwitch = deps.config.killSwitch;
    this.decider = deps.decider;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Live kill-switch state — used by sibling loops (e.g. the planner) to back
   *  off when the strategist is in hands-off mode. */
  isKilled(): boolean {
    return this.killSwitch;
  }

  private log(): Logger {
    return this.deps.logger ?? noopLogger;
  }

  /** Connect, seed from one snapshot, subscribe to live state, run the loop. */
  async start(): Promise<void> {
    this.started = true;
    try {
      const snap = await this.deps.bridge.snapshot();
      this.state = snap.state;
      this.directives = snap.directives ?? {};
      this.ack = snap.ack;
    } catch (e) {
      this.log().warn('startup snapshot failed (will rely on live state)', { err: String(e) });
    }

    this.stopWatch = this.deps.bridge.watchState((s) => this.onState(s));
    this.slowTimer = setInterval(() => void this.evaluate('slow-tick'), this.deps.config.slowTickMs);
    await this.evaluate('startup');
  }

  stop(): void {
    this.started = false;
    this.stopWatch?.();
    this.stopWatch = null;
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.slowTimer = null;
  }

  private onState(state: ColonyState): void {
    this.state = state;
    void this.evaluate('state-change');
  }

  /** One full evaluation cycle. Guarded by an in-flight lock; never overlaps. */
  async evaluate(trigger: string): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = this.now();
      const force = trigger === 'startup' || trigger === 'manual';
      const hash = digestHash(this.state);
      const changed = hash !== this.lastDigest;
      const slowElapsed = now - this.lastEvalAt >= this.deps.config.slowTickMs;

      if (!force) {
        if (now - this.lastEvalAt < this.deps.config.minEvalIntervalMs) return; // throttle
        if (!changed && !slowElapsed) return; // nothing material + slow tick not due
      }
      this.lastEvalAt = now;
      this.lastDigest = hash;

      // Kill switch halts all writing; the colony stays autonomous.
      if (this.killSwitch) {
        this.status = 'kill-switch';
        return;
      }

      // Tolerate a not-yet-deployed executor.
      if (!this.state) {
        this.status = 'awaiting-executor';
        return;
      }

      // Detect a stalled executor (heartbeat not advancing) and back off.
      if (this.lastHeartbeat !== null && this.state.heartbeat === this.lastHeartbeat) {
        this.stallCount += 1;
      } else {
        this.stallCount = 0;
      }
      this.lastHeartbeat = this.state.heartbeat;
      if (this.stallCount >= this.deps.config.stallEvalThreshold) {
        this.status = 'executor-stalled';
        this.recordOnce({
          tick: this.state.tick,
          decider: this.decider.kind,
          outcome: 'skipped',
          patch: null,
          blocked: ['executor heartbeat not advancing'],
          trigger,
        });
        return;
      }

      // Decide.
      const snap: CommanderSnapshot = {
        state: this.state,
        directives: this.directives,
        ack: this.ack,
      };
      const raw = await this.decider.decide(snap);
      if (!raw) {
        this.status = 'idle';
        return;
      }

      // Clamp, then enforce big-move preconditions (defense in depth).
      const cleaned = validateAndClamp(raw);
      const pre = applyPreconditions(cleaned, this.state, this.deps.config);
      const patch = pre.patch;
      const note = typeof raw.note === 'string' ? raw.note : patch.note;

      if (Object.keys(patch).filter((k) => k !== 'note').length === 0) {
        this.status = 'idle';
        this.recordOnce({
          tick: this.state.tick,
          decider: this.decider.kind,
          outcome: 'blocked',
          patch: null,
          blocked: pre.blocked,
          note,
          trigger,
        });
        return;
      }

      // Diff-gate — skip writes that wouldn't change anything.
      if (isSubset(patch, this.directives)) {
        this.status = 'idle';
        this.recordOnce({
          tick: this.state.tick,
          decider: this.decider.kind,
          outcome: 'no-change',
          patch,
          blocked: pre.blocked.length ? pre.blocked : undefined,
          note,
          trigger,
        });
        return;
      }

      // Budget cap — never exceed the per-hour write ceiling.
      this.pruneWrites(now);
      if (this.writeTimes.length >= this.deps.config.maxWritesPerHour) {
        this.status = 'budget-capped';
        this.recordOnce({
          tick: this.state.tick,
          decider: this.decider.kind,
          outcome: 'budget-capped',
          patch,
          note,
          trigger,
        });
        return;
      }

      // Dry-run — record the decision, write nothing.
      if (this.dryRun) {
        this.status = 'dry-run';
        this.recordOnce({
          tick: this.state.tick,
          decider: this.decider.kind,
          outcome: 'dry-run',
          patch,
          blocked: pre.blocked.length ? pre.blocked : undefined,
          note,
          trigger,
        });
        return;
      }

      // Live — propose and await the executor's ack.
      this.writeTimes.push(now);
      let rev: number;
      let applied: boolean;
      try {
        const result = await this.deps.bridge.propose(patch);
        rev = result.rev;
        applied = result.applied;
      } catch (e) {
        this.status = 'error';
        this.deps.history.record({
          tick: this.state.tick,
          decider: this.decider.kind,
          outcome: 'error',
          patch,
          note: `propose failed: ${e instanceof Error ? e.message : String(e)}`,
          trigger,
        });
        this.lastEntryKey = null;
        return;
      }

      // We are the only writer — update the local directive cache (no extra read).
      this.directives = { ...this.directives, ...patch, rev };
      if (applied) this.ack = { directiveVersion: rev, appliedTick: this.state.tick };
      this.status = 'live';
      this.deps.history.record({
        tick: this.state.tick,
        decider: this.decider.kind,
        outcome: 'written',
        patch,
        rev,
        appliedConfirmed: applied,
        blocked: pre.blocked.length ? pre.blocked : undefined,
        note,
        trigger,
      });
      this.lastEntryKey = null; // a write always advances; the next quiet entry should record
    } finally {
      this.inFlight = false;
    }
  }

  /** Record, but collapse consecutive identical quiet entries (no-op spam control). */
  private recordOnce(entry: Parameters<History['record']>[0]): void {
    const key = `${entry.outcome}:${JSON.stringify(entry.patch)}:${JSON.stringify(entry.blocked ?? null)}`;
    if (key === this.lastEntryKey) return;
    this.lastEntryKey = key;
    this.deps.history.record(entry);
  }

  private pruneWrites(now: number): void {
    const cutoff = now - HOUR_MS;
    this.writeTimes = this.writeTimes.filter((t) => t > cutoff);
  }

  // ---- Control surface (live toggles from the UI) ----

  setControl(patch: { dryRun?: boolean; killSwitch?: boolean; decider?: DeciderKind }): void {
    if (typeof patch.dryRun === 'boolean') this.dryRun = patch.dryRun;
    if (typeof patch.killSwitch === 'boolean') this.killSwitch = patch.killSwitch;
    if (patch.decider && patch.decider !== this.decider.kind) {
      if (this.deps.deciderFactory) {
        this.decider = this.deps.deciderFactory(patch.decider);
        // Run the freshly-selected decider promptly rather than waiting for the
        // next material state change or the slow-tick fallback.
        void this.evaluate('manual');
      } else {
        this.log().warn('decider switch requested but no factory configured', { to: patch.decider });
      }
    }
  }

  /**
   * Force a fresh evaluation now (the "run now" button). Bypasses the cadence
   * gates and clears the decider's cache so the LLM is re-queried even when the
   * state digest is unchanged. Returns the resulting status.
   */
  async runNow(): Promise<StatusSnapshot> {
    this.decider.reset?.();
    await this.evaluate('manual');
    return this.getStatus();
  }

  setSteering(patch: { shortTerm?: string | null; longTerm?: string | null }): void {
    if (patch.shortTerm !== undefined) this.deps.steering.setShortTerm(patch.shortTerm);
    if (patch.longTerm !== undefined) this.deps.steering.setLongTerm(patch.longTerm);
  }

  getStatus(): StatusSnapshot {
    this.pruneWrites(this.now());
    return {
      status: this.status,
      decider: this.decider.kind,
      dryRun: this.dryRun,
      killSwitch: this.killSwitch,
      connected: this.started,
      tick: this.state?.tick ?? null,
      heartbeat: this.state?.heartbeat ?? null,
      budget: { writesThisHour: this.writeTimes.length, maxPerHour: this.deps.config.maxWritesPerHour },
      ollamaCalls: this.deps.getOllamaCalls ? this.deps.getOllamaCalls() : 0,
      currentDirectives: this.directives,
      digest: this.state
        ? buildDigest({ state: this.state, directives: this.directives, ack: this.ack })
        : null,
      steering: this.deps.steering.snapshot(),
      latestWritten: this.deps.history.latestWritten(),
      history: this.deps.history.list(),
    };
  }
}

const noopLogger: Logger = { info() {}, warn() {}, error() {} };

/** True when every field in `patch` already deep-equals the value in `current`. */
export function isSubset(patch: Directives, current: Directives): boolean {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'note') continue; // note is descriptive, not a state to match
    if (!deepEqual(value, (current as Record<string, unknown>)[key])) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
    return true;
  }
  return false;
}
