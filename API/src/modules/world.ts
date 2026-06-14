/**
 * World manipulation module.
 *
 * Wraps unique-name helpers, flags, construction/spawn placement, and the
 * overloaded `add-object-intent` endpoint. Each discrete world action gets its
 * own ergonomic method so callers never assemble raw intent payloads by hand.
 */

import type { FlagColor } from '../types/common';
import { ModuleBase } from './base';

export class WorldModule extends ModuleBase {
  // ---- Unique-name helpers ----

  /** Generate a unique object name (`type` e.g. `creep`, `spawn`, `flag`). @rateLimit default */
  genUniqueObjectName(type: string, shard?: string): Promise<{ name: string }> {
    return this.client.call('game/gen-unique-object-name', {
      body: { type, shard: this.shard(shard) },
    });
  }

  /** Check whether an object name is free. @rateLimit default */
  checkUniqueObjectName(type: string, name: string, shard?: string): Promise<unknown> {
    return this.client.call('game/check-unique-object-name', {
      body: { type, name, shard: this.shard(shard) },
    });
  }

  /** Generate a unique flag name. @rateLimit default */
  genUniqueFlagName(shard?: string): Promise<{ name: string }> {
    return this.client.call('game/gen-unique-flag-name', { body: { shard: this.shard(shard) } });
  }

  // ---- Flags ----

  /** Create a flag at room/x/y with primary + secondary colours. @rateLimit default */
  createFlag(
    args: { room: string; x: number; y: number; name: string; color?: FlagColor; secondaryColor?: FlagColor; shard?: string },
  ): Promise<{ result?: unknown }> {
    return this.client.call('game/create-flag', {
      body: {
        room: args.room,
        x: args.x,
        y: args.y,
        name: args.name,
        color: args.color ?? 1,
        secondaryColor: args.secondaryColor ?? 1,
        shard: this.shard(args.shard),
      },
    });
  }

  /** Move a flag to a new room/x/y. @rateLimit default */
  changeFlag(
    args: { name: string; room: string; x: number; y: number; shard?: string },
  ): Promise<unknown> {
    return this.client.call('game/change-flag', {
      body: { name: args.name, room: args.room, x: args.x, y: args.y, shard: this.shard(args.shard) },
    });
  }

  /** Change a flag's colours. @rateLimit default */
  changeFlagColor(
    args: { name: string; room: string; color: FlagColor; secondaryColor: FlagColor; shard?: string },
  ): Promise<unknown> {
    return this.client.call('game/change-flag-color', {
      body: {
        name: args.name,
        room: args.room,
        color: args.color,
        secondaryColor: args.secondaryColor,
        shard: this.shard(args.shard),
      },
    });
  }

  /** Remove a flag by name + room. @rateLimit default */
  removeFlag(name: string, room: string, shard?: string): Promise<unknown> {
    return this.client.call('game/remove-flag', {
      body: { name, room, shard: this.shard(shard) },
    });
  }

  // ---- Construction / spawn ----

  /** Place a construction site. @rateLimit default */
  createConstruction(
    args: { room: string; x: number; y: number; structureType: string; name?: string; shard?: string },
  ): Promise<unknown> {
    return this.client.call('game/create-construction', {
      body: {
        room: args.room,
        x: args.x,
        y: args.y,
        structureType: args.structureType,
        name: args.name,
        shard: this.shard(args.shard),
      },
    });
  }

  /** Place the initial spawn (respawn / new room claim). @rateLimit default */
  placeSpawn(
    args: { room: string; x: number; y: number; name: string; shard?: string },
  ): Promise<unknown> {
    return this.client.call('game/place-spawn', {
      body: { room: args.room, x: args.x, y: args.y, name: args.name, shard: this.shard(args.shard) },
    });
  }

  /** Toggle attack notifications for an object. @rateLimit default */
  setNotifyWhenAttacked(id: string, enabled: boolean, shard?: string): Promise<unknown> {
    return this.client.call('game/set-notify-when-attacked', {
      body: { _id: id, enabled, shard: this.shard(shard) },
    });
  }

  // ---- add-object-intent (overloaded) split into named actions ----

  /** Low-level access to the raw overloaded intent endpoint. @rateLimit default */
  private addObjectIntent(
    room: string,
    id: string,
    intent: Record<string, unknown>,
    shard?: string,
  ): Promise<unknown> {
    return this.client.call('game/add-object-intent', {
      body: { room, name: id, intent, shard: this.shard(shard) },
    });
  }

  /** Suicide a creep. @rateLimit default */
  suicideCreep(id: string, room: string, shard?: string): Promise<unknown> {
    return this.addObjectIntent(room, id, { id, name: 'suicide' }, shard);
  }

  /** Unclaim a controller. @rateLimit default */
  unclaimController(id: string, room: string, shard?: string): Promise<unknown> {
    return this.addObjectIntent(room, id, { id, name: 'unclaim' }, shard);
  }

  /**
   * Destroy a structure. The intent uses the magic `_id = "room"` shape the
   * server expects for this action.
   * @rateLimit default
   */
  destroyStructures(id: string, room: string, shard?: string): Promise<unknown> {
    return this.client.call('game/add-object-intent', {
      body: { room, name: 'room', intent: { roomName: room, [id]: 1 }, shard: this.shard(shard) },
    });
  }

  /** Remove a construction site. @rateLimit default */
  removeConstructionSite(id: string, room: string, shard?: string): Promise<unknown> {
    return this.addObjectIntent(room, id, { id, name: 'remove' }, shard);
  }

  /** Remove a flag via the intent endpoint (alias of {@link removeFlag}). @rateLimit default */
  removeFlagIntent(id: string, room: string, shard?: string): Promise<unknown> {
    return this.addObjectIntent(room, id, { id, name: 'remove' }, shard);
  }
}
