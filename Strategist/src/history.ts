/**
 * Decision history (a bounded in-memory ring) and the steering store.
 *
 * History is the audit trail the UI renders: every cycle — written, dry-run,
 * skipped, blocked — lands here with the patch, the outcome, and the rationale
 * (the LLM's reasoning, captured into `note`). Steering is the human's input to
 * the AI: short-term guidance applied to the *next* iteration only, and long-term
 * guidance included in every prompt.
 */

import type { Directives } from 'screeps-web-api-bridge';
import type { DeciderKind } from './config';

export type DecisionOutcome =
  | 'written' // proposed to the executor
  | 'dry-run' // computed but not written (dry-run mode)
  | 'no-change' // patch already matches current directives
  | 'blocked' // guardrail preconditions stripped the move
  | 'budget-capped' // write budget exhausted this hour
  | 'skipped' // stale/stalled/kill-switch — no decision made
  | 'error'; // propose failed

export interface DecisionEntry {
  id: number;
  ts: number;
  tick: number | null;
  decider: DeciderKind;
  outcome: DecisionOutcome;
  /** The cleaned patch under consideration, or null for a pure no-op. */
  patch: Directives | null;
  rev?: number;
  /** Whether the executor acked the write (only meaningful when outcome==='written'). */
  appliedConfirmed?: boolean;
  /** Guardrail reasons a move was held back. */
  blocked?: string[];
  /** Rationale — the LLM's reasoning, or a rule-decider explanation. */
  note?: string;
  /** Trigger that caused this evaluation (state-change / slow-tick / startup / manual). */
  trigger?: string;
}

export class History {
  private entries: DecisionEntry[] = [];
  private seq = 0;

  constructor(private readonly max: number) {}

  record(entry: Omit<DecisionEntry, 'id' | 'ts'> & { ts?: number }): DecisionEntry {
    const full: DecisionEntry = { id: ++this.seq, ts: entry.ts ?? Date.now(), ...entry };
    this.entries.push(full);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    return full;
  }

  /** Newest first. */
  list(): DecisionEntry[] {
    return this.entries.slice().reverse();
  }

  latest(): DecisionEntry | null {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  /** Most recent entry that actually wrote a directive (the live strategy). */
  latestWritten(): DecisionEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].outcome === 'written') return this.entries[i];
    }
    return null;
  }
}

export interface SteeringState {
  shortTerm: string | null;
  longTerm: string | null;
}

/**
 * Human steering of the AI. Short-term is one-shot: it is consumed by the next
 * decision and then cleared. Long-term persists across iterations.
 */
export class SteeringStore {
  private shortTerm: string | null = null;
  private longTerm: string | null = null;

  setShortTerm(text: string | null): void {
    this.shortTerm = text && text.trim() ? text.trim() : null;
  }

  setLongTerm(text: string | null): void {
    this.longTerm = text && text.trim() ? text.trim() : null;
  }

  /** Read-and-clear the short-term guidance (applies to one iteration only). */
  consumeShortTerm(): string | null {
    const v = this.shortTerm;
    this.shortTerm = null;
    return v;
  }

  getLongTerm(): string | null {
    return this.longTerm;
  }

  snapshot(): SteeringState {
    return { shortTerm: this.shortTerm, longTerm: this.longTerm };
  }
}
