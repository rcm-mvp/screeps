/**
 * Room Viewer: terrain (GET game/room-terrain, 360/hr) as background plus the
 * bridge's merged live snapshots from the room:<shard>/<room> WS channel.
 * Click a tile to inspect raw object properties and issue intents.
 */

import { useEffect, useMemo, useState } from 'react';
import { Channels } from 'screeps-web-api-bridge/dist/socket/channels';
import { api } from '../lib/api';
import { useAsyncAction, useBridge, useChannel } from '../lib/hooks';
import { useStore } from '../lib/store';
import type { RoomSnapshot, RoomTerrain, TerrainTile } from '../lib/types';
import { isValidRoomName } from '../lib/util';
import { RenderObject, RoomCanvas } from '../components/RoomCanvas';
import { BudgetChip, ConfirmButton, ErrorBox, JsonView, Section } from '../components/common';

const FLAG_COLORS = ['', 'red', 'purple', 'blue', 'cyan', 'green', 'yellow', 'orange', 'brown', 'grey', 'white'];

/** Object types removable via a world intent, mapped to their capability. */
const INTENTS: Record<string, { cap: string; label: string }> = {
  creep: { cap: 'world.suicideCreep', label: 'Suicide creep' },
  constructionSite: { cap: 'world.removeConstructionSite', label: 'Remove site' },
  controller: { cap: 'world.unclaimController', label: 'Unclaim controller' },
};

/** Terrain is static per room — cache it so re-watching doesn't spend budget. */
const terrainCache = new Map<string, TerrainTile[][]>();

