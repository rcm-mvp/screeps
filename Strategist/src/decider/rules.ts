/**
 * Rule-based decider — the default, the deterministic baseline, and the always-on
 * fallback when the LLM misbehaves. No API cost, fully testable. Heuristics run in
 * priority order and return `null` whenever the colony is already in the right
 * shape (so the strategist's diff-gate stays quiet).
 *
 * Big moves (expand) are proposed only when clearly safe; the guardrail layer is a
 * second check on top of this.
 */

import type { StrategistConfig } from '../config';
import { hasActiveHomeThreat, totalStorageEnergy } from '../digest';
import type { Decider, DirectivePatch, Snapshot } from './types';

const NON_ESSENTIAL_ROLES = ['upgrader', 'builder'];
const NON_ESSENTIAL_FLOOR = 1;

export class RuleBasedDecider implements Decider {
  readonly kind = 'rules' as const;

  constructor(private readonly config: StrategistConfig) {}

  decide(snapshot: Snapshot): DirectivePatch | null {
    const state = snapshot.state;
    if (!state) return null;
    const cur = snapshot.directives ?? {};
    const th = this.config.thresholds;

    // 1) Defense — highest priority. An active home threat overrides everything.
    if (hasActiveHomeThreat(state)) {
      return cur.posture === 'defend'
        ? null
        : { posture: 'defend', note: 'rule: active threat at home → defend' };
    }

    const stored = totalStorageEnergy(state);
    const ownedRooms = Object.keys(state.colonies).length;

    // 2) CPU pressure — trim non-essential quotas to free CPU.
    if (state.cpu.bucket <= th.bucketFloor) {
      const current = (cur.roleQuotas ?? {}) as Record<string, number>;
      const trimmed = trimQuotas(current);
      if (!sameQuotas(trimmed, current)) {
        return {
          roleQuotas: trimmed,
          note: `rule: CPU bucket ${state.cpu.bucket} ≤ ${th.bucketFloor} → trim upgraders/builders`,
        };
      }
    }

    // 3) Expand — stable economy + GCL headroom + a viable, un-owned target.
    if (state.gcl.level > ownedRooms && stored >= th.minStoredEnergyForExpand) {
      const owned = new Set(Object.keys(state.colonies));
      const target = this.config.expandCandidates.find((r) => !owned.has(r));
      if (target) {
        const want = [target];
        const already = cur.posture === 'expand' && sameRooms(cur.targetRooms ?? [], want);
        if (already) return null;
        return {
          posture: 'expand',
          targetRooms: want,
          note: `rule: GCL headroom (${state.gcl.level}>${ownedRooms}) + ${stored} energy → expand to ${target}`,
        };
      }
    }

    // 4) Surplus at an RCL plateau — pour the overflow into upgrading.
    if (stored >= th.plateauStorageEnergy) {
      const curUpgrader = cur.roleQuotas?.upgrader ?? 0;
      if (curUpgrader < th.maxUpgraderQuota) {
        return {
          roleQuotas: { ...(cur.roleQuotas ?? {}), upgrader: th.maxUpgraderQuota },
          note: `rule: storage surplus ${stored} ≥ ${th.plateauStorageEnergy} → upgraders ${th.maxUpgraderQuota}`,
        };
      }
    }

    // 5) Nominal — settle back to economy if we were on a different posture.
    if (cur.posture && cur.posture !== 'economy') {
      return { posture: 'economy', note: 'rule: situation nominal → economy' };
    }
    return null;
  }
}

function trimQuotas(quotas: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...quotas };
  for (const role of NON_ESSENTIAL_ROLES) {
    if (typeof out[role] === 'number' && out[role] > NON_ESSENTIAL_FLOOR) {
      out[role] = NON_ESSENTIAL_FLOOR;
    }
  }
  return out;
}

function sameQuotas(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function sameRooms(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((r) => setB.has(r));
}
