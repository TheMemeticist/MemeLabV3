// ─── R₀ Estimator — inverse parameter fitting core (pure, DOM-free) ──────────
//
// MemeLab runs the SEIRS model *forward*: pick strain genes, watch the curves.
// This module does the *inverse*: given an observed outbreak curve, search for
// the strain genes whose simulated curve best matches it, then report the
// implied basic reproduction number R₀.
//
// Everything here is pure computation with no DOM and no worker dependency:
//   • `FIT_PARAMS`        — the registry of fittable parameters (data-driven, so
//                           adding a new one is a single entry).
//   • `poissonNLL` / `mse`— loss functions comparing observed vs simulated.
//   • `analyticR0`        — closed-form R₀ from genes (ports the lattice branch
//                           of `Engine.estimateR0`).
//   • `optimize`          — derivative-free optimizer: coarse grid → Nelder–Mead.
//   • `runFit`            — orchestrator. Takes an injected `simulate` function
//                           (the worker pool in the app, an in-process Engine in
//                           tests) so the whole pipeline is unit-testable.
//   • `parseObservedCSV`  — tolerant `day,value,category` / TSV parser.
//
// The injected `simulate` boundary keeps the optimizer ignorant of where the
// sims run; the UI owns the observed data + loss so editing data or toggling the
// loss re-scores cached curves without re-simulating (same "pure derived
// overlay" discipline as the cost layer).

import type { GeometryType, InterventionEvent, InterventionKey, InterventionKeyframe, InterventionParamName, InterventionParams, InterventionSpec, InterventionTimelinePoint, SimConfig, StrainGenes } from '../types';
import { makeGeometry, torus } from '../sim/neighbors';
import { Rng } from '../sim/rng';
import { runGA } from './ga';

// ─── Observed data ───────────────────────────────────────────────────────────

export type FitCategory =
  | 'cumulative_infections'
  | 'cumulative_deaths'
  | 'active_infections';

export const FIT_CATEGORIES: FitCategory[] = [
  'cumulative_infections',
  'cumulative_deaths',
  'active_infections',
];

export const CATEGORY_LABELS: Record<FitCategory, string> = {
  cumulative_infections: 'Cumulative infections',
  cumulative_deaths: 'Cumulative deaths',
  active_infections: 'Active infections',
};

export interface ObservedPoint {
  day: number;
  value: number;
  category: FitCategory;
}

/** Per-capita SEIR curves (fractions in [0..1]), indexed by day (0..days). */
export type SimCurves = Record<FitCategory, number[]>;

/** What `simulate` returns: the averaged curves plus the engine's analytic R₀
 *  for the candidate (valid for every geometry, including voronoi/mean-field). */
export interface SimResult {
  curves: SimCurves;
  rNaught: number | null;
  /** Per-trial curves — present only for ensemble (fan-chart) simulations. */
  perTrial?: SimCurves[];
}

export type LossType = 'poisson' | 'mse';

/** How to read the R₀ confidence interval:
 *  - `interval`: a genuine 95% profile-likelihood interval `[lo, hi]`.
 *  - `exact`:    the data over-determines R₀ (noise-free / huge N) so the interval
 *                collapses — reported honestly rather than as a zero-width "CI".
 *  - `none`:     no interval available (R₀ unknown, or no R₀-driving param fitted). */
export type CIKind = 'interval' | 'exact' | 'none';

// ─── Fittable-parameter registry ─────────────────────────────────────────────
// Each entry maps a strain gene to a search dimension. `get`/`set` localize the
// SimConfig path so the optimizer can work on a plain number vector. Add a
// parameter by appending one entry — nothing else in this file changes.

export type FitParamName =
  | 'attackRate'
  | 'range'
  | 'incubation'
  | 'infectious'
  | 'ifr'
  // Synthetic search dimension (not a gene, not in FIT_PARAMS): the index-date
  // offset, evolved by the optimizer when FitRequest.offset is set.
  | 'indexOffset';

export interface FitParamDef {
  name: FitParamName;
  label: string;
  /** Search bounds [lo, hi]. */
  bounds: [number, number];
  /** Integer-valued dimension (rounded when written into the config). */
  integer?: boolean;
  /** Display the value as a percentage in the UI (bounds stay fractions internally). */
  display?: 'percent';
  /** Checked by default in the UI (the core 2-param fit). */
  core?: boolean;
  get(g: StrainGenes): number;
  set(g: StrainGenes, v: number): void;
}

export const FIT_PARAMS: FitParamDef[] = [
  {
    name: 'attackRate',
    label: 'Attack rate',
    bounds: [0.01, 0.99],
    display: 'percent',
    core: true,
    get: (g) => g.attackRate,
    set: (g, v) => { g.attackRate = clamp(v, 0, 1); },
  },
  {
    name: 'range',
    label: 'Transmission range',
    bounds: [1, 6],
    integer: true,
    core: true,
    get: (g) => g.range,
    set: (g, v) => { g.range = Math.max(1, Math.round(v)); },
  },
  {
    name: 'incubation',
    label: 'Incubation (days)',
    bounds: [1, 60],
    get: (g) => g.incubation,
    set: (g, v) => { g.incubation = Math.max(0, v); },
  },
  {
    name: 'infectious',
    label: 'Infectious (days)',
    bounds: [1, 60],
    get: (g) => g.infectious,
    set: (g, v) => { g.infectious = Math.max(0, v); },
  },
  {
    name: 'ifr',
    // Bounds expressed as fractions: 0.01% – 99.99%.
    label: 'Fatality rate (IFR)',
    bounds: [0.0001, 0.9999],
    display: 'percent',
    get: (g) => g.ifr,
    set: (g, v) => { g.ifr = clamp(v, 0, 1); },
  },
];

export function findFitParam(name: FitParamName): FitParamDef {
  const p = FIT_PARAMS.find((x) => x.name === name);
  if (!p) throw new Error(`unknown fit param: ${name}`);
  return p;
}

// ─── Loss functions ──────────────────────────────────────────────────────────
// Observed values are raw counts; simulated curves are per-capita fractions, so
// we rescale by the user-supplied population N before comparing. Poisson NLL is
// the default — it is the right likelihood for count data and naturally weights
// categories on different scales. MSE is offered as a plain-least-squares toggle.

const EPS = 1e-9;

/** Negative log-likelihood under a Poisson observation model (constant ln(k!)
 *  dropped — it doesn't affect the argmin and keeps the number readable). */
export function poissonNLL(observed: ObservedPoint[], curves: SimCurves, N: number): number {
  let total = 0;
  for (const pt of observed) {
    const lambda = Math.max(sampleCurve(curves, pt.category, pt.day) * N, EPS);
    total += lambda - pt.value * Math.log(lambda);
  }
  return total;
}

export function mse(observed: ObservedPoint[], curves: SimCurves, N: number): number {
  if (observed.length === 0) return 0;
  let total = 0;
  for (const pt of observed) {
    const sim = sampleCurve(curves, pt.category, pt.day) * N;
    const d = sim - pt.value;
    total += d * d;
  }
  return total / observed.length;
}

export function lossOf(
  observed: ObservedPoint[],
  curves: SimCurves,
  N: number,
  type: LossType,
): number {
  return type === 'poisson' ? poissonNLL(observed, curves, N) : mse(observed, curves, N);
}

/** Reads a per-capita curve at an observed day, clamped to the simulated range. */
function sampleCurve(curves: SimCurves, cat: FitCategory, day: number): number {
  const c = curves[cat];
  if (!c || c.length === 0) return 0;
  const d = Math.max(0, Math.min(Math.round(day), c.length - 1));
  return c[d];
}

// ─── Goodness of fit ─────────────────────────────────────────────────────────

export interface GoodnessOfFit {
  rmse: number;
  r2: number;
}

export function goodnessOfFit(observed: ObservedPoint[], curves: SimCurves, N: number): GoodnessOfFit {
  const n = observed.length;
  if (n === 0) return { rmse: 0, r2: 1 };
  let ssRes = 0;
  let sumObs = 0;
  for (const pt of observed) {
    const sim = sampleCurve(curves, pt.category, pt.day) * N;
    const d = sim - pt.value;
    ssRes += d * d;
    sumObs += pt.value;
  }
  const meanObs = sumObs / n;
  let ssTot = 0;
  for (const pt of observed) {
    const d = pt.value - meanObs;
    ssTot += d * d;
  }
  return {
    rmse: Math.sqrt(ssRes / n),
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
  };
}

// ─── Analytic R₀ ─────────────────────────────────────────────────────────────
// Closed-form basic reproduction number from the genes — the expected number of
// secondary cases one infectious cell causes in a fully susceptible
// neighbourhood. Ports the lattice branch of `Engine.estimateR0`: the reachable
// neighbour count at the strain's range times the per-contact probability that a
// contact is ever successfully infected over the infectious window.
//
//   R₀ = |reachable(range)| × (1 − (1 − attackRate)^infectiousDays)
//
// Voronoi/mean-field are topology-/mixing-specific and return null here (the UI
// shows "—"); the fit itself still runs for those geometries.

export function analyticR0(
  genes: StrainGenes,
  geometry: GeometryType = 'square',
  size = 80,
): number | null {
  const days = genes.infectious;
  if (days <= 0) return 0;
  const p = clamp(genes.attackRate, 0, 1);
  const pInfected = 1 - Math.pow(1 - p, days);

  if (geometry === 'meanfield') return 2 * pInfected; // k = 2 matches stepMeanField
  if (geometry === 'voronoi') return null;

  // Mirror Engine.estimateR0: cap the probe grid at 80 so a torus the same size
  // as the neighbourhood doesn't double-count wrapped cells.
  const s = Math.min(Math.max(8, size), 80);
  const cx = s >> 1;
  const cy = s >> 1;
  const geo = makeGeometry(geometry);
  const offsets = geo.getOffsets(Math.max(1, Math.round(genes.range)), cx, cy);
  const reachable = new Set<number>();
  for (let k = 0; k < offsets.length; k += 2) {
    const nx = torus(cx + offsets[k], s);
    const ny = torus(cy + offsets[k + 1], s);
    const j = ny * s + nx;
    if (j !== cy * s + cx) reachable.add(j);
  }
  return reachable.size * pInfected;
}

