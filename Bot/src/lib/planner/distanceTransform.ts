/**
 * Chebyshev distance transform ("openness map").
 *
 * For every walkable tile, compute the Chebyshev (chessboard) distance to the
 * nearest wall via the standard two-pass chamfer transform. High values mark
 * the centres of large open areas — the candidate anchors for a compact base.
 *
 * Standard community algorithm (used by virtually every Screeps base planner);
 * reimplemented here, nothing vendored. Room-edge tiles are treated as walls so
 * the transform naturally pushes the base away from exits.
 */

const SIZE = 50;
export const idx = (x: number, y: number): number => x * SIZE + y;

/** Minimal terrain shape — matches `RoomTerrain` and is trivial to mock. */
export interface TerrainLike {
  get(x: number, y: number): number;
}

/**
 * Returns a `Uint8Array(2500)` of Chebyshev distances. Walls and the four edge
 * rows/cols are 0; interior open tiles grow toward the centre. Max meaningful
 * value is 25, so `Uint8Array` is plenty.
 */
export function distanceTransform(terrain: TerrainLike): Uint8Array {
  const dt = new Uint8Array(SIZE * SIZE);

  // Seed: walls and edges = 0 (already), everything else = "infinity" (we use a
  // ceiling of 99, capped back into a byte). Edges count as walls so the base
  // can't hug an exit.
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      const edge = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
      dt[idx(x, y)] = edge || terrain.get(x, y) === TERRAIN_MASK_WALL ? 0 : 99;
    }
  }

  // Forward pass: top-left → bottom-right. Each tile takes the min of its
  // already-processed 8-neighbours (up-left/up/up-right/left) + 1.
  for (let x = 1; x < SIZE - 1; x++) {
    for (let y = 1; y < SIZE - 1; y++) {
      const i = idx(x, y);
      if (dt[i] === 0) continue;
      let m = dt[i];
      if (dt[idx(x - 1, y)] + 1 < m) m = dt[idx(x - 1, y)] + 1;
      if (dt[idx(x, y - 1)] + 1 < m) m = dt[idx(x, y - 1)] + 1;
      if (dt[idx(x - 1, y - 1)] + 1 < m) m = dt[idx(x - 1, y - 1)] + 1;
      if (dt[idx(x + 1, y - 1)] + 1 < m) m = dt[idx(x + 1, y - 1)] + 1;
      dt[i] = m;
    }
  }

  // Backward pass: bottom-right → top-left, the other four neighbours.
  for (let x = SIZE - 2; x >= 1; x--) {
    for (let y = SIZE - 2; y >= 1; y--) {
      const i = idx(x, y);
      if (dt[i] === 0) continue;
      let m = dt[i];
      if (dt[idx(x + 1, y)] + 1 < m) m = dt[idx(x + 1, y)] + 1;
      if (dt[idx(x, y + 1)] + 1 < m) m = dt[idx(x, y + 1)] + 1;
      if (dt[idx(x + 1, y + 1)] + 1 < m) m = dt[idx(x + 1, y + 1)] + 1;
      if (dt[idx(x - 1, y + 1)] + 1 < m) m = dt[idx(x - 1, y + 1)] + 1;
      dt[i] = m;
    }
  }

  return dt;
}
