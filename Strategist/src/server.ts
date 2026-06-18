/**
 * Tiny HTTP API the UI commander panel talks to. All endpoints are local and
 * cheap (no Screeps traffic) — the panel may poll `/state` freely.
 *
 *   GET  /health   -> { ok: true }
 *   GET  /state    -> StatusSnapshot (status, flags, budget, history, steering, digest)
 *   POST /run      -> force a fresh evaluation now (re-queries the LLM)
 *   POST /control  -> { dryRun?, killSwitch?, decider? }  (live toggles)
 *   POST /steer    -> { shortTerm?, longTerm? }           (human guidance for the AI)
 */

import http from 'node:http';
import type { DeciderKind } from './config';
import type { Logger, Strategist } from './strategist';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

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

export function createServer(strategist: Strategist, logger?: Logger): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') return send(res, 204, {});

    try {
      switch (route) {
        case 'GET /health':
          return send(res, 200, { ok: true });

        case 'GET /state':
          return send(res, 200, strategist.getStatus());

        case 'POST /run':
          return send(res, 200, await strategist.runNow());

        case 'POST /control': {
          const body = await readBody(req);
          const patch: { dryRun?: boolean; killSwitch?: boolean; decider?: DeciderKind } = {};
          if (typeof body.dryRun === 'boolean') patch.dryRun = body.dryRun;
          if (typeof body.killSwitch === 'boolean') patch.killSwitch = body.killSwitch;
          if (body.decider === 'rules' || body.decider === 'ollama') patch.decider = body.decider;
          strategist.setControl(patch);
          return send(res, 200, strategist.getStatus());
        }

        case 'POST /steer': {
          const body = await readBody(req);
          const patch: { shortTerm?: string | null; longTerm?: string | null } = {};
          if ('shortTerm' in body) patch.shortTerm = asNullableString(body.shortTerm);
          if ('longTerm' in body) patch.longTerm = asNullableString(body.longTerm);
          strategist.setSteering(patch);
          return send(res, 200, strategist.getStatus());
        }

        default:
          return send(res, 404, { error: { kind: 'not_found', message: `No route ${route}` } });
      }
    } catch (e) {
      logger?.warn('http request failed', { route, err: String(e) });
      return send(res, 400, { error: { kind: 'bad_request', message: e instanceof Error ? e.message : String(e) } });
    }
  });
}

function asNullableString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  return null;
}