// ─── Optimizer ───────────────────────────────────────────────────────────────
// Three derivative-free, pool-parallel stages:
//   1. A seeded Latin-hypercube sample fills the parameter box with `budget`
//      candidates — space-filling and, crucially, independent of dimensionality.
//      (A full-factorial grid is `gridSteps^dims`, which explodes past 2–3 genes.)
//   2. Successive-halving races those candidates on *trial count*: screen them all
//      at a few stochastic trials, keep the top `1/eta`, re-run the survivors at
//      `eta×` the trials, repeat to full fidelity. Common random numbers (shared
//      trial seeds across candidates, see fit-sim.ts) keep low-trial ranking
//      faithful, so the optimum is rarely screened out — and the bulk of the eval
//      budget never gets spent on hopeless candidates.
//   3. Multi-start Nelder–Mead refines the top survivors concurrently, so the
//      worker pool stays saturated instead of idling behind one serial simplex.
// The objective `evaluate(values, K)` is injected and takes the trial count, so
// the optimizer is agnostic about where sims run; the pool memoizes by (genes, K).

export interface GridSample {
  values: number[];
  loss: number;
}

export interface OptimizeResult {
  best: GridSample;
  evaluations: number;
}

export interface OptimizeOptions {
  params: FitParamDef[];
  /** Objective at a chosen trial count K. Called at escalating K by the racing
   *  stage and at `Kfull` by the refine; the injected pool memoizes by (genes,K). */
  evaluate: (values: number[], K: number) => Promise<number>;
  /** Full-fidelity trial count (final racing rung + Nelder–Mead refine). */
  Kfull: number;
  /** Quasi-random sampling budget. Defaults to 16·dims (min 16). */
  budget?: number;
  /** Successive-halving: starting trials per candidate and reduction factor. */
  K0?: number;
  eta?: number;
  /** Nelder–Mead iterations per simplex. */
  nmIters?: number;
  /** Independent NM restarts (top survivors), run concurrently. */
  restarts?: number;
  /** Seed for the deterministic Latin-hypercube sampler. */
  seed: number;
  onProgress?: (done: number, total: number) => void;
  signal?: { aborted: boolean };
}

export async function optimize(opts: OptimizeOptions): Promise<OptimizeResult> {
  const { params, evaluate, Kfull } = opts;
  const dims = params.length;
  const budget = Math.max(16, opts.budget ?? 16 * dims);
  // Screen at a *reliable* trial count, not a noisy handful. Successive-halving
  // assumes low-fidelity ranking is faithful, but high-variance objectives (e.g.
  // Voronoi "settlements", where hub ignition is near-bimodal) can make a good
  // candidate look terrible in 3–4 trials and get wrongly culled. Screening at
  // ~half the full trials (min 8) keeps ranking trustworthy; the speedup then comes
  // from not spending *full* trials on the clearly-bad tail (largest at high budget
  // / dimensionality), not from shrinking the screen itself.
  const K0 = Math.max(1, Math.min(opts.K0 ?? Math.max(8, Math.round(Kfull / 2)), Kfull));
  const eta = Math.max(2, opts.eta ?? 2);
  // 24 simplex iterations is plenty on a noisy stochastic objective — past that NM
  // mostly chases sampling noise — and it's the dominant per-fit cost, so keeping it
  // tight matters more than the (already cheap) screening.
  const nmIters = opts.nmIters ?? 24;
  const restarts = Math.max(1, opts.restarts ?? 3);

  // Approximate eval budget for the progress bar (over-counting is harmless).
  const total = budget * 2 + restarts * nmIters + 1;
  let done = 0;
  const tick = () => { done++; opts.onProgress?.(Math.min(done, total), total); };

  // ── 1. Initial candidate set ──
  const rng = new Rng((opts.seed ^ 0xf17f17f1) >>> 0);
  const candidates = sampleCandidates(params, budget, rng);

  // ── 2. Successive-halving on trial count ──
  const survivors = await successiveHalving(
    candidates, evaluate, K0, eta, Kfull, restarts, opts.signal, tick,
  );
  if (opts.signal?.aborted || survivors.length === 0) {
    const best = survivors[0] ?? { values: candidates[0], loss: Number.POSITIVE_INFINITY };
    return { best, evaluations: done };
  }

  // ── 3. Multi-start Nelder–Mead refine (concurrent → pool stays busy) ──
  const refineEval = (v: number[]) => evaluate(v, Kfull);
  const refined = await Promise.all(
    survivors.map((s) => nelderMead(s, params, refineEval, nmIters, opts.signal, tick)),
  );
  const best = refined.reduce((a, b) => (b.loss < a.loss ? b : a), survivors[0]);

  return { best, evaluations: done };
}

// Pick the initial candidate set. For 1–3 genes a full-factorial grid is both cheap
// and *exhaustive* — it guarantees joint coverage of narrow basins (e.g. low attack
// rate × range 1) that a sparse, randomly-paired Latin-hypercube can miss entirely,
// which would strand the racing + local refine in a worse optimum. Past 3 genes the
// grid is `steps^dims` and explodes, so we switch to a space-filling LHS of the same
// budget — the dimensionality where LHS's scaling earns its slightly weaker coverage.
function sampleCandidates(params: FitParamDef[], budget: number, rng: Rng): number[][] {
  if (params.length <= 3) {
    const steps = Math.max(2, Math.round(Math.pow(budget, 1 / params.length)));
    return gridCandidates(params, steps);
  }
  return latinHypercube(params, budget, rng);
}

// Full-factorial grid: a per-axis set of `steps` evenly-spaced values (integer axes
// enumerate their distinct integers, capped at `steps`), then the Cartesian product.
function gridCandidates(params: FitParamDef[], steps: number): number[][] {
  const axes = params.map((p) => {
    const [lo, hi] = p.bounds;
    if (p.integer) {
      const a = Math.round(lo);
      const span = Math.round(hi) - a;
      const count = Math.min(span + 1, Math.max(2, steps));
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(Math.round(a + (span * i) / (count - 1)));
      return Array.from(new Set(out));
    }
    if (steps <= 1) return [(lo + hi) / 2];
    const out: number[] = [];
    for (let i = 0; i < steps; i++) out.push(lo + ((hi - lo) * i) / (steps - 1));
    return out;
  });
  return axes.reduce<number[][]>(
    (acc, axis) => acc.flatMap((combo) => axis.map((v) => [...combo, v])),
    [[]],
  );
}

// Latin-hypercube sample over the parameter box: stratify each axis into `n` equal
// bins, draw one jittered point per bin, then shuffle the per-axis columns
// independently so the strata recombine without correlation. Integer axes are
// rounded (small ranges yield repeats, which the pool cache dedupes for free).
export function latinHypercube(params: FitParamDef[], n: number, rng: Rng): number[][] {
  const cols = params.map((p) => {
    const col: number[] = [];
    const [lo, hi] = p.bounds;
    for (let i = 0; i < n; i++) {
      const u = (i + rng.random()) / n; // stratified jitter in [0,1)
      const v = lo + u * (hi - lo);
      col.push(p.integer ? Math.round(v) : v);
    }
    for (let i = n - 1; i > 0; i--) {
      const j = rng.intRange(i + 1);
      const t = col[i]; col[i] = col[j]; col[j] = t;
    }
    return col;
  });
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push(cols.map((c) => c[i]));
  return out;
}

// Successive-halving (Hyperband's inner loop): evaluate the whole pool at the
// current trial count, sort by loss, keep the top `1/eta` (never below
// `keepFinal`), bump the trial count by `eta`, repeat until the survivors have
// been scored at full fidelity. Returns the `keepFinal` best, each scored at Kfull.
async function successiveHalving(
  candidates: number[][],
  evaluate: (v: number[], K: number) => Promise<number>,
  K0: number,
  eta: number,
  Kfull: number,
  keepFinal: number,
  signal: { aborted: boolean } | undefined,
  tick: () => void,
): Promise<GridSample[]> {
  let pool: GridSample[] = candidates.map((values) => ({ values, loss: Number.POSITIVE_INFINITY }));
  let K = Math.min(K0, Kfull);

  for (;;) {
    if (signal?.aborted) break;
    const losses = await Promise.all(
      pool.map(async (c) => {
        if (signal?.aborted) return Number.POSITIVE_INFINITY;
        const loss = await evaluate(c.values, K);
        tick();
        return loss;
      }),
    );
    pool.forEach((c, i) => { c.loss = losses[i]; });
    pool.sort((a, b) => a.loss - b.loss);

    if (K >= Kfull) break; // survivors now scored at full fidelity
    const nextN = Math.max(keepFinal, Math.ceil(pool.length / eta));
    if (nextN >= pool.length) {
      // Can't shrink further without dropping below keepFinal — jump to full K.
      pool = pool.slice(0, nextN);
      K = Kfull;
    } else {
      pool = pool.slice(0, nextN);
      K = Math.min(Kfull, K * eta);
    }
  }
  return pool.slice(0, keepFinal);
}

