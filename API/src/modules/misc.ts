/** Miscellaneous module: decorations, leaderboard, PTR activation, scoreboard. */

import { ModuleBase } from './base';

export class MiscModule extends ModuleBase {
  // ---- Decorations ----

  /** Owned decorations inventory. @rateLimit default */
  decorationsInventory(): Promise<Record<string, unknown>> {
    return this.client.call('decorations/inventory');
  }

  /** Available decoration themes. @rateLimit default */
  decorationsThemes(): Promise<Record<string, unknown>> {
    return this.client.call('decorations/themes');
  }

  /** Convert decorations to resources. @rateLimit default */
  decorationsConvert(decorations: string[]): Promise<unknown> {
    return this.client.call('decorations/convert', { body: { decorations } });
  }

  /** Pixelize / convert credits (decoration economy op). @rateLimit default */
  decorationsPixelize(count = 1): Promise<unknown> {
    return this.client.call('decorations/pixelize', { body: { count } });
  }

  /** Activate / deactivate a decoration in a room. @rateLimit default */
  decorationsActivate(id: string, active: boolean): Promise<unknown> {
    return this.client.call('decorations/activate', { body: { _id: id, active } });
  }

  // ---- Leaderboard / scoreboard ----

  /** Leaderboard page. `mode` is `world` or `power`. @rateLimit default */
  leaderboardList(
    opts: { mode?: 'world' | 'power'; season?: string; limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.client.call('leaderboard/list', {
      query: {
        mode: opts.mode ?? 'world',
        season: opts.season,
        limit: opts.limit,
        offset: opts.offset,
      },
    });
  }

  /** A user's leaderboard rank. @rateLimit default */
  leaderboardFind(
    username: string,
    opts: { mode?: 'world' | 'power'; season?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.client.call('leaderboard/find', {
      query: { username, mode: opts.mode ?? 'world', season: opts.season },
    });
  }

  /** List of leaderboard seasons. @rateLimit default */
  leaderboardSeasons(): Promise<{ seasons: Array<Record<string, unknown>> }> {
    return this.client.call('leaderboard/seasons');
  }

  /** Seasonal scoreboard. @rateLimit default */
  scoreboard(
    opts: { season?: string; limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.client.call('scoreboard', {
      query: { season: opts.season, limit: opts.limit, offset: opts.offset },
    });
  }

  // ---- PTR ----

  /** Activate the PTR for the account (PTR host only). @rateLimit default */
  activatePtr(): Promise<unknown> {
    return this.client.call('user/activate-ptr', { body: {} });
  }
}
