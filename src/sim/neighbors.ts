// Precomputed Manhattan-distance neighbor offsets.
// One offset list per range. Toroidal grid wrapping is applied at lookup time.

export interface OffsetTable {
  range: number;
  offsets: Int32Array; // pairs: [dx, dy, dx, dy, ...]
  count: number;
}

const cache = new Map<number, OffsetTable>();

export function getOffsets(range: number): OffsetTable {
  const r = Math.max(1, Math.floor(range));
  const cached = cache.get(r);
  if (cached) return cached;

  const pairs: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (Math.abs(dx) + Math.abs(dy) <= r) pairs.push(dx, dy);
    }
  }
  const offsets = new Int32Array(pairs);
  const table: OffsetTable = { range: r, offsets, count: offsets.length / 2 };
  cache.set(r, table);
  return table;
}

/** Inline-friendly toroidal index. size assumed > 0. */
export function torus(x: number, size: number): number {
  // Branchless modulo for negative.
  const m = x % size;
  return m < 0 ? m + size : m;
}
