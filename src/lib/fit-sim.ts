// Shared headless-trial runner for the R₀ Estimator. Imported by both
// `fit.worker.ts` (production path) and the fit tests (in-process), so the two
// can never drift. Pure: constructs its own Engine instances and never touches
// any live simulation state.

import { type EngineOptions } from '../sim';
import { WasmEngine, createEngine, wasmAvailable, wasmCompatible, type AnyEngine } from '../sim/wasm-engine';
import { CellState } from '../types';
import type { SimConfig, VoronoiTopology } from '../types';
import { buildVoronoi } from '../sim/voronoi';
import { Rng } from '../sim/rng';
import type { SimCurves, SimResult } from './fit';

// Decorrelate trial seeds: trial k runs at seed ⊕ (k · golden-ratio constant),
// so the K trials sample independent stochastic realizations of the same config.
const SEED_STRIDE = 0x9e3779b1;

// Voronoi topology is expensive to build (Delaunay triangulation), and during a
// fit only the genes vary — the topology (seed/size/voronoiConfig) is constant.
// Build it once per key and share it across every trial and candidate, so we
// never pay the triangulation cost per `Engine`. Mirrors the live worker's
// topology cache (`sim.worker.ts:buildAndPostTopology`).
let cachedTopo: VoronoiTopology | null = null;
let cachedTopoKey: string | null = null;

// One engine per worker, reset per trial. Engine.reset() reuses every buffer
// when the grid size is unchanged, and a reset engine is bit-identical to a
// freshly constructed one — construction (~0.5 ms of allocations at 128²) was
// the dominant per-trial cost for burnout candidates, paid K× per candidate,
// thousands of times per fit.
//
// Backend: the WASM engine when the config is inside its feature space (it is
// BIT-IDENTICAL to the TS engine — tests/wasm-engine.test.ts — so fits produce
// the same results either way, just faster); the TS engine for mutation
// configs or when wasm is unavailable.
let cachedEngine: AnyEngine | null = null;

function engineFor(config: SimConfig, topo: VoronoiTopology | undefined, opts: EngineOptions): AnyEngine {
  const wantWasm = wasmCompatible(config) && wasmAvailable();
  if (cachedEngine === null || (cachedEngine instanceof WasmEngine) !== wantWasm) {
    cachedEngine = createEngine(config, topo ?? null, opts, wantWasm);
  } else {
    cachedEngine.reset(config, topo, opts);
  }
  return cachedEngine;
}

function topologyFor(config: SimConfig, baseSeed: number): VoronoiTopology | undefined {
  if ((config.geometry ?? 'square') !== 'voronoi') return undefined;
  const v = config.voronoiConfig ?? { mode: 'jittered', irregularity: 0.5 };
  const key = `${baseSeed}|${config.size}|${v.mode}|${v.irregularity}`;
  if (cachedTopo && cachedTopoKey === key) return cachedTopo;
  // Same topology RNG derivation the engine/worker use, off the base seed.
  const rng = new Rng((baseSeed ^ 0x564f524f) >>> 0);
  cachedTopo = buildVoronoi(config.size * config.size, config.voronoiConfig, rng, false);
  cachedTopoKey = key;
  return cachedTopo;
}

/** Run K stochastic trials of `config` for `days` days; returns mean per-capita
 *  SEIR curves (fractions in [0..1], length days + 1) plus the engine's analytic
 *  R₀ for the candidate (identical across trials — same genes + topology). */
