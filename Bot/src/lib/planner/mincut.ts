/**
 * Minimum-cut rampart solver.
 *
 * Model the room as a flow network and find the cheapest set of tiles to
 * rampart so the protected interior cannot reach any room exit. This is the
 * same max-flow family as the Ford-Fulkerson traffic manager (lib/traffic.ts) —
 * here we use Dinic's algorithm for the bigger graph.
 *
 *   - Each passable interior tile (non-wall, x,y in [1,48]) is split into an
 *     in-node and an out-node joined by an edge whose capacity is the cost of
 *     ramparting it: 1 for a cuttable tile, ∞ for a protected tile.
 *   - Adjacent tiles connect out(a) → in(b) with capacity ∞ (free movement).
 *   - A super-source feeds every protected tile; tiles on the [1,48] frame
 *     (one step from the exit ring) drain to a super-sink.
 *   - The min cut saturates exactly the in→out edges of the boundary tiles to
 *     rampart.
 *
 * Standard Screeps min-cut technique (popularised by Saruss/others);
 * reimplemented here from the description, nothing vendored.
 */
import type { TerrainLike } from './distanceTransform';

const SIZE = 50;
const INF = 1 << 20;
const S = 2 * SIZE * SIZE; // super-source
const T = S + 1; // super-sink
const NODES = T + 1;

const inNode = (x: number, y: number): number => 2 * (x * SIZE + y);
const outNode = (x: number, y: number): number => 2 * (x * SIZE + y) + 1;

export interface ProtectRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

class Dinic {
  private readonly to: number[] = [];
  private readonly cap: number[] = [];
  private readonly g: number[][] = Array.from({ length: NODES }, () => []);
  private readonly level = new Int32Array(NODES);
  private readonly iter = new Int32Array(NODES);

  addEdge(u: number, v: number, c: number): void {
    this.g[u].push(this.to.length);
    this.to.push(v);
    this.cap.push(c);
    this.g[v].push(this.to.length);
    this.to.push(u);
    this.cap.push(0);
  }

  private bfs(s: number): boolean {
    this.level.fill(-1);
    const queue = [s];
    this.level[s] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (const e of this.g[u]) {
        if (this.cap[e] > 0 && this.level[this.to[e]] < 0) {
          this.level[this.to[e]] = this.level[u] + 1;
          queue.push(this.to[e]);
        }
      }
    }
    return this.level[T] >= 0;
  }

  private dfs(u: number, pushed: number): number {
    if (u === T) return pushed;
    for (; this.iter[u] < this.g[u].length; this.iter[u]++) {
      const e = this.g[u][this.iter[u]];
      const v = this.to[e];
      if (this.cap[e] > 0 && this.level[v] === this.level[u] + 1) {
        const d = this.dfs(v, Math.min(pushed, this.cap[e]));
        if (d > 0) {
          this.cap[e] -= d;
          this.cap[e ^ 1] += d;
          return d;
        }
      }
    }
    return 0;
  }

  maxflow(): void {
    // Phase count is bounded by the shortest-augmenting-path length (≤ NODES);
    // for a grid it converges in a handful of phases.
    let phases = 0;
    while (this.bfs(S) && phases++ < NODES) {
      this.iter.fill(0);
      while (this.dfs(S, INF) > 0) {
        /* push blocking flow */
      }
    }
  }

  /** Nodes still reachable from S in the residual graph (the source side). */
  reachableFromSource(): Uint8Array {
    const seen = new Uint8Array(NODES);
    const queue = [S];
    seen[S] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (const e of this.g[u]) {
        if (this.cap[e] > 0 && !seen[this.to[e]]) {
          seen[this.to[e]] = 1;
          queue.push(this.to[e]);
        }
      }
    }
    return seen;
  }
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Returns the tiles to rampart so nothing inside `rect` can reach an exit.
 * Returns `[]` if the interior is already sealed by natural walls.
 */
export function minCutRamparts(terrain: TerrainLike, rect: ProtectRect): Array<{ x: number; y: number }> {
  const passable = (x: number, y: number): boolean =>
    x >= 1 && x <= 48 && y >= 1 && y <= 48 && terrain.get(x, y) !== TERRAIN_MASK_WALL;
  const inRect = (x: number, y: number): boolean => x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2;

  const net = new Dinic();
  for (let x = 1; x <= 48; x++) {
    for (let y = 1; y <= 48; y++) {
      if (!passable(x, y)) continue;
      const protectedTile = inRect(x, y);
      // in → out: ∞ if protected (never cut), else 1 (a rampart costs 1).
      net.addEdge(inNode(x, y), outNode(x, y), protectedTile ? INF : 1);
      if (protectedTile) net.addEdge(S, inNode(x, y), INF);
      // Frame tiles are one step from the exit ring → drain to the sink.
      if (x === 1 || x === 48 || y === 1 || y === 48) net.addEdge(outNode(x, y), T, INF);
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (passable(nx, ny)) net.addEdge(outNode(x, y), inNode(nx, ny), INF);
      }
    }
  }

  net.maxflow();
  const reachable = net.reachableFromSource();

  const ramparts: Array<{ x: number; y: number }> = [];
  for (let x = 1; x <= 48; x++) {
    for (let y = 1; y <= 48; y++) {
      if (!passable(x, y) || inRect(x, y)) continue;
      // A cut tile: its in-node is on the source side, its out-node is not.
      if (reachable[inNode(x, y)] && !reachable[outNode(x, y)]) ramparts.push({ x, y });
    }
  }
  return ramparts;
}
