/**
 * Minimal SockJS frame decoder for the Screeps WebSocket protocol.
 *
 * The Screeps socket speaks SockJS framing over a raw WebSocket. Frames:
 *   `o`            – open
 *   `h`            – heartbeat
 *   `c[code,reas]` – close
 *   `m"payload"`   – a single application message (JSON-encoded string)
 *   `a["p1","p2"]` – a batch of application messages (array of JSON strings)
 *
 * Each application *payload* is itself a string; Screeps payloads are either a
 * control string (`auth ok <token>`, `auth failed`, `time <n>`) or a
 * JSON-encoded `[channel, data]` tuple. This module only unwraps the SockJS
 * layer; channel interpretation happens in {@link SocketClient}.
 */

export type SockJsEvent =
  | { type: 'open' }
  | { type: 'heartbeat' }
  | { type: 'close'; code?: number; reason?: string }
  | { type: 'message'; payload: string };

/** Decode one raw SockJS frame into zero or more typed events. */
export function decodeSockJsFrame(raw: string): SockJsEvent[] {
  if (!raw) return [];
  const kind = raw[0];
  const rest = raw.slice(1);

  switch (kind) {
    case 'o':
      return [{ type: 'open' }];
    case 'h':
      return [{ type: 'heartbeat' }];
    case 'c': {
      try {
        const [code, reason] = JSON.parse(rest) as [number, string];
        return [{ type: 'close', code, reason }];
      } catch {
        return [{ type: 'close' }];
      }
    }
    case 'm': {
      try {
        return [{ type: 'message', payload: JSON.parse(rest) as string }];
      } catch {
        return [];
      }
    }
    case 'a': {
      try {
        const arr = JSON.parse(rest) as string[];
        return arr.map((payload) => ({ type: 'message', payload }) as const);
      } catch {
        return [];
      }
    }
    default:
      return [];
  }
}

/**
 * Interpret a Screeps application payload string. Returns either a control
 * message or a `[channel, data]` channel message.
 */
export type AppMessage =
  | { kind: 'control'; text: string }
  | { kind: 'channel'; channel: string; data: unknown };

export function parseAppMessage(payload: string): AppMessage {
  if (payload.startsWith('[')) {
    try {
      const arr = JSON.parse(payload) as [string, unknown];
      if (Array.isArray(arr) && typeof arr[0] === 'string') {
        return { kind: 'channel', channel: arr[0], data: arr[1] };
      }
    } catch {
      /* fall through to control */
    }
  }
  return { kind: 'control', text: payload };
}

/** Build the random SockJS URL suffix: `/<3-digit server>/<8-char session>`. */
export function sockjsPath(): string {
  const server = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let session = '';
  for (let i = 0; i < 8; i++) session += chars[Math.floor(Math.random() * chars.length)];
  return `/${server}/${session}`;
}
