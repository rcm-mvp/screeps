/**
 * Dashboard shell: left nav of panels + persistent header with connection,
 * shard, last tick, a live CPU sparkline and the global rate-limit budget.
 */

import { useMemo } from 'react';
import { useBridge, useNow, useRateLimit } from './lib/hooks';
import { PanelId, useStore } from './lib/store';
import { Dot } from './components/common';
import { Sparkline } from './components/Sparkline';
import { ConnectionPanel } from './panels/ConnectionPanel';
import { ColonyPanel } from './panels/ColonyPanel';
import { CpuPanel } from './panels/CpuPanel';
import { ConsolePanel } from './panels/ConsolePanel';
import { RoomPanel } from './panels/RoomPanel';
import { MapPanel } from './panels/MapPanel';
import { MemoryPanel } from './panels/MemoryPanel';
import { CodePanel } from './panels/CodePanel';
import { MarketPanel } from './panels/MarketPanel';
import { WorldActionsPanel } from './panels/WorldActionsPanel';
import { RawApiPanel } from './panels/RawApiPanel';
import { RateLimitPanel } from './panels/RateLimitPanel';

const PANELS: Array<{ id: PanelId; label: string; component: () => JSX.Element }> = [
  { id: 'connection', label: 'Connection', component: ConnectionPanel },
  { id: 'colony', label: 'Colony', component: ColonyPanel },
  { id: 'cpu', label: 'CPU & Memory', component: CpuPanel },
  { id: 'console', label: 'Console', component: ConsolePanel },
  { id: 'room', label: 'Room Viewer', component: RoomPanel },
  { id: 'map', label: 'World Map', component: MapPanel },
  { id: 'memory', label: 'Memory', component: MemoryPanel },
  { id: 'code', label: 'Code / Branches', component: CodePanel },
  { id: 'market', label: 'Market', component: MarketPanel },
  { id: 'actions', label: 'World Actions', component: WorldActionsPanel },
  { id: 'rawapi', label: 'Raw API', component: RawApiPanel },
  { id: 'ratelimits', label: 'Rate Limits', component: RateLimitPanel },
];

function Header() {
  const { connected, account, shard, gameSocket, uiSocketState } = useBridge();
  const cpuHistory = useStore((s) => s.cpuHistory);
  const gameTime = useStore((s) => s.gameTime);
  const lastTickAt = useStore((s) => s.lastTickAt);
  const colony = useStore((s) => s.colonyState);
  const global = useRateLimit('global');
  const now = useNow(1000);

  const cpuValues = useMemo(() => cpuHistory.slice(-60).map((h) => h.cpu), [cpuHistory]);
  const limit = colony?.cpu.limit ?? account?.cpu ?? undefined;
  const lastCpu = cpuHistory[cpuHistory.length - 1];
  const tickAge = lastTickAt ? Math.round((now - lastTickAt) / 1000) : null;

  const tone =
    !connected || uiSocketState !== 'open'
      ? 'bad'
      : gameSocket === 'connected'
        ? 'ok'
        : gameSocket === 'reconnecting' || gameSocket === 'connecting'
          ? 'warn'
          : 'bad';
  const label = !connected
    ? 'disconnected'
    : uiSocketState !== 'open'
      ? 'host link down'
      : gameSocket === 'connected'
        ? (account?.username ?? 'connected')
        : gameSocket;

  return (
    <header className="header">
      <span className="brand">Screeps Bridge Panel</span>
      <span className="header-item">
        <Dot tone={tone} /> {label}
      </span>
      {shard && <span className="header-item chip chip-dim">{shard}</span>}
      <span className="header-item muted">
        tick {gameTime ?? '—'}
        {tickAge !== null && tickAge <= 60 && <span className="muted small"> ({tickAge}s ago)</span>}
        {tickAge !== null && tickAge > 60 && <span className="text-warn small"> (stale {tickAge}s)</span>}
      </span>
      <span className="spacer" />
      {cpuValues.length > 1 && (
        <span className="header-item" title={`CPU last tick: ${lastCpu?.cpu.toFixed(1)}${limit ? ` / ${limit}` : ''}`}>
          <Sparkline values={cpuValues} limit={limit} />
          <span className="muted small">{lastCpu ? `${lastCpu.cpu.toFixed(0)} cpu` : ''}</span>
        </span>
      )}
      {global && (
        <span
          className={`header-item chip ${global.remaining <= 10 ? 'chip-bad' : 'chip-dim'}`}
          title="global request budget (120/min)"
        >
          {global.remaining}/{global.max} req
        </span>
      )}
    </header>
  );
}

export default function App() {
  const active = useStore((s) => s.activePanel);
  const setPanel = useStore((s) => s.setPanel);
  const connected = useStore((s) => s.status?.connected ?? false);
  const Active = PANELS.find((p) => p.id === active)?.component ?? ConnectionPanel;

  return (
    <div className="app">
      <Header />
      <div className="body">
        <nav className="nav">
          {PANELS.map((p) => (
            <button
              key={p.id}
              className={`nav-item ${p.id === active ? 'nav-active' : ''}`}
              onClick={() => setPanel(p.id)}
              disabled={!connected && p.id !== 'connection' && p.id !== 'rawapi' && p.id !== 'ratelimits'}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <main className="main">
          <Active />
        </main>
      </div>
    </div>
  );
}
