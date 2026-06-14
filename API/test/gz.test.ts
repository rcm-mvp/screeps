import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodeMemory, encodeMemory, isGzMemory } from '../src/core/gz';

describe('memory gz codec', () => {
  it('detects gz-prefixed payloads', () => {
    expect(isGzMemory('gz:abc')).toBe(true);
    expect(isGzMemory('plain')).toBe(false);
    expect(isGzMemory({ a: 1 })).toBe(false);
  });

  it('round-trips a value through encode/decode', () => {
    const value = { creeps: { harvester1: { role: 'harvester', n: 42 } }, flags: [1, 2, 3] };
    const encoded = encodeMemory(value);
    expect(encoded.startsWith('gz:')).toBe(true);
    expect(decodeMemory(encoded)).toEqual(value);
  });

  it('decodes a real gz: payload produced like the server', () => {
    const value = { foo: 'bar', nested: { x: 1 } };
    const wire = 'gz:' + gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');
    expect(decodeMemory(wire)).toEqual(value);
  });

  it('passes through already-decoded plain values unchanged', () => {
    const obj = { a: 1 };
    expect(decodeMemory(obj)).toBe(obj);
    expect(decodeMemory('hello')).toBe('hello');
    expect(decodeMemory(undefined)).toBeUndefined();
  });
});
