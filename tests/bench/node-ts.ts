// TypeScript-engine benchmark entry, for PLAIN Node.
//
// This entry is deliberately tiny and imports ONLY `./protocol`, which in turn
// imports only `src/sim/engine.ts` and `src/types.ts`. That is what makes the
// pair graftable: `tests/bench/ladder.mjs` copies these two files into a
// worktree of a year-old commit, bundles them with esbuild, and runs them on
// plain Node — so every rung of the ladder is measured by the SAME harness
// rather than by whatever benchmark that commit happened to ship.
//
// It is never run through vite-node. See tests/README.md for why that matters.
//
// Env knobs (all optional):
//   BENCH_GEOMETRIES=square,voronoi   default: all five
//   BENCH_SIZES=320,2048              default: 320
//   BENCH_REPS=5                      default: 3
//   BENCH_LABEL="pre-optimization"    free-text label echoed into the output
//   BENCH_SPLIT=1                     also run a separate PROFILED window and
//                                     report the per-pass split. The profile
//                                     hook adds two timer calls per pass per
//                                     tick, so its window is reported apart
//                                     from the tick-rate table and must never
//                                     be quoted as a rate.

import {
  GEOMETRIES, PROTOCOL, formatResult, formatSplit, measureTs, measureTsSplit, protocolBanner,
  type BenchResult,
} from './protocol';
import type { GeometryType } from '../../src/types';

const env = (k: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p && p.env ? p.env[k] : undefined;
};

const geometries: GeometryType[] = (env('BENCH_GEOMETRIES') || '').trim()
  ? (env('BENCH_GEOMETRIES') as string).split(',').map((s) => s.trim() as GeometryType)
  : GEOMETRIES;
const sizes: number[] = (env('BENCH_SIZES') || '').trim()
  ? (env('BENCH_SIZES') as string).split(',').map((s) => parseInt(s.trim(), 10))
  : [PROTOCOL.size];
const reps = parseInt(env('BENCH_REPS') || String(PROTOCOL.reps), 10);
const label = env('BENCH_LABEL') || 'HEAD';

console.log(protocolBanner(label));
console.log(`runtime: plain Node, ${env('BENCH_BUNDLER') || 'vite'} bundle (NOT vite-node)  engine: TypeScript`);
console.log('');

const results: BenchResult[] = [];
for (const size of sizes) {
  for (const geometry of geometries) {
    const r = measureTs(geometry, size, reps);
    results.push(r);
    console.log(formatResult(r));
  }
}

const splits: BenchResult[] = [];
if ((env('BENCH_SPLIT') || '') === '1') {
  console.log('');
  console.log('per-pass split (PROFILED window — separate run, slower by construction)');
  for (const size of sizes) {
    for (const geometry of geometries) {
      const r = measureTsSplit(geometry, size);
      splits.push(r);
      console.log(formatSplit(r));
    }
  }
}

// One machine-readable line; the .mjs runners parse it out of stdout so this
// file needs no filesystem import and stays graftable.
console.log(`##BENCH_JSON## ${JSON.stringify({ label, runtime: 'node', protocol: PROTOCOL, results, splits })}`);
