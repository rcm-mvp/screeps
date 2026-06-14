/**
 * Colony overview: every room a user owns (defaults to the authenticated
 * account, but any username can be looked up via auth.findUser), with a
 * per-room summary card. Selecting a room opens a live detail view fed by the
 * room:<shard>/<room> WS channel: controller progress, energy, structures,
 * construction, and a creep table with a working / moving / idle status
 * derived from each creep's actionLog + movement between ticks.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Channels } from 'screeps-web-api-bridge/dist/socket/channels';
import { api } from '../lib/api';
import { useAsyncAction, useBridge, useChannel } from '../lib/hooks';
import { fetchOwnedRooms, OwnedRoom, useStore } from '../lib/store';
import type { RoomSnapshot } from '../lib/types';
import { formatNumber } from '../lib/util';
import { ErrorBox, JsonView, Section } from '../components/common';

/** The fields we read off room object documents (everything else stays raw). */
interface ObjDoc {
  _id: string;
  type?: string;
  x?: number;
  y?: number;
  user?: string;
  name?: string;
  level?: number;
  progress?: number;
  progressTotal?: number;
  downgradeTime?: number;
  safeMode?: number;
  hits?: number;
  hitsMax?: number;
  ageTime?: number;
  spawning?: boolean | { name?: string; remainingTime?: number } | null;
  fatigue?: number;
  body?: Array<{ type: string }>;
  store?: Record<string, number>;
  storeCapacity?: number;
  storeCapacityResource?: Record<string, number>;
  energy?: number;
  energyCapacity?: number;
  actionLog?: Record<string, unknown>;
  off?: boolean;
  [key: string]: unknown;
}

const BODY_ABBREV: Record<string, string> = {
  work: 'W',
  carry: 'C',
  move: 'M',
  attack: 'A',
  ranged_attack: 'R',
  heal: 'H',
  claim: 'L',
  tough: 'T',
};

const ENERGY_STRUCTS = new Set(['spawn', 'extension']);

function storeTotal(o: ObjDoc): number {
  if (o.store) return Object.values(o.store).reduce((a, b) => a + (b ?? 0), 0);
  return o.energy ?? 0;
}

function energyOf(o: ObjDoc): number {
  return o.store?.energy ?? o.energy ?? 0;
}

function energyCapOf(o: ObjDoc): number {
  return (
    o.storeCapacityResource?.energy ??
    o.energyCapacity ??
    (o.type === 'spawn' ? 300 : o.type === 'extension' ? 50 : 0)
  );
}

interface RoomSummary {
  controller: ObjDoc | null;
  energyAvailable: number;
  energyCapacity: number;
  storageEnergy: number | null;
  creeps: number;
  hostiles: number;
  structures: Record<string, number>;
  sites: number;
  spawningNames: string[];
}

