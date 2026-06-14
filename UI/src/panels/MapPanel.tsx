/**
 * World map: a pannable grid of rooms colored by ownership via map.mapStats
 * (POST game/map-stats, 60/hr — one batched call per refresh, manual only),
 * with optional PvP / nuke overlays from the experimental endpoints.
 * Click a room to open it in the Room Viewer.
 */

import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsyncAction, useBridge } from '../lib/hooks';
import { useStore } from '../lib/store';
import { colorForUser, isValidRoomName, shiftRoom } from '../lib/util';
import { BudgetChip, ErrorBox, Section } from '../components/common';

interface RoomStat {
  status?: string;
  own?: { user?: string; level?: number };
  novice?: number;
  [key: string]: unknown;
}

interface MapStatsResponse {
  stats?: Record<string, RoomStat>;
  users?: Record<string, { username?: string }>;
}

export function MapPanel() {
  const { connected, shard: defaultShard, userId } = useBridge();
  const openRoom = useStore((s) => s.openRoom);
  const defaultRoom = useStore((s) => s.defaultRoom);

  const [shard, setShard] = useState(defaultRoom?.shard ?? defaultShard ?? 'shard3');
  const [center, setCenter] = useState(defaultRoom?.room ?? 'E0S0');
  const [radius, setRadius] = useState(4);
  const [stats, setStats] = useState<Record<string, RoomStat>>({});
  const [users, setUsers] = useState<Record<string, { username?: string }>>({});
  const [pvp, setPvp] = useState<Set<string>>(new Set());
  const [nukes, setNukes] = useState<Set<string>>(new Set());
  const { loading, error, run } = useAsyncAction();
  const overlay = useAsyncAction();

  const rooms = useMemo(() => {
    if (!isValidRoomName(center)) return [];
    const grid: string[][] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      const row: string[] = [];
      for (let dx = -radius; dx <= radius; dx++) row.push(shiftRoom(center, dx, dy));
      grid.push(row);
    }
    return grid;
  }, [center, radius]);

  const refresh = (centerRoom = center) => {
    if (!isValidRoomName(centerRoom)) return;
    const list: string[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) list.push(shiftRoom(centerRoom, dx, dy));
    }
    void run(async () => {
      const res = await api.invoke<MapStatsResponse>('map.mapStats', {
        rooms: list,
        statName: 'owner0',
        shard,
      });
      setStats(res.stats ?? {});
      setUsers(res.users ?? {});
    });
  };

  const pan = (dx: number, dy: number) => {
    const next = shiftRoom(center, dx * radius, dy * radius);
    setCenter(next);
    refresh(next);
  };

  const loadPvp = () =>
    void overlay.run(async () => {
      const res = await api.invoke<Record<string, { rooms?: Array<{ _id: string }> }>>('rooms.pvp', {
        interval: 100,
        shard,
      });
      const set = new Set<string>();
      for (const shardData of Object.values(res ?? {})) {
        for (const r of shardData?.rooms ?? []) set.add(r._id);
      }
      setPvp(set);
    });

  const loadNukes = () =>
    void overlay.run(async () => {
      const res = await api.invoke<Record<string, Array<{ room?: string; landTime?: number }>>>(
        'rooms.nukes',
        { shard },
      );
      const set = new Set<string>();
      for (const list of Object.values(res ?? {})) {
        if (Array.isArray(list)) for (const n of list) n.room && set.add(n.room);
      }
      setNukes(set);
    });

  const cellColor = (room: string): { bg: string; fg?: string; label?: string } => {
    const s = stats[room];
    if (!s) return { bg: '#15171c' };
    if (s.status && s.status !== 'normal') return { bg: '#0a0a0c' };
    if (s.own?.user) {
      const mine = s.own.user === userId;
      const owned = (s.own.level ?? 0) > 0;
      const base = mine ? '#2f7d2d' : colorForUser(s.own.user);
      return {
        bg: owned ? base : 'transparent',
        fg: owned ? '#fff' : base,
        label: owned ? `${s.own.level}` : 'rsv',
      };
    }
    if (s.novice !== undefined && s.novice > Date.now()) return { bg: '#1d2c3a', label: 'nov' };
    return { bg: '#1b1f23' };
  };

  return (
    <div className="panel-body">
      <Section
        title="World Map"
        actions={
          <div className="row">
            <input className="input input-s" value={shard} onChange={(e) => setShard(e.target.value)} placeholder="shard" />
            <input
              className="input input-s"
              value={center}
              onChange={(e) => setCenter(e.target.value)}
              placeholder="E0S0"
              onKeyDown={(e) => e.key === 'Enter' && refresh()}
            />
            <select className="input input-s" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
              {[2, 3, 4, 5, 6].map((r) => (
                <option key={r} value={r}>
                  {r * 2 + 1}×{r * 2 + 1}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" disabled={!connected || loading || !isValidRoomName(center)} onClick={() => refresh()}>
              {loading ? 'Loading…' : 'Load'}
            </button>
            <BudgetChip label="POST game/map-stats" />
          </div>
        }
      >
        {!connected && <div className="muted">Connect first.</div>}
        <ErrorBox error={error} />
        <ErrorBox error={overlay.error} />

        <div className="map-toolbar row">
          <button className="btn btn-xs" onClick={() => pan(0, -1)}>↑ N</button>
          <button className="btn btn-xs" onClick={() => pan(0, 1)}>↓ S</button>
          <button className="btn btn-xs" onClick={() => pan(-1, 0)}>← W</button>
          <button className="btn btn-xs" onClick={() => pan(1, 0)}>→ E</button>
          <span className="spacer" />
          <button className="btn btn-xs" disabled={!connected || overlay.loading} onClick={loadPvp}>
            PvP overlay
          </button>
          <button className="btn btn-xs" disabled={!connected || overlay.loading} onClick={loadNukes}>
            Nukes overlay
          </button>
        </div>

        <div className="map-grid" style={{ gridTemplateColumns: `repeat(${radius * 2 + 1}, 1fr)` }}>
          {rooms.flat().map((room) => {
            const c = cellColor(room);
            const s = stats[room];
            const owner = s?.own?.user ? users[s.own.user]?.username ?? s.own.user : null;
            return (
              <button
                key={room}
                className="map-cell"
                style={{ background: c.bg, color: c.fg, borderColor: c.fg ?? 'rgba(255,255,255,0.08)' }}
                title={`${room}${owner ? ` — ${owner}${s?.own?.level ? ` RCL${s.own.level}` : ' (reserved)'}` : ''}`}
                onClick={() => openRoom(shard, room)}
              >
                <span className="map-room">{room}</span>
                {c.label && <span className="map-level">{c.label}</span>}
                {pvp.has(room) && <span className="map-flag map-pvp" title="recent PvP">⚔</span>}
                {nukes.has(room) && <span className="map-flag map-nuke" title="nuke inbound">☢</span>}
              </button>
            );
          })}
        </div>
        <p className="muted small">
          map-stats is 60/hr — refreshes are manual. Click a room to open it in the Room Viewer.
        </p>
      </Section>
    </div>
  );
}
