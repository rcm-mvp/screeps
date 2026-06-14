/**
 * Configuration: server presets, environment loading, and the resolved config
 * object consumed by the HTTP and WebSocket layers.
 */

/** Known server presets. `private` requires an explicit `host`. */
export type ServerPreset = 'official' | 'ptr' | 'private';

export interface ServerEndpoints {
  /** Base HTTP(S) origin, no trailing slash, e.g. `https://screeps.com`. */
  http: string;
  /** Optional API path prefix appended after the origin, e.g. `/ptr`. */
  prefix: string;
  /** Base WebSocket origin, e.g. `wss://screeps.com`. */
  ws: string;
  /**
   * Whether the server rotates the auth token via the `X-Token` response
   * header. Official + PTR do; most private servers do not.
   */
  rotatesToken: boolean;
}

/** Built-in presets for the official server and PTR. */
export const SERVER_PRESETS: Record<'official' | 'ptr', ServerEndpoints> = {
  official: {
    http: 'https://screeps.com',
    prefix: '',
    ws: 'wss://screeps.com',
    rotatesToken: true,
  },
  ptr: {
    http: 'https://screeps.com',
    prefix: '/ptr',
    ws: 'wss://screeps.com',
    rotatesToken: true,
  },
};

export interface BridgeConfig {
  /** Server preset; defaults to `official`. */
  server?: ServerPreset;
  /**
   * For `server: 'private'` (or to override a preset), the full origin of the
   * server, e.g. `http://localhost:21025`. The matching `ws://` / `wss://`
   * origin is derived automatically unless `wsHost` is given.
   */
  host?: string;
  /** Explicit WebSocket origin override (otherwise derived from `host`). */
  wsHost?: string;
  /** Optional path prefix override (e.g. `/ptr`). */
  prefix?: string;
  /** Persistent auth token (preferred auth method). */
  token?: string;
  /** Username for private-server `auth/signin` (when no token). */
  username?: string;
  /** Password for private-server `auth/signin` (when no token). */
  password?: string;
  /** Default shard for shard-scoped calls. */
  shard?: string;
  /** Enable structured request/response logging. */
  log?: boolean;
  /** Override token rotation behaviour. */
  rotatesToken?: boolean;
  /** Max automatic retries for transient (network / 5xx) failures. Default 3. */
  maxRetries?: number;
}

/** Fully-resolved configuration used internally. */
export interface ResolvedConfig {
  endpoints: ServerEndpoints;
  token?: string;
  username?: string;
  password?: string;
  shard: string;
  log: boolean;
  maxRetries: number;
}

/** Derive a `ws(s)://` origin from an `http(s)://` origin. */
function deriveWsHost(httpHost: string): string {
  if (httpHost.startsWith('https://')) return 'wss://' + httpHost.slice('https://'.length);
  if (httpHost.startsWith('http://')) return 'ws://' + httpHost.slice('http://'.length);
  return httpHost;
}

/**
 * Resolve a partial {@link BridgeConfig} (merged with environment variables)
 * into a complete {@link ResolvedConfig}.
 */
export function resolveConfig(cfg: BridgeConfig = {}): ResolvedConfig {
  const env = typeof process !== 'undefined' ? process.env : ({} as NodeJS.ProcessEnv);

  const server: ServerPreset =
    cfg.server ?? (env.SCREEPS_SERVER as ServerPreset | undefined) ?? 'official';

  const host = cfg.host ?? env.SCREEPS_HOST;
  let endpoints: ServerEndpoints;

  if (server === 'private') {
    if (!host) {
      throw new Error('config: server "private" requires a `host` (or SCREEPS_HOST).');
    }
    endpoints = {
      http: host.replace(/\/$/, ''),
      prefix: cfg.prefix ?? '',
      ws: cfg.wsHost ?? deriveWsHost(host.replace(/\/$/, '')),
      rotatesToken: cfg.rotatesToken ?? false,
    };
  } else {
    const preset = SERVER_PRESETS[server];
    endpoints = {
      http: host ? host.replace(/\/$/, '') : preset.http,
      prefix: cfg.prefix ?? preset.prefix,
      ws: cfg.wsHost ?? preset.ws,
      rotatesToken: cfg.rotatesToken ?? preset.rotatesToken,
    };
  }

  const log =
    cfg.log ?? (env.SCREEPS_LOG ? env.SCREEPS_LOG.toLowerCase() === 'true' : false);

  return {
    endpoints,
    token: cfg.token ?? env.SCREEPS_TOKEN,
    username: cfg.username ?? env.SCREEPS_USERNAME,
    password: cfg.password ?? env.SCREEPS_PASSWORD,
    shard: cfg.shard ?? env.SCREEPS_SHARD ?? 'shard3',
    log,
    maxRetries: cfg.maxRetries ?? 3,
  };
}
