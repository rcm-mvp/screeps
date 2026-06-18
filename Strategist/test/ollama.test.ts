import { describe, it, expect, vi } from 'vitest';
import { OllamaDecider } from '../src/decider/ollama';
import { RuleBasedDecider } from '../src/decider/rules';
import { SteeringStore } from '../src/history';
import { loadConfig } from '../src/config';
import type { ChatResult, OllamaClient } from '../src/ollamaClient';
import { colony, state, snap } from './helpers';

const config = loadConfig({ DECIDER: 'ollama', OLLAMA_RETRIES: '1' });

/** A mock client that returns a queued sequence of results (last one repeats). */
function mockClient(results: ChatResult[]): OllamaClient & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async chat(): Promise<ChatResult> {
      this.calls += 1;
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return r;
    },
  };
}

function makeDecider(client: OllamaClient) {
  const steering = new SteeringStore();
  const fallback = new RuleBasedDecider(config);
  return new OllamaDecider({ client, config, fallback, steering });
}

describe('OllamaDecider', () => {
  it('captures the thinking trace into note, not into the parsed directive', async () => {
    const client = mockClient([{ content: '{"posture":"economy"}', thinking: 'Economy is safest right now.' }]);
    const decider = makeDecider(client);
    const patch = await decider.decide(snap(state(), { posture: 'war' }));
    expect(patch).toMatchObject({ posture: 'economy', note: 'Economy is safest right now.' });
    // The reasoning must not leak into directive fields.
    expect(patch?.posture).toBe('economy');
    expect(Object.keys(patch ?? {}).sort()).toEqual(['note', 'posture']);
  });

  it('rejects off-schema output and falls back to the rule-based decider', async () => {
    // Always-invalid posture. After retries are exhausted, fall back. The snapshot
    // has an active home threat, so the rule decider returns defend.
    const client = mockClient([{ content: '{"posture":"banana"}' }]);
    const decider = makeDecider(client);
    const threatState = state({ colonies: { W1N1: colony({ threats: { hostiles: 2, safeMode: false } }) } });
    const patch = await decider.decide(snap(threatState, { posture: 'economy' }));
    expect(patch).toMatchObject({ posture: 'defend' }); // came from the fallback
    expect(client.calls).toBe(config.ollama.retries + 1); // tried, retried, then fell back
  });

  it('retries on invalid output then accepts a valid retry', async () => {
    const client = mockClient([
      { content: 'not json at all' },
      { content: '{"roleQuotas":{"upgrader":5}}' },
    ]);
    const decider = makeDecider(client);
    const patch = await decider.decide(snap(state()));
    expect(patch).toMatchObject({ roleQuotas: { upgrader: 5 } });
    expect(client.calls).toBe(2);
  });

  it('does NOT call the model again when the state digest is unchanged', async () => {
    const client = mockClient([{ content: '{"posture":"economy"}' }]);
    const decider = makeDecider(client);
    const s = snap(state(), { posture: 'economy' });
    await decider.decide(s);
    await decider.decide(s); // same material state
    await decider.decide(snap(state({ tick: 9999, cpu: { used: 1, limit: 20, bucket: 10_000 } }))); // only noise changed
    expect(client.calls).toBe(1);
  });

  it('calls the model again when the digest materially changes', async () => {
    const client = mockClient([{ content: '{"posture":"economy"}' }, { content: '{"posture":"defend"}' }]);
    const decider = makeDecider(client);
    await decider.decide(snap(state()));
    await decider.decide(snap(state({ colonies: { W1N1: colony({ rcl: 7 }) } })));
    expect(client.calls).toBe(2);
  });
});
