/**
 * Scenario F — contract-version drift guard.
 *
 * The executor stamps `Memory.bridge.version`; the bridge's contract.ts
 * defines the shape; this harness pins the version it certifies
 * (src/contractVersion.ts). If any repo bumps the contract alone, this
 * screams with a message naming both sides — instead of production failing
 * silently weeks later.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_PATHS } from 'screeps-web-api-bridge';
import type { BridgeMemory } from 'screeps-web-api-bridge';
import { EXPECTED_CONTRACT_VERSION } from '../src/contractVersion';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs } from '../src/poll';
import { half } from '../src/report';

describe('F. contract-version drift guard', () => {
  let s: Scenario;
  let watcher: StateWatcher;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before reading the contract block'),
    });
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('the version the bot writes equals the version this suite certifies', async () => {
    const root = (await s.bridge.memory.get(CONTRACT_PATHS.root)) as BridgeMemory | null;
    expect(root, half('bot-write', 'Memory.bridge must exist once the executor runs')).not.toBeNull();

    expect(
      root!.version,
      `CONTRACT DRIFT: the deployed executor writes Memory.bridge.version=${root!.version} but this ` +
        `integration suite certifies version ${EXPECTED_CONTRACT_VERSION}. Someone bumped the contract in one ` +
        'repo only. Align Bot/src/settings.ts CONTRACT_VERSION, API/src/contract.ts, and ' +
        'Integration/src/contractVersion.ts in one coordinated change.',
    ).toBe(EXPECTED_CONTRACT_VERSION);
  });

  it('the full BridgeMemory block matches the contract shape', async () => {
    const root = (await s.bridge.memory.get(CONTRACT_PATHS.root)) as BridgeMemory;

    // ack — executor's half of the handshake
    expect(typeof root.ack, half('ack', 'Memory.bridge.ack must be an object')).toBe('object');
    expect(typeof root.ack.directiveVersion, half('ack', 'ack.directiveVersion must be a number')).toBe('number');
    expect(typeof root.ack.appliedTick, half('ack', 'ack.appliedTick must be a number')).toBe('number');

    // directives — bridge's half (object even when empty)
    expect(typeof root.directives, half('directive-write', 'Memory.bridge.directives must be an object')).toBe('object');

    // state — every required ColonyState key with the right primitive type
    const state = root.state;
    expect(state, half('bot-write', 'Memory.bridge.state must exist')).toBeTruthy();
    expect(typeof state.tick).toBe('number');
    expect(typeof state.heartbeat).toBe('number');
    expect(typeof state.credits).toBe('number');
    expect(typeof state.cpu.used).toBe('number');
    expect(typeof state.cpu.limit).toBe('number');
    expect(typeof state.cpu.bucket).toBe('number');
    expect(typeof state.gcl.level).toBe('number');
    expect(typeof state.gcl.progress).toBe('number');
    expect(typeof state.gcl.progressTotal).toBe('number');
    expect(typeof state.creeps.total).toBe('number');
    expect(typeof state.creeps.byRole).toBe('object');
    expect(state.lastError === null || typeof state.lastError === 'object').toBe(true);

    const colony = state.colonies[s.ctx.room];
    expect(colony, half('bot-write', `state.colonies must contain ${s.ctx.room}`)).toBeDefined();
    expect(typeof colony.rcl).toBe('number');
    expect(typeof colony.energyAvailable).toBe('number');
    expect(typeof colony.energyCapacity).toBe('number');
    expect(typeof colony.constructionSites).toBe('number');
    expect(typeof colony.threats.hostiles).toBe('number');
    expect(typeof colony.threats.safeMode).toBe('boolean');
  });
});
