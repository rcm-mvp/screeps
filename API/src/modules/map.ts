/**
 * Map / meta module: batched map-stats, game time, shard info, version, and the
 * community server list.
 */

import { ModuleBase } from './base';

export type MapStatName =
  | 'owner0'
  | 'claim0'
  | 'minerals0'
  | 'controller0'
  | 'creep0'
  | string;

export class MapModule extends ModuleBase {
  /**
   * Batched per-room stats for a list of rooms (e.g. ownership colouring for a
   * map view). `statName` selects the dataset.
   * @rateLimit POST game/map-stats (60/hr)
   */
  mapStats(rooms: string[], statName: MapStatName = 'owner0', shard?: string): Promise<Record<string, unknown>> {
    return this.client.call('game/map-stats', {
      body: { rooms, statName, shard: this.shard(shard) },
    });
  }

  /** Current game tick for a shard. @rateLimit default */
  time(shard?: string): Promise<{ time: number }> {
    return this.client.call('game/time', { query: { shard: this.shard(shard) }, auth: false });
  }

  /** List of shards with metadata. @rateLimit default */
  shards(): Promise<{ shards: Array<{ name: string; [k: string]: unknown }> }> {
    return this.client.call('game/shards/info', { auth: false });
  }

  /** Server version + protocol info. @rateLimit default */
  version(): Promise<Record<string, unknown>> {
    return this.client.call('version', { auth: false });
  }

  /** Community server list (official server only). @rateLimit default */
  serverList(): Promise<{ servers: Array<Record<string, unknown>> }> {
    return this.client.call('servers/list', { auth: false, body: {} });
  }
}
