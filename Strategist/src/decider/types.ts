/**
 * The decider contract. A decider observes a snapshot and returns the directive
 * patch it wants applied, or `null` when nothing should change (the common case —
 * most cycles are no-ops). It is async-friendly so the LLM-backed implementation
 * fits the same shape as the synchronous rule-based one.
 *
 * Deciders return *intent*; the strategist clamps, gates, and proposes it. A
 * decider can never emit creep-level or per-tick actions — the directive shape
 * doesn't allow them.
 */

import type { CommanderSnapshot, Directives } from 'screeps-web-api-bridge';
import type { DeciderKind } from '../config';

export type Snapshot = CommanderSnapshot;
export type DirectivePatch = Partial<Directives>;

export interface Decider {
  readonly kind: DeciderKind;
  decide(snapshot: Snapshot): Promise<DirectivePatch | null> | DirectivePatch | null;
  /**
   * Clear any internal caching so the next `decide()` recomputes from scratch —
   * e.g. forces a fresh LLM call even when the state digest is unchanged. Used by a
   * manual "run now". Optional; the rule-based decider has no cache to clear.
   */
  reset?(): void;
}
