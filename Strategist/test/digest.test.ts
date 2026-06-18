import { describe, it, expect } from 'vitest';
import { digestHash, buildDigest, hasActiveHomeThreat, totalStorageEnergy } from '../src/digest';
import { colony, state, snap } from './helpers';

describe('digestHash', () => {
  it('is stable under per-tick noise (tick, cpu used, spawn energy, progress)', () => {
    const a = state();
    const b = state({
      tick: 9999,
      cpu: { used: 19, limit: 20, bucket: 10_000 },
      gcl: { level: 1, progress: 555, progressTotal: 1000 },
      colonies: { W1N1: colony({ energyAvailable: 50 }) },
    });
    expect(digestHash(a)).toBe(digestHash(b));
  });

  it('changes when an RCL changes', () => {
    const a = state({ colonies: { W1N1: colony({ rcl: 4 }) } });
    const b = state({ colonies: { W1N1: colony({ rcl: 5 }) } });
    expect(digestHash(a)).not.toBe(digestHash(b));
  });

  it('changes when a threat appears', () => {
    const a = state();
    const b = state({ colonies: { W1N1: colony({ threats: { hostiles: 2, safeMode: false } }) } });
    expect(digestHash(a)).not.toBe(digestHash(b));
  });

  it('changes when stored energy crosses a bucket boundary (plateau)', () => {
    const a = state({ colonies: { W1N1: colony({ storageEnergy: 5_000 }) } });
    const b = state({ colonies: { W1N1: colony({ storageEnergy: 120_000 }) } });
    expect(digestHash(a)).not.toBe(digestHash(b));
  });

  it('treats null state distinctly', () => {
    expect(digestHash(null)).toBe('null');
    expect(digestHash(null)).not.toBe(digestHash(state()));
  });
});

describe('digest aggregates', () => {
  it('sums stored energy and detects active home threat', () => {
    const s = state({
      colonies: {
        W1N1: colony({ storageEnergy: 40_000 }),
        W2N2: colony({ storageEnergy: 60_000, threats: { hostiles: 1, safeMode: false } }),
      },
    });
    expect(totalStorageEnergy(s)).toBe(100_000);
    expect(hasActiveHomeThreat(s)).toBe(true);
  });

  it('does not count a safe-moded room as an active threat', () => {
    const s = state({ colonies: { W1N1: colony({ threats: { hostiles: 3, safeMode: true } }) } });
    expect(hasActiveHomeThreat(s)).toBe(false);
  });

  it('buildDigest carries current directives through for the prompt', () => {
    const d = buildDigest(snap(state(), { posture: 'economy', rev: 2 }));
    expect(d.directives).toMatchObject({ posture: 'economy', rev: 2 });
    expect(d.ownedRooms).toBe(1);
  });
});
