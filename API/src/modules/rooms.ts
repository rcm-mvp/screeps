/**
 * Room data module: overview, terrain (raw + decoded grid), status, objects,
 * PvP/nukes activity, and tick-history replay.
 */

import type {
  RoomObjectsResponse,
  RoomOverview,
  RoomStatus,
  RoomTerrain,
  TerrainTile,
} from '../types/game';
import { ModuleBase } from './base';

/** Map an encoded terrain digit to a tile type. 0=plain, 1/3=wall, 2=swamp. */
function digitToTile(d: string): TerrainTile {
  switch (d) {
    case '1':
    case '3':
      return 'wall';
    case '2':
      return 'swamp';
    default:
      return 'plain';
  }
}

/** Decode a 2500-char encoded terrain string into `grid[y][x]`. */
export function decodeTerrain(encoded: string): TerrainTile[][] {
  const grid: TerrainTile[][] = [];
  for (let y = 0; y < 50; y++) {
    const row: TerrainTile[] = [];
    for (let x = 0; x < 50; x++) {
      row.push(digitToTile(encoded[y * 50 + x] ?? '0'));
    }
    grid.push(row);
  }
  return grid;
}

export class RoomsModule extends ModuleBase {
  /** Room overview stats over an interval (8/180/1440). @rateLimit default */
  overview(room: string, interval = 8, shard?: string): Promise<RoomOverview> {
    return this.client.call('game/room-overview', {
      query: { room, interval, shard: this.shard(shard) },
    });
  }

  /**
   * Room terrain. By default requests the encoded digit string and returns both
   * the raw string and a decoded `grid[y][x]`. Pass `{ encoded: false }` to get
   * the server's per-tile document form instead.
   * @rateLimit GET game/room-terrain (360/hr)
   */
  async terrain(
    room: string,
    opts: { encoded?: boolean; shard?: string } = {},
  ): Promise<RoomTerrain> {
    const useEncoded = opts.encoded ?? true;
    const shard = this.shard(opts.shard);
    if (useEncoded) {
      const res = await this.client.call<{ terrain: Array<{ terrain: string }> }>(
        'game/room-terrain',
        { query: { room, shard, encoded: 1 }, auth: false },
      );
      const encoded = res.terrain?.[0]?.terrain ?? '';
      return { room, shard, encoded, grid: decodeTerrain(encoded) };
    }
    const res = await this.client.call<{ terrain: Array<{ room: string; terrain: string }> }>(
      'game/room-terrain',
      { query: { room, shard }, auth: false },
    );
    return { room, shard, terrain: res.terrain };
  }

  /** Room ownership / novice / respawn status. @rateLimit default */
  status(room: string, shard?: string): Promise<RoomStatus> {
    return this.client.call('game/room-status', { query: { room, shard: this.shard(shard) } });
  }

  /** All objects + referenced users in a room. @rateLimit default */
  objects(room: string, shard?: string): Promise<RoomObjectsResponse> {
    return this.client.call('game/room-objects', { query: { room, shard: this.shard(shard) } });
  }

  /** Rooms with recent PvP activity. @rateLimit default */
  pvp(opts: { interval?: number; start?: number; shard?: string } = {}): Promise<Record<string, unknown>> {
    return this.client.call('experimental/pvp', {
      query: { interval: opts.interval, start: opts.start, shard: opts.shard },
    });
  }

  /** In-flight nukes across shards. @rateLimit default */
  nukes(shard?: string): Promise<Record<string, unknown>> {
    return this.client.call('experimental/nukes', { query: { shard } });
  }

  /**
   * Replay data for a room at a given tick. `tick` must be a multiple of 100;
   * the file covers ticks `[tick, tick+100)`. Returns the raw static JSON.
   * @rateLimit default
   */
  history(room: string, tick: number, shard?: string): Promise<unknown> {
    return this.client.call('game/room-history', {
      pathParams: { shard: this.shard(shard), room, tick },
      auth: false,
      raw: true,
    });
  }
}
