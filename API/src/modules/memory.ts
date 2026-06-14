/**
 * Memory + memory-segment module.
 *
 * Reads transparently decode the `gz:<base64>` wire format (see
 * {@link decodeMemory}). Writes accept a plain JS value and serialise it.
 */

import { decodeMemory, encodeMemory } from '../core/gz';
import { ModuleBase } from './base';

export class MemoryModule extends ModuleBase {
  /**
   * Read Memory at a dotted path (empty/omitted = whole Memory). The `gz:`
   * payload is auto-detected, gunzipped and JSON-parsed; you get a normal value.
   * @rateLimit GET user/memory (1440/day)
   */
  async get(path = '', shard?: string): Promise<unknown> {
    const res = await this.client.call<{ data: unknown }>('GET user/memory', {
      query: { path, shard: this.shard(shard) },
    });
    return decodeMemory(res?.data);
  }

  /**
   * Write a value to Memory at a dotted path. The value is sent as-is; the
   * screeps backend's `POST /api/user/memory` serialises it server-side
   * (`JSON.stringify(request.body.value)`). Pre-stringifying here would
   * double-encode it, landing a string in Memory instead of the object.
   * @rateLimit POST user/memory (240/day)
   */
  set(path: string, value: unknown, shard?: string): Promise<unknown> {
    return this.client.call('POST user/memory', {
      body: { path, value, shard: this.shard(shard) },
    });
  }

  /**
   * Read one or more raw memory segments (ids 0..99). Returns the segment data
   * strings keyed by id.
   * @rateLimit GET user/memory-segment (360/hr)
   */
  getSegment(segment: number, shard?: string): Promise<{ data: string }> {
    return this.client.call('GET user/memory-segment', {
      query: { segment, shard: this.shard(shard) },
    });
  }

  /**
   * Write a raw memory segment (0..99). `data` is stored verbatim; pass a
   * string. For large values use {@link encodeMemory} to gzip first.
   * @rateLimit POST user/memory-segment (60/hr)
   */
  setSegment(segment: number, data: string, shard?: string): Promise<unknown> {
    return this.client.call('POST user/memory-segment', {
      body: { segment, data, shard: this.shard(shard) },
    });
  }

  /** Convenience: gzip-encode a value into the `gz:` wire format. */
  encode(value: unknown): string {
    return encodeMemory(value);
  }
}
