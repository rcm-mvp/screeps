/**
 * Guardrails — defense in depth, independent of which decider produced a patch.
 *
 * `validateAndClamp` (schema.ts) already repaired ranges/types. This layer enforces
 * *strategic* preconditions: a big move (expand / war) is only allowed when the
 * colony can actually sustain it. If a precondition fails the offending fields are
 * stripped (rather than forcing some other posture), and the reason is recorded so
 * the decision log explains why the AI's intent was held back. The bot clamps too —
 * this is a second net, not the first line.
 */

import type { ColonyState, Directives } from 'screeps-web-api-bridge';
import type { StrategistConfig } from './config';
import { hasActiveHomeThreat, totalStorageEnergy } from './digest';

export interface PreconditionResult {
  /** The patch with any disallowed big-move fields stripped. */
  patch: Directives;
  /** Human-readable reasons a field was blocked (empty when nothing was blocked). */
  blocked: string[];
}

const BIG_MOVES = new Set<NonNullable<Directives['posture']>>(['expand', 'war']);

export function applyPreconditions(
  patch: Directives,
  state: ColonyState | null,
  config: StrategistConfig,
): PreconditionResult {
  const out: Directives = { ...patch };
  const blocked: string[] = [];

  if (out.posture && BIG_MOVES.has(out.posture)) {
    const reasons = bigMoveBlockers(out.posture, state, config);
    if (reasons.length) {
      blocked.push(...reasons);
      delete out.posture;
      // An expand target only makes sense alongside the expand posture.
      if (patch.posture === 'expand') delete out.targetRooms;
    }
  }

  return { patch: out, blocked };
}

function bigMoveBlockers(
  posture: NonNullable<Directives['posture']>,
  state: ColonyState | null,
  config: StrategistConfig,
): string[] {
  const reasons: string[] = [];
  if (!state) {
    reasons.push(`${posture} blocked: no colony state yet`);
    return reasons;
  }

  if (hasActiveHomeThreat(state)) {
    reasons.push(`${posture} blocked: active threat at home (defend first)`);
  }

  const stored = totalStorageEnergy(state);
  if (stored < config.thresholds.minStoredEnergyForExpand) {
    reasons.push(
      `${posture} blocked: stored energy ${stored} < ${config.thresholds.minStoredEnergyForExpand}`,
    );
  }

  if (posture === 'expand') {
    const ownedRooms = Object.keys(state.colonies).length;
    if (state.gcl.level <= ownedRooms) {
      reasons.push(`expand blocked: no GCL headroom (GCL ${state.gcl.level}, rooms ${ownedRooms})`);
    }
  }

  return reasons;
}
