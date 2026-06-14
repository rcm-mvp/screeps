/**
 * Incremental room-state merge for the `room:<shard>/<room>` channel.
 *
 * The first frame for a room is the full state; subsequent frames are deltas
 * containing only changed properties, where `null` means "deleted". This class
 * maintains the merged current state and produces clean snapshots, while the
 * raw deltas remain available to the caller separately.
 */

import type { RoomSnapshot } from '../types/socket';

type Dict = Record<string, unknown>;

function isPlainObject(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `delta` into `target` in place. A `null` value deletes the key; a
 * nested object recurses; anything else overwrites.
 */
export function deepMerge(target: Dict, delta: Dict): Dict {
  for (const [key, value] of Object.entries(delta)) {
    if (value === null) {
      delete target[key];
    } else if (isPlainObject(value)) {
      const existing = isPlainObject(target[key]) ? (target[key] as Dict) : {};
      target[key] = deepMerge(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export class RoomState {
  private objects: Record<string, Dict> = {};
  private users: Record<string, Dict> = {};
  private info: Dict = {};
  private gameTime?: number;

  constructor(
    readonly shard: string,
    readonly room: string,
  ) {}

  /**
   * Apply one room-channel delta (or the initial full frame). For each entry in
   * `objects`, a `null` value removes the object; otherwise the partial is
   * deep-merged into the object's current state.
   */
  apply(data: unknown): void {
    if (!isPlainObject(data)) return;

    if (typeof data.gameTime === 'number') this.gameTime = data.gameTime;

    if (isPlainObject(data.objects)) {
      for (const [id, patch] of Object.entries(data.objects)) {
        if (patch === null) {
          delete this.objects[id];
        } else if (isPlainObject(patch)) {
          this.objects[id] = deepMerge(this.objects[id] ?? {}, patch);
        }
      }
    }

    if (isPlainObject(data.users)) {
      for (const [id, patch] of Object.entries(data.users)) {
        if (patch === null) delete this.users[id];
        else if (isPlainObject(patch)) this.users[id] = deepMerge(this.users[id] ?? {}, patch);
      }
    }

    if (isPlainObject(data.info)) deepMerge(this.info, data.info);
  }

  /** A deep-cloned snapshot of the current merged room state. */
  snapshot(): RoomSnapshot {
    return {
      shard: this.shard,
      room: this.room,
      gameTime: this.gameTime,
      objects: structuredClone(this.objects),
      users: structuredClone(this.users),
      info: structuredClone(this.info),
    };
  }

  reset(): void {
    this.objects = {};
    this.users = {};
    this.info = {};
    this.gameTime = undefined;
  }
}
