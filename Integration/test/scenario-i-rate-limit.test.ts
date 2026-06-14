/**
 * Scenario I (optional) — rate-limit behaviour under 429s.
 *
 * Private servers don't impose token budgets, so this is the one scenario
 * that runs against a LOCAL MOCK instead: an in-process HTTP server that
 * answers `GET /api/user/memory` with 429 + Retry-After before succeeding.
 * It exercises the only code path the private server can't: the bridge must
 * queue and back off honouring the server's own timer — never hammer, never
 * surface a transient 429 to the caller — and throw a typed RateLimitError
 * only when the budget is truly exhausted. This is the sole pre-deploy
 * rehearsal that code gets before it meets the public MMO.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { RateLimitError, ScreepsBridge } from 'screeps-web-api-bridge';

interface MockServer {
  bridge: ScreepsBridge;
  hits: number[];
  close: () => Promise<void>;
}

/** Mock private server: first `failures` memory reads get 429 + Retry-After. */
async function startMock(failures: number, retryAfterSec: number): Promise<MockServer> {
  const hits: number[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/user/memory' && req.method === 'GET') {
      hits.push(Date.now());
      if (hits.length <= failures) {
        res.writeHead(429, { 'Retry-After': String(retryAfterSec), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: 1, data: { tick: 42, heartbeat: 42 } }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const bridge = new ScreepsBridge({
    server: 'private',
    host: `http://127.0.0.1:${port}`,
    token: 'mock-token',
    maxRetries: 3,
  });

  return {
    bridge,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.(); // don't wait out fetch's keep-alive sockets
        server.close(() => r());
      }),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('I. rate-limit behaviour (simulated 429s)', () => {
  let mock: MockServer | undefined;

  afterEach(async () => {
    mock?.bridge.close();
    await mock?.close();
    mock = undefined;
  });

  it('honours Retry-After: backs off, then succeeds without surfacing the 429', async () => {
    const retryAfterSec = 2;
    mock = await startMock(1, retryAfterSec);

    const started = Date.now();
    const state = await mock.bridge.control.getState();
    const elapsed = Date.now() - started;

    expect(state, 'the read must eventually succeed').toMatchObject({ tick: 42 });
    expect(mock.hits.length, 'exactly one retry after the single 429').toBe(2);
    expect(
      mock.hits[1] - mock.hits[0],
      'the retry must wait out the server\'s own Retry-After timer, not hammer',
    ).toBeGreaterThanOrEqual(retryAfterSec * 1000 - 50);
    expect(elapsed).toBeGreaterThanOrEqual(retryAfterSec * 1000 - 50);
  }, 30_000);

  it('queues a second caller behind the 429 penalty instead of stampeding', async () => {
    const retryAfterSec = 2;
    mock = await startMock(1, retryAfterSec);

    // Caller 1 eats the 429 and triggers the penalty...
    const first = mock.bridge.control.getState();
    while (mock.hits.length < 1) await sleep(20);
    await sleep(300); // penalty is now active (set on the 429 response)

    // ...then caller 2 arrives INSIDE the penalty window. The limiter must
    // hold it until the server's own timer expires — zero wire traffic.
    const second = mock.bridge.control.getState();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ tick: 42 });
    expect(b).toMatchObject({ tick: 42 });

    const first429 = mock.hits[0];
    const offenders = mock.hits.filter(
      (t) => t > first429 + 400 && t < first429 + retryAfterSec * 1000 - 200,
    );
    expect(
      offenders.length,
      `no request may land inside the 429 penalty window (saw hits at +` +
        mock.hits.map((t) => t - first429).join('ms, +') + 'ms after the 429)',
    ).toBe(0);
    expect(mock.hits.length, 'one 429 + one retry + one queued caller = 3 requests').toBe(3);
  }, 30_000);

  it('throws a typed RateLimitError once retries are exhausted', async () => {
    mock = await startMock(99, 1);

    const err = await mock.bridge.control.getState().then(
      () => {
        throw new Error('getState must not succeed while the server keeps returning 429');
      },
      (e: unknown) => e,
    );
    expect(err, 'exhausted retries must surface as RateLimitError').toBeInstanceOf(RateLimitError);
    expect(
      (err as RateLimitError).retryAfterSec,
      'the parsed Retry-After must ride on the typed error',
    ).toBe(1);
    // maxRetries=3 → exactly 4 attempts, each spaced by the server's timer.
    expect(mock.hits.length).toBe(4);
  }, 30_000);
});
