import type { GeometryType, VoronoiTopology } from '../types';

export interface LatticeGeometry {
  /** Returns flat [dx,dy,...] offset pairs for neighbors of a cell at (x,y). */
  getOffsets(range: number, x: number, y: number): Int32Array;
  /** True only for mean-field; engine skips spatial loop and uses global mixing. */
  isMeanField(): boolean;
  /** True for VoronoiLattice; engine uses getNeighborIndices instead of getOffsets+torus. */
  isVoronoi?(): boolean;
  /** Returns absolute cell indices for Voronoi neighbors. Only on VoronoiLattice. */
  getNeighborIndices?(cellIdx: number, range: number): Int32Array;
}

// ─── Square (Manhattan diamond, existing behaviour) ───────────────────────────

const squareCache = new Map<number, Int32Array>();

function squareOffsets(range: number): Int32Array {
  const r = Math.max(1, Math.floor(range));
  const cached = squareCache.get(r);
  if (cached) return cached;
  const pairs: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (Math.abs(dx) + Math.abs(dy) <= r) pairs.push(dx, dy);
    }
  }
  const offsets = new Int32Array(pairs);
  squareCache.set(r, offsets);
  return offsets;
}

class SquareLattice implements LatticeGeometry {
  getOffsets(range: number, _x: number, _y: number): Int32Array {
    return squareOffsets(range);
  }
  isMeanField(): boolean { return false; }
}

// ─── Hexagonal (flat-top, offset-r rows) ─────────────────────────────────────
// Even rows: neighbors (-1,0),(1,0),(-1,-1),(0,-1),(-1,1),(0,1)
// Odd rows:  neighbors (-1,0),(1,0),(0,-1),(1,-1),(0,1),(1,1)
// For range>1 we BFS in offset-grid space using row-parity-aware adjacency.

const HEX_EVEN = [[-1, 0], [1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]] as const;
const HEX_ODD  = [[-1, 0], [1, 0], [0, -1],  [1, -1], [0, 1],  [1, 1]] as const;

// Cache key: range * 2 + parity
const hexCache = new Map<number, Int32Array>();

function hexOffsets(range: number, srcRowParity: 0 | 1): Int32Array {
  const r = Math.max(1, Math.floor(range));
  const key = r * 2 + srcRowParity;
  const cached = hexCache.get(key);
  if (cached) return cached;

  // BFS from the source cell (placed at row srcRowParity so its parity is correct).
  type Pos = { c: number; r: number };
  const srcC = 0, srcR = srcRowParity;
  const visited = new Map<string, Pos>();
  visited.set(`${srcC},${srcR}`, { c: srcC, r: srcR });
  let frontier: Pos[] = [{ c: srcC, r: srcR }];

  for (let step = 0; step < r; step++) {
    const next: Pos[] = [];
    for (const { c, r: row } of frontier) {
      const dirs = (row & 1) ? HEX_ODD : HEX_EVEN;
      for (const [dc, dr] of dirs) {
        const nc = c + dc, nr = row + dr;
        const k = `${nc},${nr}`;
        if (!visited.has(k)) {
          visited.set(k, { c: nc, r: nr });
          next.push({ c: nc, r: nr });
        }
      }
    }
    frontier = next;
  }

  const pairs: number[] = [];
  for (const { c, r: row } of visited.values()) {
    const dc = c - srcC, dr = row - srcR;
    if (dc === 0 && dr === 0) continue;
    pairs.push(dc, dr);
  }
  const offsets = new Int32Array(pairs);
  hexCache.set(key, offsets);
  return offsets;
}

class HexLattice implements LatticeGeometry {
  getOffsets(range: number, _x: number, y: number): Int32Array {
    return hexOffsets(range, (y & 1) as 0 | 1);
  }
  isMeanField(): boolean { return false; }
}

// ─── Triangular (alternating up/down cells, 3 edge-neighbours each) ───────────
// Cell parity = (x + y) % 2.
// Up-cell   (parity 0): edge-neighbours at (-1,0),(1,0),(0,1)
// Down-cell (parity 1): edge-neighbours at (-1,0),(1,0),(0,-1)
// For range>1 we BFS through the triangle adjacency graph.

// Cache key: range * 2 + srcCellParity
const triCache = new Map<number, Int32Array>();

