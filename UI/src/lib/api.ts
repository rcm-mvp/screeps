/** HTTP client for the bridge host. All Screeps calls funnel through invoke(). */

import type { ApiErrorInfo, BridgeStatus, Capability, ConnectForm, RateLimitBudget } from './types';

export class ApiError extends Error {
  readonly info: ApiErrorInfo;
  readonly httpStatus: number;

  constructor(httpStatus: number, info: ApiErrorInfo) {
    super(info.message);
    this.name = 'ApiError';
    this.info = info;
    this.httpStatus = httpStatus;
  }

  get isRateLimit(): boolean {
    return this.info.kind === 'rate_limit';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (e) {
    throw new ApiError(0, {
      kind: 'unknown',
      message: `Bridge host unreachable (${e instanceof Error ? e.message : e}). Is "npm run server" running?`,
    });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const info = (body as { error?: ApiErrorInfo } | null)?.error ?? {
      kind: 'unknown' as const,
      message: `HTTP ${res.status}`,
    };
    throw new ApiError(res.status, info);
  }
  return body as T;
}

export const api = {
  status: () => req<BridgeStatus>('/api/status'),

  connect: (form: ConnectForm) =>
    req<BridgeStatus>('/api/connect', { method: 'POST', body: JSON.stringify(form) }),

  disconnect: () => req<BridgeStatus>('/api/disconnect', { method: 'POST' }),

  setShard: (shard: string) =>
    req<BridgeStatus>('/api/shard', { method: 'POST', body: JSON.stringify({ shard }) }),

  manifest: () => req<{ capabilities: Capability[] }>('/api/manifest'),

  rateLimits: () => req<{ budgets: RateLimitBudget[] }>('/api/rate-limits'),

  /** Call any bridge capability by manifest name. */
  invoke: async <T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<T> => {
    const res = await req<{ ok: boolean; result: T }>('/api/invoke', {
      method: 'POST',
      body: JSON.stringify({ name, params }),
    });
    return res.result;
  },
};
