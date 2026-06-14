import { describe, it, expect } from 'vitest';
import { RoomState, deepMerge } from '../src/socket/roomMerge';

describe('deepMerge', () => {
  it('overwrites scalars and recurses into objects', () => {
    const target = { a: 1, nested: { x: 1, y: 2 } };
    deepMerge(target, { a: 5, nested: { y: 9, z: 3 } });
    expect(target).toEqual({ a: 5, nested: { x: 1, y: 9, z: 3 } });
  });

  it('deletes keys whose delta value is null', () => {
    const target = { a: 1, b: 2, nested: { keep: 1, drop: 2 } };
    deepMerge(target, { b: null, nested: { drop: null } });
    expect(target).toEqual({ a: 1, nested: { keep: 1 } });
  });
});

describe('RoomState incremental merge', () => {
  it('applies a full frame then merges deltas and deletions', () => {
    const state = new RoomState('shard3', 'W1N1');

    // Initial full frame.
    state.apply({
      gameTime: 100,
      objects: {
        c1: { _id: 'c1', type: 'creep', x: 10, y: 10, hits: 100 },
        s1: { _id: 's1', type: 'spawn', x: 25, y: 25 },
      },
      users: { u1: { _id: 'u1', username: 'alice' } },
    });

    // Delta: creep moves + loses hits, spawn deleted, new creep appears.
    state.apply({
      gameTime: 101,
      objects: {
        c1: { x: 11, hits: 80 },
        s1: null,
        c2: { _id: 'c2', type: 'creep', x: 5, y: 5 },
      },
    });

    const snap = state.snapshot();
    expect(snap.gameTime).toBe(101);
    expect(snap.objects.c1).toEqual({ _id: 'c1', type: 'creep', x: 11, y: 10, hits: 80 });
    expect(snap.objects.s1).toBeUndefined();
    expect(snap.objects.c2).toEqual({ _id: 'c2', type: 'creep', x: 5, y: 5 });
    expect(snap.users.u1).toEqual({ _id: 'u1', username: 'alice' });
  });

  it('produces independent snapshots (no shared references)', () => {
    const state = new RoomState('shard3', 'W1N1');
    state.apply({ objects: { c1: { _id: 'c1', x: 1 } } });
    const a = state.snapshot();
    state.apply({ objects: { c1: { x: 2 } } });
    const b = state.snapshot();
    expect(a.objects.c1.x).toBe(1);
    expect(b.objects.c1.x).toBe(2);
  });
});
