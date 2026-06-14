/**
 * Auth + account module.
 *
 * Covers sign-in (private servers), token introspection, and the read-only
 * account/world endpoints. Real paths and rate-limit classes live in
 * {@link ENDPOINTS}.
 */

import { ModuleBase } from './base';

export interface SigninResult {
  token: string;
}

export interface MeProfile {
  _id: string;
  email?: string;
  username: string;
  cpu?: number;
  gcl?: number;
  power?: number;
  credits?: number;
  badge?: unknown;
  [key: string]: unknown;
}

export class AuthModule extends ModuleBase {
  /**
   * Sign in with username/email + password (private servers without tokens).
   * On success the returned token is stored on the client for subsequent calls.
   * @rateLimit default
   */
  async signin(email: string, password: string): Promise<SigninResult> {
    const res = await this.client.call<SigninResult>('auth/signin', {
      auth: false,
      body: { email, password },
    });
    if (res?.token) {
      this.client.setToken(res.token);
      // A signin session token rotates on every response (the backend re-issues
      // an X-Token with a refreshed expiry and expires the old one). Adopt the
      // rotation even on the `private` preset, which defaults it off — otherwise
      // the session expires mid-run and subsequent calls 401.
      this.client.enableTokenRotation();
    }
    return res;
  }

  /** Current authenticated account profile. @rateLimit default */
  me(): Promise<MeProfile> {
    return this.client.call<MeProfile>('auth/me');
  }

  /** Exchange the session for a query token. @rateLimit default */
  queryToken(): Promise<{ token: string }> {
    return this.client.call('auth/query-token');
  }

  /** Current user's display name + id. @rateLimit default */
  name(): Promise<{ username: string; _id?: string }> {
    return this.client.call('user/name');
  }

  /** Look up a user by username or id. @rateLimit default */
  findUser(by: { username?: string; id?: string }): Promise<{ user: Record<string, unknown> }> {
    return this.client.call('user/find', { query: { username: by.username, id: by.id } });
  }

  /** World status: `normal` | `lost` | `empty`. @rateLimit default */
  worldStatus(): Promise<{ status: string }> {
    return this.client.call('user/world-status');
  }

  /** Suggested respawn start room(s). @rateLimit default */
  worldStartRoom(shard?: string): Promise<{ room: string[]; shard?: string }> {
    return this.client.call('user/world-start-room', { query: { shard: this.shard(shard) } });
  }

  /** World dimensions. @rateLimit default */
  worldSize(shard?: string): Promise<{ width: number; height: number }> {
    return this.client.call('user/world-size', { query: { shard: this.shard(shard) } });
  }

  /** Rooms where respawn is currently prohibited. @rateLimit default */
  respawnProhibitedRooms(shard?: string): Promise<{ rooms: string[] }> {
    return this.client.call('user/respawn-prohibited-rooms', {
      query: { shard: this.shard(shard) },
    });
  }

  /** Rooms owned by a user (defaults to the current user). @rateLimit default */
  rooms(userId: string): Promise<{ shards: Record<string, string[]> } | { rooms: string[] }> {
    return this.client.call('user/rooms', { query: { id: userId } });
  }

  /**
   * User statistics over an interval (8 = hour, 180 = day, 1440 = week).
   * @rateLimit default
   */
  stats(interval: number): Promise<{ stats: Record<string, unknown> }> {
    return this.client.call('user/stats', { query: { interval } });
  }

  /** GCL/room overview for the dashboard. @rateLimit default */
  overview(
    interval: number,
    statName: string,
    shard?: string,
  ): Promise<Record<string, unknown>> {
    return this.client.call('user/overview', {
      query: { interval, statName, shard: this.shard(shard) },
    });
  }

  /** Get or set the account badge. Pass `badge` to update. @rateLimit default */
  badge(badge?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.call('user/badge', { body: badge ? { badge } : {} });
  }

  /** Get or update notification preferences. @rateLimit default */
  notifyPrefs(prefs?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.call('user/notify-prefs', { body: prefs ?? {} });
  }
}
