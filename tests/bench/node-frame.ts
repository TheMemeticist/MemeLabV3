// Frame-post / history-payload micro-bench, for PLAIN Node.
//
// What sim.worker's `postFrame` pays, per posted frame, to hand the UI thread
// its slice of the long history. Two payload shapes:
//
//   full snapshot  `history.toLongStats()`  — every stored row, 16 series.
//                  Posted only on init/reset and on window overrun.
//   1-row delta    `history.lastRows(1)`    — what a steady-state 60 fps post
//                  actually sends.
//
// Both are measured the way the worker pays for them: the `slice()` that
// materializes plain arrays out of the ring buffer, PLUS the structured clone
// postMessage performs on the way out. The typed-array grid buffers are
// transferred, not cloned, so they are deliberately not in this window.
//
// The dish is 128² at 600 ticks: the payload cost scales with the number of
// stored TICKS, not with grid size, so the small dish only makes the setup
// cheap. The workload is the shared `benchConfig` from `./protocol`, at a
// smaller size — same config object, so the payload shape is the app's.
//
// Runs under plain Node from a production (vite/rollup) bundle — never
// vite-node. See tests/README.md for why that distinction exists.
//
// Env knobs:
//   BENCH_REPS=5      best-of-N timed batches (default 5)
//   BENCH_TICKS=600   history depth to snapshot (default 600)
//   BENCH_WARM=50     clones per payload before the clock starts (default 50).
//                     BENCH_WARM=0 BENCH_REPS=1 reproduces the cold, single-
//                     batch methodology of the legacy `tests/bench.ts` bench.
//   BENCH_LABEL=...   free text echoed into the output

import { Engine } from '../../src/sim/engine';
import { benchConfig } from './protocol';

const env = (k: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p && p.env ? p.env[k] : undefined;
};

const REPS = parseInt(env('BENCH_REPS') || '5', 10);
const TICKS = parseInt(env('BENCH_TICKS') || '600', 10);
const ITERS = 300; // clones per timed batch
const label = env('BENCH_LABEL') || 'HEAD';

const cfg = benchConfig('square', 128);
const engine = new Engine(cfg);
for (let t = 0; t < TICKS; t++) engine.step();

let sink = 0;

/** Best-of-N mean-per-op, in microseconds. Noise only ever makes a batch
 *  slower, so the fastest batch is the cleanest estimate. */
function bestOf(payload: () => { tick: number[] }): { us: number; all: number[] } {
  const warm = parseInt(env('BENCH_WARM') || '50', 10);
  for (let r = 0; r < warm; r++) sink += (structuredClone(payload()).tick.length); // warm-up / JIT
  const all: number[] = [];
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) sink += structuredClone(payload()).tick.length;
    all.push(((performance.now() - t0) / ITERS) * 1000);
  }
  return { us: Math.min(...all), all };
}

const full = bestOf(() => engine.history.toLongStats());
const delta = bestOf(() => engine.history.lastRows(1));
const ratio = full.us / delta.us;

console.log(`MemeLab frame-post micro-bench — ${TICKS}-tick history, ${ITERS} clones/batch, best of ${REPS}`);
console.log(`runtime: plain Node ${(globalThis as { process?: { version?: string } }).process?.version}, ${env('BENCH_BUNDLER') || 'vite'} bundle (NOT vite-node)   stage: ${label}`);
console.log(`rows stored: ${engine.history.length}   sink: ${sink}`);
console.log('');
console.log(`full snapshot @${TICKS} ticks   ${full.us.toFixed(1).padStart(8)} µs/frame   batches: ${full.all.map((n) => n.toFixed(1)).join(' ')}`);
console.log(`1-row delta                ${delta.us.toFixed(1).padStart(8)} µs/frame   batches: ${delta.all.map((n) => n.toFixed(2)).join(' ')}`);
console.log(`ratio full/delta           ${ratio.toFixed(1).padStart(8)}×`);
console.log(`at 60 fps                  delta ${(delta.us * 60 / 1000).toFixed(2)} ms/s   vs full ${(full.us * 60 / 1000).toFixed(1)} ms/s`);
console.log(`##BENCH_JSON## ${JSON.stringify({ label, runtime: 'node', ticks: TICKS, iters: ITERS, reps: REPS, fullUs: full.us, deltaUs: delta.us, ratio, fullBatches: full.all, deltaBatches: delta.all })}`);