async function nelderMead(
  start: GridSample,
  params: FitParamDef[],
  evaluate: (values: number[]) => Promise<number>,
  maxIters: number,
  signal: { aborted: boolean } | undefined,
  tick: () => void,
): Promise<GridSample> {
  const n = params.length;
  const lo = params.map((p) => p.bounds[0]);
  const hi = params.map((p) => p.bounds[1]);
  const clampVec = (v: number[]) => v.map((x, i) => clamp(x, lo[i], hi[i]));

  const f = async (v: number[]): Promise<number> => {
    const loss = await evaluate(clampVec(v));
    return loss;
  };

  // Initial simplex: best vertex plus a per-axis step of 12% of the range.
  const simplex: number[][] = [start.values.slice()];
  for (let i = 0; i < n; i++) {
    const v = start.values.slice();
    const step = (hi[i] - lo[i]) * 0.12 || 0.1;
    v[i] = clamp(v[i] + step, lo[i], hi[i]);
    simplex.push(v);
  }
  let fvals = await Promise.all(simplex.map(f));
  simplex.forEach(tick);

  const alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;
  for (let iter = 0; iter < maxIters; iter++) {
    if (signal?.aborted) break;
    // Order by loss.
    const order = fvals.map((_, i) => i).sort((a, b) => fvals[a] - fvals[b]);
    const ordered = order.map((i) => simplex[i]);
    const ofvals = order.map((i) => fvals[i]);
    simplex.splice(0, simplex.length, ...ordered);
    fvals = ofvals;

    // Centroid of all but the worst.
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

    const worst = simplex[n];
    const reflect = centroid.map((c, j) => c + alpha * (c - worst[j]));
    const fr = await f(reflect); tick();

    if (fr < fvals[0]) {
      // Expand.
      const expand = centroid.map((c, j) => c + gamma * (reflect[j] - c));
      const fe = await f(expand); tick();
      if (fe < fr) { simplex[n] = clampVec(expand); fvals[n] = fe; }
      else { simplex[n] = clampVec(reflect); fvals[n] = fr; }
    } else if (fr < fvals[n - 1]) {
      simplex[n] = clampVec(reflect); fvals[n] = fr;
    } else {
      // Contract.
      const contract = centroid.map((c, j) => c + rho * (worst[j] - c));
      const fc = await f(contract); tick();
      if (fc < fvals[n]) { simplex[n] = clampVec(contract); fvals[n] = fc; }
      else {
        // Shrink toward the best vertex.
        for (let i = 1; i <= n; i++) {
          simplex[i] = clampVec(simplex[0].map((b, j) => b + sigma * (simplex[i][j] - b)));
          fvals[i] = await f(simplex[i]); tick();
        }
      }
    }
  }

  let bi = 0;
  for (let i = 1; i < fvals.length; i++) if (fvals[i] < fvals[bi]) bi = i;
  return { values: clampVec(simplex[bi]), loss: fvals[bi] };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface FitOptions {
  /** Full-fidelity stochastic trials per candidate (final racing rung, refine, and
   *  CI sweep). The racing stage screens most candidates at far fewer (see `K0`). */
  K: number;
  loss: LossType;
  /** Real-world population the observed counts are drawn from. */
  population: number;
  /** Quasi-random sampling budget (default 16·#params). */
  budget?: number;
  /** Successive-halving starting trials + reduction factor (defaults 4, 3). */
  K0?: number;
  eta?: number;
  nmIters?: number;
  /** Nelder–Mead restarts from the top survivors (default 3). */
  restarts?: number;
  /** Search strategy: `local` (grid/LHS → Nelder–Mead) or `genetic` (population
   *  GA — global, robust on rugged/multimodal surfaces). Defaults to `local` in the
   *  core; the UI defaults to `genetic`. */
  optimizer?: 'local' | 'genetic';
  /** GA knobs (only used when optimizer === 'genetic'; sensible defaults in runGA). */
  gaPopulation?: number;
  gaGenerations?: number;
  gaMutationRate?: number;
  gaCrossoverRate?: number;
  gaElitism?: number;
  gaTournament?: number;
}

/** Best-so-far snapshot streamed during a fit so the UI can animate convergence.
 *  `provisional` marks snapshots from low-fidelity (K < Kfull) screening rungs /
 *  early GA generations: they animate the search in real time but their losses
 *  are noisier and not comparable to full-fidelity ones. */
export interface FitProgress {
  values: number[];
  curves: SimCurves;
  loss: number;
  r0: number | null;
  provisional: boolean;
  /** The candidate's index-date offset (0 when the offset isn't evolved) — lets
   *  the live chart slide the model line to align with the raw-day data dots. */
  indexOffset: number;
}

/** Profile-likelihood interval over the index-date offset. Calibrated via the
 *  2·ln(L_max/L) ≤ χ²₁ rule (3.84 → 95%, 1.0 → ≈68%) — legitimate because the
 *  Poisson NLL is a proper likelihood. This is the cheap frequentist analogue
 *  of a posterior; NOT the fan chart's ensemble percentile bands. */
export interface OffsetCI {
  ci95: [number, number];
  ci68: [number, number];
  /** The profile mode — always equals the reported point estimate. */
  mode: number;
}

export interface FitRequest extends FitOptions {
  observed: ObservedPoint[];
  baseConfig: SimConfig;
  params: FitParamDef[];
  /** Evolve the index-date offset (days of outbreak head start before the
   *  observed days) as an extra bounded integer search dimension. The offset
   *  shifts the loss's day mapping only — never the SimConfig — so same-gene
   *  candidates at different offsets share one memoized sim. */
  offset?: { bounds: [number, number] };
  /** Project this many days beyond the data's last day: the sim horizon (and
   *  therefore every returned curve) extends past the observations. */
  extraDays?: number;
  /** Post-fit Bayesian posterior-predictive band: a seeded Metropolis chain
   *  over the fitted parameters (flat priors within their bounds), each draw's
   *  curve simulated (pool-memoized), percentiles across draws. Heavier than
   *  the live path — runs once, after the optimum lands. */
  posterior?: { draws?: number; burn?: number };
  /** Active interventions (time-varying transmission R(t)). Every simulation
   *  in the fit runs under the resulting per-tick schedule; with an evolved
   *  index offset the schedule shifts per candidate (the pool cache keys on
   *  the schedule, so this is safe — but it does mean offsets no longer share
   *  one sim while interventions are active). */
  interventions?: InterventionSpec[];
  /** Runs K trials of `config` for `days` days and returns mean per-capita curves
   *  plus the candidate's analytic R₀. `schedule` is the per-tick transmission
   *  multiplier (interventions); implementations may ignore it only if the
   *  caller never passes `interventions`. */
  simulate: (config: SimConfig, days: number, K: number, seed: number, schedule?: number[]) => Promise<SimResult>;
  onProgress?: (frac: number) => void;
  /** Fires whenever a new global-best candidate is found, so the UI can redraw
   *  the overlaid curves live as the optimizer converges. */
  onImprove?: (progress: FitProgress) => void;
  signal?: { aborted: boolean };
}

export interface FittedParam {
  name: FitParamName;
  label: string;
  value: number;
}

export interface FitResult {
  params: FittedParam[];
  r0: number | null;
  r0CI: [number, number] | null;
  /** How to read `r0CI` — a real interval, an over-determined point, or absent. */
  r0CIKind: CIKind;
  gof: GoodnessOfFit;
  loss: number;
  days: number;
  population: number;
  observed: ObservedPoint[];
  simulated: SimCurves;
  /** The fully-resolved best-fit config (genes applied), ready to apply to the sim. */
  config: SimConfig;
  /** Evolved index-date offset (days), present when FitRequest.offset was set.
   *  `observed` is already shifted by it. */
  indexOffset?: number;
  /** Profile-likelihood CI for the index date (null when not evolved). */
  offsetCI?: OffsetCI | null;
  /** Bayesian posterior-predictive band per category: three per-capita rows —
   *  LOW (5th), CENTRAL (50th), HIGH (95th percentile across posterior draws).
   *  Parameter-uncertainty propagation (calibrated), distinct from the
   *  index-date profile-likelihood CI. Null when not requested/aborted. */
  bayes?: Record<FitCategory, number[][]> | null;
}

/** Posterior-predictive band percentiles: LOW / CENTRAL / HIGH. */
export const BAND_PROBS = [5, 50, 95];
export const BAND_CENTRAL = 1; // index of the central row in BAND_PROBS order

export async function runFit(req: FitRequest): Promise<FitResult> {
  const maxObsDay = Math.max(1, ...req.observed.map((p) => Math.round(p.day)));
  // With an evolved index offset the sim horizon must cover the data at the
  // largest candidate shift; without one this reduces to the old fixed horizon.
  const offLo = req.offset ? Math.max(0, Math.round(req.offset.bounds[0])) : 0;
  const offHi = req.offset ? Math.max(offLo, Math.round(req.offset.bounds[1])) : 0;
  const extraDays = Math.max(0, Math.round(req.extraDays ?? 0));
  const days = maxObsDay + offHi + extraDays;
  const baseSeed = req.baseConfig.seed;

  // The searched vector = the gene params plus (optionally) the index-date
  // offset as a final integer dimension. The offset never touches the
  // SimConfig — it only shifts the loss's day mapping — so the pool's
  // (genes, K) memo makes same-gene candidates at different offsets free:
  // one sim, many losses.
  const offsetDef: FitParamDef | null = req.offset
    ? {
        name: 'indexOffset',
        label: 'Index-date offset',
        bounds: [offLo, offHi],
        integer: true,
        get: () => 0,
        set: () => { /* not a gene — applied in the loss day mapping */ },
      }
    : null;
  const allParams = offsetDef ? [...req.params, offsetDef] : req.params;
  const offsetOf = (values: number[]): number =>
    offsetDef ? clamp(Math.round(values[req.params.length]), offLo, offHi) : 0;
  const shiftPts = (pts: ObservedPoint[], o: number): ObservedPoint[] =>
    o ? pts.map((p) => ({ ...p, day: p.day + o })) : pts;

  const configFor = (values: number[]): SimConfig => {
    const cfg = structuredClone(req.baseConfig);
    req.params.forEach((p, i) => p.set(cfg.strain, values[i]));
    return cfg;
  };

  // One sim of a candidate at `K` trials, yielding the loss, the engine's R₀, and
  // the curves. The pool memoizes by (genes, K), so the racing rungs, the refine,
  // the final best, and the CI sweeps all share results for free.
  // Intervention schedules depend only on the candidate's offset (integer),
  // so memoize per offset instead of rebuilding per eval.
  const schedCache = new Map<number, number[] | undefined>();
  const schedFor = (o: number): number[] | undefined => {
    if (!req.interventions?.length) return undefined;
    if (!schedCache.has(o)) schedCache.set(o, transmissionSchedule(req.interventions, days + 1, o));
    return schedCache.get(o);
  };

  const EMPTY_EVAL = {
    loss: Number.POSITIVE_INFINITY,
    r0: null as number | null,
    result: { curves: { cumulative_infections: [], cumulative_deaths: [], active_infections: [] }, rNaught: null } as SimResult,
  };
  const evalAt = async (
    values: number[],
    K: number,
  ): Promise<{ loss: number; r0: number | null; result: SimResult }> => {
    // Cancel must be instant at EVERY await: after cancelAll respawns the pool,
    // a fresh simulate would run for real — so never issue one once aborted.
    if (req.signal?.aborted) return EMPTY_EVAL;
    try {
      const result = await req.simulate(configFor(values), days, K, baseSeed, schedFor(offsetOf(values)));
      const shifted = shiftPts(req.observed, offsetOf(values));
      return { loss: lossOf(shifted, result.curves, req.population, req.loss), r0: result.rNaught, result };
    } catch (err) {
      // A cancelled pool rejects every pending sim so nothing awaits a message
      // that will never arrive — swallow those into +Inf losses and let the
      // optimizer wind down instantly. Real errors still propagate.
      if (req.signal?.aborted) return EMPTY_EVAL;
      throw err;
    }
  };

  // Stream the best-so-far to the UI. Full-fidelity (Kfull) improvements gate
  // `bestLoss` and are the authoritative overlay — losses from low-trial racing
  // rungs are noisier and not comparable across rungs, so feeding them into the
  // same gate would let a lucky low-K candidate pin it and freeze the overlay.
  // Low-fidelity evals stream too (marked `provisional`, gated per-K) so the
  // chart animates from the very first generation instead of sitting static
  // until the first full-fidelity eval. Display only — the returned result is
  // untouched.
  let bestLoss = Number.POSITIVE_INFINITY;
  const reportIfBetter = (loss: number, values: number[], result: SimResult, r0: number | null): void => {
    if (!req.onImprove || !Number.isFinite(loss) || loss >= bestLoss) return;
    bestLoss = loss;
    req.onImprove({ values: values.slice(), curves: result.curves, loss, r0, provisional: false, indexOffset: offsetOf(values) });
  };

  // Provisional (low-K) best, tracked per trial count: comparisons are only
  // valid between losses computed at the same K.
  let provisionalK = -1;
  let provisionalLoss = Number.POSITIVE_INFINITY;
  const reportProvisional = (K: number, loss: number, values: number[], result: SimResult, r0: number | null): void => {
    if (!req.onImprove || !Number.isFinite(loss)) return;
    if (K !== provisionalK) { provisionalK = K; provisionalLoss = Number.POSITIVE_INFINITY; }
    if (loss >= provisionalLoss) return;
    provisionalLoss = loss;
    // Once a full-fidelity best exists, stop streaming noisier low-K frames
    // over it — the authoritative overlay has taken over.
    if (bestLoss < Number.POSITIVE_INFINITY) return;
    req.onImprove({ values: values.slice(), curves: result.curves, loss, r0, provisional: true, indexOffset: offsetOf(values) });
  };

  const evaluate = async (values: number[], K: number): Promise<number> => {
    if (req.signal?.aborted) return Number.POSITIVE_INFINITY;
    const { loss, r0, result } = await evalAt(values, K);
    if (K >= req.K) reportIfBetter(loss, values, result, r0);
    else reportProvisional(K, loss, values, result, r0);
    return loss;
  };

  // ── Unified, monotonic fit-wide progress (fixes the bar freezing at ~32%) ──
  // The optimizer reports its own (done, total), but GA patience can stop early
  // (done ≪ total) and the post-fit stages (profile-CI grid, MCMC chain, Bayes
  // draws, final re-eval) previously never ticked at all. Track one fraction:
  // optimizer stage + exactly-counted post stages; when a stage ends early its
  // allocation completes (an honest "stage done" jump), never regresses.
  const postDraws = req.posterior ? Math.max(10, Math.round(req.posterior.draws ?? 120)) : 0;
  // Burn-in doubles as step-scale adaptation; sharp likelihoods need several
  // shrink windows (10 iters each) before the chain mixes, so don't skimp.
  const postBurn = req.posterior ? Math.max(40, Math.round(req.posterior.burn ?? Math.ceil(postDraws * 0.5))) : 0;
  const postTotal = (offsetDef ? offHi - offLo + 1 : 0) + (postDraws + postBurn) + postDraws + 1;
  let optT = 0;
  let optDone = 0;
  let postDone = 0;
  let lastFrac = 0;
  const report = (): void => {
    const frac = (optDone + postDone) / ((optT || 1) + postTotal);
    if (frac > lastFrac) { lastFrac = frac; req.onProgress?.(Math.min(1, frac)); }
  };
  const postTick = (): void => { postDone = Math.min(postDone + 1, postTotal); report(); };
  const onProgress = (d: number, t: number): void => {
    optT = Math.max(optT, t);
    optDone = Math.min(Math.max(optDone, d), optT);
    report();
  };
  const opt = req.optimizer === 'genetic'
    ? await runGA({
        params: allParams,
        evaluate,
        Kfull: req.K,
        K0: req.K0,
        seed: baseSeed,
        population: req.gaPopulation,
        generations: req.gaGenerations,
        mutationRate: req.gaMutationRate,
        crossoverRate: req.gaCrossoverRate,
        elitism: req.gaElitism,
        tournament: req.gaTournament,
        signal: req.signal,
        onProgress,
      })
    : await optimize({
        params: allParams,
        evaluate,
        Kfull: req.K,
        budget: req.budget,
        K0: req.K0,
        eta: req.eta,
        nmIters: req.nmIters,
        restarts: req.restarts,
        seed: baseSeed,
        signal: req.signal,
        onProgress,
      });

  // Optimizer stage complete (possibly early via GA patience) — fill its bar
  // allocation so the post stages continue from there instead of ~32%.
  optDone = optT;
  report();

  const bestValues = opt.best.values.slice();
  let bestLossFinal = opt.best.loss;

  // ── Profile-likelihood CI over the index date (the "cheap posterior") ──
  // 1D integer grid over the offset bounds with the genes held at their best.
  // The genes don't change, so the sim is one pool cache hit and every grid
  // point is just a loss re-scoring — a handful of milliseconds, deterministic.
  let offsetCI: OffsetCI | null = null;
  if (offsetDef && !req.signal?.aborted) {
    const profile: { offset: number; loss: number }[] = [];
    for (let o = offLo; o <= offHi; o++) {
      if (req.signal?.aborted) break; // cancel mid-grid, not at the stage boundary
      const v = bestValues.slice();
      v[req.params.length] = o;
      const { loss } = await evalAt(v, req.K);
      profile.push({ offset: o, loss });
      postTick();
    }
    if (req.signal?.aborted || profile.length === 0) {
      // Cancelled mid-grid — skip the CI rather than reading a partial profile.
    } else {
      let mi = 0;
      for (let i = 1; i < profile.length; i++) if (profile[i].loss < profile[mi].loss) mi = i;
      // Adopt the profile mode as the point estimate: a strict deterministic
      // improvement when the joint search landed a day off, and it guarantees
      // the reported offset IS the mode of the profile the CI is read from.
      if (profile[mi].loss < bestLossFinal) {
        bestValues[req.params.length] = profile[mi].offset;
        bestLossFinal = profile[mi].loss;
      }
      offsetCI = profileOffsetCI(profile, mi, req.loss, req.observed.length);
    }
  }

  // ── Bayesian posterior-predictive band (post-fit, seeded, deterministic) ──
  // Metropolis over ALL fitted dimensions (flat priors within bounds) started
  // at the MAP; each retained draw's mean curve comes from the pool (memoized —
  // repeated/quantized draws are free), then per-day 5/50/95 percentiles across
  // draws. Parameter-uncertainty propagation: calibrated, unlike the raw
  // index-case ensemble percentiles this replaces for the FINAL band. The live
  // streaming path stays the cheap one.
  let bayes: Record<FitCategory, number[][]> | null = null;
  if (req.posterior && !req.signal?.aborted) {
    // (postDraws/postBurn hoisted above for the progress accounting; burn-in
    // doubles as the step-adaptation phase.)
    const chain = await metropolisChain(
      async (v) => (await evalAt(v, req.K)).loss,
      bestValues,
      allParams,
      (baseSeed ^ 0x0ba7e5ea) >>> 0,
      postDraws + postBurn,
      postBurn,
      req.loss,
      req.observed.length,
      req.signal,
      postTick,
    );
    const drawCurves: SimCurves[] = [];
    for (const v of chain) {
      if (req.signal?.aborted) break;
      const { result } = await evalAt(v, req.K);
      if (result.curves.cumulative_infections.length) drawCurves.push(result.curves);
      postTick();
    }
    if (drawCurves.length && !req.signal?.aborted) bayes = percentileBands(drawCurves, BAND_PROBS);
  }

  const bestConfig = configFor(bestValues);
  const best = await evalAt(bestValues, req.K); // cache hit
  postDone = postTotal; // final re-eval — the bar completes at 100%
  report();
  const bestOffset = offsetOf(bestValues);
  const shiftedObserved = shiftPts(req.observed, bestOffset);
  const ciEval = (values: number[]) => evalAt(values, req.K).then((r) => ({ loss: r.loss, r0: r.r0 }));
  const { ci: r0CI, kind: r0CIKind } = await profileR0CI({ values: bestValues, loss: bestLossFinal }, req, ciEval);

  return {
    params: req.params.map((p, i) => ({
      name: p.name,
      label: p.label,
      value: p.integer ? Math.round(bestValues[i]) : bestValues[i],
    })),
    // R₀ from the engine's own estimate — correct for every geometry, and
    // consistent with the topbar readout (no separate analytic formula).
    r0: best.r0,
    r0CI,
    r0CIKind,
    gof: goodnessOfFit(shiftedObserved, best.result.curves, req.population),
    loss: bestLossFinal,
    days,
    population: req.population,
    observed: shiftedObserved,
    simulated: best.result.curves,
    config: bestConfig,
    indexOffset: offsetDef ? bestOffset : undefined,
    offsetCI,
    bayes,
  };
}

/** Seeded random-walk Metropolis over the fit parameters, flat priors within
 *  their bounds. Works in DEVIANCE units so both loss types are handled (for
 *  Poisson NLL the deviance is the NLL itself, so the acceptance ratio is the
 *  exact likelihood ratio; for MSE it is the Gaussian profile approximation).
 *  Integer dimensions propose in whole steps; everything clamps to bounds.
 *  Deterministic: a pure function of (nll, start, params, seed, iters, burn).
 *  Returns the retained draws (post burn-in). */
export async function metropolisChain(
  nll: (values: number[]) => Promise<number> | number,
  start: number[],
  params: FitParamDef[],
  seed: number,
  iters: number,
  burn: number,
  lossType: LossType = 'poisson',
  nObs = 1,
  signal?: { aborted: boolean },
  onStep?: () => void,
): Promise<number[][]> {
  const rng = new Rng((seed ^ 0x6d636d63) >>> 0);
  const lo = params.map((p) => p.bounds[0]);
  const hi = params.map((p) => p.bounds[1]);
  const step = params.map((p, i) => {
    const s = 0.08 * (hi[i] - lo[i]);
    return p.integer ? Math.max(1, s) : s;
  });
  const decode = (v: number[]): number[] =>
    v.map((x, i) => clamp(params[i].integer ? Math.round(x) : x, lo[i], hi[i]));

  let cur = decode(start.slice());
  let curDev = deviance(await nll(cur), lossType, nObs);
  const draws: number[][] = [];
  // Deterministic step adaptation DURING BURN-IN ONLY (frozen afterwards, so
  // the retained draws satisfy detailed balance): a sharp likelihood (large
  // counts) needs far smaller proposals than 8% of the bounds, or nothing is
  // ever accepted and the band collapses to the MAP. Target ≈ 20–45% acceptance.
  let accepted = 0;
  let window = 0;
  for (let it = 0; it < iters; it++) {
    if (signal?.aborted) break; // cancel mid-chain — return the draws so far
    const prop = decode(cur.map((x, i) => x + rng.gaussian() * step[i]));
    const propDev = deviance(await nll(prop), lossType, nObs);
    // Accept with probability exp(devCur − devProp) — the likelihood ratio.
    if (Math.log(Math.max(rng.random(), 1e-12)) < curDev - propDev) {
      cur = prop;
      curDev = propDev;
      accepted++;
    }
    window++;
    if (it < burn && window === 10) {
      const rate = accepted / window;
      // Razor-sharp likelihoods (many large Poisson counts) reject EVERY move
      // at the initial 8%-of-bounds scale — without an aggressive shrink the
      // chain never mixes and the posterior band collapses to zero width.
      // Shrink hard (×0.25) while acceptance is zero, gently (×0.5/×1.4)
      // around the ~30% target otherwise; frozen after burn-in.
      const f = rate === 0 ? 0.25 : rate < 0.15 ? 0.5 : rate > 0.45 ? 1.4 : 1;
      if (f !== 1) for (let i = 0; i < step.length; i++) step[i] *= f;
      accepted = 0;
      window = 0;
    }
    if (it >= burn) draws.push(cur.slice());
    onStep?.();
  }
  return draws;
}

/** Default underreporting keyframes for the current-outbreak Ebola preset
 *  ('ebola-rev'), from the user's sitrep-phase tables (ranges → midpoints; all
 *  ≥ 1 so floor ≤ central ≤ upper). Day −8 = first confirmed case (before the
 *  data), day 110 = projected asymptote (beyond the data) — the keyframe
 *  interpolation clamps outside its ends. Editable defaults, not fixed. */
export const EBOLA_ADJUST: { t0: number; cases: Keyframe[]; deaths: Keyframe[] } = {
  t0: -8,
  cases: [
    { day: -8, m: 5.0 },   // first confirmed case; early undetected spread
    { day: 0, m: 4.8 },    // declaration (4.6–5.0)
    { day: 34, m: 3.8 },   // 6 wk post-first-case; conflict setting
    { day: 45, m: 3.0 },   // data resumes; band edge
    { day: 68, m: 1.9 },   // Jul 25 backlog dump / reconciliation
    { day: 81, m: 1.45 },  // active-response phase (1.4–1.5)
    { day: 110, m: 1.25 }, // projected asymptote (1.2–1.3)
  ],
  deaths: [
    { day: -8, m: 3.0 },   // burials keep deaths more visible
    { day: 0, m: 2.9 },    // no burial teams yet (2.8–3.0)
    { day: 34, m: 2.5 },   // safe-burial teams scaling
    { day: 60, m: 1.8 },   // death reporting accelerating
    { day: 68, m: 1.4 },   // Jul 25 death dump / reconciliation
    { day: 81, m: 1.1 },   // deaths now over-ascertained (1.0–1.2)
    { day: 110, m: 1.05 }, // projected; deaths converge first (1.0–1.1)
  ],
};

/** Profile-likelihood CI over a 1D offset profile via 2·ln(L_max/L) ≤ χ²₁
 *  (3.84 → 95%, 1.0 → ≈68%). Walks OUTWARD from the mode so the interval is the
 *  connected region containing it (a disconnected below-threshold pocket does
 *  not extend the interval). `deviance` maps both loss types onto units whose
 *  differences are χ²₁-calibrated — for Poisson NLL, 2·Δdev IS 2·ln(L_max/L). */
export function profileOffsetCI(
  profile: { offset: number; loss: number }[],
  modeIdx: number,
  lossType: LossType,
  nObs: number,
): OffsetCI {
  const dev = profile.map((p) => deviance(p.loss, lossType, nObs));
  const dMin = dev[modeIdx];
  const within = (i: number, thr: number): boolean => 2 * (dev[i] - dMin) <= thr;
  const bounds = (thr: number): [number, number] => {
    let lo = modeIdx;
    while (lo > 0 && within(lo - 1, thr)) lo--;
    let hi = modeIdx;
    while (hi < profile.length - 1 && within(hi + 1, thr)) hi++;
    return [profile[lo].offset, profile[hi].offset];
  };
  return { ci95: bounds(3.841459), ci68: bounds(1.0), mode: profile[modeIdx].offset };
}

// Parameters that move R₀ — the CI is only profiled over these.
const R0_DRIVERS = new Set<FitParamName>(['attackRate', 'range', 'infectious']);

// χ²₁,₀.₉₅ / 2 — the profile-likelihood deviance threshold for a 95% interval on a
// single parameter (here R₀, profiled through its driving genes).
const CHI2_HALF = 1.920729;

// Convert a raw loss into a deviance whose *differences* are χ²₁-calibrated, so the
// one threshold (CHI2_HALF) is valid for both loss functions. Poisson NLL is
// already a log-likelihood → use as-is. Least-squares maps to the Gaussian profile
// deviance (n/2)·ln(SSR); with SSR = n·MSE the constant ln(n) cancels in
// differences, so (n/2)·ln(MSE) suffices. Without this, applying the NLL threshold
// directly to a raw MSE (which can run into the thousands) puts *every* off-optimum
// candidate past the cutoff and collapses the interval to a point.
function deviance(loss: number, type: LossType, n: number): number {
  return type === 'poisson' ? loss : (n / 2) * Math.log(Math.max(loss, EPS));
}

export interface CIResult {
  ci: [number, number] | null;
  kind: CIKind;
}

// Profile-likelihood 95% CI on R₀. Holding the other genes at the optimum, we walk
// each R₀-driving axis outward from the optimum and bisect for the last point whose
// deviance stays within CHI2_HALF of the minimum; the engine's R₀ at those crossing
// points bounds the interval. Local bisection gives a far tighter, unbiased interval
// than the old full-bounds coarse sweep — and when the data over-determines R₀
// (noise-free / huge N) the interval collapses, which we report honestly as `exact`
// rather than a misleading zero-width "95% CI". Works for every geometry, since R₀
// comes from the engine rather than a closed form.
async function profileR0CI(
  best: GridSample,
  req: FitRequest,
  evalFull: (values: number[]) => Promise<{ loss: number; r0: number | null }>,
): Promise<CIResult> {
  const n = req.observed.length;
  const drivers = req.params
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => R0_DRIVERS.has(p.name));
  if (drivers.length === 0 || n === 0) return { ci: null, kind: 'none' };

  const base = await evalFull(best.values);
  if (base.r0 == null) return { ci: null, kind: 'none' };
  const minDev = deviance(base.loss, req.loss, n);

  let lo = base.r0;
  let hi = base.r0;
  const consider = (r0: number | null): void => {
    if (r0 == null) return;
    if (r0 < lo) lo = r0;
    if (r0 > hi) hi = r0;
  };

  // Excess deviance + R₀ at a candidate differing from the optimum only on axis `i`.
  const evalAxis = async (i: number, x: number) => {
    const values = best.values.slice();
    values[i] = x;
    const r = await evalFull(values);
    return { excess: deviance(r.loss, req.loss, n) - minDev, r0: r.r0 };
  };

  for (const { p, i } of drivers) {
    const x0 = best.values[i];
    for (const bound of [p.bounds[0], p.bounds[1]]) {
      if (bound === x0) continue;
      const edge = await evalAxis(i, bound);
      if (edge.excess <= CHI2_HALF) {
        // The whole half-axis stays within the threshold → the bound is the edge.
        consider(edge.r0);
        continue;
      }
      // Bisect between x0 (inside) and the bound (outside) for the last inside point.
      let inside = x0;
      let outside = bound;
      let r0Inside = base.r0;
      for (let it = 0; it < 11; it++) { // 2^-11 of the axis range — finer than the noise floor
        const mid = p.integer ? Math.round((inside + outside) / 2) : (inside + outside) / 2;
        if (mid === inside || mid === outside) break; // integer axis converged
        const m = await evalAxis(i, mid);
        if (m.excess <= CHI2_HALF) { inside = mid; if (m.r0 != null) r0Inside = m.r0; }
        else { outside = mid; }
      }
      consider(r0Inside);
    }
  }

  // Over-determined data pins R₀ — report it honestly instead of "x – x".
  const rel = base.r0 !== 0 ? (hi - lo) / Math.abs(base.r0) : hi - lo;
  if (rel < 1e-3) return { ci: null, kind: 'exact' };
  return { ci: [lo, hi], kind: 'interval' };
}

