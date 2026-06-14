import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreepsBridge } from '../src/bridge';
import { CONTRACT_PATHS } from '../src/contract';

/**
 * Control-channel tests use a real ScreepsBridge but stub the underlying memory
 * module so we exercise the contract logic (rev auto-increment, merge, null
 * handling) without a server. This proves the control layer sits on top of the
 * raw memory methods rather than bypassing them.
 */
describe('ControlChannel', () => {
  let bridge: ScreepsBridge;
  let store: Record<string, unknown>;

  beforeEach(() => {
    bridge = new ScreepsBridge({ server: 'official', token: 'tok' });
    store = {};
    // Stub the memory module the control channel rides on.
    vi.spyOn(bridge.memory, 'get').mockImplementation(async (path: string) => store[path]);
    vi.spyOn(bridge.memory, 'set').mockImplementation(async (path: string, value: unknown) => {
      store[path] = value;
      return { ok: 1 };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('getState returns null when absent', async () => {
    expect(await bridge.control.getState()).toBeNull();
  });

  it('getDirectives defaults to {}', async () => {
    expect(await bridge.control.getDirectives()).toEqual({});
  });

  it('setDirectives auto-increments rev and merges', async () => {
    const rev1 = await bridge.control.setDirectives({ posture: 'economy' });
    expect(rev1).toBe(1);
    expect(store[CONTRACT_PATHS.directives]).toMatchObject({ posture: 'economy', rev: 1 });

    const rev2 = await bridge.control.setDirectives({ paused: true });
    expect(rev2).toBe(2);
    // Merge preserves the earlier posture.
    expect(store[CONTRACT_PATHS.directives]).toMatchObject({ posture: 'economy', paused: true, rev: 2 });
  });

  it('setQuota merges into existing roleQuotas', async () => {
    await bridge.control.setQuota('harvester', 4);
    await bridge.control.setQuota('upgrader', 2);
    expect(store[CONTRACT_PATHS.directives]).toMatchObject({
      roleQuotas: { harvester: 4, upgrader: 2 },
      rev: 2,
    });
  });

  it('ergonomic wrappers write the right fields', async () => {
    await bridge.control.pause();
    expect(store[CONTRACT_PATHS.directives]).toMatchObject({ paused: true });
    await bridge.control.setTargetRooms(['W1N1', 'W2N2']);
    expect(store[CONTRACT_PATHS.directives]).toMatchObject({ targetRooms: ['W1N1', 'W2N2'] });
  });

  it('awaitAck resolves true immediately when ack is already >= rev', async () => {
    store[CONTRACT_PATHS.ack] = { directiveVersion: 5, appliedTick: 100 };
    expect(await bridge.control.awaitAck(3, { timeoutMs: 50 })).toBe(true);
  });

  it('awaitAck times out (false) when no ack arrives and WS is down', async () => {
    // Force the WS path to fail so awaitAck falls back to polling (no network).
    vi.spyOn(bridge, 'connectSocket').mockRejectedValue(new Error('no ws in test'));
    store[CONTRACT_PATHS.ack] = { directiveVersion: 1, appliedTick: 10 };
    const ok = await bridge.control.awaitAck(99, { timeoutMs: 120, pollMs: 40 });
    expect(ok).toBe(false);
  });

  it('commander.snapshot bundles state + directives + ack', async () => {
    store[CONTRACT_PATHS.state] = { tick: 42 };
    store[CONTRACT_PATHS.directives] = { posture: 'war', rev: 9 };
    store[CONTRACT_PATHS.ack] = { directiveVersion: 9, appliedTick: 41 };
    const snap = await bridge.commander.snapshot();
    expect(snap.state).toMatchObject({ tick: 42 });
    expect(snap.directives).toMatchObject({ posture: 'war', rev: 9 });
    expect(snap.ack).toMatchObject({ directiveVersion: 9 });
  });
});
