/**
 * Optional, dependency-free MCP server wrapper.
 *
 * Registers every capability from the manifest as an MCP tool over a stdio
 * JSON-RPC transport (newline-delimited messages). The core library stays
 * MCP-agnostic; this file is the only place that knows about MCP, and it adds
 * no extra dependencies.
 *
 * Run: `node dist/mcp/server.js` (or `npm run mcp`). Configure your MCP client
 * to launch it with `SCREEPS_TOKEN` (+ optional `SCREEPS_SERVER`/`SCREEPS_SHARD`)
 * in the environment.
 */

import { createInterface } from 'node:readline';
import { ScreepsBridge } from '../bridge';
import { CAPABILITIES } from '../manifest';
import { BridgeError, RateLimitError } from '../errors';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function write(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function result(id: JsonRpcRequest['id'], res: unknown): void {
  write({ jsonrpc: '2.0', id, result: res });
}

function error(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): void {
  write({ jsonrpc: '2.0', id, error: { code, message, data } });
}

export function startMcpServer(bridge = new ScreepsBridge()): void {
  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return; // ignore malformed lines
    }

    try {
      switch (req.method) {
        case 'initialize':
          result(req.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'screeps-web-api-bridge', version: '0.1.0' },
          });
          return;

        case 'notifications/initialized':
        case 'initialized':
          return; // notification, no response

        case 'ping':
          result(req.id, {});
          return;

        case 'tools/list':
          result(req.id, {
            tools: CAPABILITIES.map((c) => ({
              name: c.name.replace(/\./g, '__'), // MCP tool names: no dots
              description: c.description,
              inputSchema: c.params,
            })),
          });
          return;

        case 'tools/call': {
          const params = req.params ?? {};
          const toolName = String(params.name ?? '').replace(/__/g, '.');
          const args = (params.arguments as Record<string, unknown>) ?? {};
          try {
            const value = await bridge.invoke(toolName, args);
            result(req.id, {
              content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            });
          } catch (err) {
            const text =
              err instanceof RateLimitError
                ? `RateLimitError: ${err.message} (retry after ${err.retryAfterSec ?? '?'}s)`
                : err instanceof BridgeError
                  ? `${err.name}: ${err.message}`
                  : String(err);
            result(req.id, { content: [{ type: 'text', text }], isError: true });
          }
          return;
        }

        default:
          error(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      error(req.id, -32603, 'Internal error', String(err));
    }
  });

  process.stderr.write('screeps-web-api-bridge MCP server ready on stdio\n');
}

if (require.main === module) {
  startMcpServer();
}
