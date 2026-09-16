// TypeScript-engine benchmark entry for a BROWSER page — the graftable one.
//
// `browser-entry.ts` covers all three backends but imports `wasm-engine.ts` and
// `gpu-engine.ts`, neither of which exists in the older commits. This entry
// imports only `./protocol`, so it can be grafted into any commit in the ladder
// exactly like `node-ts.ts` — which is what lets the historical ladder be
// replayed IN THE BROWSER, not just under node.
//
// Exposes the same global as `browser-entry.ts`, minus the backends it cannot
// have, so one driver script works for both.

import { GEOMETRIES, PROTOCOL, measureTs, measureTsSplit, type BenchResult } from './protocol';
import type { GeometryType } from '../../src/types';

interface Req {
  geometries?: string[];
  sizes?: number[];
  reps?: number;
  label?: string;
  split?: boolean;
  backends?: string[];
}

async function runBench(req: Req): Promise<{
  label: string; runtime: string; adapter: null; softwareAdapter: boolean;
  protocol: typeof PROTOCOL; results: BenchResult[]; splits: BenchResult[]; errors: string[];
}> {
  const geometries = (req.geometries ?? GEOMETRIES) as GeometryType[];
  const sizes = req.sizes ?? [PROTOCOL.size];
  const reps = req.reps ?? PROTOCOL.reps;
  const results: BenchResult[] = [];
  const splits: BenchResult[] = [];
  const errors: string[] = [];

  for (const b of req.backends ?? ['ts']) {
    if (b !== 'ts') errors.push(`backend '${b}' is not available in this entry (TS only — it is the graftable one)`);
  }

  for (const size of sizes) {
    for (const geometry of geometries) {
      results.push(measureTs(geometry, size, reps));
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  if (req.split === true) {
    for (const size of sizes) for (const geometry of geometries) splits.push(measureTsSplit(geometry, size));
  }

  return {
    label: req.label ?? 'HEAD', runtime: 'browser', adapter: null, softwareAdapter: false,
    protocol: PROTOCOL, results, splits, errors,
  };
}

(window as unknown as { memelabBench: (r: Req) => unknown }).memelabBench = runBench;