export function RoomPanel() {
  const { connected, shard: defaultShard, userId } = useBridge();
  const roomTarget = useStore((s) => s.roomTarget);
  const defaultRoom = useStore((s) => s.defaultRoom);

  const [shard, setShard] = useState(defaultRoom?.shard ?? defaultShard ?? 'shard3');
  const [roomInput, setRoomInput] = useState(defaultRoom?.room ?? 'W1N1');
  const [watched, setWatched] = useState<{ shard: string; room: string } | null>(null);
  const [terrain, setTerrain] = useState<TerrainTile[][] | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [flagName, setFlagName] = useState('');
  const [flagColor, setFlagColor] = useState(1);
  const terrainAction = useAsyncAction();
  const intentAction = useAsyncAction();

  // Deep link from the world map.
  useEffect(() => {
    if (roomTarget) {
      setShard(roomTarget.shard);
      setRoomInput(roomTarget.room);
      watch(roomTarget.shard, roomTarget.room);
      useStore.setState({ roomTarget: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomTarget]);

  // Auto-watch the default (strongest) room on mount.
  useEffect(() => {
    if (connected && !watched && !roomTarget && defaultRoom) {
      watch(defaultRoom.shard, defaultRoom.room);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const channel = watched ? Channels.room(watched.shard, watched.room) : null;
  const msg = useChannel<RoomSnapshot>(channel);
  const snapshot = msg && !msg.isError ? msg.data : null;
  const rateLimited = msg?.isError ?? false;

  const watch = (s: string, room: string) => {
    if (!isValidRoomName(room)) return;
    const upper = room.toUpperCase();
    setWatched({ shard: s, room: upper });
    setSelected(null);
    setInspectId(null);
    const cached = terrainCache.get(`${s}/${upper}`);
    setTerrain(cached ?? null);
    if (cached) return;
    void terrainAction.run(async () => {
      const t = await api.invoke<RoomTerrain>('rooms.terrain', {
        room: upper,
        shard: s,
        encoded: true,
      });
      if (t.grid) terrainCache.set(`${s}/${upper}`, t.grid);
      setTerrain(t.grid ?? null);
    });
  };

  const objects = (snapshot?.objects ?? {}) as Record<string, RenderObject>;

  const atTile = useMemo(() => {
    if (!selected) return [];
    return Object.values(objects).filter((o) => o.x === selected.x && o.y === selected.y);
  }, [objects, selected]);

  const inspected = inspectId ? objects[inspectId] : atTile.length === 1 ? atTile[0] : null;

  const runIntent = (cap: string, id: string) =>
    void intentAction.run(() =>
      api.invoke(cap, { id, room: watched!.room, shard: watched!.shard }),
    );

  return (
    <div className="panel-body room-panel">
      <Section
        title="Room Viewer"
        actions={
          <div className="row">
            <input className="input input-s" value={shard} onChange={(e) => setShard(e.target.value)} placeholder="shard" />
            <input
              className="input input-s"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              placeholder="W1N1"
              onKeyDown={(e) => e.key === 'Enter' && watch(shard, roomInput)}
            />
            <button
              className="btn btn-primary"
              disabled={!connected || !isValidRoomName(roomInput)}
              onClick={() => watch(shard, roomInput)}
            >
              Watch
            </button>
            <BudgetChip label="GET game/room-terrain" />
          </div>
        }
      >
        {!connected && <div className="muted">Connect first.</div>}
        {rateLimited && (
          <div className="error-box">
            Room channel rate-limited (err@{channel}) — the server is throttling room subscriptions.
          </div>
        )}
        <ErrorBox error={terrainAction.error} />
        <div className="room-layout">
          <div>
            {watched ? (
              <>
                <RoomCanvas
                  terrain={terrain}
                  objects={objects}
                  myUserId={userId}
                  selected={selected}
                  onSelectTile={(x, y) => {
                    setSelected({ x, y });
                    setInspectId(null);
                  }}
                />
                <div className="row muted small">
                  <span>
                    {watched.shard}/{watched.room}
                  </span>
                  <span>tick {snapshot?.gameTime ?? '—'}</span>
                  <span>{Object.keys(objects).length} objects</span>
                  {terrainAction.loading && <span>loading terrain…</span>}
                </div>
              </>
            ) : (
              <div className="muted">Pick a shard + room and press Watch.</div>
            )}
          </div>

          <div className="room-side">
            {selected && (
              <>
                <h3>
                  Tile {selected.x},{selected.y}
                </h3>
                {atTile.length === 0 && <div className="muted small">No objects here.</div>}
                {atTile.map((o) => (
                  <div key={o._id} className="tile-object">
                    <button className="link" onClick={() => setInspectId(o._id)}>
                      {o.type ?? 'object'} <code className="small">{o._id.slice(-6)}</code>
                    </button>
                    {o.type && INTENTS[o.type] && (
                      <ConfirmButton
                        className="btn btn-danger btn-xs"
                        onConfirm={() => runIntent(INTENTS[o.type!].cap, o._id)}
                      >
                        {INTENTS[o.type].label}
                      </ConfirmButton>
                    )}
                    {o.type && /^(spawn|extension|tower|storage|terminal|link|lab|container|road|rampart|constructedWall|extractor|observer|nuker|factory|powerSpawn)$/.test(o.type) && (
                      <ConfirmButton className="btn btn-danger btn-xs" onConfirm={() => runIntent('world.destroyStructures', o._id)}>
                        Destroy
                      </ConfirmButton>
                    )}
                  </div>
                ))}

                <div className="flag-form">
                  <h4>Create flag here</h4>
                  <div className="row">
                    <input
                      className="input input-s"
                      placeholder="flag name"
                      value={flagName}
                      onChange={(e) => setFlagName(e.target.value)}
                    />
                    <select className="input input-s" value={flagColor} onChange={(e) => setFlagColor(Number(e.target.value))}>
                      {FLAG_COLORS.map((c, i) =>
                        i === 0 ? null : (
                          <option key={i} value={i}>
                            {c}
                          </option>
                        ),
                      )}
                    </select>
                    <button
                      className="btn"
                      disabled={!flagName.trim() || !watched}
                      onClick={() =>
                        void intentAction.run(() =>
                          api.invoke('world.createFlag', {
                            room: watched!.room,
                            shard: watched!.shard,
                            x: selected.x,
                            y: selected.y,
                            name: flagName.trim(),
                            color: flagColor,
                          }),
                        )
                      }
                    >
                      Place
                    </button>
                  </div>
                </div>
                <ErrorBox error={intentAction.error} />
              </>
            )}
            {inspected && (
              <>
                <h3>Object</h3>
                <JsonView value={inspected} maxHeight={420} />
              </>
            )}
            {!selected && <div className="muted small">Click a tile to inspect objects and act on them.</div>}
          </div>
        </div>
        <div className="legend muted small">
          <span className="lg lg-mine" /> mine · <span className="lg lg-hostile" /> other players ·{' '}
          <span className="lg lg-source" /> source/energy · <span className="lg lg-mineral" /> mineral ·{' '}
          <span className="lg lg-controller" /> controller · <span className="lg lg-swamp" /> swamp ·{' '}
          <span className="lg lg-wall" /> wall
        </div>
      </Section>
    </div>
  );
}
