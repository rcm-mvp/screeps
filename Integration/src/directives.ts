/**
 * Raw directive writers — write straight to `Memory.bridge.directives` over the
 * bridge's HTTP transport with a single (server-side) JSON encoding.
 *
 * These predate the fix for bridge bug #2 (`memory.set()` used to double-encode
 * the value; see README "Findings"). Now that `control.setDirectives` encodes
 * correctly, scenario C exercises the bridge's own write path directly. The raw
 * writers are retained because `writeRawDirectiveObject` is still the way to
 * inject a MALFORMED directive object (bypassing Commander validation, with
 * correct on-wire encoding) for the malformed-survival scenario.
 */

import type { Directives, ScreepsBridge } from 'screeps-web-api-bridge';
import { CONTRACT_PATHS } from 'screeps-web-api-bridge';

/**
 * Merge `patch` into the current directives, bump `rev`, and write the merged
 * object correctly. Returns the new `rev` the executor should ack.
 */
export async function writeDirectivesRaw(
  bridge: ScreepsBridge,
  patch: Partial<Directives>,
  shard: string,
): Promise<number> {
  // `current` may be a STRING if a prior bridge `setDirectives` already
  // double-encoded into Memory (bug #2) — treat anything non-object as empty.
  const raw = await bridge.control.getDirectives();
  const current: Directives = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const baseRev = typeof current.rev === 'number' ? current.rev : 0;
  const rev = baseRev + 1;
  const merged: Directives = { ...current, ...patch, rev };
  await putMemoryRaw(bridge, CONTRACT_PATHS.directives, merged, shard);
  return rev;
}

/**
 * Replace `Memory.bridge.directives` wholesale with `value` (no merge) and a
 * fresh `rev` — used to inject malformed object payloads as a buggy AI would,
 * bypassing Commander validation but with correct on-wire encoding.
 */
export async function writeRawDirectiveObject(
  bridge: ScreepsBridge,
  value: Record<string, unknown>,
  shard: string,
): Promise<void> {
  await putMemoryRaw(bridge, CONTRACT_PATHS.directives, value, shard);
}

/** POST user/memory with the RAW value (single server-side stringify). */
async function putMemoryRaw(
  bridge: ScreepsBridge,
  path: string,
  value: unknown,
  shard: string,
): Promise<void> {
  await bridge.http.call('POST user/memory', { body: { path, value, shard } });
}