export function runTrials(
  config: SimConfig,
  days: number,
  K: number,
  seed: number,
  schedule?: number[],
): SimResult {
  const N = config.size * config.size;
  const len = days + 1;
  const sumInf = new Float64Array(len);
  const sumDeath = new Float64Array(len);
  const sumActive = new Float64Array(len);

  // Built once (voronoi only); shared across trials so we skip the per-Engine
  // triangulation. undefined for lattice/mean-field geometries.
  const topo = topologyFor(config, seed);
  let rNaught: number | null = null;

  // With reseed off (the fit baseline), once a trial reaches E+I=0 the epidemic
  // can never recover: cumulative counts are frozen and active stays 0. Skip the
  // remaining day-steps and fill the curves forward — a large saving on
  // long-horizon datasets where most candidates burn out early.
  const canReseed = config.reseedOnExtinction === true;

  for (let k = 0; k < K; k++) {
    const trialSeed = (seed ^ ((k * SEED_STRIDE) >>> 0)) >>> 0;
    // Trials differ only by seed, and the analytic R₀ depends on the genes,
    // geometry and topology — never the seed — so it is identical across all K.
    // Compute it on trial 0 and hand it to the rest: `estimateR0` draws no
    // randomness, so skipping it leaves every trial's PRNG trajectory (and
    // therefore its curves) bit-identical. On Voronoi with range > 1 this is
    // the expensive one — it BFS-expands ~512 cells per engine.
    // Annotated to break the inference cycle: `rNaught` is assigned from
    // `engine.rNaught` and also feeds the reset options.
    const engine: AnyEngine = engineFor(
      { ...config, seed: trialSeed },
      topo,
      k === 0 ? { txSchedule: schedule } : { rNaught, txSchedule: schedule },
    );
    if (k === 0) rNaught = engine.rNaught;

    // Day 0 — the seeded population before any step. Patient-zero / seed
    // infections already count toward cumulative infections.
    const { state } = engine.buffers();
    let cumInf = 0;
    let active = 0;
    for (let i = 0; i < state.length; i++) {
      const s = state[i];
      if (s === CellState.Exposed) cumInf++;
      else if (s === CellState.Infectious) { cumInf++; active++; }
    }
    let cumDeath = 0;
    sumInf[0] += cumInf;
    sumActive[0] += active;

    for (let d = 1; d <= days; d++) {
      const stats = engine.step();
      cumInf += stats.newInfections; // newInfections == new exposures this tick
      cumDeath += stats.newDeaths;
      sumInf[d] += cumInf;
      sumDeath[d] += cumDeath;
      sumActive[d] += stats.i;
      if (!canReseed && stats.e + stats.i === 0) {
        // Extinct — carry the frozen cumulative totals forward (active = 0).
        for (let f = d + 1; f <= days; f++) {
          sumInf[f] += cumInf;
          sumDeath[f] += cumDeath;
        }
        break;
      }
    }
  }

  const inv = 1 / (K * N);
  const scale = (s: Float64Array): number[] => Array.from(s, (v) => v * inv);
  const curves: SimCurves = {
    cumulative_infections: scale(sumInf),
    cumulative_deaths: scale(sumDeath),
    active_infections: scale(sumActive),
  };
  return { curves, rNaught };
}

/** Re-run the K trials behind a fitted mean curve (identical seeds and
 *  seeding to `runTrials`) and pick the REPRESENTATIVE one: the trial whose
 *  deaths + cumulative-infections curves sit closest (normalized L2) to the
 *  K-mean. Returns its trial seed — applying `{...config, seed}` to the live
 *  sim replays that exact trial bit-for-bit (CPU ≡ WASM), so the live run
 *  tracks the fitted curve instead of being a fresh lottery draw that may
 *  fizzle at patient zero.
 *
 *  Voronoi caveat: the live app derives its topology from config.seed, while
 *  fit trials share one topology from the base seed — only trial 0
 *  (trialSeed === baseSeed) reproduces the same world, so voronoi always
 *  picks trial 0. */
export function bestTrialSeed(
  config: SimConfig,
  days: number,
  K: number,
  seed: number,
  schedule?: number[],
): { seed: number; kIndex: number } {
  if ((config.geometry ?? 'square') === 'voronoi' || K <= 1) return { seed: seed >>> 0, kIndex: 0 };
  const len = days + 1;
  const canReseed = config.reseedOnExtinction === true;
  let rNaught: number | null = null;
  const deaths: Float64Array[] = [];
  const infs: Float64Array[] = [];

  for (let k = 0; k < K; k++) {
    const trialSeed = (seed ^ ((k * SEED_STRIDE) >>> 0)) >>> 0;
    const engine: AnyEngine = engineFor(
      { ...config, seed: trialSeed },
      undefined,
      k === 0 ? { txSchedule: schedule } : { rNaught, txSchedule: schedule },
    );
    if (k === 0) rNaught = engine.rNaught;
    const death = new Float64Array(len);
    const inf = new Float64Array(len);
    const { state } = engine.buffers();
    let cumInf = 0;
    for (let i = 0; i < state.length; i++) {
      const s = state[i];
      if (s === CellState.Exposed || s === CellState.Infectious) cumInf++;
    }
    inf[0] = cumInf;
    let cumDeath = 0;
    for (let d = 1; d <= days; d++) {
      const stats = engine.step();
      cumInf += stats.newInfections;
      cumDeath += stats.newDeaths;
      inf[d] = cumInf;
      death[d] = cumDeath;
      if (!canReseed && stats.e + stats.i === 0) {
        for (let f = d + 1; f <= days; f++) { inf[f] = cumInf; death[f] = cumDeath; }
        break;
      }
    }
    deaths.push(death);
    infs.push(inf);
  }

  const meanD = new Float64Array(len);
  const meanI = new Float64Array(len);
  for (let k = 0; k < K; k++) {
    for (let d = 0; d < len; d++) { meanD[d] += deaths[k][d]; meanI[d] += infs[k][d]; }
  }
  for (let d = 0; d < len; d++) { meanD[d] /= K; meanI[d] /= K; }
  // Normalize each curve family by its mean's peak so deaths (small counts)
  // and infections (large counts) weigh equally.
  const dScale = 1 / Math.max(1, meanD[len - 1]);
  const iScale = 1 / Math.max(1, meanI[len - 1]);
  let bestK = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let k = 0; k < K; k++) {
    let score = 0;
    for (let d = 0; d < len; d++) {
      const ed = (deaths[k][d] - meanD[d]) * dScale;
      const ei = (infs[k][d] - meanI[d]) * iScale;
      // Deaths weigh 3×: they are what users read the fit against, and their
      // small counts leave the most visible per-trial wiggle around the mean.
      score += 3 * ed * ed + ei * ei;
    }
    if (score < bestScore) { bestScore = score; bestK = k; }
  }
  return { seed: (seed ^ ((bestK * SEED_STRIDE) >>> 0)) >>> 0, kIndex: bestK };
}

