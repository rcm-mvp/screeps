import { describe, it, expect, vi } from 'vitest';
import type { ColonyState, CommanderSnapshot, Directives } from 'screeps-web-api-bridge';
import { Strategist, type BridgePort } from '../src/strategist';
import { History, SteeringStore } from '../src/history';
import { loadConfig, type StrategistConfig } from '../src/config';
import type { Decider, DirectivePatch } from '../src/decider/types';
import { state, snap } from './helpers';

const NOW = 1_000_000;

class StubDecider implements Decider {
  readonly kind = 'rules' as const;
  resetCalls = 0;
  constructor(public next: DirectivePatch | null) {}
  decide(): DirectivePatch | null {
    return this.next;
  }
  reset(): void {
    this.resetCalls += 1;
  }
}

function fakeBridge(initial: CommanderSnapshot) {
  const propose = vi.fn(async (_patch: Partial<Directives>) => ({ rev: 99, applied: true }));
  const bridge: BridgePort = {
    snapshot: async () => initial,
    propose,
    watchState: () => () => {},
  };
  return { bridge, propose };
}

function build(decider: Decider, initial: CommanderSnapshot, env: Record<string, string> = {}) {
  const config: StrategistConfig = loadConfig({ MIN_EVAL_INTERVAL_MS: '0', ...env });
  const history = new History(100);
  const steering = new SteeringStore();
  const { bridge, propose } = fakeBridge(initial);
  const strat = new Strategist({ bridge, decider, history, steering, config, now: () => NOW });
  // Seed internal state directly (avoids the live timer); evaluate('manual') is forced.
  const internal = strat as unknown as { state: ColonyState | null; directives: Directives };
  internal.state = initial.state;
  internal.directives = initial.directives;
  return { strat, propose, history, internal };
}

describe('Strategist loop', () => {
  it('skips redundant writes (diff-gate)', async () => {
    const { strat, propose, history } = build(new StubDecider({ posture: 'economy' }), snap(state(), { posture: 'economy', rev: 1 }), { DRY_RUN: 'false' });
    await strat.evaluate('manual');
    expect(propose).not.toHaveBeenCalled();
    expect(history.latest()?.outcome).toBe('no-change');
  });

  it('proposes a changing directive when live', async () => {
    const { strat, propose, history } = build(new StubDecider({ posture: 'defend' }), snap(state(), { posture: 'economy', rev: 1 }), { DRY_RUN: 'false' });
    await strat.evaluate('manual');
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith({ posture: 'defend' });
    expect(history.latest()).toMatchObject({ outcome: 'written', rev: 99, appliedConfirmed: true });
  });

  it('never writes in dry-run, but records the decision', async () => {
    const { strat, propose, history } = build(new StubDecider({ posture: 'defend' }), snap(state(), { posture: 'economy', rev: 1 }), { DRY_RUN: 'true' });
    await strat.evaluate('manual');
    expect(propose).not.toHaveBeenCalled();
    expect(history.latest()).toMatchObject({ outcome: 'dry-run', patch: { posture: 'defend' } });
    expect(strat.status).toBe('dry-run');
  });

  it('backs off on null state (executor not deployed)', async () => {
    const { strat, propose, internal } = build(new StubDecider({ posture: 'defend' }), snap(null), { DRY_RUN: 'false' });
    internal.state = null;
    await strat.evaluate('manual');
    expect(propose).not.toHaveBeenCalled();
    expect(strat.status).toBe('awaiting-executor');
  });

  it('backs off when the executor heartbeat stalls', async () => {
    const { strat, propose, history } = build(new StubDecider(null), snap(state({ heartbeat: 500 }), {}), { STALL_EVAL_THRESHOLD: '2', DRY_RUN: 'false' });
    await strat.evaluate('manual');
    await strat.evaluate('manual');
    await strat.evaluate('manual');
    expect(propose).not.toHaveBeenCalled();
    expect(strat.status).toBe('executor-stalled');
    expect(history.latest()).toMatchObject({ outcome: 'skipped' });
    expect(history.latest()?.blocked?.join(' ')).toMatch(/heartbeat/);
  });

  it('caps writes per hour', async () => {
    const decider = new StubDecider({ posture: 'defend' });
    const { strat, propose, history, internal } = build(decider, snap(state(), { posture: 'economy', rev: 1 }), {
      MAX_WRITES_PER_HOUR: '1',
      DRY_RUN: 'false',
    });
    await strat.evaluate('manual'); // writes #1
    expect(propose).toHaveBeenCalledTimes(1);
    decider.next = { posture: 'economy' };
    internal.state = state({ tick: 1001 });
    await strat.evaluate('manual'); // capped
    expect(propose).toHaveBeenCalledTimes(1);
    expect(history.latest()?.outcome).toBe('budget-capped');
    expect(strat.status).toBe('budget-capped');
  });

  it('runNow resets the decider and forces a fresh evaluation', async () => {
    const decider = new StubDecider({ posture: 'defend' });
    const { strat, propose } = build(decider, snap(state(), { posture: 'economy', rev: 1 }), { DRY_RUN: 'false' });
    const status = await strat.runNow();
    expect(decider.resetCalls).toBe(1);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(status.status).toBe('live');
  });

  it('applies guardrail preconditions before proposing (blocks unsafe expand)', async () => {
    // GCL headroom but no stored energy → expand must be blocked, not written.
    const s = state({ gcl: { level: 5, progress: 0, progressTotal: 1 } });
    const { strat, propose, history } = build(
      new StubDecider({ posture: 'expand', targetRooms: ['W5N8'] }),
      snap(s, { posture: 'economy', rev: 1 }),
      { DRY_RUN: 'false', MIN_STORED_ENERGY_FOR_EXPAND: '50000' },
    );
    await strat.evaluate('manual');
    expect(propose).not.toHaveBeenCalled();
    expect(history.latest()).toMatchObject({ outcome: 'blocked' });
  });
});
