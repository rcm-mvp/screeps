/**
 * Global app store. Owns connection status, live budgets, and the always-on
 * stream buffers (CPU history, console feed, Memory.bridge.state) so panels
 * can mount/unmount without losing history. Room/map channels are subscribed
 * per-panel via useChannel instead.
 */

import { create } from 'zustand';
import { Channels } from 'screeps-web-api-bridge/dist/socket/channels';
import { api, ApiError } from './api';
import { uiSocket, UiSocketState } from './socket';
import type {
  BridgeStatus,
  ChannelMessage,
  ColonyState,
  ConnectForm,
  ConsoleError,
  ConsoleMessage,
  CpuStats,
  RateLimitBudget,
} from './types';
import { nextId } from './util';

export type PanelId =
  | 'connection'
  | 'colony'
  | 'cpu'
  | 'console'
  | 'room'
  | 'map'
  | 'memory'
  | 'code'
  | 'market'
  | 'actions'
  | 'rawapi'
  | 'ratelimits';

export interface CpuSample {
  ts: number;
  cpu: number;
  memory: number;
}

export interface ConsoleLine {
  id: number;
  ts: number;
  kind: 'log' | 'result' | 'error' | 'input';
  text: string;
  shard?: string;
}

const CPU_HISTORY_MAX = 600;
const CONSOLE_MAX = 500;

export interface OwnedRoom {
  shard: string;
  room: string;
  level: number | null;
}

const DEFAULT_ROOM_KEY = 'bridge-ui.defaultRoom';

