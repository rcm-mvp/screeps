#!/usr/bin/env node
// fetch-room-fixture.mjs — pull REAL terrain + room objects for a Screeps room
// from the official API (screeps.com) and write committed test fixtures the
// bot's smoke tests can import.
//
// Usage:
//   node scripts/fetch-room-fixture.mjs <ROOM> [shard]
//   node scripts/fetch-room-fixture.mjs W52S13 shard3
//
// Auth: reads SCREEPS_TOKEN from the environment, else from
// `<repo>/Strategist/.env`. The token is NEVER printed, logged, or written
// into any output file.
//
// Writes (relative to repo root):
//   Bot/test/fixtures/<room>.terrain.json
//   Bot/test/fixtures/<room>.objects.json
//
// Terrain digit -> tile mapping mirrors API/src/modules/rooms.ts#digitToTile:
//   0 = plain, 1/3 = wall, 2 = swamp.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const API_BASE = 'https://screeps.com/api';

// scripts/ -> Bot/ -> repo root
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'Bot', 'test', 'fixtures');

/** Map an encoded terrain digit to a tile type. 0=plain, 1/3=wall, 2=swamp. */
function digitToTile(d) {
  switch (d) {
    case '1':
    case '3':
      return 'wall';
    case '2':
      return 'swamp';
    default:
      return 'plain';
  }
}

/** Decode a 2500-char encoded terrain string into grid[y][x]. */
function decodeTerrain(encoded) {
  const grid = [];
  for (let y = 0; y < 50; y++) {
    const row = [];
    for (let x = 0; x < 50; x++) {
      row.push(digitToTile(encoded[y * 50 + x] ?? '0'));
    }
    grid.push(row);
  }
  return grid;
}

/** Read SCREEPS_TOKEN from env or Strategist/.env. Never returned to caller in logs. */
function readToken() {
  if (process.env.SCREEPS_TOKEN && process.env.SCREEPS_TOKEN.trim()) {
    return process.env.SCREEPS_TOKEN.trim();
  }
  const envPath = join(REPO_ROOT, 'Strategist', '.env');
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(
      `No SCREEPS_TOKEN in env and could not read ${envPath}. ` +
        'Set SCREEPS_TOKEN or provide Strategist/.env.',
    );
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*SCREEPS_TOKEN\s*=\s*(.*)$/.exec(line);
    if (m) {
      // strip optional surrounding quotes
      return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error(`SCREEPS_TOKEN not found in ${envPath}`);
}

async function apiGet(path, query, token) {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { 'X-Token': token } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  const room = process.argv[2];
  const shard = process.argv[3] || 'shard3';
  if (!room) {
    console.error('Usage: node scripts/fetch-room-fixture.mjs <ROOM> [shard]');
    process.exit(1);
  }

  const token = readToken();

  // --- terrain (encoded) ---
  const terrainRes = await apiGet('game/room-terrain', { room, shard, encoded: 1 }, token);
  const encoded = terrainRes?.terrain?.[0]?.terrain ?? '';
  if (encoded.length !== 2500) {
    throw new Error(`Unexpected terrain length ${encoded.length} (expected 2500) for ${room}`);
  }
  const grid = decodeTerrain(encoded);

  // --- room objects ---
  const objRes = await apiGet('game/room-objects', { room, shard }, token);
  const objects = Array.isArray(objRes?.objects) ? objRes.objects : [];

  // Transient / movable objects we exclude from the stable fixture: creeps,
  // dropped resources, tombstones, construction sites, ruins, nukes, etc.
  const TRANSIENT = new Set([
    'creep',
    'powerCreep',
    'energy',
    'resource',
    'tombstone',
    'ruin',
    'constructionSite',
    'nuke',
  ]);

  // normalize
  const sources = [];
  let controller = null;
  let mineral = null;
  const structures = [];
  const spawns = [];
  for (const o of objects) {
    const pos = { x: o.x, y: o.y };
    switch (o.type) {
      case 'source':
        sources.push(pos);
        break;
      case 'controller':
        controller = pos;
        break;
      case 'mineral':
        mineral = { x: o.x, y: o.y, mineralType: o.mineralType ?? null };
        break;
      case 'spawn':
        spawns.push(pos);
        structures.push({ type: 'spawn', x: o.x, y: o.y });
        break;
      default:
        if (TRANSIENT.has(o.type)) break;
        // treat remaining buildable structures (with a position) as structures
        structures.push({ type: o.type, x: o.x, y: o.y });
        break;
    }
  }
  sources.sort((a, b) => a.y - b.y || a.x - b.x);
  structures.sort((a, b) => a.type.localeCompare(b.type) || a.y - b.y || a.x - b.x);

  const headerNote =
    'Pulled from screeps.com via Bot/scripts/fetch-room-fixture.mjs. ' +
    'Do not hand-edit; re-run the script to refresh. See fixtures/README.md.';

  const terrainFixture = {
    _note: headerNote,
    room,
    shard,
    encoded,
    grid,
  };
  const objectsFixture = {
    _note: headerNote,
    room,
    shard,
    sources,
    controller,
    mineral,
    structures,
    spawns,
  };

  mkdirSync(FIXTURES_DIR, { recursive: true });
  const lc = room.toLowerCase();
  const terrainPath = join(FIXTURES_DIR, `${lc}.terrain.json`);
  const objectsPath = join(FIXTURES_DIR, `${lc}.objects.json`);
  writeFileSync(terrainPath, JSON.stringify(terrainFixture, null, 2) + '\n');
  writeFileSync(objectsPath, JSON.stringify(objectsFixture, null, 2) + '\n');

  // --- summary ---
  let wall = 0;
  let swamp = 0;
  let plain = 0;
  let minX = 50;
  let minY = 50;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const t = grid[y][x];
      if (t === 'wall') {
        wall++;
      } else {
        if (t === 'swamp') swamp++;
        else plain++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const byType = {};
  for (const s of structures) byType[s.type] = (byType[s.type] || 0) + 1;

  console.log(`\nFixtures written for ${room} @ ${shard}:`);
  console.log(`  ${terrainPath}`);
  console.log(`  ${objectsPath}`);
  console.log('\nSUMMARY');
  console.log(`  tiles: wall=${wall} swamp=${swamp} plain=${plain} (total=${wall + swamp + plain})`);
  console.log(`  non-wall bounding box: x[${minX}..${maxX}] y[${minY}..${maxY}]`);
  console.log(`  sources (${sources.length}): ${sources.map((s) => `(${s.x},${s.y})`).join(' ')}`);
  console.log(`  controller: ${controller ? `(${controller.x},${controller.y})` : 'none'}`);
  console.log(
    `  mineral: ${mineral ? `(${mineral.x},${mineral.y}) ${mineral.mineralType}` : 'none'}`,
  );
  console.log(`  spawns (${spawns.length}): ${spawns.map((s) => `(${s.x},${s.y})`).join(' ')}`);
  console.log('  structures by type:');
  for (const [t, n] of Object.entries(byType).sort()) {
    console.log(`    ${t}: ${n}`);
  }
}

main().catch((err) => {
  console.error('fetch-room-fixture failed:', err.message);
  process.exit(1);
});
