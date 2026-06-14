/**
 * Scenario C — directive round-trip + ack handshake. THE contract test.
 *
 * Round-trip (observed over HTTP, the working read path):
 *   directive written to Memory.bridge.directives (rev N)  →  executor
 *   validates + applies  →  executor writes Memory.bridge.ack.directiveVersion
 *   = N  →  an OBSERVABLE behaviour change follows (the plan posture flips; a
 *   raised quota raises the live creep count).
 *
 * The directive is written with `writeDirectivesRaw` (a single, correctly
 * encoded POST user/memory) because the bridge's own `control.setDirectives` /
 * `commander.propose` DOUBLE-encode the value (bug #2 — see README): the value
 * lands in Memory as a STRING, the executor's `readDirectives` rejects the
 * non-object, and the directive never takes effect. Two `it.fails` cases below
 * pin that bug (and the related WS ack-confirm bug) so they flip RED when the
 * bridge is fixed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StrategyPlanLike } from '../src/types';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs, waitFor, waitForAck } from '../src/poll';
import { writeDirectivesRaw } from '../src/directives';
import { half } from '../src/report';

describe('C. directive round-trip + ack', () => {
  let s: Scenario;
  let watcher: StateWatcher;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before driving directives'),
    });
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('a posture directive lands, the executor acks the rev, and the plan follows', async () => {
    // Correctly-encoded directive write (workaround for bridge bug #2).
    const rev = await writeDirectivesRaw(s.bridge, { posture: 'expand', note: 'integration scenario C' }, s.ctx.shard);
    expect(rev, half('directive-write', 'the directive write must return a positive rev')).toBeGreaterThan(0);

    // Executor acks the rev — the authoritative handshake, observed over HTTP.
    const ack = await waitForAck(s.bridge, rev, ticksMs(60));
    expect(
      ack.directiveVersion,
      half('ack', `Memory.bridge.ack.directiveVersion must reach the written rev ${rev}`),
    ).toBeGreaterThanOrEqual(rev);
    expect(ack.appliedTick, half('ack', 'ack.appliedTick must be a positive game tick')).toBeGreaterThan(0);

    // Observable behaviour change: the strategy plan recomputes immediately on
    // a new rev and carries the new posture.
    const plan = await waitFor(
      async () => {
        const p = (await s.bridge.memory.get('plan')) as StrategyPlanLike | null;
        return p && p.rev === rev ? p : null;
      },
      {
        timeoutMs: ticksMs(40),
        intervalMs: 1500,
        what: half('ack', `Memory.plan recomputed for rev ${rev} (strategy reacts to new directives)`),
      },
    );
    expect(plan.posture, 'plan.posture must follow the acked directive').toBe('expand');
  }, 120_000);

  it('a quota directive raises the live creep count toward the quota', async () => {
    const baseline = watcher.latest?.creeps.byRole['upgrader'] ?? 0;

    const rev = await writeDirectivesRaw(s.bridge, { roleQuotas: { upgrader: 5 } }, s.ctx.shard);
    const ack = await waitForAck(s.bridge, rev, ticksMs(60));
    expect(ack.directiveVersion, half('ack', `executor never acked quota directive rev ${rev}`)).toBeGreaterThanOrEqual(rev);

    // The behaviour change, observed through the executor's own census: at
    // least one MORE upgrader than before the directive.
    await watcher.next((st) => (st.creeps.byRole['upgrader'] ?? 0) >= baseline + 1, {
      timeoutMs: ticksMs(400),
      what:
        `creeps.byRole.upgrader to exceed the pre-directive baseline of ${baseline} ` +
        '(quota=5 was acked, so the spawner must act on it)',
    });
  }, 300_000);

  it(
    'control.setDirectives() reaches the executor and gets acked (bug #2 fixed: memory.set no ' +
      'longer double-encodes — the value lands as an object the executor applies)',
    async () => {
      const rev = await s.bridge.control.setDirectives({ posture: 'war' });
      const ack = await waitForAck(s.bridge, rev, ticksMs(60));
      expect(ack.directiveVersion, 'setDirectives must produce an executor ack for its rev').toBeGreaterThanOrEqual(rev);
    },
    120_000,
  );

  it(
    'pushAndConfirm() writes a directive and confirms its ack over WS (bug #1 fixed: awaitAck ' +
      'reads the bridge.ackJson string mirror, not the "[object Object]" object path)',
    async () => {
      // The bridge's own end-to-end confirm helper, exercised verbatim: a
      // correctly-encoded write (bug #2 fix) that the executor acks, confirmed
      // over the WS ackJson mirror (bug #1 fix).
      const applied = await s.bridge.control.pushAndConfirm({ posture: 'war' }, { timeoutMs: ticksMs(60) });
      expect(applied, 'pushAndConfirm must write a directive and confirm its ack').toBe(true);
    },
    120_000,
  );
});
