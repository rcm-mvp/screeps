/**
 * Decider factory — builds the configured decider. The rule-based decider is always
 * constructed (it is the LLM decider's mandatory fallback) and returned directly when
 * `DECIDER=rules`. The Ollama decider wraps it.
 */

import type { StrategistConfig } from '../config';
import { SteeringStore } from '../history';
import { HttpOllamaClient, type OllamaClient } from '../ollamaClient';
import { OllamaDecider } from './ollama';
import { RuleBasedDecider } from './rules';
import type { Decider } from './types';

export interface MakeDeciderDeps {
  steering: SteeringStore;
  /** Override the Ollama transport (tests inject a mock). */
  client?: OllamaClient;
  /** Metrics hook fired once per real model invocation. */
  onOllamaCall?: () => void;
}

export function makeDecider(config: StrategistConfig, deps: MakeDeciderDeps): Decider {
  const fallback = new RuleBasedDecider(config);
  if (config.decider !== 'ollama') return fallback;

  const client = deps.client ?? new HttpOllamaClient(config.ollama);
  return new OllamaDecider({
    client,
    config,
    fallback,
    steering: deps.steering,
    onCall: deps.onOllamaCall,
  });
}

export { RuleBasedDecider } from './rules';
export { OllamaDecider } from './ollama';
export type { Decider, DirectivePatch, Snapshot } from './types';
