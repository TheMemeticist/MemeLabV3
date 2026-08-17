// Shared headless-trial runner for the R₀ Estimator. Imported by both
// `fit.worker.ts` (production path) and the fit tests (in-process), so the two
// can never drift. Pure: constructs its own Engine instances and never touches
// any live simulation state.

import { Engine } from '../sim';
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
export function runTrials(config: SimConfig, days: number, K: number, seed: number): SimResult {
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
    // `engine.rNaught` and also feeds the constructor.
    const engine: Engine = new Engine(
      { ...config, seed: trialSeed },
      topo,
      k === 0 ? undefined : { rNaught },
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
