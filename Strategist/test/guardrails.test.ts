import { describe, it, expect } from 'vitest';
import { validateAndClamp } from '../src/schema';
import { applyPreconditions } from '../src/guardrails';
import { loadConfig } from '../src/config';
import { colony, state } from './helpers';

const config = loadConfig({ MIN_STORED_ENERGY_FOR_EXPAND: '50000' });

describe('validateAndClamp', () => {
  it('drops an unknown posture', () => {
    expect(validateAndClamp({ posture: 'banana' }).posture).toBeUndefined();
    expect(validateAndClamp({ posture: 'war' }).posture).toBe('war');
  });

  it('filters invalid room names and dedupes', () => {
    const out = validateAndClamp({ targetRooms: ['W5N8', 'not-a-room', 'W5N8', 'E1S1'] });
    expect(out.targetRooms).toEqual(['W5N8', 'E1S1']);
  });

  it('clamps quotas to 0..20 and rounds', () => {
    const out = validateAndClamp({ roleQuotas: { upgrader: 99, hauler: -3, miner: 2.6, bad: 'x' } });
    expect(out.roleQuotas).toEqual({ upgrader: 20, hauler: 0, miner: 3 });
  });

  it('strips rev and unknown keys', () => {
    const out = validateAndClamp({ posture: 'economy', rev: 7, secret: 'leak' } as Record<string, unknown>);
    expect(out).toEqual({ posture: 'economy' });
  });
});

describe('applyPreconditions', () => {
  it('blocks expand when stored energy is below threshold', () => {
    const s = state({ gcl: { level: 5, progress: 0, progressTotal: 1 }, colonies: { W1N1: colony({ storageEnergy: 100 }) } });
    const res = applyPreconditions({ posture: 'expand', targetRooms: ['W5N8'] }, s, config);
    expect(res.patch.posture).toBeUndefined();
    expect(res.patch.targetRooms).toBeUndefined();
    expect(res.blocked.join(' ')).toMatch(/stored energy/);
  });

  it('blocks expand when there is no GCL headroom', () => {
    const s = state({ gcl: { level: 1, progress: 0, progressTotal: 1 }, colonies: { W1N1: colony({ storageEnergy: 200_000 }) } });
    const res = applyPreconditions({ posture: 'expand' }, s, config);
    expect(res.patch.posture).toBeUndefined();
    expect(res.blocked.join(' ')).toMatch(/GCL headroom/);
  });

  it('blocks a big move while a home threat is active', () => {
    const s = state({
      gcl: { level: 5, progress: 0, progressTotal: 1 },
      colonies: { W1N1: colony({ storageEnergy: 200_000, threats: { hostiles: 2, safeMode: false } }) },
    });
    const res = applyPreconditions({ posture: 'war' }, s, config);
    expect(res.patch.posture).toBeUndefined();
    expect(res.blocked.join(' ')).toMatch(/threat at home/);
  });

  it('allows expand when all preconditions are met', () => {
    const s = state({
      gcl: { level: 5, progress: 0, progressTotal: 1 },
      colonies: { W1N1: colony({ storageEnergy: 200_000 }) },
    });
    const res = applyPreconditions({ posture: 'expand', targetRooms: ['W5N8'] }, s, config);
    expect(res.patch.posture).toBe('expand');
    expect(res.patch.targetRooms).toEqual(['W5N8']);
    expect(res.blocked).toHaveLength(0);
  });

  it('leaves non-big-move postures untouched', () => {
    const res = applyPreconditions({ posture: 'defend' }, state(), config);
    expect(res.patch.posture).toBe('defend');
    expect(res.blocked).toHaveLength(0);
  });
});
