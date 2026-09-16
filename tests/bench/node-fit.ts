// Fit-path micro-bench, for PLAIN Node.
//
// The R₀ estimator's inner loop is `runTrials(days, K)` at the 128² grid a real
// fit runs at, for the two candidate shapes a GA actually sweeps: one that
// burns out early (per-trial FIXED costs dominate — engine construction or
// reset, the analytic-R₀ estimate) and one that sweeps the grid (stepping
// dominates). A tick-rate number alone predicts neither.
//
// Graftability: this entry needs `src/lib/fit-sim.ts` in addition to
// `src/sim/*`, so it runs at the hot-loop commit and later, but NOT at the
// pre-optimization commit, which has no fit path at all. `tests/bench/ladder.mjs`
// skips it there rather than pretending a zero.
//
// Never run through vite-node. See tests/README.md.

import { benchConfig, protocolBanner } from './protocol';
import { runTrials } from '../../src/lib/fit-sim';
import type { GeometryType, SimConfig } from '../../src/types';

const env = (k: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p && p.env ? p.env[k] : undefined;
};

const FIT_GRID = 128;   // FIT_GRID_CAP — the size real fits run at
const DAYS = 60;
const K = 5;
const FIT_SEED = 0xc0ffee;
const REPS = 3;

// Fit-shaped config: the estimator fits cumulative-incidence curves from a
// single index case with no births and lifelong immunity — NOT the endemic
// steady state the tick-rate protocol uses. Derived from the shared
// benchConfig so the two can never drift apart silently.
function fitConfig(geometry: GeometryType, range: number, attackRate: number): SimConfig {
  const c = benchConfig(geometry, FIT_GRID);
  c.seedInfections = 0;
  c.birthRate = 0;
  c.strain = { ...c.strain, range, attackRate, immunityDays: 36500 };
  return c;
}

const cases: Array<[string, SimConfig]> = [
  ['square r1 spread', fitConfig('square', 1, 0.3)],
  ['voronoi r3 burnout', fitConfig('voronoi', 3, 0.02)],
  ['voronoi r3 spread', fitConfig('voronoi', 3, 0.3)],
];

const label = env('BENCH_LABEL') || 'HEAD';
console.log(protocolBanner(label));
console.log(`runtime: plain Node, ${env('BENCH_BUNDLER') || 'vite'} bundle (NOT vite-node)  bench: fit inner loop`);
console.log(`runTrials(${DAYS}d, K=${K}) at ${FIT_GRID}², seed 0x${FIT_SEED.toString(16)}, best of ${REPS}`);
console.log('');

const results: Array<{ candidate: string; msTotal: number; msPerTrial: number; rNaught: number | null; samples: number[] }> = [];
for (const [name, cfg] of cases) {
  runTrials(cfg, DAYS, K, FIT_SEED); // warm-up / JIT
  const samples: number[] = [];
  let best = Infinity;
  let r0: number | null = null;
  for (let rep = 0; rep < REPS; rep++) {
    const t0 = performance.now();
    const r = runTrials(cfg, DAYS, K, FIT_SEED);
    const ms = performance.now() - t0;
    samples.push(ms);
    if (ms < best) best = ms;
    r0 = r.rNaught === undefined ? null : r.rNaught;
  }
  results.push({ candidate: name, msTotal: best, msPerTrial: best / K, rNaught: r0, samples });
  console.log(
    `fit ${name.padEnd(20)} ${best.toFixed(1).padStart(8)} ms  ` +
    `${(best / K).toFixed(2).padStart(7)} ms/trial  R0=${r0 === null ? 'n/a' : r0.toFixed(3)}`,
  );
}

console.log(`##BENCH_JSON## ${JSON.stringify({ label, runtime: 'node', bench: 'fit', grid: FIT_GRID, days: DAYS, k: K, seed: FIT_SEED, reps: REPS, results })}`);
