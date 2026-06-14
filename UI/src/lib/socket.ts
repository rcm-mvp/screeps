/**
 * Singleton WebSocket connection to the bridge host (/bridge-ws).
 *
 * Holds the desired channel set client-side and resubscribes after any
 * reconnect — both of this socket and of the underlying bridge (the host
 * clears its per-client subscriptions when the bridge reconnects, so we
 * re-send them whenever a fresh `status` arrives).
 */

import type { ChannelMessage, HostFrame } from './types';

export type UiSocketState = 'connecting' | 'open' | 'closed';

type ChannelHandler = (m: ChannelMessage) => void;
type FrameHandler = (f: HostFrame) => void;
type StateHandler = (s: UiSocketState) => void;

class UiSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<ChannelHandler>>();
  private frameHandlers = new Set<FrameHandler>();
  private stateHandlers = new Set<StateHandler>();
  private retry = 0;
  state: UiSocketState = 'closed';

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/bridge-ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setState('open');
      this.resubscribeAll();
    };
    ws.onclose = () => {
      this.setState('closed');
      const delay = Math.min(1000 * 2 ** this.retry, 10000);
      this.retry += 1;
      setTimeout(() => this.connect(), delay);
    };
    ws.onmessage = (ev) => {
      let frame: HostFrame;
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (frame.type === 'channel') {
        const set = this.handlers.get(frame.channel);
        if (set) {
          const msg: ChannelMessage = {
            channel: frame.channel,
            data: frame.data,
            isError: frame.isError,
          };
          for (const h of set) h(msg);
        }
        return;
      }
      // A fresh status means the host may have rebuilt the bridge — re-assert
      // every subscription this client wants (the host dedupes per client).
      if ((frame.type === 'status' || frame.type === 'hello') && frame.status.connected) {
        this.resubscribeAll();
      }
      for (const h of this.frameHandlers) h(frame);
    };
  }

  onFrame(h: FrameHandler): () => void {
    this.frameHandlers.add(h);
    return () => this.frameHandlers.delete(h);
  }

  onState(h: StateHandler): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }

  /** Subscribe a handler to a bridge channel; returns an unsubscribe fn. */
  on(channel: string, handler: ChannelHandler): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      this.send({ type: 'subscribe', channel });
    }
    set.add(handler);
    return () => this.off(channel, handler);
  }

  off(channel: string, handler: ChannelHandler): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(channel);
      this.send({ type: 'unsubscribe', channel });
    }
  }

  private resubscribeAll(): void {
    for (const channel of this.handlers.keys()) {
      this.send({ type: 'subscribe', channel });
    }
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private setState(s: UiSocketState): void {
    this.state = s;
    for (const h of this.stateHandlers) h(s);
  }
}

export const uiSocket = new UiSocket();