function triOffsets(range: number, srcCellParity: 0 | 1): Int32Array {
  const r = Math.max(1, Math.floor(range));
  const key = r * 2 + srcCellParity;
  const cached = triCache.get(key);
  if (cached) return cached;

  // Place source so (srcC + srcR) % 2 == srcCellParity.
  type Pos = { c: number; r: number };
  const srcC = 0, srcR = srcCellParity; // (0 + parity) % 2 == parity ✓
  const visited = new Map<string, Pos>();
  visited.set(`${srcC},${srcR}`, { c: srcC, r: srcR });
  let frontier: Pos[] = [{ c: srcC, r: srcR }];

  for (let step = 0; step < r; step++) {
    const next: Pos[] = [];
    for (const { c, r: row } of frontier) {
      const isUp = (c + row) % 2 === 0;
      const dirs: [number, number][] = isUp
        ? [[-1, 0], [1, 0], [0, 1]]
        : [[-1, 0], [1, 0], [0, -1]];
      for (const [dc, dr] of dirs) {
        const nc = c + dc, nr = row + dr;
        const k = `${nc},${nr}`;
        if (!visited.has(k)) {
          visited.set(k, { c: nc, r: nr });
          next.push({ c: nc, r: nr });
        }
      }
    }
    frontier = next;
  }

  const pairs: number[] = [];
  for (const { c, r: row } of visited.values()) {
    const dc = c - srcC, dr = row - srcR;
    if (dc === 0 && dr === 0) continue;
    pairs.push(dc, dr);
  }
  const offsets = new Int32Array(pairs);
  triCache.set(key, offsets);
  return offsets;
}

class TriangularLattice implements LatticeGeometry {
  getOffsets(range: number, x: number, y: number): Int32Array {
    return triOffsets(range, ((x + y) & 1) as 0 | 1);
  }
  isMeanField(): boolean { return false; }
}

// ─── Mean-field (no spatial structure) ───────────────────────────────────────

class MeanFieldLattice implements LatticeGeometry {
  getOffsets(_range: number, _x: number, _y: number): Int32Array {
    return new Int32Array(0);
  }
  isMeanField(): boolean { return true; }
}

// ─── Voronoi (adjacency-list based, instance-specific) ───────────────────────

export class VoronoiLattice implements LatticeGeometry {
  private bfsCache = new Map<string, Int32Array>();

  constructor(private topo: VoronoiTopology) {}

  getOffsets(_range: number, _x: number, _y: number): Int32Array {
    return new Int32Array(0); // unused; engine dispatches via isVoronoi()
  }
  isMeanField(): boolean { return false; }
  isVoronoi(): boolean { return true; }

  getNeighborIndices(cellIdx: number, range: number): Int32Array {
    if (range <= 1) return this.directNeighbors(cellIdx);
    const key = `${cellIdx}_${range}`;
    const cached = this.bfsCache.get(key);
    if (cached) return cached;
    const result = this.bfsExpand(cellIdx, range);
    this.bfsCache.set(key, result);
    return result;
  }

  private directNeighbors(i: number): Int32Array {
    const { adjOffsets, adjList } = this.topo;
    return adjList.subarray(adjOffsets[i], adjOffsets[i + 1]);
  }

  private bfsExpand(start: number, maxRange: number): Int32Array {
    const { adjOffsets, adjList, n } = this.topo;
    const visited = new Uint8Array(n);
    visited[start] = 1;
    let frontier: number[] = [start];
    const result: number[] = [];
    for (let step = 0; step < maxRange; step++) {
      const next: number[] = [];
      for (const cur of frontier) {
        const lo = adjOffsets[cur], hi = adjOffsets[cur + 1];
        for (let k = lo; k < hi; k++) {
          const nb = adjList[k];
          if (!visited[nb]) {
            visited[nb] = 1;
            next.push(nb);
            result.push(nb);
          }
        }
      }
      frontier = next;
    }
    return new Int32Array(result);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

// Voronoi is instance-specific (seed-dependent) and is constructed by the Engine directly.
const INSTANCES: Omit<Record<GeometryType, LatticeGeometry>, 'voronoi'> = {
  square: new SquareLattice(),
  hexagonal: new HexLattice(),
  triangular: new TriangularLattice(),
  meanfield: new MeanFieldLattice(),
};

export function makeGeometry(type: GeometryType = 'square'): LatticeGeometry {
  const inst = INSTANCES as Partial<Record<GeometryType, LatticeGeometry>>;
  return inst[type] ?? INSTANCES.square;
}

/** Backward-compatible export for estimateR0 and tests. */
export function getOffsets(range: number): { offsets: Int32Array; count: number } {
  const offsets = squareOffsets(range);
  return { offsets, count: offsets.length / 2 };
}

/** Inline-friendly toroidal index. size assumed > 0. */
export function torus(x: number, size: number): number {
  const m = x % size;
  return m < 0 ? m + size : m;
}
