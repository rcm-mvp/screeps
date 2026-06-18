/**
 * The Directives schema — enforced entirely on our side.
 *
 * Two layers, both important:
 *   1. `directiveSchema` (strict Zod) validates raw LLM output. Ollama Cloud does
 *      NOT grammar-constrain output to a schema, so anything off-schema (unknown
 *      posture, quota out of range, malformed room name) is rejected here and the
 *      decider retries / falls back. Never pass unvalidated LLM output downstream.
 *   2. `validateAndClamp` is a lenient final pass applied to EVERY decider's output
 *      before it is proposed — it drops unknown fields, clamps quotas to 0–20, and
 *      filters invalid room names. This mirrors the bot's own clamping (defense in
 *      depth) so a bad directive never even leaves the strategist.
 */

import { z } from 'zod';
import type { Directives } from 'screeps-web-api-bridge';

/** Standard Screeps room name, e.g. W5N8 / E12S3. */
export const ROOM_RE = /^[EW]\d+[NS]\d+$/;
export const POSTURES = ['economy', 'expand', 'defend', 'war'] as const;
export const MAX_QUOTA = 20;
const MAX_TARGET_ROOMS = 20;
const MAX_NOTE = 2000;

/** Strict schema for validating LLM output. No `rev` (the bridge owns that). */
export const directiveSchema = z
  .object({
    paused: z.boolean().optional(),
    posture: z.enum(POSTURES).optional(),
    targetRooms: z.array(z.string().regex(ROOM_RE)).max(MAX_TARGET_ROOMS).optional(),
    roleQuotas: z.record(z.string(), z.number().int().min(0).max(MAX_QUOTA)).optional(),
    flagsAsOrders: z.boolean().optional(),
    note: z.string().max(MAX_NOTE).optional(),
  })
  .strict();

export type ValidatedDirective = z.infer<typeof directiveSchema>;

/**
 * Lenient clamp applied to any decider's output before proposing. Unlike the
 * strict schema this never throws — it silently drops/repairs out-of-range values
 * so the result is always a safe `Directives`.
 */
export function validateAndClamp(patch: Record<string, unknown> | null | undefined): Directives {
  const out: Directives = {};
  if (!patch || typeof patch !== 'object') return out;

  if (typeof patch.paused === 'boolean') out.paused = patch.paused;
  if (typeof patch.flagsAsOrders === 'boolean') out.flagsAsOrders = patch.flagsAsOrders;

  if (typeof patch.posture === 'string' && (POSTURES as readonly string[]).includes(patch.posture)) {
    out.posture = patch.posture as Directives['posture'];
  }

  if (Array.isArray(patch.targetRooms)) {
    const rooms = patch.targetRooms
      .filter((r): r is string => typeof r === 'string' && ROOM_RE.test(r))
      .slice(0, MAX_TARGET_ROOMS);
    out.targetRooms = [...new Set(rooms)];
  }

  if (patch.roleQuotas && typeof patch.roleQuotas === 'object' && !Array.isArray(patch.roleQuotas)) {
    const quotas: Record<string, number> = {};
    for (const [role, raw] of Object.entries(patch.roleQuotas as Record<string, unknown>)) {
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      quotas[role] = Math.max(0, Math.min(MAX_QUOTA, Math.round(n)));
    }
    out.roleQuotas = quotas;
  }

  if (typeof patch.note === 'string' && patch.note.trim()) {
    out.note = patch.note.trim().slice(0, MAX_NOTE);
  }

  // `rev` and any unknown keys are intentionally dropped.
  return out;
}
