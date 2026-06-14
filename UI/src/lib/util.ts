/** Small formatting + room-name helpers shared across panels. */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

/** mm:ss (or h:mm:ss) until an epoch-ms timestamp; '0:00' when past. */
export function countdown(resetAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((resetAt - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/** GCL/GPL level from raw points (Screeps formula, multiplier 1e6, exp 2.4). */
export function gclLevel(points: number | undefined): number {
  if (!points || points <= 0) return 1;
  return Math.floor(Math.pow(points / 1_000_000, 1 / 2.4)) + 1;
}

const ROOM_RE = /^([WE])(\d+)([NS])(\d+)$/i;

export function isValidRoomName(name: string): boolean {
  return ROOM_RE.test(name.trim());
}

/** Room name -> world grid coords (W0->-1, E0->0 / N0->-1, S0->0). */
export function roomToXY(name: string): { x: number; y: number } | null {
  const m = ROOM_RE.exec(name.trim().toUpperCase());
  if (!m) return null;
  const x = m[1] === 'W' ? -1 - Number(m[2]) : Number(m[2]);
  const y = m[3] === 'N' ? -1 - Number(m[4]) : Number(m[4]);
  return { x, y };
}

export function xyToRoom(x: number, y: number): string {
  const h = x < 0 ? `W${-1 - x}` : `E${x}`;
  const v = y < 0 ? `N${-1 - y}` : `S${y}`;
  return h + v;
}

/** Shift a room name by (dx, dy) rooms. dy > 0 moves south. */
export function shiftRoom(name: string, dx: number, dy: number): string {
  const xy = roomToXY(name);
  if (!xy) return name;
  return xyToRoom(xy.x + dx, xy.y + dy);
}

/** Stable color for an arbitrary user id (hostile owners on maps/rooms). */
export function colorForUser(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 55%)`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

let idCounter = 0;
export function nextId(): number {
  return ++idCounter;
}