// ─── CSV / TSV parser ────────────────────────────────────────────────────────
// Tolerant `day,value,category` reader shared by the table importer and the
// paste box. Accepts comma or tab delimiters, skips blank lines and a header
// row, and ignores malformed rows rather than throwing.

const CATEGORY_ALIASES: Record<string, FitCategory> = {
  cumulative_infections: 'cumulative_infections',
  cumulative_cases: 'cumulative_infections',
  infections: 'cumulative_infections',
  cases: 'cumulative_infections',
  cumulative_deaths: 'cumulative_deaths',
  deaths: 'cumulative_deaths',
  active_infections: 'active_infections',
  active: 'active_infections',
  infectious: 'active_infections',
};

export interface ParseResult {
  points: ObservedPoint[];
  skipped: number;
}

export function parseObservedCSV(text: string, defaultCategory: FitCategory = 'cumulative_infections'): ParseResult {
  const points: ObservedPoint[] = [];
  let skipped = 0;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/[\t,]/).map((c) => c.trim());
    const day = Number(cells[0]);
    const value = Number(cells[1]);
    if (!Number.isFinite(day) || !Number.isFinite(value)) { skipped++; continue; } // header / junk
    const catRaw = (cells[2] ?? '').toLowerCase().replace(/\s+/g, '_');
    const category = CATEGORY_ALIASES[catRaw] ?? defaultCategory;
    points.push({ day, value, category });
  }
  return { points, skipped };
}