function summarize(objects: ObjDoc[], ownerId: string | null): RoomSummary {
  const s: RoomSummary = {
    controller: null,
    energyAvailable: 0,
    energyCapacity: 0,
    storageEnergy: null,
    creeps: 0,
    hostiles: 0,
    structures: {},
    sites: 0,
    spawningNames: [],
  };
  for (const o of objects) {
    const type = o.type ?? '';
    if (type === 'controller') s.controller = o;
    else if (type === 'creep' || type === 'powerCreep') {
      if (!ownerId || o.user === ownerId) s.creeps += 1;
      else s.hostiles += 1;
    } else if (type === 'constructionSite') s.sites += 1;
    else if (type && type !== 'source' && type !== 'mineral' && type !== 'energy' && type !== 'tombstone' && type !== 'ruin') {
      s.structures[type] = (s.structures[type] ?? 0) + 1;
    }
    if (ENERGY_STRUCTS.has(type) && (!ownerId || o.user === ownerId)) {
      s.energyAvailable += energyOf(o);
      s.energyCapacity += energyCapOf(o);
    }
    if (type === 'storage') s.storageEnergy = energyOf(o);
    if (type === 'spawn' && o.spawning && typeof o.spawning === 'object') {
      s.spawningNames.push(o.spawning.name ?? o.name ?? 'spawn');
    }
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Creep status                                                         */
/* ------------------------------------------------------------------ */

type CreepStatus = { label: string; tone: 'ok' | 'warn' | 'bad' | 'dim' };

function creepStatus(o: ObjDoc, prev: { x: number; y: number } | undefined, hasPrevTick: boolean): CreepStatus {
  if (o.spawning) return { label: 'spawning', tone: 'dim' };
  const actions = o.actionLog
    ? Object.entries(o.actionLog).filter(([, v]) => v !== null && v !== undefined)
    : [];
  if (actions.length) {
    const a = actions.find(([k]) => k !== 'say') ?? actions[0];
    return { label: a[0], tone: 'ok' };
  }
  if (prev && (prev.x !== o.x || prev.y !== o.y)) return { label: 'moving', tone: 'dim' };
  if (hasPrevTick) return { label: 'idle', tone: 'warn' };
  return { label: '…', tone: 'dim' };
}

function roleOf(name: string | undefined): string {
  if (!name) return '—';
  const m = /^([a-zA-Z]+)/.exec(name);
  return m ? m[1].toLowerCase() : name;
}

function bodySummary(body: Array<{ type: string }> | undefined): string {
  if (!body?.length) return '—';
  const counts = new Map<string, number>();
  for (const part of body) counts.set(part.type, (counts.get(part.type) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => `${n}${BODY_ABBREV[t] ?? t[0].toUpperCase()}`).join(' ');
}

/* ------------------------------------------------------------------ */
/* Panel                                                                */
/* ------------------------------------------------------------------ */

export function ColonyPanel() {
  const { connected, userId, account, shard: defaultShard } = useBridge();
  const colonyRooms = useStore((s) => s.colonyRooms);
  const defaultRoom = useStore((s) => s.defaultRoom);
  const openRoom = useStore((s) => s.openRoom);

  const [username, setUsername] = useState('');
  const [targetUserId, setTargetUserId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<OwnedRoom[]>([]);
  const [summaries, setSummaries] = useState<Record<string, RoomSummary>>({});
  const [selected, setSelected] = useState<{ shard: string; room: string } | null>(null);
  const { loading, error, run } = useAsyncAction();
  const loadedForRef = useRef<string | null>(null);

  const keyOf = (r: { shard: string; room: string }) => `${r.shard}/${r.room}`;

  const loadSummaries = async (list: OwnedRoom[], owner: string | null) => {
    for (const r of list) {
      try {
        const res = await api.invoke<{ objects: ObjDoc[] }>('rooms.objects', {
          room: r.room,
          shard: r.shard,
        });
        setSummaries((prev) => ({ ...prev, [keyOf(r)]: summarize(res.objects ?? [], owner) }));
      } catch {
        /* keep the card without a summary */
      }
    }
  };

  /** Load the colony of the authenticated user (store already has the rooms). */
  const loadOwn = (list: OwnedRoom[]) => {
    if (!userId) return;
    setTargetUserId(userId);
    setRooms(list);
    if (!selected) {
      const def = defaultRoom && list.some((r) => keyOf(r) === keyOf(defaultRoom)) ? defaultRoom : list[0];
      if (def) setSelected({ shard: def.shard, room: def.room });
    }
    void loadSummaries(list, userId);
  };

  const lookup = () =>
    void run(async () => {
      const name = username.trim();
      if (!name || (account && name.toLowerCase() === account.username.toLowerCase())) {
        loadedForRef.current = userId;
        loadOwn(colonyRooms);
        return;
      }
      const found = await api.invoke<{ user?: { _id?: string; username?: string } }>('auth.findUser', {
        username: name,
      });
      const uid = found.user?._id;
      if (!uid) throw new Error(`User "${name}" not found.`);
      const list = await fetchOwnedRooms(uid, defaultShard ?? 'shard3');
      loadedForRef.current = uid;
      setTargetUserId(uid);
      setRooms(list);
      setSummaries({});
      setSelected(list[0] ? { shard: list[0].shard, room: list[0].room } : null);
      void loadSummaries(list, uid);
    });

  // Auto-load own colony once the bootstrap has produced the rooms list.
  useEffect(() => {
    if (connected && userId && colonyRooms.length > 0 && loadedForRef.current !== userId) {
      loadedForRef.current = userId;
      loadOwn(colonyRooms);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, userId, colonyRooms]);

  return (
    <div className="panel-body">
      <Section
        title="Colony"
        actions={
          <div className="row">
            <input
              className="input input-s"
              placeholder={account?.username ?? 'username'}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && lookup()}
            />
            <button className="btn btn-primary" disabled={!connected || loading} onClick={lookup}>
              {loading ? '…' : 'Load'}
            </button>
          </div>
        }
      >
        {!connected && <div className="muted">Connect first.</div>}
        <ErrorBox error={error} />
        {connected && rooms.length === 0 && !loading && (
          <div className="muted">
            {colonyRooms.length === 0
              ? 'No owned rooms found yet — they load automatically after connecting.'
              : 'Loading…'}
          </div>
        )}
        <div className="colony-grid">
          {rooms.map((r) => {
            const s = summaries[keyOf(r)];
            const isSel = selected !== null && keyOf(selected) === keyOf(r);
            const isDefault = defaultRoom !== null && keyOf(defaultRoom) === keyOf(r);
            const ctrl = s?.controller;
            const prog = ctrl?.progress && ctrl?.progressTotal ? ctrl.progress / ctrl.progressTotal : null;
            return (
              <button
                key={keyOf(r)}
                className={`colony-card ${isSel ? 'colony-selected' : ''}`}
                onClick={() => setSelected({ shard: r.shard, room: r.room })}
              >
                <div className="row">
                  <strong>{r.room}</strong>
                  <span className="muted small">{r.shard}</span>
                  {isDefault && <span className="chip chip-ok" title="strongest room — used as default">default</span>}
                  <span className="spacer" />
                  <span className="colony-rcl">RCL {ctrl?.level ?? r.level ?? '?'}</span>
                </div>
                {prog !== null && (
                  <div className="bar" title={`${formatNumber(ctrl!.progress!)} / ${formatNumber(ctrl!.progressTotal!)} (${(prog * 100).toFixed(1)}%)`}>
                    <div className="bar-fill" style={{ width: `${Math.min(100, prog * 100)}%` }} />
                  </div>
                )}
                {s ? (
                  <div className="row wrap small muted">
                    <span>
                      ⚡ {formatNumber(s.energyAvailable)}/{formatNumber(s.energyCapacity)}
                    </span>
                    {s.storageEnergy !== null && <span>🏦 {formatNumber(s.storageEnergy)}</span>}
                    <span>creeps {s.creeps}</span>
                    {s.sites > 0 && <span>🚧 {s.sites}</span>}
                    {s.hostiles > 0 && <span className="text-warn">⚔ {s.hostiles} hostile</span>}
                    {s.spawningNames.length > 0 && <span>spawning…</span>}
                  </div>
                ) : (
                  <div className="muted small">loading summary…</div>
                )}
              </button>
            );
          })}
        </div>
      </Section>

      {selected && (
        <RoomDetail
          key={keyOf(selected)}
          shard={selected.shard}
          room={selected.room}
          ownerId={targetUserId}
          onOpenViewer={() => openRoom(selected.shard, selected.room)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live room detail                                                     */
/* ------------------------------------------------------------------ */

function RoomDetail({
  shard,
  room,
  ownerId,
  onOpenViewer,
}: {
  shard: string;
  room: string;
  ownerId: string | null;
  onOpenViewer: () => void;
}) {
  const msg = useChannel<RoomSnapshot>(Channels.room(shard, room));
  const snapshot = msg && !msg.isError ? msg.data : null;
  const [inspectId, setInspectId] = useState<string | null>(null);

  // Previous-tick positions for movement/idle detection.
  const prevRef = useRef<{ tick: number | null; pos: Map<string, { x: number; y: number }> }>({
    tick: null,
    pos: new Map(),
  });

  const objects = useMemo(
    () => Object.values((snapshot?.objects ?? {}) as Record<string, ObjDoc>),
    [snapshot],
  );
  const gameTime = snapshot?.gameTime ?? null;

  const { creepRows, hostiles, hasPrevTick } = useMemo(() => {
    const prev = prevRef.current;
    const samePrev = prev.tick !== null && prev.tick !== gameTime;
    const mine: Array<{ o: ObjDoc; status: CreepStatus }> = [];
    const hostile: ObjDoc[] = [];
    for (const o of objects) {
      if (o.type !== 'creep' && o.type !== 'powerCreep') continue;
      if (ownerId && o.user !== ownerId) {
        hostile.push(o);
        continue;
      }
      mine.push({ o, status: creepStatus(o, prev.pos.get(o._id), samePrev) });
    }
    mine.sort((a, b) => (a.o.name ?? '').localeCompare(b.o.name ?? ''));
    return { creepRows: mine, hostiles: hostile, hasPrevTick: samePrev };
  }, [objects, ownerId, gameTime]);

  // Record positions after computing statuses (runs after render).
  useEffect(() => {
    if (gameTime === null) return;
    const pos = new Map<string, { x: number; y: number }>();
    for (const o of objects) {
      if ((o.type === 'creep' || o.type === 'powerCreep') && typeof o.x === 'number' && typeof o.y === 'number') {
        pos.set(o._id, { x: o.x, y: o.y });
      }
    }
    prevRef.current = { tick: gameTime, pos };
  }, [objects, gameTime]);

  const summary = useMemo(() => summarize(objects, ownerId), [objects, ownerId]);
  const ctrl = summary.controller;
  const sites = useMemo(() => objects.filter((o) => o.type === 'constructionSite'), [objects]);

  const structureRows = useMemo(() => {
    const byType = new Map<string, { count: number; minHits: number | null }>();
    for (const o of objects) {
      const type = o.type ?? '';
      if (!(type in summary.structures) && type !== 'spawn') continue;
      if (!(type in summary.structures)) continue;
      const entry = byType.get(type) ?? { count: 0, minHits: null };
      entry.count += 1;
      if (typeof o.hits === 'number' && typeof o.hitsMax === 'number' && o.hitsMax > 0) {
        const frac = o.hits / o.hitsMax;
        entry.minHits = entry.minHits === null ? frac : Math.min(entry.minHits, frac);
      }
      byType.set(type, entry);
    }
    return [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [objects, summary]);

  const inspected = inspectId ? objects.find((o) => o._id === inspectId) : null;
  const downgradeIn = ctrl?.downgradeTime && gameTime ? ctrl.downgradeTime - gameTime : null;

  return (
    <Section
      title={`${room} — live`}
      actions={
        <div className="row">
          <span className="muted small">tick {gameTime ?? '—'}</span>
          <button className="btn btn-xs" onClick={onOpenViewer}>
            Open in Room Viewer
          </button>
        </div>
      }
    >
      {msg?.isError && <div className="error-box">Room channel rate-limited (err@room).</div>}
      {!snapshot && !msg?.isError && <div className="muted">Subscribing to live room data…</div>}
      {snapshot && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-value">RCL {ctrl?.level ?? '?'}</div>
              <div className="stat-label">controller</div>
              {ctrl?.progress !== undefined && ctrl?.progressTotal !== undefined && ctrl.progressTotal > 0 && (
                <>
                  <div className="bar" style={{ marginTop: 6 }}>
                    <div className="bar-fill" style={{ width: `${Math.min(100, (ctrl.progress / ctrl.progressTotal) * 100)}%` }} />
                  </div>
                  <div className="stat-hint">
                    {formatNumber(ctrl.progress)} / {formatNumber(ctrl.progressTotal)} (
                    {((ctrl.progress / ctrl.progressTotal) * 100).toFixed(1)}%)
                  </div>
                </>
              )}
              {downgradeIn !== null && downgradeIn < 10000 && (
                <div className="stat-hint text-warn">downgrade in {formatNumber(downgradeIn)} ticks</div>
              )}
              {ctrl?.safeMode && gameTime && ctrl.safeMode > gameTime && (
                <div className="stat-hint">safe mode ({formatNumber(ctrl.safeMode - gameTime)} ticks)</div>
              )}
            </div>
            <div className="stat">
              <div className="stat-value">
                {formatNumber(summary.energyAvailable)}
                <span className="muted"> / {formatNumber(summary.energyCapacity)}</span>
              </div>
              <div className="stat-label">spawn energy</div>
              {summary.spawningNames.length > 0 && (
                <div className="stat-hint">spawning: {summary.spawningNames.join(', ')}</div>
              )}
            </div>
            <div className={`stat ${hostiles.length ? 'stat-bad' : ''}`}>
              <div className="stat-value">{hostiles.length}</div>
              <div className="stat-label">hostiles</div>
            </div>
            {summary.storageEnergy !== null && (
              <div className="stat">
                <div className="stat-value">{formatNumber(summary.storageEnergy)}</div>
                <div className="stat-label">storage energy</div>
              </div>
            )}
            <div className="stat">
              <div className="stat-value">{summary.sites}</div>
              <div className="stat-label">construction sites</div>
            </div>
          </div>

          <h3>Creeps ({creepRows.length})</h3>
          {!hasPrevTick && creepRows.length > 0 && (
            <div className="muted small">status needs two ticks of data — refining…</div>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Body</th>
                <th>HP</th>
                <th>TTL</th>
                <th>Store</th>
                <th>Pos</th>
              </tr>
            </thead>
            <tbody>
              {creepRows.map(({ o, status }) => (
                <tr key={o._id} className="row-click" onClick={() => setInspectId(o._id === inspectId ? null : o._id)}>
                  <td>
                    <code>{o.name ?? o._id.slice(-6)}</code>
                  </td>
                  <td>{roleOf(o.name)}</td>
                  <td>
                    <span className={`chip chip-${status.tone === 'ok' ? 'ok' : status.tone === 'warn' ? 'bad' : 'dim'}`}>
                      {status.label}
                    </span>
                  </td>
                  <td className="small">{bodySummary(o.body)}</td>
                  <td className={o.hits !== undefined && o.hitsMax && o.hits < o.hitsMax ? 'text-warn' : ''}>
                    {o.hits !== undefined ? `${formatNumber(o.hits)}/${formatNumber(o.hitsMax ?? o.hits)}` : '—'}
                  </td>
                  <td className={o.ageTime && gameTime && o.ageTime - gameTime < 100 ? 'text-warn' : ''}>
                    {o.ageTime && gameTime ? formatNumber(o.ageTime - gameTime) : '—'}
                  </td>
                  <td>
                    {formatNumber(storeTotal(o))}
                    {o.storeCapacity ? <span className="muted">/{formatNumber(o.storeCapacity)}</span> : null}
                  </td>
                  <td className="small muted">
                    {o.x},{o.y}
                  </td>
                </tr>
              ))}
              {creepRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    no creeps in this room
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {hostiles.length > 0 && (
            <>
              <h3 className="text-warn">Hostiles ({hostiles.length})</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Owner</th>
                    <th>Body</th>
                    <th>HP</th>
                    <th>Pos</th>
                  </tr>
                </thead>
                <tbody>
                  {hostiles.map((o) => (
                    <tr key={o._id} className="row-click" onClick={() => setInspectId(o._id === inspectId ? null : o._id)}>
                      <td>
                        <code>{o.name ?? o._id.slice(-6)}</code>
                      </td>
                      <td>{(snapshot.users?.[o.user ?? '']?.username as string) ?? o.user ?? '—'}</td>
                      <td className="small">{bodySummary(o.body)}</td>
                      <td>{o.hits !== undefined ? `${formatNumber(o.hits)}/${formatNumber(o.hitsMax ?? o.hits)}` : '—'}</td>
                      <td className="small muted">
                        {o.x},{o.y}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3>Structures</h3>
          <div className="row wrap">
            {structureRows.map(([type, info]) => (
              <span key={type} className={`chip ${info.minHits !== null && info.minHits < 0.5 ? 'chip-bad' : 'chip-dim'}`}>
                {type} ×{info.count}
                {info.minHits !== null && info.minHits < 1 && ` · min ${(info.minHits * 100).toFixed(0)}% hp`}
              </span>
            ))}
            {structureRows.length === 0 && <span className="muted">none</span>}
          </div>

          {sites.length > 0 && (
            <>
              <h3>Construction ({sites.length})</h3>
              <div className="row wrap">
                {sites.map((o) => (
                  <span key={o._id} className="chip chip-dim">
                    {(o.structureType as string) ?? 'site'} @{o.x},{o.y}
                    {o.progress !== undefined && o.progressTotal ? ` · ${Math.round(((o.progress ?? 0) / o.progressTotal) * 100)}%` : ''}
                  </span>
                ))}
              </div>
            </>
          )}

          {inspected && (
            <>
              <h3>
                Inspect <code>{inspected.name ?? inspected._id}</code>
              </h3>
              <JsonView value={inspected} maxHeight={300} />
            </>
          )}
        </>
      )}
    </Section>
  );
}
