// Headless tick-rate benchmark — the Phase 0 perf harness required by
// docs/wasm-plan.md §2. Run with `npm run bench` (vite-node; no browser).
//
// Reports, per geometry at 320×320:
//   - ticks/sec and ms/tick over a fixed measured window
//   - coarse per-pass split: transmission / quarantine / life-cycle / stats
//     (via Engine.profile — two performance.now() calls per pass per tick)
//
// The config and seed are fixed, so successive runs of the same code measure
// the *identical* workload (determinism invariant) — differences between runs
// are noise; differences between code versions are real.
//
// Two micro-benches follow the main table:
//   - frame-post cost: what sim.worker's postFrame pays per posted frame for
//     the long-history payload
//   - history maintenance at the LONG_CAP window: per-tick cost of the sliding
//     long-stats window once it is full (4096 ticks)

import { Engine } from '../src/sim/engine';
import type { GeometryType, SimConfig } from '../src/types';

const SIZE = 320;
const WARMUP_TICKS = 200;
const MEASURE_TICKS = 300;
const GEOMETRIES: GeometryType[] = ['square', 'triangular', 'hexagonal', 'voronoi', 'meanfield'];

// Endemic-steady-state config: fast-waning immunity keeps a large infectious
// pool alive through the whole measured window (so the transmission pass is
// actually exercised — R0 must stay >1 even on the 3-neighbour triangular and
// k=2 mean-field geometries), quarantine is on so pass 2b runs, and a little
// mortality + birth exercises the dead-cell rebirth path.
function benchConfig(geometry: GeometryType): SimConfig {
  return {
    seed: 0xb175b175 >>> 0,
    size: SIZE,
    geometry,
    voronoiConfig: { mode: 'jittered', irregularity: 0.5 },
    seedInfections: 0.05,
    birthRate: 0.05,
    mutate: false,
    strain: {
      attackRate: 0.4,
      incubation: 3,
      infectious: 7,
      ifr: 0.02,
      range: 1,
      immunityDays: 60,
      mutationRate: 0,
    },
    defenses: [
      { id: 'mask', label: 'Mask', enabled: true, protection: 0.2, sourceControl: 0.2, mortalityReduction: 0, uptake: 0.3 },
      { id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0.4, sourceControl: 0, mortalityReduction: 0.8, uptake: 0.4 },
    ],
    lockdown: { enabled: false, mobilityReduction: 0, transmissionReduction: 0, compliance: 0 },
    quarantine: { enabled: true, detectionRate: 0.02, contactsRange: 1, protection: 0.3, sourceControl: 0.5, duration: 14 },
  };
}

function pct(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(1).padStart(5)}%` : '    —';
}

function runGeometry(geometry: GeometryType): void {
  const cfg = benchConfig(geometry);
  const t0 = performance.now();
  const engine = new Engine(cfg);
  const buildMs = performance.now() - t0;

  for (let t = 0; t < WARMUP_TICKS; t++) engine.step();

  engine.profile = { transmission: 0, quarantine: 0, lifecycle: 0, stats: 0 };
  const s0 = performance.now();
  let last = engine.step();
  for (let t = 1; t < MEASURE_TICKS; t++) last = engine.step();
  const totalMs = performance.now() - s0;
  const p = engine.profile;
  engine.profile = null;

  const profiled = p.transmission + p.quarantine + p.lifecycle + p.stats;
  const other = Math.max(0, totalMs - profiled);
  const ticksPerSec = (MEASURE_TICKS / totalMs) * 1000;

  console.log(
    `${geometry.padEnd(10)} ${ticksPerSec.toFixed(1).padStart(8)} t/s ` +
    `${(totalMs / MEASURE_TICKS).toFixed(3).padStart(8)} ms/tick | ` +
    `trans ${pct(p.transmission, totalMs)}  quar ${pct(p.quarantine, totalMs)}  ` +
    `life ${pct(p.lifecycle, totalMs)}  stats ${pct(p.stats, totalMs)}  other ${pct(other, totalMs)} | ` +
    `build ${buildMs.toFixed(0)}ms  I=${last.i} E=${last.e} D=${last.d}`,
  );
}

// ── Frame-post micro-bench ───────────────────────────────────────────────────
// sim.worker's postFrame serializes the long-history payload per posted frame
// (up to 60/s). Measure what one post pays for that payload.
function benchFramePost(): void {
  const cfg = benchConfig('square');
  cfg.size = 128; // history cost depends on tick count, not grid size
  const engine = new Engine(cfg);
  for (let t = 0; t < 600; t++) engine.step();

  const REPS = 300;
  let c0 = performance.now();
  for (let r = 0; r < REPS; r++) structuredClone(engine.history.toLongStats());
  const fullMs = (performance.now() - c0) / REPS;
  c0 = performance.now();
  for (let r = 0; r < REPS; r++) structuredClone(engine.history.lastRows(1));
  const deltaMs = (performance.now() - c0) / REPS;
  console.log(
    `frame-post: full snapshot @600 ticks = ${(fullMs * 1000).toFixed(1)} µs/frame, ` +
    `1-row delta = ${(deltaMs * 1000).toFixed(1)} µs/frame` +
    ` (steady-state posts are deltas; ~${(deltaMs * 60).toFixed(2)} ms/s at 60 fps vs ~${(fullMs * 60).toFixed(2)})`,
  );
}

// ── History-maintenance micro-bench ──────────────────────────────────────────
// Once tick > LONG_CAP (4096) the long-stats window slides every tick. Use a
// small mean-field grid so the window cost dominates the tick cost.
function benchHistoryMaintenance(): void {
  const cfg = benchConfig('meanfield');
  cfg.size = 48;
  // Quiet sim (no epidemic at all) so the per-tick workload is identical below
  // and at the cap — the delta isolates the window-slide cost alone.
  cfg.seedInfections = 0;
  cfg.strain.attackRate = 0;
  cfg.quarantine.enabled = false;
  const engine = new Engine(cfg);

  for (let t = 0; t < 300; t++) engine.step(); // JIT warmup before the below-cap leg

  const PRE = 300;
  let s0 = performance.now();
  for (let t = 0; t < PRE; t++) engine.step();
  const preMs = (performance.now() - s0) / PRE;

  while (engine.tick < 4200) engine.step(); // cross LONG_CAP

  const POST = 300;
  s0 = performance.now();
  for (let t = 0; t < POST; t++) engine.step();
  const postMs = (performance.now() - s0) / POST;

  console.log(
    `history:    tick cost below cap ${(preMs * 1000).toFixed(1)} µs, at cap ${(postMs * 1000).toFixed(1)} µs` +
    ` (window-slide overhead ≈ ${((postMs - preMs) * 1000).toFixed(1)} µs/tick, 48×48 meanfield)`,
  );
}

// BENCH_ONLY=<geometry> runs a single geometry and skips the micro-benches —
// for quick A/B iterations on the hot loops.
const only = process.env.BENCH_ONLY as GeometryType | undefined;
console.log(`MemeLab bench — ${SIZE}×${SIZE}, warmup ${WARMUP_TICKS}, measured ${MEASURE_TICKS} ticks, node ${process.version}`);
for (const g of GEOMETRIES) {
  if (only && g !== only) continue;
  runGeometry(g);
}
if (!only) {
  benchFramePost();
  benchHistoryMaintenance();
}
