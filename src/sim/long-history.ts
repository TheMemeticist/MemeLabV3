import type { LongStats, RetiredCostTotals } from '../types';

/** Sliding-window cap on the per-tick history (matches the chart window). */
export const LONG_CAP = 4096;

const SERIES = [
  'tick', 's', 'e', 'i', 'r', 'd', 'reff',
  'dnew', 'masked', 'vaccinated', 'quarantined', 'lockdownStringency',
  'ecum', 'icum', 'rcum', 'dcum',
] as const;

type SeriesName = (typeof SERIES)[number];

export type LongRow = Record<SeriesName, number>;

export function emptyLongStats(): LongStats {
  const out = {} as Record<SeriesName, number[]>;
  for (const k of SERIES) out[k] = [];
  return out as LongStats;
}

/**
 * Ring-buffered replacement for the old push/shift `LongStats` maintenance in
 * the engine: `push()` is O(1) (the old path did 16 × `Array.shift()` — an
 * O(LONG_CAP) memmove each — every tick once the window was full), and the
 * worker sends per-frame deltas via `lastRows()` instead of structured-cloning
 * the whole ~65k-number history on every posted frame. Full `toLongStats()`
 * snapshots are only materialized on init/reset posts and exports.
 */
export class LongHistory {
  private buf: Record<SeriesName, Float64Array>;
  private head = 0; // ring index of the oldest stored row
  private count = 0;

  constructor() {
    this.buf = {} as Record<SeriesName, Float64Array>;
    for (const k of SERIES) this.buf[k] = new Float64Array(LONG_CAP);
  }

  get length(): number {
    return this.count;
  }

  /**
   * Append one tick's row. When the window is full, the oldest row is retired
   * first: its cost-relevant counts fold into `retired` so the (UI-thread)
   * cost layer keeps a true cumulative total even though the window slides.
   * Cumulative series (ecum/…) are absolute totals, so dropping their oldest
   * entries needs no retirement.
   */
  push(row: LongRow, retired: RetiredCostTotals): void {
    const buf = this.buf;
    if (this.count === LONG_CAP) {
      const h = this.head;
      retired.ticks++;
      retired.i += buf.i[h];
      retired.dnew += buf.dnew[h];
      retired.masked += buf.masked[h];
      retired.vaccinated += buf.vaccinated[h];
      retired.quarantined += buf.quarantined[h];
      retired.lockdownStringency += buf.lockdownStringency[h];
      this.head = (h + 1) % LONG_CAP;
      this.count--;
    }
    const w = (this.head + this.count) % LONG_CAP;
    for (const k of SERIES) buf[k][w] = row[k];
    this.count++;
  }

  /** Full ordered snapshot (allocates; use only for init/reset posts and exports). */
  toLongStats(): LongStats {
    return this.slice(0, this.count);
  }

  /** The most recent `k` rows in order (k clamped to the stored count). */
  lastRows(k: number): LongStats {
    const take = Math.min(Math.max(0, k | 0), this.count);
    return this.slice(this.count - take, this.count);
  }

  private slice(from: number, to: number): LongStats {
    const out = {} as Record<SeriesName, number[]>;
    const len = to - from;
    for (const k of SERIES) {
      const src = this.buf[k];
      const arr = new Array<number>(len);
      for (let i = 0; i < len; i++) arr[i] = src[(this.head + from + i) % LONG_CAP];
      out[k] = arr;
    }
    return out as LongStats;
  }
}

/**
 * UI-side mirror maintenance: append a delta's rows to `target` and trim the
 * front so the mirror matches the engine's LONG_CAP sliding window.
 */
export function appendLongDelta(target: LongStats, delta: LongStats): void {
  for (const k of SERIES) {
    const dst = target[k];
    const src = delta[k];
    for (let i = 0; i < src.length; i++) dst.push(src[i]);
    if (dst.length > LONG_CAP) dst.splice(0, dst.length - LONG_CAP);
  }
}
