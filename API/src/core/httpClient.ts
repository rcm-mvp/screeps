/**
 * HTTP transport for the Screeps Web API.
 *
 * Responsibilities:
 *  - URL + query construction from the {@link ENDPOINTS} catalogue;
 *  - auth headers (`X-Token` + `X-Username`, with a `_token` query fallback);
 *  - token rotation (reading the `X-Token` response header on rotating servers);
 *  - rate-limit gating + header sync via {@link RateLimiter};
 *  - response normalisation: unwrap `{ ok: 1, ... }`, map failures to typed
 *    errors, and surface rate-limit info on the error;
 *  - retry-with-backoff for transient (network / 5xx) failures, and honouring a
 *    429's own timer before any retry.
 */

import { ENDPOINTS, EndpointName, RateLimitClass } from '../endpoints';
import type { ResolvedConfig } from '../config';
import {
  AuthError,
  BridgeError,
  NotFoundError,
  RateLimitError,
  ServerError,
} from '../errors';
import type { OkEnvelope } from '../types/common';
import { Logger } from './logger';
import { RateLimiter } from './rateLimiter';

export interface RequestOptions {
  /** Query-string parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body (POST). */
  body?: unknown;
  /** Path-template parameters for parameterised endpoints. */
  pathParams?: Record<string, string | number>;
  /** Override whether this call needs auth (defaults to the endpoint's flag). */
  auth?: boolean;
  /** Skip unwrapping `{ ok, ... }` (e.g. for static JSON like room-history). */
  raw?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpClient {
  private token?: string;
  /** Notified whenever the token rotates, so the socket can re-auth. */
  private tokenListeners = new Set<(token: string) => void>();
  /**
   * Runtime override for {@link ServerEndpoints.rotatesToken}. A `signin`
   * session token rotates on every response (the backend re-issues an `X-Token`
   * with a refreshed expiry, then expires the old one) regardless of preset —
   * so signin turns this on. Without it a long-lived private session silently
   * expires mid-run and the next call 401s.
   */
  private rotatesTokenOverride = false;

  constructor(
    private cfg: ResolvedConfig,
    readonly limiter: RateLimiter,
    readonly logger: Logger,
  ) {
    this.token = cfg.token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  setToken(token: string): void {
    if (!token || token === this.token) return;
    this.token = token;
    for (const fn of this.tokenListeners) fn(token);
  }

  onTokenRotate(fn: (token: string) => void): () => void {
    this.tokenListeners.add(fn);
    return () => this.tokenListeners.delete(fn);
  }

  /** Adopt `X-Token` rotation even on a preset that defaults it off (see signin). */
  enableTokenRotation(): void {
    this.rotatesTokenOverride = true;
  }

  private buildUrl(
    path: string,
    query?: RequestOptions['query'],
    includeQueryToken = false,
  ): string {
    const { http, prefix } = this.cfg.endpoints;
    const url = new URL(http + prefix + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    if (includeQueryToken && this.token) url.searchParams.set('_token', this.token);
    return url.toString();
  }

  /** Call a named endpoint from the catalogue. */
  async call<T = unknown>(name: EndpointName, opts: RequestOptions = {}): Promise<T> {
    const def = ENDPOINTS[name];
    const path = typeof def.path === 'function' ? def.path(opts.pathParams ?? {}) : def.path;
    const needsAuth = opts.auth ?? def.auth;
    return this.execute<T>({
      method: def.method,
      path,
      rateLimitClass: def.rateLimitClass,
      needsAuth,
      endpointName: name,
      opts,
    });
  }

  /**
   * Escape hatch for endpoints not in the catalogue. Uses the `default`
   * rate-limit class and the global cap.
   */
  async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    return this.execute<T>({
      method,
      path,
      rateLimitClass: 'default',
      needsAuth: opts.auth ?? true,
      endpointName: `${method} ${path}`,
      opts,
    });
  }

  private async execute<T>(args: {
    method: 'GET' | 'POST';
    path: string;
    rateLimitClass: RateLimitClass;
    needsAuth: boolean;
    endpointName: string;
    opts: RequestOptions;
  }): Promise<T> {
    const { method, path, rateLimitClass, needsAuth, endpointName, opts } = args;

    if (needsAuth && !this.token) {
      throw new AuthError(`Endpoint "${endpointName}" requires a token but none is configured.`, {
        endpoint: path,
      });
    }

    const maxAttempts = this.cfg.maxRetries + 1;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      await this.limiter.acquire(rateLimitClass);

      const url = this.buildUrl(path, opts.query);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.token) {
        headers['X-Token'] = this.token;
        headers['X-Username'] = this.token;
      }
      let bodyInit: string | undefined;
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        bodyInit = JSON.stringify(opts.body ?? {});
      }

      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: bodyInit });
      } catch (cause) {
        this.logger.warn('http: network error', { endpoint: endpointName, attempt, cause: String(cause) });
        if (attempt < maxAttempts) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw new ServerError(`Network error calling ${endpointName}`, { endpoint: path, cause });
      }

      // Token rotation: rotating servers return a fresh token to use next time.
      const rotated = res.headers.get('x-token');
      if (rotated && (this.cfg.endpoints.rotatesToken || this.rotatesTokenOverride)) this.setToken(rotated);

      this.limiter.syncFromHeaders(rateLimitClass, res.headers);

      this.logger.debug('http: response', {
        endpoint: endpointName,
        status: res.status,
        ms: Date.now() - started,
        attempt,
        rateLimitRemaining: res.headers.get('x-ratelimit-remaining') ?? undefined,
      });

      if (res.status === 429) {
        const retryAfter = this.parseRetryAfter(res);
        this.limiter.penalize(rateLimitClass, retryAfter);
        if (attempt < maxAttempts) {
          // Honour the server's own timer before retrying.
          await sleep(retryAfter * 1000 + 50);
          continue;
        }
        throw new RateLimitError(`Rate limited on ${endpointName}`, {
          status: 429,
          endpoint: path,
          retryAfterSec: retryAfter,
          rateLimitClass,
          resetAt: Date.now() + retryAfter * 1000,
          body: await this.safeText(res),
        });
      }

      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`Authentication failed on ${endpointName} (HTTP ${res.status})`, {
          status: res.status,
          endpoint: path,
          body: await this.safeText(res),
        });
      }

      if (res.status === 404) {
        throw new NotFoundError(`Not found: ${endpointName}`, {
          status: 404,
          endpoint: path,
          body: await this.safeText(res),
        });
      }

      if (res.status >= 500) {
        if (attempt < maxAttempts) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw new ServerError(`Server error on ${endpointName} (HTTP ${res.status})`, {
          status: res.status,
          endpoint: path,
          body: await this.safeText(res),
        });
      }

      if (!res.ok) {
        throw new BridgeError(`Unexpected status ${res.status} on ${endpointName}`, {
          status: res.status,
          endpoint: path,
          body: await this.safeText(res),
        });
      }

      const payload = await this.parseBody(res);

      if (opts.raw) return payload as T;

      // Unwrap the `{ ok, ... }` envelope when present.
      if (payload && typeof payload === 'object' && 'ok' in (payload as object)) {
        const env = payload as OkEnvelope;
        if (env.ok === 0) {
          throw new ServerError(env.error || `Request failed: ${endpointName}`, {
            status: res.status,
            endpoint: path,
            body: env,
          });
        }
        // Return the envelope minus the `ok` flag.
        const { ok: _ok, ...rest } = env;
        return rest as T;
      }

      return payload as T;
    }
  }

  private backoff(attempt: number): number {
    const base = 300 * 2 ** (attempt - 1);
    const jitter = Math.random() * 200;
    return Math.min(base + jitter, 8000);
  }

  private parseRetryAfter(res: Response): number {
    const header = res.headers.get('retry-after');
    if (header) {
      const asNum = Number(header);
      if (!Number.isNaN(asNum)) return asNum;
      const asDate = Date.parse(header);
      if (!Number.isNaN(asDate)) return Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
    }
    const reset = res.headers.get('x-ratelimit-reset');
    if (reset) {
      const resetSec = Number(reset);
      if (!Number.isNaN(resetSec)) {
        const ms = resetSec > 1e6 ? resetSec * 1000 - Date.now() : resetSec * 1000;
        return Math.max(1, Math.ceil(ms / 1000));
      }
    }
    return 10; // conservative default
  }

  private async parseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  private async safeText(res: Response): Promise<string | undefined> {
    try {
      return await res.text();
    } catch {
      return undefined;
    }
  }
}