// ─── Revised-cumulative cleaning ─────────────────────────────────────────────
// Real surveillance data gets *revised down* as duplicates and misdiagnoses are
// removed: an early cumulative count can exceed a later one (impossible for true
// cumulative counts). Later reports supersede earlier over-counts, so the
// consistent monotone series is the right-to-left running-min envelope: clip each
// value to the minimum of all later values in its category. Non-destructive —
// callers fit against the cleaned copy while the table keeps the raw data.
// `active_infections` is prevalence (legitimately non-monotone) and passes
// through untouched.

const CUMULATIVE_CATS: FitCategory[] = ['cumulative_infections', 'cumulative_deaths'];

/** Right-to-left running-min envelope over each cumulative category. */
export function revisionEnvelope(points: ObservedPoint[]): ObservedPoint[] {
  const out = points.map((p) => ({ ...p }));
  for (const cat of CUMULATIVE_CATS) {
    const idx = out
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.category === cat)
      .sort((a, b) => a.p.day - b.p.day);
    let min = Number.POSITIVE_INFINITY;
    for (let k = idx.length - 1; k >= 0; k--) {
      min = Math.min(min, idx[k].p.value);
      out[idx[k].i].value = min;
    }
  }
  return out;
}

/** True if any cumulative-category value exceeds a later value in its category
 *  (a downward revision — the envelope would change the data). */
