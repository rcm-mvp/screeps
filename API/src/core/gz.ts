/**
 * Codec for the Screeps Memory "gz:" wire format.
 *
 * `GET /api/user/memory` (and memory WebSocket frames) may return either a
 * plain JSON value or a string of the form `gz:<base64(gzip(json))>`. The
 * server switches to the gzipped form once the payload is large enough. This
 * module transparently detects and decodes it, and can re-encode on write.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

const GZ_PREFIX = 'gz:';

/** True when `value` is a `gz:`-prefixed encoded Memory payload. */
export function isGzMemory(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(GZ_PREFIX);
}

/**
 * Decode a Memory payload into a normal JS value.
 *
 * - `gz:<base64>` strings are base64-decoded, gunzipped, and JSON-parsed.
 * - Any other value is returned unchanged (the server already sent plain JSON,
 *   which the HTTP layer parsed for us).
 */
export function decodeMemory(value: unknown): unknown {
  if (!isGzMemory(value)) return value;
  const b64 = value.slice(GZ_PREFIX.length);
  const gz = Buffer.from(b64, 'base64');
  const json = gunzipSync(gz).toString('utf8');
  return JSON.parse(json);
}

/**
 * Encode a JS value into the `gz:<base64>` Memory wire format. Used for large
 * memory-segment writes where compression is worthwhile. For ordinary
 * `POST /api/user/memory` writes the server accepts plain JSON, so callers
 * normally do not need this.
 */
export function encodeMemory(value: unknown): string {
  const json = JSON.stringify(value);
  const gz = gzipSync(Buffer.from(json, 'utf8'));
  return GZ_PREFIX + gz.toString('base64');
}
