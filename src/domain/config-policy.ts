import type { SimConfig } from '../types';

/** Shared UI/headless routing policy: only structural changes rebuild a world.
 * Optional defaults are normalized; inactive Voronoi settings do not affect a
 * lattice run. Gene/intervention changes are patched into the running engine. */
export function needsRebuild(prev: SimConfig | null, next: SimConfig): boolean {
  if (!prev) return true;
  if (prev.size !== next.size) return true;
  if (prev.seed !== next.seed) return true;
  if ((prev.geometry ?? 'square') !== (next.geometry ?? 'square')) return true;
  if (prev.geometry === 'voronoi' && next.geometry === 'voronoi') {
    const pv = prev.voronoiConfig ?? { mode: 'jittered', irregularity: 0.5 };
    const nv = next.voronoiConfig ?? { mode: 'jittered', irregularity: 0.5 };
    if (pv.mode !== nv.mode || pv.irregularity !== nv.irregularity) return true;
  }
  return false;
}
