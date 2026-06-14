/**
 * Shared 50×50 room renderer: terrain background + live objects from the
 * bridge's merged room snapshots, colored by ownership. Click a tile to
 * select/inspect the objects on it.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { TerrainTile } from '../lib/types';
import { colorForUser } from '../lib/util';

export interface RenderObject {
  _id: string;
  type?: string;
  x?: number;
  y?: number;
  user?: string;
  [key: string]: unknown;
}

const TERRAIN_COLORS: Record<TerrainTile, string> = {
  plain: '#1b1f23',
  swamp: '#2a3d22',
  wall: '#0a0a0c',
};

const NEUTRAL_TYPES: Record<string, string> = {
  source: '#ffe56d',
  mineral: '#4fc8e8',
  deposit: '#4fc8e8',
  controller: '#a071ff',
  keeperLair: '#b34f4f',
  portal: '#9d4fe8',
  powerBank: '#f24d4d',
  constructedWall: '#3c3c46',
  road: '#4a4a55',
  ruin: '#555',
  tombstone: '#666',
  energy: '#ffe56d',
};

function objectColor(o: RenderObject, myUserId: string | null): string {
  const type = o.type ?? '';
  if (type in NEUTRAL_TYPES && !o.user) return NEUTRAL_TYPES[type];
  if (type in NEUTRAL_TYPES && type !== 'controller') return NEUTRAL_TYPES[type];
  if (o.user) {
    if (myUserId && o.user === myUserId) return '#65fd62';
    return colorForUser(o.user);
  }
  return '#8a8a96';
}

/** Larger = drawn later (on top). */
function zOf(o: RenderObject): number {
  switch (o.type) {
    case 'road':
      return 0;
    case 'constructedWall':
    case 'rampart':
      return 1;
    case 'creep':
    case 'powerCreep':
      return 3;
    default:
      return 2;
  }
}

export function RoomCanvas({
  terrain,
  objects,
  myUserId,
  selected,
  onSelectTile,
  size = 600,
}: {
  terrain: TerrainTile[][] | null;
  objects: Record<string, RenderObject>;
  myUserId: string | null;
  selected: { x: number; y: number } | null;
  onSelectTile?: (x: number, y: number) => void;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cell = size / 50;

  const sorted = useMemo(
    () =>
      Object.values(objects)
        .filter((o) => typeof o.x === 'number' && typeof o.y === 'number')
        .sort((a, b) => zOf(a) - zOf(b)),
    [objects],
  );

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Terrain background
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, size, size);
    if (terrain) {
      for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
          const t = terrain[y]?.[x] ?? 'plain';
          ctx.fillStyle = TERRAIN_COLORS[t];
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }

    // Faint grid every 10 tiles
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 50; i += 10) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, size);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(size, i * cell);
      ctx.stroke();
    }

    // Objects
    for (const o of sorted) {
      const x = (o.x as number) * cell;
      const y = (o.y as number) * cell;
      const color = objectColor(o, myUserId);
      ctx.fillStyle = color;
      switch (o.type) {
        case 'road':
          ctx.beginPath();
          ctx.arc(x + cell / 2, y + cell / 2, cell * 0.16, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'rampart':
          ctx.fillStyle = o.user === myUserId ? 'rgba(101,253,98,0.25)' : 'rgba(255,80,80,0.25)';
          ctx.fillRect(x, y, cell, cell);
          break;
        case 'creep':
        case 'powerCreep':
          ctx.beginPath();
          ctx.arc(x + cell / 2, y + cell / 2, cell * 0.38, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.stroke();
          break;
        case 'constructionSite':
          ctx.strokeStyle = color;
          ctx.setLineDash([2, 2]);
          ctx.strokeRect(x + cell * 0.2, y + cell * 0.2, cell * 0.6, cell * 0.6);
          ctx.setLineDash([]);
          break;
        case 'controller':
          ctx.beginPath();
          ctx.moveTo(x + cell / 2, y + cell * 0.1);
          ctx.lineTo(x + cell * 0.9, y + cell / 2);
          ctx.lineTo(x + cell / 2, y + cell * 0.9);
          ctx.lineTo(x + cell * 0.1, y + cell / 2);
          ctx.closePath();
          ctx.fill();
          break;
        case 'source':
        case 'mineral':
          ctx.fillRect(x + cell * 0.2, y + cell * 0.2, cell * 0.6, cell * 0.6);
          break;
        default:
          ctx.fillRect(x + cell * 0.12, y + cell * 0.12, cell * 0.76, cell * 0.76);
      }
    }

    // Selection
    if (selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(selected.x * cell + 0.5, selected.y * cell + 0.5, cell - 1, cell - 1);
    }
  }, [terrain, sorted, myUserId, selected, cell, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      className="room-canvas"
      onClick={(e) => {
        if (!onSelectTile) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const scale = size / rect.width;
        const x = Math.floor(((e.clientX - rect.left) * scale) / cell);
        const y = Math.floor(((e.clientY - rect.top) * scale) / cell);
        if (x >= 0 && x < 50 && y >= 0 && y < 50) onSelectTile(x, y);
      }}
    />
  );
}
