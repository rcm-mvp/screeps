/**
 * Client for the private server's CLI (the backend's admin REPL). This is the
 * harness's "god mode": world reset, tick duration, user bootstrap, NPC
 * hostiles — none of which exist on the player-facing HTTP API.
 *
 * Transport: modern screeps backends expose the CLI as an HTTP endpoint
 * (`POST <cliBase>/cli`, body = a JS expression, response = the printed
 * result text). The launcher default port is 21026. (Older builds spoke a
 * raw TCP REPL on the same port; this client targets the HTTP form, which is
 * what `screepers/screeps-launcher` ships today.)
 *
 * Result framing: the CLI evaluates one expression and prints its result, but
 * promise results print whenever they resolve and util.inspect mangles
 * quoting. So every command is wrapped to print its own unambiguous marker —
 * `@@RES@@<encodeURIComponent(JSON)>@@END@@` (or `@@ERR@@...@@END@@`).
 * encodeURIComponent output contains no quotes, so it survives inspect's
 * escaping and the double-echo (print + REPL return) intact; we parse the
 * first marker occurrence.
 *
 * Constraints on scripts passed to {@link runJson}: they are collapsed onto a
 * single line, so they must not contain `//` comments (everything after one
 * would be commented out), and the encoded result must stay small (< ~8 KiB)
 * — return ids and summaries, not whole collections.
 */

export interface ServerCliOptions {
  host: string;
  port: number;
  /** Per-command timeout in ms (default 25s). */
  timeoutMs?: number;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly script: string,
    readonly rawOutput: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const RES_RE = /@@RES@@([^@]*)@@END@@/;
const ERR_RE = /@@ERR@@([^@]*)@@END@@/;

/** Undo the escaping util.inspect may add around our URI-encoded payload. */
function unescapeInspect(payload: string): string {
  return payload.replace(/\\(['"\\])/g, '$1');
}

export class ServerCli {
  private readonly base: string;

  constructor(private readonly opts: ServerCliOptions) {
    this.base = `http://${opts.host}:${opts.port}`;
  }

  /**
   * Evaluate `expr` (an expression or IIFE; promises are awaited server-side)
   * and return its JSON-roundtripped result. Throws {@link CliError} with the
   * raw CLI output when the script throws or produces no parseable result.
   */
  async runJson<T = unknown>(expr: string): Promise<T> {
    const oneLine = expr.replace(/\r?\n/g, ' ').trim();
    // Some server builds print resolved promise values, others only output
    // via the CLI's `print` helper — emit the marker through both channels.
    const emit =
      `function (s) { try { if (typeof print === 'function') print(s); } catch (e) {} return s; }`;
    const wrapped =
      `Promise.resolve().then(function () { return (${oneLine}); })` +
      `.then(function (v) { return '@@RES@@' + encodeURIComponent(JSON.stringify(v === undefined ? null : v)) + '@@END@@'; },` +
      ` function (e) { return '@@ERR@@' + encodeURIComponent(String((e && e.stack) || e)) + '@@END@@'; })` +
      `.then(${emit})`;

    const raw = await this.post(wrapped, oneLine);
    const err = ERR_RE.exec(raw);
    if (err) {
      throw new CliError(
        `server CLI script failed: ${decodeURIComponent(unescapeInspect(err[1]))}`,
        oneLine,
        raw,
      );
    }
    const res = RES_RE.exec(raw);
    if (!res) {
      throw new CliError('server CLI produced no result marker (see rawOutput)', oneLine, raw);
    }
    return JSON.parse(decodeURIComponent(unescapeInspect(res[1]))) as T;
  }

  /** Quick reachability check of the CLI endpoint. */
  async ping(): Promise<boolean> {
    try {
      const pong = await this.runJson<string>(`'pong'`);
      return pong === 'pong';
    } catch {
      return false;
    }
  }

  /** POST one expression to the CLI endpoint and return the raw response text. */
  private async post(body: string, original: string): Promise<string> {
    const timeoutMs = this.opts.timeoutMs ?? 25_000;
    let res: Response;
    try {
      res = await fetch(`${this.base}/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CliError(`server CLI request failed: ${String(err)}`, original, '');
    }
    const text = await res.text();
    if (!res.ok) {
      throw new CliError(`server CLI returned HTTP ${res.status}`, original, text);
    }
    return text;
  }
}
