import { describe, it, expect } from 'vitest';
import { RuleBasedDecider } from '../src/decider/rules';
import { loadConfig } from '../src/config';
import { colony, state, snap } from './helpers';

const config = loadConfig({
  EXPAND_CANDIDATES: 'W5N8,W6N8',
  MIN_STORED_ENERGY_FOR_EXPAND: '50000',
  PLATEAU_STORAGE_ENERGY: '100000',
  BUCKET_FLOOR: '2000',
  MAX_UPGRADER_QUOTA: '8',
});
const decider = new RuleBasedDecider(config);

describe('RuleBasedDecider', () => {
  it('returns null for null state', () => {
    expect(decider.decide(snap(null))).toBeNull();
  });

  it('switches to defend when a home threat is active', () => {
    const s = state({ colonies: { W1N1: colony({ threats: { hostiles: 2, safeMode: false } }) } });
    expect(decider.decide(snap(s, { posture: 'economy' }))).toMatchObject({ posture: 'defend' });
  });

  it('does not re-issue defend when already defending', () => {
    const s = state({ colonies: { W1N1: colony({ threats: { hostiles: 2, safeMode: false } }) } });
    expect(decider.decide(snap(s, { posture: 'defend' }))).toBeNull();
  });

  it('trims non-essential quotas under CPU pressure', () => {
    const s = state({ cpu: { used: 19, limit: 20, bucket: 1000 } });
    const patch = decider.decide(snap(s, { roleQuotas: { upgrader: 6, builder: 3, hauler: 4 } }));
    expect(patch?.roleQuotas).toMatchObject({ upgrader: 1, builder: 1, hauler: 4 });
  });

  it('expands when stable with GCL headroom and a viable target', () => {
    const s = state({
      gcl: { level: 2, progress: 0, progressTotal: 1 },
      colonies: { W1N1: colony({ storageEnergy: 80_000 }) },
    });
    const patch = decider.decide(snap(s, { posture: 'economy' }));
    expect(patch).toMatchObject({ posture: 'expand', targetRooms: ['W5N8'] });
  });

  it('does not expand without GCL headroom', () => {
    const s = state({
      gcl: { level: 1, progress: 0, progressTotal: 1 },
      colonies: { W1N1: colony({ storageEnergy: 80_000 }) },
    });
    // Stable economy, no headroom → no change.
    expect(decider.decide(snap(s, { posture: 'economy' }))).toBeNull();
  });

  it('bumps the upgrader quota on a storage surplus at plateau', () => {
    const s = state({ colonies: { W1N1: colony({ storageEnergy: 150_000 }) } });
    const patch = decider.decide(snap(s, { posture: 'economy', roleQuotas: { upgrader: 2 } }));
    expect(patch?.roleQuotas).toMatchObject({ upgrader: 8 });
  });

  it('settles back to economy from a stale non-economy posture', () => {
    const s = state();
    expect(decider.decide(snap(s, { posture: 'war' }))).toMatchObject({ posture: 'economy' });
  });

  it('returns null when the colony is already nominal', () => {
    expect(decider.decide(snap(state(), { posture: 'economy' }))).toBeNull();
  });
});