function loadDefaultRoom(): { shard: string; room: string } | null {
  try {
    const raw = localStorage.getItem(DEFAULT_ROOM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

interface AppState {
  status: BridgeStatus | null;
  uiSocketState: UiSocketState;
  budgets: RateLimitBudget[];
  connectError: string | null;
  connecting: boolean;

  cpuHistory: CpuSample[];
  consoleLines: ConsoleLine[];
  colonyState: ColonyState | null;
  gameTime: number | null;
  lastTickAt: number | null;

  activePanel: PanelId;
  /** Set by the map panel to deep-link into the room viewer. */
  roomTarget: { shard: string; room: string } | null;
  /** Rooms owned by the authenticated account (bootstrapped after connect). */
  colonyRooms: OwnedRoom[];
  /** Strongest owned room — default for the room viewer / map (persisted). */
  defaultRoom: { shard: string; room: string } | null;

  setPanel: (p: PanelId) => void;
  openRoom: (shard: string, room: string) => void;
  setDefaultRoom: (d: { shard: string; room: string } | null) => void;
  pushConsoleInput: (text: string) => void;
  refreshStatus: () => Promise<void>;
  connect: (form: ConnectForm) => Promise<void>;
  disconnect: () => Promise<void>;
  setShard: (shard: string) => Promise<void>;
  init: () => void;
}

export const useStore = create<AppState>((set, get) => ({
  status: null,
  uiSocketState: 'closed',
  budgets: [],
  connectError: null,
  connecting: false,

  cpuHistory: [],
  consoleLines: [],
  colonyState: null,
  gameTime: null,
  lastTickAt: null,

  activePanel: 'connection',
  roomTarget: null,
  colonyRooms: [],
  defaultRoom: loadDefaultRoom(),

  setPanel: (p) => set({ activePanel: p }),

  openRoom: (shard, room) => set({ roomTarget: { shard, room }, activePanel: 'room' }),

  setDefaultRoom: (d) => {
    try {
      if (d) localStorage.setItem(DEFAULT_ROOM_KEY, JSON.stringify(d));
      else localStorage.removeItem(DEFAULT_ROOM_KEY);
    } catch {
      /* private mode */
    }
    set({ defaultRoom: d });
  },

  pushConsoleInput: (text) =>
    set((s) => ({
      consoleLines: appendLines(s.consoleLines, [
        { id: nextId(), ts: Date.now(), kind: 'input', text },
      ]),
    })),

  refreshStatus: async () => {
    try {
      const status = await api.status();
      set({ status, budgets: status.budgets });
      onStatus(status);
    } catch (e) {
      set({ connectError: e instanceof Error ? e.message : String(e) });
    }
  },

  connect: async (form) => {
    set({ connecting: true, connectError: null });
    try {
      const status = await api.connect(form);
      set({
        status,
        budgets: status.budgets,
        connecting: false,
        cpuHistory: [],
        colonyState: null,
      });
      onStatus(status);
      if (get().activePanel === 'connection') set({ activePanel: 'cpu' });
    } catch (e) {
      const msg = e instanceof ApiError ? e.info.message : e instanceof Error ? e.message : String(e);
      set({ connecting: false, connectError: msg });
      throw e;
    }
  },

  disconnect: async () => {
    unbindUserChannels();
    colonyBootstrapFor = null;
    const status = await api.disconnect();
    set({ status, budgets: status.budgets, colonyState: null, colonyRooms: [] });
  },

  setShard: async (shard) => {
    const status = await api.setShard(shard);
    set({ status });
  },

  init: () => {
    uiSocket.onState((uiSocketState) => set({ uiSocketState }));
    uiSocket.onFrame((frame) => {
      switch (frame.type) {
        case 'hello':
        case 'status':
          set({ status: frame.status, budgets: frame.status.budgets });
          onStatus(frame.status);
          break;
        case 'socket':
          set((s) => (s.status ? { status: { ...s.status, socket: frame.state } } : {}));
          break;
        case 'budgets':
          set({ budgets: frame.budgets });
          break;
        default:
          break;
      }
    });
    uiSocket.connect();
    void get().refreshStatus();
  },
}));

/* ------------------------------------------------------------------ */
/* Colony bootstrap: owned rooms + RCL, strongest room becomes default  */
/* ------------------------------------------------------------------ */

function onStatus(status: BridgeStatus): void {
  bindUserChannels(status);
  void bootstrapColony(status);
}

let colonyBootstrapFor: string | null = null;

async function bootstrapColony(status: BridgeStatus): Promise<void> {
  if (!status.connected || !status.userId || colonyBootstrapFor === status.userId) return;
  colonyBootstrapFor = status.userId;
  try {
    const owned = await fetchOwnedRooms(status.userId, status.shard ?? 'shard3');
    useStore.setState({ colonyRooms: owned });
    const strongest = owned.slice().sort((a, b) => (b.level ?? 0) - (a.level ?? 0))[0];
    if (strongest) {
      useStore.getState().setDefaultRoom({ shard: strongest.shard, room: strongest.room });
    }
  } catch (e) {
    colonyBootstrapFor = null; // retry on the next status frame
    console.warn('colony bootstrap failed:', e);
  }
}

/**
 * Owned rooms for a user via account.rooms, enriched with RCL from one
 * batched map.mapStats call per shard. Shared with the Colony panel.
 */
export async function fetchOwnedRooms(userId: string, fallbackShard: string): Promise<OwnedRoom[]> {
  const res = await api.invoke<Record<string, unknown>>('account.rooms', { userId });
  const pairs: Array<{ shard: string; room: string }> = [];
  const shards = res?.shards;
  if (shards && typeof shards === 'object') {
    for (const [shard, list] of Object.entries(shards as Record<string, unknown>)) {
      if (Array.isArray(list)) {
        for (const room of list) if (typeof room === 'string') pairs.push({ shard, room });
      }
    }
  } else if (Array.isArray(res?.rooms)) {
    for (const room of res.rooms as unknown[]) {
      if (typeof room === 'string') pairs.push({ shard: fallbackShard, room });
    }
  }

  const byShard = new Map<string, string[]>();
  for (const p of pairs) byShard.set(p.shard, [...(byShard.get(p.shard) ?? []), p.room]);

  const out: OwnedRoom[] = [];
  for (const [shard, rooms] of byShard) {
    let stats: Record<string, { own?: { level?: number } }> = {};
    try {
      const r = await api.invoke<{ stats?: typeof stats }>('map.mapStats', {
        rooms,
        statName: 'owner0',
        shard,
      });
      stats = r.stats ?? {};
    } catch {
      /* levels stay null; the rooms list is still useful */
    }
    for (const room of rooms) out.push({ shard, room, level: stats[room]?.own?.level ?? null });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Always-on user channels (cpu / console / Memory.bridge.state)        */
/* ------------------------------------------------------------------ */

function appendLines(lines: ConsoleLine[], add: ConsoleLine[]): ConsoleLine[] {
  const out = lines.concat(add);
  return out.length > CONSOLE_MAX ? out.slice(out.length - CONSOLE_MAX) : out;
}

let boundUserId: string | null = null;
let unbinders: Array<() => void> = [];

function unbindUserChannels(): void {
  for (const u of unbinders) u();
  unbinders = [];
  boundUserId = null;
}

function bindUserChannels(status: BridgeStatus): void {
  if (!status.connected || !status.userId) {
    unbindUserChannels();
    return;
  }
  if (boundUserId === status.userId) return;
  unbindUserChannels();
  boundUserId = status.userId;
  const uid = status.userId;
  const setState = useStore.setState;

  unbinders.push(
    uiSocket.on(Channels.cpu(uid), (m: ChannelMessage) => {
      const d = m.data as CpuStats;
      if (typeof d?.cpu !== 'number') return;
      setState((s) => {
        const cpuHistory = s.cpuHistory.concat({ ts: Date.now(), cpu: d.cpu, memory: d.memory });
        if (cpuHistory.length > CPU_HISTORY_MAX) cpuHistory.shift();
        return { cpuHistory, lastTickAt: Date.now() };
      });
    }),
  );

  unbinders.push(
    uiSocket.on(Channels.console(uid), (m: ChannelMessage) => {
      const ts = Date.now();
      const add: ConsoleLine[] = [];
      if (m.isError) {
        add.push({ id: nextId(), ts, kind: 'error', text: String(m.data) });
      } else {
        const d = m.data as Partial<ConsoleMessage & ConsoleError>;
        if (typeof d?.error === 'string') {
          add.push({ id: nextId(), ts, kind: 'error', text: d.error, shard: d.shard });
        }
        for (const line of d?.log ?? []) {
          add.push({ id: nextId(), ts, kind: 'log', text: line, shard: d?.shard });
        }
        for (const line of d?.results ?? []) {
          add.push({ id: nextId(), ts, kind: 'result', text: line, shard: d?.shard });
        }
      }
      if (add.length) setState((s) => ({ consoleLines: appendLines(s.consoleLines, add) }));
    }),
  );

  // Bucket / tick / GCL ride the executor contract at Memory.bridge.state —
  // the only live push channel that carries them (the cpu channel does not).
  // Subscribe to the `bridge.stateJson` STRING mirror, not the object path:
  // the screeps memory pubsub String()-coerces object paths to "[object Object]",
  // so the executor publishes a JSON-string copy that the channel carries intact.
  unbinders.push(
    uiSocket.on(Channels.memory(uid, 'bridge.stateJson'), (m: ChannelMessage) => {
      let d: ColonyState | null = null;
      if (typeof m.data === 'string' && m.data !== '[object Object]') {
        try {
          d = JSON.parse(m.data) as ColonyState;
        } catch {
          d = null;
        }
      } else if (m.data && typeof m.data === 'object') {
        d = m.data as ColonyState; // tolerate a pre-parsed object (mocks)
      }
      if (d && typeof d.tick === 'number') {
        setState({ colonyState: d, gameTime: d.tick, lastTickAt: Date.now() });
      }
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Selectors                                                            */
/* ------------------------------------------------------------------ */

export function selectBudget(budgets: RateLimitBudget[], label: string): RateLimitBudget | null {
  return budgets.find((b) => b.label === label) ?? null;
}
