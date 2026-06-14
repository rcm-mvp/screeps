import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient } from '../src/core/httpClient';
import { RateLimiter } from '../src/core/rateLimiter';
import { Logger } from '../src/core/logger';
import { resolveConfig } from '../src/config';
import { AuthError, NotFoundError, RateLimitError, ServerError } from '../src/errors';

function makeClient(maxRetries = 0) {
  const cfg = resolveConfig({ server: 'official', token: 'tok-1', maxRetries });
  return new HttpClient(cfg, new RateLimiter(), new Logger(false));
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('HttpClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('unwraps the { ok: 1, ... } envelope', async () => {
    fetchMock.mockResolvedValue(json({ ok: 1, time: 12345 }));
    const client = makeClient();
    const res = await client.call<{ time: number }>('game/time', { auth: false });
    expect(res).toEqual({ time: 12345 });
  });

  it('throws ServerError on { ok: 0 }', async () => {
    fetchMock.mockResolvedValue(json({ ok: 0, error: 'nope' }));
    const client = makeClient();
    await expect(client.call('auth/me')).rejects.toBeInstanceOf(ServerError);
  });

  it('rotates the token from the X-Token response header', async () => {
    fetchMock.mockResolvedValue(json({ ok: 1 }, { headers: { 'content-type': 'application/json', 'x-token': 'tok-2' } }));
    const client = makeClient();
    await client.call('auth/me');
    expect(client.getToken()).toBe('tok-2');
  });

  it('does NOT rotate by default on a non-rotating preset (private)', async () => {
    fetchMock.mockResolvedValue(json({ ok: 1 }, { headers: { 'content-type': 'application/json', 'x-token': 'tok-2' } }));
    const cfg = resolveConfig({ server: 'private', host: 'http://localhost:21025', token: 'tok-1' });
    const client = new HttpClient(cfg, new RateLimiter(), new Logger(false));
    await client.call('auth/me');
    expect(client.getToken()).toBe('tok-1');
  });

  it('adopts X-Token rotation once enabled, even on a non-rotating preset (signin sessions)', async () => {
    fetchMock.mockResolvedValue(json({ ok: 1 }, { headers: { 'content-type': 'application/json', 'x-token': 'tok-2' } }));
    const cfg = resolveConfig({ server: 'private', host: 'http://localhost:21025', token: 'tok-1' });
    const client = new HttpClient(cfg, new RateLimiter(), new Logger(false));
    client.enableTokenRotation();
    await client.call('auth/me');
    expect(client.getToken()).toBe('tok-2');
  });

  it('maps 401 to AuthError and 404 to NotFoundError', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 401 }));
    await expect(client.call('auth/me')).rejects.toBeInstanceOf(AuthError);
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 404 }));
    await expect(client.call('auth/me')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws RateLimitError on 429 carrying retry-after, and penalises the budget', async () => {
    fetchMock.mockResolvedValue(new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
    const client = makeClient(0);
    const err = await client.call('GET user/code').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSec).toBe(7);
    expect(client.limiter.getBudget('GET user/code').remaining).toBe(0);
  });

  it('sends X-Token + X-Username headers', async () => {
    fetchMock.mockResolvedValue(json({ ok: 1 }));
    const client = makeClient();
    await client.call('auth/me');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Token']).toBe('tok-1');
    expect(init.headers['X-Username']).toBe('tok-1');
  });

  it('throws AuthError before fetching when auth is required but no token is set', async () => {
    const cfg = resolveConfig({ server: 'official', token: undefined });
    const client = new HttpClient(cfg, new RateLimiter(), new Logger(false));
    await expect(client.call('auth/me')).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