export function hasDownwardRevisions(points: ObservedPoint[]): boolean {
  const cleaned = revisionEnvelope(points);
  return points.some((p, i) => p.value !== cleaned[i].value);
}

// ─── Percentile bands (fan chart) ────────────────────────────────────────────
// Aggregate an ensemble of per-trial curves into per-day percentile prediction
// intervals — the standard ensemble method. Honest caveat (surface in the UI):
// trials are deterministic seeded realizations differing by stochastic path and
// index-case location, so the bands quantify that spread — they are NOT a
// Bayesian posterior over parameters.

/** Linear-interpolated quantile of a SORTED ascending array, p in [0, 100]. */
export function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const idx = (clamp(p, 0, 100) / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** Per-day percentile curves for each category: result[cat][i] is the curve of
 *  the i-th requested percentile (same length as the trials' curves). */
export function percentileBands(
  perTrial: SimCurves[],
  probs: number[],
): Record<FitCategory, number[][]> {
  const out = {} as Record<FitCategory, number[][]>;
  for (const cat of FIT_CATEGORIES) {
    const len = perTrial[0]?.[cat]?.length ?? 0;
    const rows = probs.map(() => new Array<number>(len));
    const vals = new Array<number>(perTrial.length);
    for (let d = 0; d < len; d++) {
      for (let t = 0; t < perTrial.length; t++) vals[t] = perTrial[t][cat][d] ?? 0;
      vals.sort((a, b) => a - b);
      probs.forEach((p, pi) => { rows[pi][d] = quantileSorted(vals, p); });
    }
    out[cat] = rows;
  }
  return out;
}

// ─── Case/death keyframe multipliers + vintaged accumulation ────────────────
// Reported counts are a FLOOR on the true burden; early in an outbreak the
// under-ascertainment multiplier is largest and decays as surveillance ramps
// up. The multiplier is a piecewise-linear function of the report day defined
// by keyframes (clamped to the first/last keyframe outside their range — the
// pseudocode's min(max(w,0),T)/T ramp is exactly two keyframes). Crucially the
// multiplier applies to INCREMENTS at their report date ("vintaged"
// accumulation), not to the cumulative total:
//
//   upper(t_i)   = Σ_{j≤i} Δreported(t_j) · m(t_j)
//   central(t_i) = (reported(t_i) + upper(t_i)) / 2
//
// The initial stock at the first observation uses m evaluated at the midpoint
// of [t0, t_first] (those cases accrued over that whole window). Only the
// cumulative categories are adjusted; active_infections passes through.

export interface Keyframe {
  day: number;
  m: number;
}

/** Piecewise-linear multiplier at `day`, clamped to the end keyframes. */
export function multiplierAt(frames: Keyframe[], day: number): number {
  if (frames.length === 0) return 1;
  const f = frames.slice().sort((a, b) => a.day - b.day);
  if (day <= f[0].day) return f[0].m;
  if (day >= f[f.length - 1].day) return f[f.length - 1].m;
  for (let i = 1; i < f.length; i++) {
    if (day <= f[i].day) {
      const span = f[i].day - f[i - 1].day;
      const t = span > 0 ? (day - f[i - 1].day) / span : 1;
      return f[i - 1].m + (f[i].m - f[i - 1].m) * t;
    }
  }
  return f[f.length - 1].m;
}

export interface AdjustedSeries {
  /** Points with cumulative values replaced by the vintaged upper bound. */
  upper: ObservedPoint[];
  /** Points with cumulative values replaced by (reported + upper) / 2. */
  central: ObservedPoint[];
}

/** Vintaged upper bound + central estimate over the observed points.
 *  `frames` maps each cumulative category to its keyframes (missing category →
 *  passthrough); `t0` is the date of the first confirmed case (for the
 *  initial-stock midpoint rule). Assumes cumulative series are monotone — run
 *  `revisionEnvelope` first if the data carries downward revisions. */
export function vintagedAdjust(
  points: ObservedPoint[],
  frames: Partial<Record<FitCategory, Keyframe[]>>,
  t0: number,
): AdjustedSeries {
  const upper = points.map((p) => ({ ...p }));
  const central = points.map((p) => ({ ...p }));
  for (const cat of CUMULATIVE_CATS) {
    const f = frames[cat];
    if (!f || f.length === 0) continue;
    const idx = points
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.category === cat)
      .sort((a, b) => a.p.day - b.p.day);
    if (idx.length === 0) continue;
    let acc = 0;
    let prevReported = 0;
    for (let k = 0; k < idx.length; k++) {
      const { p, i } = idx[k];
      const delta = k === 0 ? p.value : p.value - prevReported;
      // Initial stock accrued over [t0, t_first] → multiplier at the midpoint;
      // later increments are vintaged at their own report day.
      const mDay = k === 0 ? (t0 + p.day) / 2 : p.day;
      acc += delta * multiplierAt(f, mDay);
      prevReported = p.value;
      upper[i].value = acc;
      central[i].value = (p.value + acc) / 2;
    }
  }
  return { upper, central };
}

// ─── Interventions: time-varying transmission R(t) ───────────────────────────
// Public-health interventions modulate the MODEL's transmission over time —
// R(t) = R₀ × Π_i (1 − effect_i × intensity_i(t)) — via a per-tick multiplier
// on the per-contact attack probability (EngineOptions.txSchedule). This is a
// separate dimension from the case/death keyframe multipliers above, which
// correct the reported DATA for under-ascertainment and never touch the model.

// The intervention shape is SHARED with the live simulation — see
// InterventionSpec in types.ts. Time variation is expressed by KEYFRAMING THE
// REAL PARAMS (per-param {tick, value} tracks, linearly interpolated, HELD at
// the ends); there is no separate "intensity" scalar — time variation IS the
// params varying. The model consumes the keyframed params:
// R(t) = R₀ × Π(1 − effectiveReduction(paramsAt(t))).
export type { InterventionSpec } from '../types';

/** Value of one keyframe track at a (data-day) tick: linear interpolation,
 *  clamped/HELD outside the first/last keyframe — interventions persist
 *  indefinitely unless a later keyframe sets the value down. */
export function valueAt(track: InterventionTimelinePoint[], tick: number): number {
  return multiplierAt(track.map((e) => ({ day: e.tick, m: e.value })), tick);
}

/** The intervention's effective max transmission reduction from its (resolved)
 *  params — the model honors the FULL spec, composing fields the way the live
 *  engine does:
 *  - mask/vaccine (DefenseSpec): (1 − uptake·protection)(1 − uptake·sourceControl);
 *    mortalityReduction affects deaths, not R(t).
 *  - lockdown (LockdownSpec): (1 − transmissionReduction)(1 − mobility·compliance).
 *  - quarantine (QuarantineSpec): detectionRate·sourceControl (steady-state
 *    approximation; contactsRange/duration/protection shape live-sim spatial
 *    dynamics, not this population-level rate).
 *  Param-less specs ('custom') use the flat transmissionReduction. */
export function effectiveReduction(iv: InterventionSpec): number {
  const p = iv.params;
  if (!p) return clamp(iv.transmissionReduction, 0, 0.95);
  switch (iv.intervention) {
    case 'mask':
    case 'vaccine':
    case 'custom': { // custom shares the canonical defense schema
      const u = clamp(p.uptake ?? 0, 0, 1);
      const incoming = 1 - u * clamp(p.protection ?? 0, 0, 1);
      const outgoing = 1 - u * clamp(p.sourceControl ?? 0, 0, 1);
      return clamp(1 - incoming * outgoing, 0, 0.95);
    }
    case 'lockdown': {
      const global = 1 - clamp(iv.transmissionReduction, 0, 1);
      const visits = 1 - clamp(p.mobilityReduction ?? 0, 0, 1) * clamp(p.compliance ?? 0, 0, 1);
      return clamp(1 - global * visits, 0, 0.95);
    }
    case 'quarantine':
      return clamp(clamp(p.detectionRate ?? 0, 0, 1) * clamp(p.sourceControl ?? 0, 0, 1), 0, 0.95);
    default:
      return clamp(iv.transmissionReduction, 0, 0.95);
  }
}

/** The spec with its params resolved at data day `tick` from its KEYFRAMES —
 *  each keyframe is a day plus a full param snapshot; every field interpolates
 *  linearly between keyframes and is HELD outside the first/last (base values
 *  fill any field a keyframe omits). No keyframes → the base params. Pure. */
export function specAtDay(iv: InterventionSpec, tick: number): InterventionSpec {
  const kfs = iv.keyframes;
  if (!kfs || kfs.length === 0) return iv;
  const sorted = kfs.slice().sort((a, b) => a.tick - b.tick);
  const field = (get: (k: InterventionKeyframe) => number | undefined, base: number): number =>
    valueAt(sorted.map((k) => ({ tick: k.tick, value: get(k) ?? base })), tick);
  const baseP = iv.params ?? {};
  const params: InterventionParams = {
    uptake: field((k) => k.params.uptake, baseP.uptake ?? 0),
    protection: field((k) => k.params.protection, baseP.protection ?? 0),
    sourceControl: field((k) => k.params.sourceControl, baseP.sourceControl ?? 0),
    mortalityReduction: field((k) => k.params.mortalityReduction, baseP.mortalityReduction ?? 0),
    mobilityReduction: field((k) => k.params.mobilityReduction, baseP.mobilityReduction ?? 0),
    compliance: field((k) => k.params.compliance, baseP.compliance ?? 0),
    detectionRate: field((k) => k.params.detectionRate, baseP.detectionRate ?? 0),
    contactsRange: field((k) => k.params.contactsRange, baseP.contactsRange ?? 1),
    duration: field((k) => k.params.duration, baseP.duration ?? 14),
  };
  return {
    ...iv,
    transmissionReduction: field((k) => k.transmissionReduction, iv.transmissionReduction),
    params,
  };
}

/** Effective max transmission reduction at data day `tick`, honoring the FULL
 *  keyframed spec. */
export function effectiveReductionAt(iv: InterventionSpec, tick: number): number {
  return effectiveReduction(specAtDay(iv, tick));
}

/** Convert the live sim's binary InterventionEvent timeline into the shared
 *  spec: toggles become a transmissionReduction keyframe track (on → the given
 *  strength, off → 0) with step-preserving hold-points, so pre-history is off
 *  and on-windows hold full value under the linear interpolation. */
export function specFromEvents(
  key: InterventionKey,
  events: InterventionEvent[],
  transmissionReduction: number,
  label?: string,
): InterventionSpec {
  const tr = clamp(transmissionReduction, 0, 0.95);
  // Keyframe the field the taxonomy's effectiveReduction actually consumes so
  // on/off toggles map to strength tr/0 exactly for every type:
  //   mask/vaccine → protection (with uptake 1, sourceControl 0 ⇒ eff = protection)
  //   lockdown     → the transmissionReduction dial (mobility·compliance = 0)
  //   quarantine   → detectionRate (with sourceControl 1 ⇒ eff = detectionRate)
  const snap = (on: boolean): InterventionKeyframe => {
    const v = on ? tr : 0;
    if (key === 'lockdown') {
      return { tick: 0, transmissionReduction: v, params: { mobilityReduction: 0, compliance: 0 } };
    }
    if (key === 'quarantine') {
      return { tick: 0, params: { detectionRate: v, sourceControl: 1, contactsRange: 1, protection: 0, duration: 14 } };
    }
    return { tick: 0, params: { uptake: 1, protection: v, sourceControl: 0, mortalityReduction: 0 } };
  };
  const at = (tick: number, on: boolean): InterventionKeyframe => ({ ...snap(on), tick });
  const sorted = events.slice().sort((a, b) => a.tick - b.tick);
  const kfs: InterventionKeyframe[] = [];
  let prev = false;
  for (const e of sorted) {
    if (kfs.length === 0) {
      if (e.on) kfs.push(at(e.tick - 1, false));
    } else if (e.on !== prev && e.tick - 1 > kfs[kfs.length - 1].tick) {
      kfs.push(at(e.tick - 1, prev));
    }
    kfs.push(at(e.tick, e.on));
    prev = e.on;
  }
  return {
    id: key,
    intervention: key,
    label: label ?? sorted.find((e) => e.label)?.label ?? key,
    enabled: true,
    transmissionReduction: tr,
    params: snap(true).params,
    keyframes: kfs,
  };
}

/** Migrate persisted interventions from earlier shapes — v1 {effect,
 *  intensity:[{day,m}]} and v2 {events:[{tick,intensity}]} — onto keyframed
 *  real params: the old whole-intervention intensity ramp becomes a
 *  transmissionReduction track scaled by the flat strength, which is
 *  schedule-equivalent by construction (old eff(t) = flat·intensity(t)).
 *  Param-less typed legacy specs are retagged 'custom': a flat strength +
 *  ramp IS the custom parameterization; re-typing in the UI seeds the full
 *  controls. */
export function migrateInterventionSpecs(list: unknown[]): InterventionSpec[] {
  return (list as Array<InterventionSpec & {
    effect?: number;
    intensity?: { day: number; m: number }[];
    events?: { tick: number; intensity: number }[];
    timeline?: Partial<Record<InterventionParamName, InterventionTimelinePoint[]>>;
  }>).map((iv) => {
    const tr = clamp(iv.transmissionReduction ?? iv.effect ?? 0.3, 0, 0.95);
    const out: InterventionSpec = {
      id: iv.id,
      intervention: iv.intervention ?? 'custom',
      label: iv.label,
      enabled: iv.enabled,
      transmissionReduction: tr,
      params: iv.params ? { ...iv.params } : undefined,
      keyframes: iv.keyframes?.map((k) => ({ tick: k.tick, transmissionReduction: k.transmissionReduction, params: { ...k.params } })),
    };
    // v3 per-param tracks → keyframes: resolve the FULL param set at the union
    // of all track ticks. Piecewise-linear functions sampled at every
    // breakpoint reproduce exactly under re-interpolation — bit-equivalent.
    if (!out.keyframes && iv.timeline && Object.keys(iv.timeline).length > 0) {
      const ticks = [...new Set(Object.values(iv.timeline).flatMap((t) => (t ?? []).map((f) => f.tick)))].sort((a, b) => a - b);
      const probe: InterventionSpec = { ...out, keyframes: undefined, params: out.params, timeline: iv.timeline } as InterventionSpec;
      // Temporarily emulate the old per-param-track resolution:
      const trackVal = (name: InterventionParamName, tick: number, base: number): number => {
        const track = iv.timeline?.[name];
        return track && track.length ? valueAt(track.map((f) => ({ tick: f.tick, value: f.value })), tick) : base;
      };
      void probe;
      const bp = out.params ?? {};
      out.keyframes = ticks.map((t) => ({
        tick: t,
        transmissionReduction: trackVal('transmissionReduction', t, tr),
        params: {
          uptake: trackVal('uptake', t, bp.uptake ?? 0),
          protection: trackVal('protection', t, bp.protection ?? 0),
          sourceControl: trackVal('sourceControl', t, bp.sourceControl ?? 0),
          mortalityReduction: trackVal('mortalityReduction', t, bp.mortalityReduction ?? 0),
          mobilityReduction: trackVal('mobilityReduction', t, bp.mobilityReduction ?? 0),
          compliance: trackVal('compliance', t, bp.compliance ?? 0),
          detectionRate: trackVal('detectionRate', t, bp.detectionRate ?? 0),
          contactsRange: trackVal('contactsRange', t, bp.contactsRange ?? 1),
          duration: trackVal('duration', t, bp.duration ?? 14),
        },
      }));
    }
    // v1/v2 whole-intervention intensity ramps → custom-schema keyframes
    // (uptake 1, protection = intensity·strength, sourceControl 0 ⇒ eff equal).
    const legacyRamp = iv.events ?? iv.intensity?.map((f) => ({ tick: f.day, intensity: f.m }));
    if (!out.keyframes && legacyRamp?.length) {
      out.intervention = out.params ? out.intervention : 'custom';
      out.keyframes = legacyRamp.map((f) => ({
        tick: f.tick,
        params: { uptake: 1, protection: clamp(f.intensity, 0, 1) * tr, sourceControl: 0, mortalityReduction: 0 },
      }));
    }
    // One shared schema: every spec carries base params.
    if (!out.params) {
      out.params = { uptake: 1, protection: clamp(tr, 0, 0.95), sourceControl: 0, mortalityReduction: 0 };
    }
    return out;
  });
}

/** Crossover sync: a main-sim intervention toggle (mask/vaccine/lockdown/
 *  quarantine on/off) flips `enabled` on every shared-store spec of that
 *  taxonomy, so the live sim and the fit modal act on the SAME objects.
 *  Returns true when anything changed (callers persist + refresh then). */
export function syncSpecsWithToggle(
  specs: InterventionSpec[],
  key: InterventionKey,
  on: boolean,
): boolean {
  let changed = false;
  for (const iv of specs) {
    if (iv.intervention === key && iv.enabled !== on) {
      iv.enabled = on;
      changed = true;
    }
  }
  return changed;
}

/** Per-model-tick transmission multiplier for the engine: tick t maps to data
 *  day t − offsetDays. Undefined when nothing is active (or every day is a
 *  no-op) — callers skip the scheduled path, keeping unscheduled runs
 *  bit-identical. */
export function transmissionSchedule(
  interventions: InterventionSpec[],
  len: number,
  offsetDays = 0,
): number[] | undefined {
  const active = interventions.filter((iv) => iv.enabled);
  if (active.length === 0) return undefined;
  const out = new Array<number>(len);
  let any = false;
  for (let t = 0; t < len; t++) {
    const d = t - offsetDays;
    let f = 1;
    for (const iv of active) {
      f *= 1 - effectiveReductionAt(iv, d);
    }
    out[t] = f;
    if (f !== 1) any = true;
  }
  return any ? out : undefined;
}

/** Default interventions for the current-outbreak Ebola presets, grounded in
 *  the REAL 2014 West Africa response mapped onto this dataset's day axis
 *  (day 0 = the May 18 declaration): MSF's Kailahun ETC opened late June
 *  (~day 38); Sierra Leone's state of emergency 31 July (day 74) with enforced
 *  quarantines 4–6 Aug (days 78–80); WHO PHEIC 8 Aug (day 82); airline
 *  suspensions from late July (~day 72); MSF ELWA-3 17 Aug (day 91). Sources:
 *  WHO DON 4 Aug 2014, WHO PHEIC statement 8 Aug 2014, CDC MMWR 65(Su-3).
 *  Expressed as REAL params with keyframe tracks, factorized to be schedule-
 *  equivalent to the original calibrated strengths (effect·coverage products
 *  preserved exactly — verified by test). EFFECT SIZES AND COVERAGE RAMPS ARE
 *  REASONED ESTIMATES; ring vaccination ships DISABLED (rVSV-ZEBOV ring trial
 *  began ~day 300, outside this window). */
export const EBOLA_INTERVENTIONS: InterventionSpec[] = [
  {
    id: 'safe-burials',
    intervention: 'custom', // no live-sim analogue — burial-practice change
    label: 'Safe & dignified burials',
    enabled: true,
    transmissionReduction: 0.3,
    // Defense schema: protection 0.3 const, coverage (Rate) keyframed to the
    // 2014 ramp → eff = uptake(t)·0.3, schedule-equivalent to the calibration.
    params: { uptake: 0, protection: 0.3, sourceControl: 0, mortalityReduction: 0 },
    keyframes: [
      { tick: 30, params: { uptake: 0, protection: 0.3, sourceControl: 0, mortalityReduction: 0 } },
      { tick: 60, params: { uptake: 0.4, protection: 0.3, sourceControl: 0, mortalityReduction: 0 } },
      { tick: 110, params: { uptake: 0.8, protection: 0.3, sourceControl: 0, mortalityReduction: 0 } },
    ],
  },
  {
    id: 'contact-tracing',
    intervention: 'quarantine',
    label: 'Contact tracing & case isolation',
    enabled: true,
    transmissionReduction: 0.25,
    params: { detectionRate: 0.05, contactsRange: 2, protection: 0.3, sourceControl: 0.5, duration: 21 },
    // Old eff = 0.25 × coverage = detectionRate(t) × 0.5:
    keyframes: [
      { tick: 7, params: { detectionRate: 0.05, contactsRange: 2, protection: 0.3, sourceControl: 0.5, duration: 21 } },
      { tick: 45, params: { detectionRate: 0.15, contactsRange: 2, protection: 0.3, sourceControl: 0.5, duration: 21 } },
      { tick: 82, params: { detectionRate: 0.25, contactsRange: 2, protection: 0.3, sourceControl: 0.5, duration: 21 } },
      { tick: 110, params: { detectionRate: 0.35, contactsRange: 2, protection: 0.3, sourceControl: 0.5, duration: 21 } },
    ],
  },
  {
    id: 'treatment-centers',
    intervention: 'quarantine',
    label: 'Treatment centres (ETCs)',
    enabled: true,
    transmissionReduction: 0.3,
    params: { detectionRate: 0.15, contactsRange: 1, protection: 0.4, sourceControl: 0.6, duration: 30 },
    // Old eff = 0.3 × coverage = detectionRate(t) × 0.6:
    keyframes: [
      { tick: 38, params: { detectionRate: 0.15, contactsRange: 1, protection: 0.4, sourceControl: 0.6, duration: 30 } },
      { tick: 74, params: { detectionRate: 0.25, contactsRange: 1, protection: 0.4, sourceControl: 0.6, duration: 30 } },
      { tick: 91, params: { detectionRate: 0.35, contactsRange: 1, protection: 0.4, sourceControl: 0.6, duration: 30 } },
      { tick: 110, params: { detectionRate: 0.4, contactsRange: 1, protection: 0.4, sourceControl: 0.6, duration: 30 } },
    ],
  },
  {
    id: 'emergency-travel',
    intervention: 'lockdown',
    label: 'Emergency measures & travel restrictions',
    enabled: true,
    transmissionReduction: 0,
    params: { mobilityReduction: 0, compliance: 0 },
    // Old eff = 0.15 × coverage: keyframe the transmission-reduction dial
    // (with mobility·compliance = 0, lockdown eff reduces to tr).
    keyframes: [
      { tick: 72, transmissionReduction: 0, params: { mobilityReduction: 0, compliance: 0 } },
      { tick: 74, transmissionReduction: 0.09, params: { mobilityReduction: 0, compliance: 0 } },
      { tick: 82, transmissionReduction: 0.135, params: { mobilityReduction: 0, compliance: 0 } },
      { tick: 110, transmissionReduction: 0.135, params: { mobilityReduction: 0, compliance: 0 } },
    ],
  },
  {
    id: 'ring-vaccination',
    intervention: 'vaccine',
    label: 'Ring vaccination (2015 — outside this window)',
    enabled: false, // rVSV-ZEBOV ring trial began ~day 300; kept for exploration
    transmissionReduction: 0.5,
    params: { uptake: 0, protection: 0.5, sourceControl: 0, mortalityReduction: 0.5 },
    // Old eff = 0.5 × coverage = uptake(t)·0.5:
    keyframes: [
      { tick: 300, params: { uptake: 0, protection: 0.5, sourceControl: 0, mortalityReduction: 0.5 } },
      { tick: 330, params: { uptake: 0.8, protection: 0.5, sourceControl: 0, mortalityReduction: 0.5 } },
    ],
  },
];


// ─── Fit-grid resolution ─────────────────────────────────────────────────────
// One grid cell represents population/size² real people — the smallest nonzero
// value the model can produce (day 0 is exactly one index-case cell). If that
// quantum exceeds the smallest observed data point, the Poisson loss carries an
// irreducible floor the optimizer cannot fix and every curve renders as giant
// steps. So the fit grid must satisfy population/size² ≤ min positive observed:
// size ≥ ceil(√(population / minObs)). We fit at the live size when it already
// satisfies this (reproduce-on-Apply), raise it to the resolution floor when it
// doesn't (with a UI warning that Apply needs a larger live grid), and cap for
// cost — beyond the cap the caller warns that resolution is insufficient.

export function resolutionFitSize(
  liveSize: number,
  population: number,
  minPositiveObs: number,
  cap: number,
): number {
  const floor =
    Number.isFinite(minPositiveObs) && minPositiveObs > 0 && population > 0
      ? Math.ceil(Math.sqrt(population / minPositiveObs))
      : 0;
  return Math.min(cap, Math.max(Math.min(liveSize, cap), floor, 8));
}

// ─── Initial-guess seam ──────────────────────────────────────────────────────
// Heuristic warm start for the optimizer. Currently returns the bound midpoints;
// this is the documented hook where a future TensorFlow.js surrogate (trained on
// synthetic sims) would propose an instant near-optimal starting point. Kept a
// pure function so dropping in a surrogate is additive, not a refactor.
export function proposeInitialGuess(_observed: ObservedPoint[], params: FitParamDef[]): number[] {
  return params.map((p) => (p.bounds[0] + p.bounds[1]) / 2);
}

// ─── Small numeric helpers ───────────────────────────────────────────────────

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
