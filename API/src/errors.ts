/**
 * Typed error hierarchy for the Screeps Web API Bridge.
 *
 * Every failure surfaced to a caller is one of these classes so that callers
 * (and AI agents) can branch on error type rather than parsing strings.
 */

/** Base class for every error thrown by the bridge. */
export class BridgeError extends Error {
  /** HTTP status code, when the error originated from an HTTP response. */
  public readonly status?: number;
  /** Raw response body / payload, when available, for debugging. */
  public readonly body?: unknown;
  /** Endpoint path that produced the error, when known. */
  public readonly endpoint?: string;

  constructor(
    message: string,
    opts: { status?: number; body?: unknown; endpoint?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status;
    this.body = opts.body;
    this.endpoint = opts.endpoint;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Authentication failed: missing/invalid token, bad credentials, or `auth failed`. */
export class AuthError extends BridgeError {}

/**
 * The request was rate limited (HTTP 429 or a WebSocket `err@...` rate-limit
 * frame). Carries the parsed retry timing so callers can back off correctly.
 */
export class RateLimitError extends BridgeError {
  /** Seconds to wait before retrying, parsed from the response. */
  public readonly retryAfterSec?: number;
  /** Absolute epoch-ms timestamp when the budget resets, when known. */
  public readonly resetAt?: number;
  /** The rate-limit class/budget that was exhausted, when known. */
  public readonly rateLimitClass?: string;

  constructor(
    message: string,
    opts: {
      status?: number;
      body?: unknown;
      endpoint?: string;
      retryAfterSec?: number;
      resetAt?: number;
      rateLimitClass?: string;
    } = {},
  ) {
    super(message, opts);
    this.retryAfterSec = opts.retryAfterSec;
    this.resetAt = opts.resetAt;
    this.rateLimitClass = opts.rateLimitClass;
  }
}

/** The requested resource (room, user, message, …) does not exist (HTTP 404). */
export class NotFoundError extends BridgeError {}

/** The server returned an error: HTTP 5xx, or an `{ ok: 0 }` payload. */
export class ServerError extends BridgeError {}
