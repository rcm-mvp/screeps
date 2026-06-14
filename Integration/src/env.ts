/**
 * Harness environment + the public-server safety guard.
 *
 * The suite is destructive (world resets, db inserts, code pushes). It must
 * therefore ONLY ever talk to a private server. Two layers enforce that:
 *
 *  1. Static guard ({@link assertPrivateHost}): an explicit
 *     `SCREEPS_PRIVATE_HOST` is required (there is deliberately NO default to
 *     any screeps.com preset), `screeps.com` hosts are rejected outright, and
 *     non-local hosts need an explicit `SCREEPS_ALLOW_REMOTE=true` opt-in.
 *  2. Runtime probe ({@link probeNotOfficial} in bootstrap.ts): `/api/version`
 *     of the configured host is inspected for official-server fingerprints
 *     (multi-shard list, large active-user count) before anything is touched.
 */

export interface HarnessEnv {
  /** HTTP origin of the private server, e.g. `http://127.0.0.1:21025`. */
  host: string;
  /** Host of the server CLI TCP port (defaults to the API host's hostname). */
  cliHost: string;
  /** Port of the server CLI (launcher default: 21026). */
  cliPort: number;
  /** Tick duration the harness configures on the server, in ms. */
  tickMs: number;
  /** Test account credentials (created by the harness via the server CLI). */
  username: string;
  password: string;
  /** Shard name used for shard-scoped bridge calls (private default). */
  shard: string;
  /**
   * Command that restarts the server process for scenario H part 2
   * (empty string disables that sub-test).
   */
  restartCmd: string;
}

const PUBLIC_HOST_RE = /(^|\.)screeps\.com$/i;

const LOCAL_HOST_RE =
  /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|host\.docker\.internal|[^.]+\.local)$/i;

/**
 * Validate the configured host. Throws (never returns) when the host is
 * missing, is the public server, or is non-local without an explicit opt-in.
 */
export function assertPrivateHost(host: string | undefined): asserts host is string {
  if (!host) {
    throw new Error(
      'SAFETY: SCREEPS_PRIVATE_HOST is not set. This suite resets world data and ' +
        'must only run against a private server you control — point ' +
        'SCREEPS_PRIVATE_HOST at it explicitly (e.g. http://127.0.0.1:21025).',
    );
  }
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`SAFETY: SCREEPS_PRIVATE_HOST "${host}" is not a valid URL (need e.g. http://127.0.0.1:21025).`);
  }
  if (PUBLIC_HOST_RE.test(url.hostname)) {
    throw new Error(
      `SAFETY: SCREEPS_PRIVATE_HOST resolves to the public Screeps server (${url.hostname}). ` +
        'Refusing to run: this suite is destructive and must never touch the MMO.',
    );
  }
  if (!LOCAL_HOST_RE.test(url.hostname) && process.env.SCREEPS_ALLOW_REMOTE !== 'true') {
    throw new Error(
      `SAFETY: "${url.hostname}" is not a local/private-range host. If this really is ` +
        'your own private server, set SCREEPS_ALLOW_REMOTE=true to confirm.',
    );
  }
}

/** Read + validate the harness environment. Throws on unsafe configuration. */
export function loadEnv(): HarnessEnv {
  const host = process.env.SCREEPS_PRIVATE_HOST;
  assertPrivateHost(host);
  const url = new URL(host);

  return {
    host: host.replace(/\/$/, ''),
    cliHost: process.env.SCREEPS_CLI_HOST ?? url.hostname,
    cliPort: Number(process.env.SCREEPS_CLI_PORT ?? 21026),
    tickMs: Number(process.env.SCREEPS_TICK_MS ?? 150),
    username: process.env.SCREEPS_TEST_USER ?? 'itester',
    password: process.env.SCREEPS_TEST_PASSWORD ?? 'itester-secret',
    shard: process.env.SCREEPS_SHARD ?? 'shard0',
    // Defaults to the docker command (the documented setup). The post-reset
    // restart in globalSetup needs it; so does scenario H part 2. Override for
    // a non-docker private server, or set empty to skip both.
    restartCmd: process.env.SCREEPS_RESTART_CMD ?? 'docker compose restart screeps',
  };
}
