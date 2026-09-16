// Backend A/B harness — TS engine vs the Rust/WASM core on the identical
// workload, plus a grid-size scaling sweep. Companion to `tests/bench.ts`
// (which measures the TS engine alone and its per-pass split).
//
//   npx vite-node tests/bench-backends.ts            # table to stdout
//   BENCH_JSON=out.json npx vite-node tests/bench-backends.ts
//
// Protocol, per (geometry, size, backend): build the engine, step WARMUP ticks
// to reach endemic steady state and let the JIT settle, then time MEASURE
// ticks. The config and seed are fixed and both backends are bit-identical, so
// the two backends are stepping the *same* trajectory — the only difference
// measured is the cost of stepping it.
//
// A separate parity pass (not timed) steps both engines side by side and
// compares the full SimStats tuple on every tick, so a reported speedup can
// never come from the backends having quietly diverged.

import { Engine } from '../src/sim/engine';
import { WasmEngine, wasmAvailable } from '../src/sim/wasm-engine';
import type { GeometryType, SimConfig, SimStats } from '../src/types';

const WARMUP_TICKS = 200;
const MEASURE_TICKS = 300;
const PARITY_TICKS = 501;
const GEOMETRIES: GeometryType[] = ['square', 'triangular', 'hexagonal', 'voronoi', 'meanfield'];
const SIZES = [128, 320];
// Matches the GPU spike's sweep so the three backends are directly comparable.
const SWEEP_SIZES = [64, 128, 256, 320, 512, 768, 1024, 1448, 2048];

// Identical to tests/bench.ts benchConfig — endemic steady state, quarantine
// on, a little mortality and birth.
function benchConfig(geometry: GeometryType, size: number): SimConfig {
  return {
    seed: 0xb175b175 >>> 0,
    size,
    geometry,
    voronoiConfig: { mode: 'jittered', irregularity: 0.5 },
    seedInfections: 0.05,
    birthRate: 0.05,
    mutate: false,
    strain: {
      attackRate: 0.4, incubation: 3, infectious: 7, ifr: 0.02,
      range: 1, immunityDays: 60, mutationRate: 0,
    },
    defenses: [
      { id: 'mask', label: 'Mask', enabled: true, protection: 0.2, sourceControl: 0.2, mortalityReduction: 0, uptake: 0.3 },
      { id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0.4, sourceControl: 0, mortalityReduction: 0.8, uptake: 0.4 },
    ],
    lockdown: { enabled: false, mobilityReduction: 0, transmissionReduction: 0, compliance: 0 },
    quarantine: { enabled: true, detectionRate: 0.02, contactsRange: 1, protection: 0.3, sourceControl: 0.5, duration: 14 },
  };
}

type Backend = 'ts' | 'wasm';
const build = (b: Backend, cfg: SimConfig) => (b === 'ts' ? new Engine(cfg) : new WasmEngine(cfg));

// One timed window. The warmup is the same at every grid size on purpose: the
// endemic steady state has to be reached before the clock starts, or a bigger
// dish is measured on a smaller infectious pool and the comparison is void.
function once(backend: Backend, geometry: GeometryType, size: number): number {
  const engine = build(backend, benchConfig(geometry, size));
  for (let t = 0; t < WARMUP_TICKS; t++) engine.step();
  const t0 = performance.now();
  for (let t = 0; t < MEASURE_TICKS; t++) engine.step();
  return (MEASURE_TICKS / (performance.now() - t0)) * 1000;
}

// Best of N: GC pauses and scheduler noise can only ever make a run slower, so
// the fastest of a few repeats is the cleanest estimate of the code's cost.
function measure(backend: Backend, geometry: GeometryType, size: number, reps = 3): number {
  let best = 0;
  for (let r = 0; r < reps; r++) best = Math.max(best, once(backend, geometry, size));
  return best;
}

// Returns the first tick at which the two backends disagree, or -1 for parity.
function parityBreakTick(geometry: GeometryType, size: number): number {
  const ts = new Engine(benchConfig(geometry, size));
  const wa = new WasmEngine(benchConfig(geometry, size));
  const key = (s: SimStats) => `${s.s},${s.e},${s.i},${s.r},${s.d},${s.newInfections},${s.newDeaths}`;
  for (let t = 0; t < PARITY_TICKS; t++) {
    if (key(ts.step()) !== key(wa.step())) return t;
  }
  return -1;
}

if (!wasmAvailable()) throw new Error('wasm core unavailable in this runtime');

const machine = `node ${process.version}`;
console.log(`MemeLab backend bench — warmup ${WARMUP_TICKS}, measured ${MEASURE_TICKS} ticks, ${machine}`);

const backends: { geometry: string; size: number; ts: number; wasm: number; ratio: number; parity: boolean }[] = [];
for (const size of SIZES) {
  for (const geometry of GEOMETRIES) {
    const tsRate = measure('ts', geometry, size);
    const wasmRate = measure('wasm', geometry, size);
    const parity = parityBreakTick(geometry, size) === -1;
    backends.push({ geometry, size, ts: tsRate, wasm: wasmRate, ratio: wasmRate / tsRate, parity });
    console.log(
      `${String(size).padStart(4)}²  ${geometry.padEnd(10)} ` +
      `TS ${tsRate.toFixed(0).padStart(6)} t/s   WASM ${wasmRate.toFixed(0).padStart(6)} t/s   ` +
      `${(wasmRate / tsRate).toFixed(2)}×   parity ${parity ? 'OK' : 'BROKEN'} over ${PARITY_TICKS} ticks`,
    );
  }
}

// Scaling sweep on the square lattice: does the event-driven core hold its
// per-cell cost as the dish grows?
const sweep: { size: number; cells: number; ts: number; wasm: number }[] = [];
console.log('\nsquare-lattice scaling sweep');
for (const size of SWEEP_SIZES) {
  const tsRate = measure('ts', 'square', size);
  const wasmRate = measure('wasm', 'square', size);
  const cells = size * size;
  sweep.push({ size, cells, ts: tsRate, wasm: wasmRate });
  console.log(
    `${String(size).padStart(4)}²  ${String(cells).padStart(7)} cells  ` +
    `TS ${tsRate.toFixed(0).padStart(6)} t/s (${(tsRate * cells / 1e6).toFixed(1)} Mcell/s)   ` +
    `WASM ${wasmRate.toFixed(0).padStart(6)} t/s (${(wasmRate * cells / 1e6).toFixed(1)} Mcell/s)`,
  );
}

if (process.env.BENCH_JSON) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.BENCH_JSON, JSON.stringify({
    machine, warmup: WARMUP_TICKS, measured: MEASURE_TICKS, parityTicks: PARITY_TICKS,
    date: new Date().toISOString(), backends, sweep,
  }, null, 2));
  console.log(`\nwrote ${process.env.BENCH_JSON}`);
}
