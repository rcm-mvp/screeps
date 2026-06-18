/**
 * Bridge host — the thin process that owns the single ScreepsBridge instance
 * and exposes it to the browser. It re-implements nothing: every call goes
 * through bridge.invoke() (so the bridge's rate-limit manager + typed errors
 * apply), the manifest is served verbatim, and WS channels are relayed 1:1.
 *
 * HTTP:
 *   GET  /api/status        connection + account + socket state + budgets
 *   POST /api/connect       { server?, host?, token?, shard? } (token falls back to env)
 *   POST /api/disconnect
 *   POST /api/shard         { shard }
 *   GET  /api/manifest      capability manifest (available pre-connect)
 *   GET  /api/rate-limits   live budgets
 *   POST /api/invoke        { name, params } -> { ok, result, budgets }
 *
 * WS /bridge-ws (JSON frames):
 *   client -> { type: 'subscribe' | 'unsubscribe', channel }
 *   server -> { type: 'hello' | 'status', status }
 *             { type: 'channel', channel, data, isError? }
 *             { type: 'socket', state }
 *             { type: 'budgets', budgets }
 *             { type: 'error', message }
 *
 * The token only ever lives in this process (or SCREEPS_TOKEN env); it is
 * never sent back to the browser.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ScreepsBridge,
  CAPABILITIES,
  AuthError,
  NotFoundError,
  RateLimitError,
  ServerError,
  BridgeError,
} from 'screeps-web-api-bridge';
import type { ServerPreset } from 'screeps-web-api-bridge';
import type { MeProfile } from 'screeps-web-api-bridge';

/**
 * Minimal .env loader (Node 18 has no --env-file). Looks for a `.env` next to
 * the UI package (cwd when started via npm scripts). Real env vars win over
 * file values; the file is gitignored — this is where the token lives.
 */
function loadDotEnv(): void {
  for (const file of [path.join(process.cwd(), '.env'), path.join(process.cwd(), 'UI', '.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
    console.log(`[bridge-ui host] loaded env from ${file}`);
    break;
  }
}
loadDotEnv();

const PORT = Number(process.env.BRIDGE_UI_PORT ?? 4000);
/** The (optional) external AI strategist service. The UI proxies to it but never
 *  depends on it — the dashboard runs fine with the strategist offline. */
const STRATEGIST_URL = (process.env.STRATEGIST_URL ?? 'http://localhost:4100').replace(/\/$/, '');

type SocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'auth-failed';

interface ConnectBody {
  server?: ServerPreset;
  host?: string;
  token?: string;
  shard?: string;
}

let bridge: ScreepsBridge | null = null;
let account: MeProfile | null = null;
let connInfo: { server: ServerPreset; host?: string } | null = null;
let socketState: SocketState = 'disconnected';

interface Client extends WebSocket {
  subs?: Set<string>;
}

const clients = new Set<Client>();
/** Refcounted bridge-side subscriptions shared across browser clients. */
const bridgeSubs = new Map<string, { count: number; stop: () => void }>();

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function statusPayload() {
  return {
    connected: bridge !== null && account !== null,
    account,
    userId: account?._id ?? null,
    shard: bridge?.shard ?? null,
    server: connInfo?.server ?? null,
    host: connInfo?.host ?? null,
    socket: socketState,
    budgets: bridge?.getRateLimitBudgets() ?? [],
    envTokenPresent: Boolean(process.env.SCREEPS_TOKEN),
  };
}

function broadcast(obj: unknown): void {
  const json = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(json);
  }
}

function setSocketState(state: SocketState): void {
  if (socketState === state) return;
  socketState = state;
  broadcast({ type: 'socket', state });
}

function mapError(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof RateLimitError) {
    return {
      status: 429,
      body: {
        error: {
          kind: 'rate_limit',
          message: e.message,
          retryAfterSec: e.retryAfterSec,
          resetAt: e.resetAt,
          rateLimitClass: e.rateLimitClass,
        },
      },
    };
  }
  if (e instanceof AuthError) {
    return { status: 401, body: { error: { kind: 'auth', message: e.message } } };
  }
  if (e instanceof NotFoundError) {
    return { status: 404, body: { error: { kind: 'not_found', message: e.message } } };
  }
  if (e instanceof ServerError) {
    return {
      status: 502,
      body: { error: { kind: 'server', message: e.message, body: e.body ?? null } },
    };
  }
  if (e instanceof BridgeError) {
    return {
      status: 500,
      body: { error: { kind: 'bridge', message: e.message, status: e.status ?? null } },
    };
  }
  return {
    status: 500,
    body: { error: { kind: 'unknown', message: e instanceof Error ? e.message : String(e) } },
  };
}

