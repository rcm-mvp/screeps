/**
 * Types for game objects, rooms, terrain, CPU, and console output.
 *
 * The Screeps API returns loosely-typed documents; these interfaces capture the
 * well-known fields while remaining open (`[key: string]: unknown`) so unknown
 * or shard-specific fields are never dropped.
 */

import type { RoomName, Shard } from './common';

/** A generic room object document (creep, structure, source, mineral, …). */
export interface RoomObject {
  _id: string;
  type: string;
  room: RoomName;
  x: number;
  y: number;
  /** Owning user id, when the object is owned. */
  user?: string;
  [key: string]: unknown;
}

/** Terrain mask bits as returned by the encoded terrain string. */
export enum TerrainMask {
  Plain = 0,
  Wall = 1,
  Swamp = 2,
  /** Some payloads use 3 to also mean wall (wall | swamp). */
  WallAlt = 3,
}

export type TerrainTile = 'plain' | 'wall' | 'swamp';

/** Decoded 50x50 terrain grid plus the raw encoded source string. */
export interface RoomTerrain {
  room: RoomName;
  shard?: Shard;
  /** The raw `encoded=1` digit string (2500 chars), if requested. */
  encoded?: string;
  /** Decoded grid: `grid[y][x]` is the terrain tile. */
  grid?: TerrainTile[][];
  /** Raw terrain documents, when `encoded` was not requested. */
  terrain?: Array<{ room: RoomName; terrain: string; type?: string }>;
}

export interface RoomOverview {
  owner?: { username: string; badge?: unknown } | null;
  stats?: Record<string, unknown>;
  statsMax?: Record<string, unknown>;
  totals?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RoomStatus {
  room?: { status: string; novice?: number; openTime?: number; _id?: string };
  [key: string]: unknown;
}

export interface RoomObjectsResponse {
  objects: RoomObject[];
  users: Record<string, { _id: string; username: string; badge?: unknown }>;
  [key: string]: unknown;
}

/** Per-tick CPU + memory usage from the `cpu` WebSocket channel. */
export interface CpuStats {
  cpu: number;
  memory: number;
}

/** A single console output frame (from the `console` WebSocket channel). */
export interface ConsoleMessage {
  /** Log lines emitted this tick. */
  log: string[];
  /** Results of console commands run this tick. */
  results: string[];
  /** Shard the messages came from, when present. */
  shard?: Shard;
}

/** A runtime error frame from the `console` channel's error variant. */
export interface ConsoleError {
  error: string;
  shard?: Shard;
}