/** Run N stochastic trials of `config`, each starting from a DIFFERENT index
 *  case, and return the per-trial per-capita curves (for percentile/fan-chart
 *  aggregation) instead of the mean.
 *
 *  Trial 0 keeps the default center patient zero, so an N=1 ensemble is exactly
 *  the deterministic single-trial curve. Trials k > 0 place patient zero at a
 *  cell drawn deterministically from the trial seed (a separate Rng — the
 *  engine's own PRNG trajectory is untouched), which both samples index-case
 *  location spread and desynchronizes the incubation generation waves.
 *  Deterministic: a pure function of (config, days, N, seed). */
export function runTrialEnsemble(
  config: SimConfig,
  days: number,
  N: number,
  seed: number,
  schedule?: number[],
): { perTrial: SimCurves[]; rNaught: number | null } {
  const cells = config.size * config.size;
  const len = days + 1;
  const topo = topologyFor(config, seed);
  const canReseed = config.reseedOnExtinction === true;
  let rNaught: number | null = null;
  const perTrial: SimCurves[] = [];

  for (let k = 0; k < N; k++) {
    const trialSeed = (seed ^ ((k * SEED_STRIDE) >>> 0)) >>> 0;
    // k = 0 → default center index case (matches runTrials trial 0 exactly);
    // k > 0 → a deterministic per-trial cell from a dedicated Rng.
    const indexCell = k === 0
      ? undefined
      : new Rng((trialSeed ^ 0x1dcae511) >>> 0).intRange(cells);
    const engine: AnyEngine = engineFor(
      { ...config, seed: trialSeed },
      topo,
      k === 0 ? { indexCell, txSchedule: schedule } : { rNaught, indexCell, txSchedule: schedule },
    );
    if (k === 0) rNaught = engine.rNaught;

    const inf = new Float64Array(len);
    const death = new Float64Array(len);
    const active = new Float64Array(len);
    const { state } = engine.buffers();
    let cumInf = 0;
    let act = 0;
    for (let i = 0; i < state.length; i++) {
      const s = state[i];
      if (s === CellState.Exposed) cumInf++;
      else if (s === CellState.Infectious) { cumInf++; act++; }
    }
    let cumDeath = 0;
    inf[0] = cumInf;
    active[0] = act;

    for (let d = 1; d <= days; d++) {
      const stats = engine.step();
      cumInf += stats.newInfections;
      cumDeath += stats.newDeaths;
      inf[d] = cumInf;
      death[d] = cumDeath;
      active[d] = stats.i;
      if (!canReseed && stats.e + stats.i === 0) {
        for (let f = d + 1; f <= days; f++) { inf[f] = cumInf; death[f] = cumDeath; }
        break;
      }
    }

    const inv = 1 / cells;
    perTrial.push({
      cumulative_infections: Array.from(inf, (v) => v * inv),
      cumulative_deaths: Array.from(death, (v) => v * inv),
      active_infections: Array.from(active, (v) => v * inv),
    });
  }
  return { perTrial, rNaught };
}