/* ------------------------------------------------------------------ */
/* AI Strategist proxy (separate, optional service)                     */
/* ------------------------------------------------------------------ */

/**
 * Forward a request to the standalone strategist service. When it is unreachable
 * we return 503 with a friendly marker so the panel can show "offline" rather than
 * erroring — the strategist is optional and the UI never couples to it.
 */
async function proxyStrategist(
  method: string,
  subpath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`${STRATEGIST_URL}${subpath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } catch {
    return {
      status: 503,
      body: {
        error: {
          kind: 'strategist_offline',
          message: `Strategist service unreachable at ${STRATEGIST_URL}. Start it with "npm run dev" in Strategist/.`,
        },
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Connect / disconnect                                                 */
/* ------------------------------------------------------------------ */

function teardown(): void {
  for (const sub of bridgeSubs.values()) {
    try {
      sub.stop();
    } catch {
      /* socket may already be gone */
    }
  }
  bridgeSubs.clear();
  for (const c of clients) c.subs?.clear();
  try {
    bridge?.close();
  } catch {
    /* ignore */
  }
  bridge = null;
  account = null;
  connInfo = null;
  socketState = 'disconnected';
}

async function doConnect(body: ConnectBody): Promise<void> {
  teardown();

  const server = body.server ?? (process.env.SCREEPS_SERVER as ServerPreset) ?? 'official';
  const next = new ScreepsBridge({
    server,
    host: body.host || process.env.SCREEPS_HOST,
    token: body.token || process.env.SCREEPS_TOKEN,
    shard: body.shard || process.env.SCREEPS_SHARD || 'shard3',
  });

  // Validate auth before declaring the bridge live.
  const me = await next.auth.me();

  bridge = next;
  account = me;
  connInfo = { server, host: body.host || process.env.SCREEPS_HOST };

  const sock = next.socket;
  sock.on('auth', () => setSocketState('connected'));
  sock.on('authFailed', () => setSocketState('auth-failed'));
  sock.on('close', () => {
    if (socketState !== 'auth-failed') setSocketState('disconnected');
  });
  sock.on('reconnect', () => setSocketState('reconnecting'));
  sock.on('error', (err: Error) => {
    // Listener required so the bridge's EventEmitter never throws; surfaced
    // to clients via the socket state instead.
    console.warn('[bridge socket]', err.message);
  });

  setSocketState('connecting');
  try {
    await next.connectSocket();
  } catch (e) {
    // HTTP auth worked but the live socket failed — stay connected (HTTP
    // calls still work), report the socket state honestly.
    console.warn('[bridge] socket connect failed:', e instanceof Error ? e.message : e);
    setSocketState('disconnected');
  }
}

/* ------------------------------------------------------------------ */
/* WS channel relay                                                     */
/* ------------------------------------------------------------------ */

function subscribeBridge(channel: string): void {
  const existing = bridgeSubs.get(channel);
  if (existing) {
    existing.count += 1;
    return;
  }
  if (!bridge) throw new Error('Not connected to a Screeps server.');
  const stop = bridge.subscribeChannel(channel, (m) => {
    const json = JSON.stringify({
      type: 'channel',
      channel: m.channel,
      data: m.data,
      isError: m.isError ?? false,
    });
    for (const c of clients) {
      if (c.subs?.has(channel) && c.readyState === WebSocket.OPEN) c.send(json);
    }
  });
  bridgeSubs.set(channel, { count: 1, stop });
}

function unsubscribeBridge(channel: string): void {
  const sub = bridgeSubs.get(channel);
  if (!sub) return;
  sub.count -= 1;
  if (sub.count <= 0) {
    bridgeSubs.delete(channel);
    try {
      sub.stop();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                          */
/* ------------------------------------------------------------------ */

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    switch (route) {
      case 'GET /api/health':
        return send(res, 200, { ok: true });

      case 'GET /api/status':
        return send(res, 200, statusPayload());

      case 'GET /api/manifest':
        // Static catalogue — identical with or without a live bridge.
        return send(res, 200, { capabilities: CAPABILITIES });

      case 'GET /api/rate-limits':
        return send(res, 200, { budgets: bridge?.getRateLimitBudgets() ?? [] });

      case 'POST /api/connect': {
        const body = (await readBody(req)) as ConnectBody;
        await doConnect(body);
        const status = statusPayload();
        broadcast({ type: 'status', status });
        return send(res, 200, status);
      }

      case 'POST /api/disconnect': {
        teardown();
        const status = statusPayload();
        broadcast({ type: 'status', status });
        return send(res, 200, status);
      }

      case 'POST /api/shard': {
        const body = await readBody(req);
        if (!bridge) return send(res, 400, { error: { kind: 'state', message: 'Not connected.' } });
        if (typeof body.shard !== 'string' || !body.shard) {
          return send(res, 400, { error: { kind: 'params', message: 'shard required.' } });
        }
        bridge.shard = body.shard;
        const status = statusPayload();
        broadcast({ type: 'status', status });
        return send(res, 200, status);
      }

      case 'POST /api/invoke': {
        const body = await readBody(req);
        if (!bridge) {
          return send(res, 400, { error: { kind: 'state', message: 'Not connected. Use the Connection panel first.' } });
        }
        if (typeof body.name !== 'string') {
          return send(res, 400, { error: { kind: 'params', message: '"name" (capability) required.' } });
        }
        const result = await bridge.invoke(body.name, (body.params as Record<string, unknown>) ?? {});
        return send(res, 200, { ok: true, result, budgets: bridge.getRateLimitBudgets() });
      }

      case 'GET /api/strategist/state': {
        const r = await proxyStrategist('GET', '/state');
        return send(res, r.status, r.body);
      }

      case 'POST /api/strategist/run': {
        const r = await proxyStrategist('POST', '/run');
        return send(res, r.status, r.body);
      }

      case 'POST /api/strategist/control': {
        const body = await readBody(req);
        const r = await proxyStrategist('POST', '/control', body);
        return send(res, r.status, r.body);
      }

      case 'POST /api/strategist/steer': {
        const body = await readBody(req);
        const r = await proxyStrategist('POST', '/steer', body);
        return send(res, r.status, r.body);
      }

      default:
        return send(res, 404, { error: { kind: 'not_found', message: `No route ${route}` } });
    }
  } catch (e) {
    const { status, body } = mapError(e);
    return send(res, status, body);
  }
});

/* ------------------------------------------------------------------ */
/* WS server                                                            */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, path: '/bridge-ws' });

wss.on('connection', (ws: Client) => {
  ws.subs = new Set();
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', status: statusPayload() }));

  ws.on('message', (raw) => {
    let msg: { type?: string; channel?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON frame.' }));
    }
    const channel = typeof msg.channel === 'string' ? msg.channel : null;
    try {
      if (msg.type === 'subscribe' && channel) {
        if (ws.subs!.has(channel)) return; // idempotent per client
        subscribeBridge(channel);
        ws.subs!.add(channel);
        ws.send(JSON.stringify({ type: 'subscribed', channel }));
      } else if (msg.type === 'unsubscribe' && channel) {
        if (!ws.subs!.delete(channel)) return;
        unsubscribeBridge(channel);
        ws.send(JSON.stringify({ type: 'unsubscribed', channel }));
      }
    } catch (e) {
      ws.send(
        JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : String(e), channel }),
      );
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    for (const channel of ws.subs ?? []) unsubscribeBridge(channel);
  });
});

/* ------------------------------------------------------------------ */
/* Budget push (no Screeps traffic — reads the local limiter)           */
/* ------------------------------------------------------------------ */

let lastBudgetsJson = '';
setInterval(() => {
  if (!bridge || clients.size === 0) return;
  const budgets = bridge.getRateLimitBudgets();
  const json = JSON.stringify(budgets);
  if (json !== lastBudgetsJson) {
    lastBudgetsJson = json;
    broadcast({ type: 'budgets', budgets });
  }
}, 2000);

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

server.listen(PORT, () => {
  console.log(`[bridge-ui host] listening on http://localhost:${PORT}`);
  if (process.env.SCREEPS_TOKEN) {
    doConnect({})
      .then(() => console.log(`[bridge-ui host] auto-connected as ${account?.username}`))
      .catch((e) =>
        console.warn('[bridge-ui host] auto-connect failed:', e instanceof Error ? e.message : e),
      );
  } else {
    console.log('[bridge-ui host] no SCREEPS_TOKEN in env — connect via the UI.');
  }
});
