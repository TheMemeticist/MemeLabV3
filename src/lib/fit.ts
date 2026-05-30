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

import type { GeometryType, SimConfig, StrainGenes } from '../types';
import { makeGeometry, torus } from '../sim/neighbors';

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
}

export type LossType = 'poisson' | 'mse';

// ─── Fittable-parameter registry ─────────────────────────────────────────────
// Each entry maps a strain gene to a search dimension. `get`/`set` localize the
// SimConfig path so the optimizer can work on a plain number vector. Add a
// parameter by appending one entry — nothing else in this file changes.

export type FitParamName =
  | 'attackRate'
  | 'range'
  | 'incubation'
  | 'infectious'
  | 'ifr';

export interface FitParamDef {
  name: FitParamName;
  label: string;
  /** Search bounds [lo, hi]. */
  bounds: [number, number];
  /** Integer-valued dimension (rounded when written into the config). */
  integer?: boolean;
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
// Coarse grid scan (robust against the stochastic loss surface's local minima)
// followed by a bounded Nelder–Mead simplex refine from the grid minimum. The
// objective `evaluate(values) => Promise<loss>` is injected, so the optimizer is
// agnostic about whether sims run in a worker pool or in-process.

export interface GridSample {
  values: number[];
  loss: number;
}

export interface OptimizeResult {
  best: GridSample;
  /** Every coarse-grid sample, reused downstream for the profile-likelihood CI. */
  grid: GridSample[];
  evaluations: number;
}

export interface OptimizeOptions {
  params: FitParamDef[];
  evaluate: (values: number[]) => Promise<number>;
  /** Coarse-grid resolution per dimension. */
  gridSteps?: number;
  /** Max Nelder–Mead iterations. */
  nmIters?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: { aborted: boolean };
}

export async function optimize(opts: OptimizeOptions): Promise<OptimizeResult> {
  const { params, evaluate } = opts;
  const gridSteps = opts.gridSteps ?? (params.length >= 3 ? 4 : 6);
  const nmIters = opts.nmIters ?? 40;
  const dims = params.length;

  // Total is approximate (Nelder–Mead does a variable number of evals); it only
  // drives the progress bar, so over-counting slightly is fine.
  const gridTotal = Math.pow(gridSteps, dims);
  const total = gridTotal + nmIters + 1;
  let done = 0;
  const tick = () => { done++; opts.onProgress?.(Math.min(done, total), total); };

  // ── Coarse grid ──
  const axes = params.map((p) => linspace(p.bounds[0], p.bounds[1], gridSteps, p.integer));
  const grid: GridSample[] = [];
  const combos = cartesian(axes);
  // Evaluate the grid concurrently; the injected pool serializes/parallelizes.
  const losses = await mapWithProgress(combos, evaluate, opts.signal, tick);
  for (let i = 0; i < combos.length; i++) grid.push({ values: combos[i], loss: losses[i] });

  let best = grid.reduce((a, b) => (b.loss < a.loss ? b : a), grid[0]);
  if (opts.signal?.aborted) return { best, grid, evaluations: done };

  // ── Nelder–Mead refine ──
  best = await nelderMead(best, params, evaluate, nmIters, opts.signal, tick);

  return { best, grid, evaluations: done };
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
  /** Stochastic trials per candidate (10–100). */
  K: number;
  loss: LossType;
  /** Real-world population the observed counts are drawn from. */
  population: number;
  gridSteps?: number;
  nmIters?: number;
}

export interface FitRequest extends FitOptions {
  observed: ObservedPoint[];
  baseConfig: SimConfig;
  params: FitParamDef[];
  /** Runs K trials of `config` for `days` days and returns mean per-capita curves
   *  plus the candidate's analytic R₀. */
  simulate: (config: SimConfig, days: number, K: number, seed: number) => Promise<SimResult>;
  onProgress?: (frac: number) => void;
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
  gof: GoodnessOfFit;
  loss: number;
  days: number;
  population: number;
  observed: ObservedPoint[];
  simulated: SimCurves;
  /** The fully-resolved best-fit config (genes applied), ready to apply to the sim. */
  config: SimConfig;
}

export async function runFit(req: FitRequest): Promise<FitResult> {
  const days = Math.max(1, ...req.observed.map((p) => Math.round(p.day)));
  const baseSeed = req.baseConfig.seed;

  const configFor = (values: number[]): SimConfig => {
    const cfg = structuredClone(req.baseConfig);
    req.params.forEach((p, i) => p.set(cfg.strain, values[i]));
    return cfg;
  };

  // One sim of a candidate, yielding both the loss and the engine's R₀. The pool
  // memoizes by params, so the optimizer, the final best, and the CI sweep all
  // share results for free.
  const evalFull = async (values: number[]): Promise<{ loss: number; r0: number | null; result: SimResult }> => {
    const result = await req.simulate(configFor(values), days, req.K, baseSeed);
    return { loss: lossOf(req.observed, result.curves, req.population, req.loss), r0: result.rNaught, result };
  };
  const evaluate = async (values: number[]): Promise<number> => {
    if (req.signal?.aborted) return Number.POSITIVE_INFINITY;
    return (await evalFull(values)).loss;
  };

  const opt = await optimize({
    params: req.params,
    evaluate,
    gridSteps: req.gridSteps,
    nmIters: req.nmIters,
    signal: req.signal,
    onProgress: (d, t) => req.onProgress?.(d / t),
  });

  const bestConfig = configFor(opt.best.values);
  const best = await evalFull(opt.best.values); // cache hit
  const r0CI = await profileR0CI(opt, req, evalFull);

  return {
    params: req.params.map((p, i) => ({
      name: p.name,
      label: p.label,
      value: p.integer ? Math.round(opt.best.values[i]) : opt.best.values[i],
    })),
    // R₀ from the engine's own estimate — correct for every geometry, and
    // consistent with the topbar readout (no separate analytic formula).
    r0: best.r0,
    r0CI,
    gof: goodnessOfFit(req.observed, best.result.curves, req.population),
    loss: opt.best.loss,
    days,
    population: req.population,
    observed: req.observed,
    simulated: best.result.curves,
    config: bestConfig,
  };
}

// Parameters that move R₀ — the CI is only profiled over these.
const R0_DRIVERS = new Set<FitParamName>(['attackRate', 'range', 'infectious']);

// Profile-likelihood 95% CI on R₀. We sweep each R₀-driving parameter
// one-at-a-time through the refined optimum (holding the others at their best
// values), keeping the R₀ (the engine's own estimate, returned by `evalFull`)
// of every candidate whose loss is within ΔNLL ≤ 1.92 (½·χ²₁,₀.₉₅) of the global
// minimum. A per-axis sweep gives a far tighter, unbiased interval than the
// coarse grid alone (whose nodes routinely straddle the true value). Works for
// every geometry, since R₀ comes from the engine rather than a closed form.
async function profileR0CI(
  opt: OptimizeResult,
  req: FitRequest,
  evalFull: (values: number[]) => Promise<{ loss: number; r0: number | null }>,
): Promise<[number, number] | null> {
  const samples: { r0: number; loss: number }[] = [];
  let minLoss = Infinity;

  const add = (r0: number | null, loss: number): void => {
    if (r0 == null) return;
    samples.push({ r0, loss });
    if (loss < minLoss) minLoss = loss;
  };

  // Candidates to profile: the refined optimum plus a per-axis sweep through it
  // (only the R₀-driving axes). All are cache-backed in the pool.
  const candidates: number[][] = [opt.best.values];
  req.params.forEach((p, i) => {
    if (!R0_DRIVERS.has(p.name)) return;
    for (const v of linspace(p.bounds[0], p.bounds[1], 9, p.integer)) {
      const values = opt.best.values.slice();
      values[i] = v;
      candidates.push(values);
    }
  });

  await Promise.all(candidates.map((values) => evalFull(values).then((r) => add(r.r0, r.loss))));
  if (samples.length === 0) return null; // R₀ unavailable (e.g. grid < 8)

  const threshold = minLoss + 1.92;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of samples) {
    if (s.loss > threshold) continue;
    lo = Math.min(lo, s.r0);
    hi = Math.max(hi, s.r0);
  }
  return lo <= hi ? [lo, hi] : null;
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

function linspace(lo: number, hi: number, steps: number, integer?: boolean): number[] {
  if (integer) {
    // One grid point per integer in range, capped at `steps` for wide bounds.
    const span = Math.round(hi) - Math.round(lo);
    const count = Math.min(span + 1, Math.max(2, steps));
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(Math.round(lo + (span * i) / (count - 1)));
    }
    return Array.from(new Set(out));
  }
  if (steps <= 1) return [(lo + hi) / 2];
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push(lo + ((hi - lo) * i) / (steps - 1));
  return out;
}

function cartesian(axes: number[][]): number[][] {
  return axes.reduce<number[][]>(
    (acc, axis) => acc.flatMap((combo) => axis.map((v) => [...combo, v])),
    [[]],
  );
}

async function mapWithProgress(
  combos: number[][],
  evaluate: (v: number[]) => Promise<number>,
  signal: { aborted: boolean } | undefined,
  tick: () => void,
): Promise<number[]> {
  return Promise.all(
    combos.map(async (c) => {
      if (signal?.aborted) return Number.POSITIVE_INFINITY;
      const loss = await evaluate(c);
      tick();
      return loss;
    }),
  );
}
