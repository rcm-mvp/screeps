/**
 * LLM-backed decider using Ollama `kimi-k2.6:cloud`.
 *
 * Flow on each decide():
 *   1. Digest gate — if the materially-relevant state is unchanged since the last
 *      call, return the cached patch WITHOUT spending an Ollama call (conserves both
 *      the LLM budget and latency).
 *   2. Build a compact prompt (the Directives schema in-prompt + a small digest +
 *      human steering). Cloud does not grammar-constrain output, so the schema lives
 *      in the prompt and is enforced on our side.
 *   3. Call the model with `format: 'json'`, parse `content` as JSON, validate with
 *      the strict Zod schema. On failure, retry up to `retries`, feeding the error
 *      back. After repeated failure, fall back to the rule-based decider.
 *   4. Capture the model's reasoning (`thinking`) into the directive `note` — the
 *      audit trail. The directive fields themselves come from `content` only.
 */

import type { StrategistConfig } from '../config';
import { buildDigest, digestHash } from '../digest';
import { directiveSchema } from '../schema';
import type { SteeringStore } from '../history';
import type { ChatRequest, OllamaClient } from '../ollamaClient';
import type { Decider, DirectivePatch, Snapshot } from './types';

const MAX_NOTE = 2000;

const SYSTEM_PROMPT = `You are the external strategic commander of a Screeps colony. You set high-level
strategy only — never per-tick or per-creep actions. You observe a compact digest of
colony state and emit a single directive object.

Respond with ONE JSON object and nothing else (no prose, no markdown). It MUST match
this schema exactly — any field is optional, omit fields you don't want to change:

{
  "paused": boolean,                       // halt the executor
  "posture": "economy" | "expand" | "defend" | "war",
  "targetRooms": string[],                 // room names like "W5N8", max 20
  "roleQuotas": { [role: string]: number },// integer 0..20 per role
  "flagsAsOrders": boolean,
  "note": string                            // short justification (optional)
}

Rules: emit only fields that should change. Quotas are integers 0..20. Room names match
^[EW]\\d+[NS]\\d+$. Do NOT invent creep-level or movement commands. If nothing should
change, return {} (an empty object). Respond in JSON.`;

export interface OllamaDeciderDeps {
  client: OllamaClient;
  config: StrategistConfig;
  /** The rule-based decider used as the safety fallback. */
  fallback: Decider;
  steering: SteeringStore;
  /** Called once per actual model invocation (for metrics). */
  onCall?: () => void;
}

export class OllamaDecider implements Decider {
  readonly kind = 'ollama' as const;

  private lastHash: string | null = null;
  private lastPatch: DirectivePatch | null = null;

  constructor(private readonly deps: OllamaDeciderDeps) {}

  /** Drop the digest cache so the next decide() makes a fresh model call. */
  reset(): void {
    this.lastHash = null;
    this.lastPatch = null;
  }

  async decide(snapshot: Snapshot): Promise<DirectivePatch | null> {
    const hash = digestHash(snapshot.state);

    // (1) Digest gate — nothing material changed: skip the LLM entirely.
    if (this.lastHash !== null && hash === this.lastHash) {
      return this.lastPatch;
    }
    this.lastHash = hash;

    if (!snapshot.state) {
      // No state to reason about yet — defer to the (null-safe) fallback.
      this.lastPatch = (await this.deps.fallback.decide(snapshot)) ?? null;
      return this.lastPatch;
    }

    const digest = buildDigest(snapshot);
    const shortTerm = this.deps.steering.consumeShortTerm();
    const longTerm = this.deps.steering.getLongTerm();
    const retries = this.deps.config.ollama.retries;

    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      const req: ChatRequest = {
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(digest, { shortTerm, longTerm, priorError: attempt > 0 ? lastError : undefined }),
      };

      let content: string;
      let thinking: string | undefined;
      try {
        this.deps.onCall?.();
        const result = await this.deps.client.chat(req);
        content = result.content;
        thinking = result.thinking;
      } catch (e) {
        lastError = `model call failed: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }

      const parsed = extractJson(content);
      if (!parsed.ok) {
        lastError = parsed.error;
        continue;
      }

      const validated = directiveSchema.safeParse(parsed.value);
      if (!validated.success) {
        lastError = validated.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        continue;
      }

      const patch: DirectivePatch = { ...validated.data };
      // Capture the reasoning trace as the audit note (overrides any model-supplied
      // note). Parsed directive fields are untouched by this.
      const reasoning = (thinking ?? '').trim();
      if (reasoning) patch.note = reasoning.slice(0, MAX_NOTE);

      this.lastPatch = patch;
      return patch;
    }

    // (3) Repeated failure → rule-based fallback. The colony never stalls on the LLM.
    this.lastPatch = (await this.deps.fallback.decide(snapshot)) ?? null;
    return this.lastPatch;
  }
}

function buildUserPrompt(
  digest: ReturnType<typeof buildDigest>,
  steer: { shortTerm: string | null; longTerm: string | null; priorError?: string },
): string {
  const parts: string[] = [];
  if (steer.longTerm) parts.push(`LONG-TERM STEERING (persistent): ${steer.longTerm}`);
  if (steer.shortTerm) parts.push(`SHORT-TERM STEERING (this decision only): ${steer.shortTerm}`);
  parts.push(`COLONY DIGEST:\n${JSON.stringify(digest, null, 2)}`);
  if (steer.priorError) {
    parts.push(
      `Your previous response was rejected for not matching the schema: ${steer.priorError}\nRespond again with a valid JSON object.`,
    );
  }
  parts.push('Decide the directive. Respond in JSON.');
  return parts.join('\n\n');
}

interface JsonOk {
  ok: true;
  value: unknown;
}
interface JsonErr {
  ok: false;
  error: string;
}

/**
 * Parse the model's content as JSON. With `format: 'json'` it should be pure JSON,
 * but tolerate a fenced/wrapped object by extracting the first balanced `{...}`.
 */
function extractJson(content: string): JsonOk | JsonErr {
  const text = (content ?? '').trim();
  if (!text) return { ok: false, error: 'empty response' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    /* fall through to extraction */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { ok: false, error: 'no JSON object found in response' };
}
