/**
 * Common response shapes shared across modules.
 *
 * The Screeps API wraps successful responses in `{ ok: 1, ... }` and failures
 * in `{ ok: 0, error: "..." }`. The HTTP client unwraps `ok` before returning,
 * so module-level response types describe the *unwrapped* payload.
 */

/** Raw envelope as returned on the wire, before the client unwraps it. */
export interface OkEnvelope {
  ok: 0 | 1;
  error?: string;
  [key: string]: unknown;
}

/** A shard name, e.g. `shard0`..`shard3`, or `null` on single-shard servers. */
export type Shard = string;

/** Room name, e.g. `W7N3`, `E0S0`. */
export type RoomName = string;

/** The four flag/secondary colours are integers 1..10 (COLOR_* constants). */
export type FlagColor = number;

/** A snapshot of one rate-limit class's current budget. */
export interface RateLimitBudget {
  /** Class label (e.g. `GET user/code`, `global`). */
  label: string;
  /** Maximum requests permitted in the window. */
  max: number;
  /** Requests still available right now. */
  remaining: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Epoch-ms when the budget fully resets. */
  resetAt: number;
}
