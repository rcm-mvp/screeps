/** Reusable bridge-client hooks: useBridge, useChannel, useRateLimit. */

import { useEffect, useRef, useState } from 'react';
import { useStore, selectBudget } from './store';
import { uiSocket } from './socket';
import type { ChannelMessage, RateLimitBudget } from './types';

/** Connection status + account + actions — the bridge facade for panels. */
export function useBridge() {
  const status = useStore((s) => s.status);
  const uiSocketState = useStore((s) => s.uiSocketState);
  const connect = useStore((s) => s.connect);
  const disconnect = useStore((s) => s.disconnect);
  const setShard = useStore((s) => s.setShard);
  const connecting = useStore((s) => s.connecting);
  const connectError = useStore((s) => s.connectError);
  return {
    status,
    connected: status?.connected ?? false,
    account: status?.account ?? null,
    userId: status?.userId ?? null,
    shard: status?.shard ?? null,
    gameSocket: status?.socket ?? 'disconnected',
    uiSocketState,
    connecting,
    connectError,
    connect,
    disconnect,
    setShard,
  };
}

/**
 * Subscribe to a bridge WS channel for the lifetime of the component.
 * Pass null to subscribe to nothing. Returns the latest message.
 */
export function useChannel<T = unknown>(channel: string | null): ChannelMessage<T> | null {
  const [msg, setMsg] = useState<ChannelMessage<T> | null>(null);
  useEffect(() => {
    setMsg(null);
    if (!channel) return;
    const off = uiSocket.on(channel, (m) => setMsg(m as ChannelMessage<T>));
    return off;
  }, [channel]);
  return msg;
}

/** Live budget for one rate-limit class label (e.g. 'POST user/console'). */
export function useRateLimit(label: string): RateLimitBudget | null {
  return useStore((s) => selectBudget(s.budgets, label));
}

/** Re-render every `ms` (for reset countdowns). Returns the current time. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Track async invoke state: loading / error / run wrapper. */
export function useAsyncAction() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setLoading(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  return { loading, error, setError, run };
}
