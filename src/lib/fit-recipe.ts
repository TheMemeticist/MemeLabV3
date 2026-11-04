// Individual-scale grid-posterior estimator ("the recipe"): a second, opt-in forecasting
// estimator beside `runFit` (fit.ts). Off by default — nothing in the app calls it unless asked to.
//
// What it does, in one pass over the training data (cases, optionally deaths, up to `cutoff`):
//   1. Sizing — one lattice cell is one person. The lattice side comes from the training prefix and the
//      ascertainment range (B = H·max(C_cut, 7·last-week increment)/asc_lo, the next power of two, at least
//      `minSide`, at most `maxSide`, or √(population at risk) when that is smaller).
//   2. Grid — every start offset × attack rate × long-range mixing value is simulated (8 trials, survivor-
//      conditioned when the outbreak is still growing); reported cases = asc × simulated infections with asc
//      profiled within its range under a log-normal prior; trials that overshoot the data are stopped early.
//   3. Turns — the 8 best grid cells get loss-checked transmission-multiplier rounds on dated change points
//      (factor and multiplier bounds, random-walk penalty), plus one profiled extra change point.
//   4. Averaging — cells are weighted by exp(−Δloss/φ) and the 64 forecast trials are shared out by weight.
//   5. Forecast — per kept cell: damping of the last multiplier toward flat incidence (down only), survivor
//      selection, binomial reporting thinning, the last-week case anchor (bounded by the ascertainment range)
//      and, when that anchor is clamped, the state anchor (G1): the last generation's transmission is rescaled
//      so the simulated state matches the data, then the anchor is recomputed.
//
// The project's forecasting benchmark runs this same module for every job that uses exactly this option set, so
// the benchmark and the app share one implementation. Option semantics, arithmetic and RNG draw order are the
// validated ones; change nothing here without re-running the benchmark's parity checks. The engine is unchanged; all randomness is the engines' own seeded
// streams plus seeded `Rng` instances for index cells and reporting thinning (no second global source).
// Written once as a coroutine (`recipeCore`) with two drivers that give the same result bit for bit: `runRecipeForecast`,
// synchronous (run it in a worker: `fit.worker.ts` command `kind: 'recipe'`), and `runRecipeForecastParallel`
// (fit-recipe-parallel.ts), which spreads the candidate simulations over several fit workers.
// Opt-in extra (off by default): `pooledFits` = K runs the estimator K times at seeds S, S + 100, … and forecasts from the
// concatenation of their trials (see "Pooled fits" below); K× the CPU, about 1× the wall time with the parallel driver and
// enough workers.

import type { EngineOptions } from '../sim';
import { wasmAvailable, type AnyEngine } from '../sim/wasm-engine';
import { baseSimConfig } from '../sim/presets';
import { Rng } from '../sim/rng';
import { CellState } from '../types';
import type { SimConfig, VoronoiTopology } from '../types';
import { changePointSchedule, incidentCountTerms, percentileBands, ENSEMBLE_PROBS } from './fit';
import type { FitCategory, ObservedPoint, SimCurves, SimResult } from './fit';
import { runTrials, trialEngine, trialTopology, type FitBackend } from './fit-sim';

// ─── Validated recipe settings and owner defaults for missing inputs ─────────────────────────────────────────

/** The validated recipe settings. Not tuning knobs: changing any value is a model change. */
export const RECIPE_SETTINGS = Object.freeze({
  bma: Object.freeze({ rel: 0.01, maxCells: 8, phiFloor: 1, pearsonMinMean: 1, dfParams: 4 }),
  turns: Object.freeze({
    rounds: 6, factor: [0.25, 4] as [number, number], multCap: 2, earlyChangePoint: true, rwPenalty: 0.5,
    cpProfile: Object.freeze({ from: 42, to: 4, step: 2, rounds: 3, refine: 4 }), multFloor: 0.5,
  }),
  mixingGrid: [0, 0.2, 0.5, 1],
  stateAnchor: Object.freeze({ W: 'gen' as const, maxR: 4, iters: 3, tol: 0.05, sym: true }),
  ascPrior: true,
  anchorDays: 7,
  dampTau: 14,
  survive: true,
});

/** Owner-chosen defaults for inputs a user may not have. Never chosen from scores. Per-outbreak values passed
 *  by the caller override every one of them. */
export const RECIPE_DEFAULTS = Object.freeze({
  /** Ascertainment range [low, central, high] (fraction of infections reported; high ≤ 1). */
  ascertainment: [0.2, 0.45, 1.0] as [number, number, number],
  /** Largest lattice side (people = side²). */
  maxSide: 512,
  /** Generic change points: every `changePointEvery` days back from the cutoff, first segment ≥ `firstSegmentDays`. */
  changePointEvery: 21,
  firstSegmentDays: 28,
  /** Candidate start offsets (days of spread before the first report). */
  offsetGrid: [0, 7, 14, 28, 42, 56, 84, 112, 168],
  /** Lower bound of offsetMax (the benchmark's max(28, first-case gap)). */
  offsetMaxFloor: 28,
  /** Waning immunity (days); effectively none over an outbreak. */
  immunityDays: 3650,
});

// ─── Job and runner types ─────────────────────────────────────────────────────────────────────────────────────

export interface RecipeIndividual {
  /** Ascertainment range [low, central, high], 0 < low ≤ high ≤ 1. */
  asc: [number, number, number];
  /** Deaths ascertainment: a number (default 1 = deaths fully reported) or a profiled range. */
  ascD?: number | [number, number, number];
  /** Engine IFR; default = reported CFR × central ascertainment. */
  ifr?: number;
  /** Population at risk: caps the lattice at √nAtRisk when smaller than the sizing rule. */
  nAtRisk?: number;
  H?: number; minSide?: number; maxSide?: number; osFactor?: number;
  /** Log-normal prior on asc (true: σ = ln(hi/lo)/3.29; a number: σ). */
  ascPrior?: boolean | number;
}
export interface RecipeTurns {
  rounds: number; factor: [number, number]; multCap: number; earlyChangePoint?: boolean; rwPenalty?: number; cells?: number;
  cpProfile?: { from: number; to: number; step: number; rounds?: number; refine?: number; min?: number };
  multFloor?: number;
}
export interface RecipeBma { rel: number; maxCells: number; phiFloor: number; pearsonMinMean: number; dfParams: number; trials?: number }
export interface RecipeStateAnchor { W?: number | 'gen'; maxR?: number; iters?: number; tol?: number; sym?: boolean; deaths?: string; noDampUp?: boolean }

/** One estimator run. Day numbers are data days (day 0 = the series' day 0); `observed` holds only points ≤ cutoff. */
export interface RecipeJob {
  observed: ObservedPoint[];
  cutoff: number;
  seed: number;
  durations: { incubation: number; infectious: number };
  individual: RecipeIndividual;
  turns: RecipeTurns;
  bma: RecipeBma;
  /** App preset the base world comes from (default: `pathogen`, 'sars2-wild' for 'mpox'). */
  basePreset?: string;
  pathogen?: string;
  immunityDays?: number;
  firstCaseGap?: number;
  offsetMax?: number;
  offsetGrid?: number[];
  changePoints?: { tick: number }[];
  horizonDays?: number;
  backend?: FitBackend;
  anchorLastWeek?: boolean;
  anchorDays?: number;
  anchorDaysDeaths?: number;
  dampTau?: number;
  dampDownOnly?: boolean;
  phaseAccept?: boolean;
  survive?: boolean;
  mixingGrid?: number[];
  attackGrid?: number[];
  geometry?: SimConfig['geometry'];
  susceptibilityCV?: number;
  stateAnchor?: RecipeStateAnchor;
  fitTopology?: boolean;
  /** Pooled fits (opt-in; absent or 1 = off, the single estimator run). With K > 1 the forecast trials are the concatenation,
   *  in fit order, of the trials of K independent runs of this job that differ only in seed (fit j at seed + 100·j). Read by
   *  the drivers (`runRecipeForecast`, `driveRecipe`), never by `recipeCore`. 3 is the validated setting; K fits cost K× the
   *  CPU. */
  pooledFits?: number;
  /** Free-form caller fields (ids, bookkeeping) are carried through untouched. */
  [extra: string]: unknown;
}

/** How trials are run. The default uses the app's shared trial engine (fit-sim.ts); a benchmark harness may pass its
 *  own engine provider (same engines, same seeds — a reset engine is bit-identical to a fresh one). */
export interface RecipeRunners {
  engineFor(config: SimConfig, topo: VoronoiTopology | undefined, opts: EngineOptions, backend: FitBackend): AnyEngine;
  topologyFor(config: SimConfig, baseSeed: number): VoronoiTopology | undefined;
  /** K-trial mean curves from the default index cell (fit-sim `runTrials` semantics). */
  meanTrials(config: SimConfig, days: number, K: number, seed: number, schedule: number[] | undefined, backend: FitBackend): SimResult;
  /** Optional observer of every completed fit trial (draws no randomness). */
  onFitTrial?(rec: { attack: number; days: number; schedule: number[] | null; k: number; persons: number }): void;
  /** Optional progress reports (stage, fraction of that stage). */
  onProgress?(stage: 'grid' | 'turns' | 'forecast', frac: number): void;
}

export function defaultRecipeRunners(): RecipeRunners {
  return {
    engineFor: (config, topo, opts, backend) => trialEngine(config, topo, opts, backend),
    topologyFor: (config, baseSeed) => trialTopology(config, baseSeed),
    meanTrials: (config, days, K, seed, schedule, backend) => runTrials(config, days, K, seed, schedule, backend),
  };
}

// ─── Trial runners ────────────────────────────────────────────────────────────────────────────────────────────

const SEED_STRIDE = 0x9e3779b1;
const DEFAULT_HORIZON = 224;
const SURV_W = 14;

/** Trials k0 … k0 + n − 1 of the forecast ensemble (fit-sim `runTrialEnsemble` seeding: k = 0 the default index cell,
 *  k > 0 an index cell from a dedicated Rng). k0 = 0, n = N equals runTrialEnsemble(config, days, N, seed, schedule). */
export function runTrialBlock(runners: RecipeRunners, config: SimConfig, days: number, k0: number, n: number, seed: number,
  schedule: number[] | undefined, backend: FitBackend = 'auto'): { perTrial: SimCurves[]; rNaught: number | null } {
  const cells = config.size * config.size; const len = days + 1; const topo = runners.topologyFor(config, seed);
  const canReseed = config.reseedOnExtinction === true; let rNaught: number | null = null; const perTrial: SimCurves[] = [];
  for (let k = k0; k < k0 + n; k++) {
    const trialSeed = (seed ^ ((k * SEED_STRIDE) >>> 0)) >>> 0;
    const indexCell = k === 0 ? undefined : new Rng((trialSeed ^ 0x1dcae511) >>> 0).intRange(cells);
    const engine = runners.engineFor({ ...config, seed: trialSeed }, topo, (k === k0 ? { indexCell, txSchedule: schedule } : { rNaught, indexCell, txSchedule: schedule }) as EngineOptions, backend);
    if (k === k0) rNaught = engine.rNaught;
    const inf = new Float64Array(len); const death = new Float64Array(len); const active = new Float64Array(len);
    const { state } = engine.buffers(); let cumInf = 0; let act = 0;
    for (let i = 0; i < state.length; i++) { const st = state[i]; if (st === CellState.Exposed) cumInf++; else if (st === CellState.Infectious) { cumInf++; act++; } }
    let cumDeath = 0; inf[0] = cumInf; active[0] = act;
    for (let d = 1; d <= days; d++) {
      const stats = engine.step(); cumInf += stats.newInfections; cumDeath += stats.newDeaths; inf[d] = cumInf; death[d] = cumDeath; active[d] = stats.i;
      if (!canReseed && stats.e + stats.i === 0) { for (let f = d + 1; f <= days; f++) { inf[f] = cumInf; death[f] = cumDeath; } break; }
    }
    const inv = 1 / cells;
    perTrial.push({ cumulative_infections: Array.from(inf, (v) => v * inv), cumulative_deaths: Array.from(death, (v) => v * inv), active_infections: Array.from(active, (v) => v * inv) });
  }
  return { perTrial, rNaught };
}

/** Fit trials of one candidate: trials k = 0, 1, … from the default index cell (runTrials seeding). With `survive`, drawn
 *  until K survivors (cumulative infections increase over ticks [w0, w1]) or `cap` trials; the mean is over survivors (all
 *  drawn trials if none). A trial whose cumulative infections exceed `osLimit` at a tick ≤ `osTick` is stopped; ⌈K/2⌉ such
 *  overshoots abort the candidate. Overshooting trials of a candidate that is not aborted are re-run to the end (same seed,
 *  so identical to an unlimited run). */
export function runTrialsIndiv(runners: RecipeRunners, config: SimConfig, days: number, K: number, cap: number, seed: number, schedule: number[] | undefined,
  w0: number, w1: number, survive: boolean, osLimit: number, osTick: number, backend: FitBackend = 'auto'):
  SimResult & { surv: { drawn: number; survivors: number; extinctFirstK: number }; os: { overshot: number; aborted: boolean } } {
  const cells = config.size * config.size; const len = days + 1; const topo = runners.topologyFor(config, seed);
  const canReseed = config.reseedOnExtinction === true; let rNaught: number | null = null;
  const sI = new Float64Array(len), sD = new Float64Array(len), sA = new Float64Array(len);
  const aI = new Float64Array(len), aD = new Float64Array(len), aA = new Float64Array(len);
  let drawn = 0, survivors = 0, extinctFirstK = 0, overshot = 0; const need = Math.ceil(K / 2);
  const inf = new Float64Array(len), death = new Float64Array(len), active = new Float64Array(len);
  const runOne = (k: number, limit: number) => {
    const trialSeed = (seed ^ ((k * SEED_STRIDE) >>> 0)) >>> 0;
    const engine = runners.engineFor({ ...config, seed: trialSeed }, topo, (rNaught === null ? { txSchedule: schedule } : { rNaught, txSchedule: schedule }) as EngineOptions, backend);
    if (rNaught === null) rNaught = engine.rNaught;
    inf.fill(0); death.fill(0); active.fill(0);
    const { state } = engine.buffers(); let cumInf = 0; let act = 0;
    for (let i = 0; i < state.length; i++) { const st = state[i]; if (st === CellState.Exposed) cumInf++; else if (st === CellState.Infectious) { cumInf++; act++; } }
    let cumDeath = 0; inf[0] = cumInf; active[0] = act;
    for (let d = 1; d <= days; d++) {
      const stats = engine.step(); cumInf += stats.newInfections; cumDeath += stats.newDeaths; inf[d] = cumInf; death[d] = cumDeath; active[d] = stats.i;
      if (d <= osTick && cumInf > limit) return false;
      if (!canReseed && stats.e + stats.i === 0) { for (let f = d + 1; f <= days; f++) { inf[f] = cumInf; death[f] = cumDeath; } break; }
    }
    if (runners.onFitTrial) runners.onFitTrial({ attack: config.strain.attackRate, days, schedule: schedule ?? null, k, persons: inf[Math.min(days, w1)] });
    return true;
  };
  const add = (alive: boolean) => {
    for (let d = 0; d < len; d++) { aI[d] += inf[d]; aD[d] += death[d]; aA[d] += active[d]; }
    if (alive) { survivors++; for (let d = 0; d < len; d++) { sI[d] += inf[d]; sD[d] += death[d]; sA[d] += active[d]; } }
  };
  const pending: number[] = [];
  for (let k = 0; survive ? (k < cap && survivors + pending.length < K) : k < K; k++) {
    drawn++;
    if (!runOne(k, osLimit)) { overshot++; pending.push(k); if (overshot >= need) return { curves: { cumulative_infections: [], cumulative_deaths: [], active_infections: [] }, rNaught, surv: { drawn, survivors, extinctFirstK }, os: { overshot, aborted: true } }; continue; }
    const alive = !survive || inf[Math.min(days, w1)] - inf[Math.max(0, Math.min(days, w0))] > 0;
    if (survive && !alive && k < K) extinctFirstK++;
    add(alive);
  }
  for (const k of pending) { runOne(k, Infinity); const alive = !survive || inf[Math.min(days, w1)] - inf[Math.max(0, Math.min(days, w0))] > 0; if (survive && !alive && k < K) extinctFirstK++; add(alive); }
  const useS = survive && survivors > 0; const inv = 1 / ((survive ? (useS ? survivors : drawn) : drawn) * cells);
  const scale = (s: Float64Array) => Array.from(s, (v) => v * inv);
  const curves: SimCurves = useS || !survive ? { cumulative_infections: scale(survive ? sI : aI), cumulative_deaths: scale(survive ? sD : aD), active_infections: scale(survive ? sA : aA) }
    : { cumulative_infections: scale(aI), cumulative_deaths: scale(aD), active_infections: scale(aA) };
  return { curves, rNaught, surv: { drawn, survivors, extinctFirstK }, os: { overshot, aborted: false } };
}

/** Binomial(n, p) from a dedicated Rng (never an engine's stream): exact Bernoulli sum for small n·p·(1 − p) or n ≤ 64,
 *  otherwise a continuity-corrected normal approximation clamped to [0, n]. */
export function binomial(rng: Rng, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0; if (p >= 1) return n;
  if (n <= 64 || n * p * (1 - p) < 12) { let x = 0; for (let i = 0; i < n; i++) if (rng.bernoulli(p)) x++; return x; }
  const v = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * rng.gaussian()); return Math.max(0, Math.min(n, v));
}

/** Lattice sizing from the training prefix (one cell = one person). */
export function recipeSizing(observed: ObservedPoint[], cutoff: number, ind: RecipeIndividual) {
  const [aLo0, , aHi0] = ind.asc; if (!(aLo0 > 0 && aHi0 <= 1 && aLo0 <= aHi0)) throw new Error('individual: asc range');
  const cs0 = observed.filter((p) => p.category === 'cumulative_infections');
  const at0 = (d: number) => { let v = 0; for (const p of cs0) if (p.day <= d) v = p.value; return v; };
  const Ccut = at0(cutoff), lastWk = Ccut - at0(cutoff - 7);
  const B = (ind.H ?? 10) * Math.max(Ccut, 7 * lastWk) / aLo0;
  let side = Math.max(ind.minSide ?? 64, 1 << Math.ceil(Math.log2(Math.max(1, Math.sqrt(B)))));
  const ruleSide = side; let popBound = false, capBound = false;
  if (ind.nAtRisk !== undefined && ind.nAtRisk <= side * side) { side = Math.max(8, 2 * Math.round(Math.sqrt(ind.nAtRisk) / 2)); popBound = true; }
  if (side > (ind.maxSide ?? 1024)) { side = ind.maxSide ?? 1024; capBound = true; }
  const M = side * side;
  return { Ccut, lastWk, B, ruleSide, side, M, popBound, capBound, binding: B > M && (ind.nAtRisk === undefined || ind.nAtRisk > M), osLimit: (ind.osFactor ?? 10) * Math.max(1, Ccut) / aLo0 };
}

// ─── The estimator ────────────────────────────────────────────────────────────────────────────────────────────
//
// The estimator is written once, as a coroutine (`recipeCore`) that asks for its candidate simulations instead of running
// them. It yields groups of independent chains; a chain is a sequence of dependent steps, each step a batch of independent
// simulation requests. Every request is a pure function of its fields (seeded engines; no shared state), every chain reads
// only state fixed before its group started and writes only its own objects, and the core applies all shared bookkeeping
// (trial log, counters, kept-cell order, trial-index counters) after a group, in chain order. A driver may therefore run the
// chains of a group, and the requests of a batch, in any order or concurrently, and the result is the same bit for bit:
//   - runRecipeForecast (below): synchronous, one request after another, chains in order (the benchmark harness uses it);
//   - runRecipeForecastParallel (fit-recipe-parallel.ts): the same core with requests spread over a pool of fit workers.

type Row = { obs: number; sim: number };
type Eval = { loss: number; N: number; rows: Row[]; asc?: number; ascD?: number };

/** One candidate simulation the estimator asks for: `indiv` = runTrialsIndiv (fit trials of a grid cell or phase round),
 *  `block` = runTrialBlock (forecast trials k0 … k0 + n − 1), `mean` = the runners' K-trial mean (damping bisection, training
 *  re-run). A pure function of its fields. */
export type RecipeSimRequest =
  | { kind: 'indiv'; config: SimConfig; days: number; K: number; cap: number; seed: number; schedule: number[] | undefined;
      w0: number; w1: number; survive: boolean; osLimit: number; osTick: number; backend: FitBackend }
  | { kind: 'block'; config: SimConfig; days: number; k0: number; n: number; seed: number; schedule: number[] | undefined; backend: FitBackend }
  | { kind: 'mean'; config: SimConfig; days: number; K: number; seed: number; schedule: number[] | undefined; backend: FitBackend };
type IndivRes = ReturnType<typeof runTrialsIndiv>;
type BlockRes = ReturnType<typeof runTrialBlock>;
export type RecipeSimResponse = IndivRes | BlockRes | SimResult;

/** Runs one request with the given runners (in the calling thread). */
export function execRecipeRequest(runners: RecipeRunners, req: RecipeSimRequest): RecipeSimResponse {
  switch (req.kind) {
    case 'indiv': return runTrialsIndiv(runners, req.config, req.days, req.K, req.cap, req.seed, req.schedule, req.w0, req.w1, req.survive, req.osLimit, req.osTick, req.backend);
    case 'block': return runTrialBlock(runners, req.config, req.days, req.k0, req.n, req.seed, req.schedule, req.backend);
    case 'mean': return runners.meanTrials(req.config, req.days, req.K, req.seed, req.schedule, req.backend);
  }
}

type Batch = RecipeSimRequest[];
/** Dependent steps; each step yields a batch of independent requests and receives their responses in batch order. */
export type RecipeChain<T = unknown> = Generator<Batch, T, RecipeSimResponse[]>;
/** Independent chains. The core receives the chains' return values in chain order. `from`/`to` = the stage's progress span. */
export interface RecipeGroup { stage: 'grid' | 'turns' | 'forecast'; from: number; to: number; chains: RecipeChain[] }
function* simsOf(batch: Batch): Generator<Batch, RecipeSimResponse[], RecipeSimResponse[]> { return yield batch; }
function* groupOf<T>(stage: RecipeGroup['stage'], from: number, to: number, chains: RecipeChain<T>[]): Generator<RecipeGroup, T[], unknown[]> {
  return (yield { stage, from, to, chains }) as T[];
}

/** The recipe on one job, as a coroutine (see above). Deterministic: a pure function of the job and the engines. The
 *  return value carries the forecast paths plus the fit's diagnostics (grid, turns, kept cells, anchors). `env.wasmAvailable`
 *  reports the engines' backend availability for the result (a parallel driver asks its workers). */
export function* recipeCore(job: RecipeJob, env: { wasmAvailable: () => boolean } = { wasmAvailable }) {
  const start = performance.now();
  if (!job.individual || !job.turns || !job.bma || !job.durations) throw new Error('recipe: individual, turns, bma and durations are required');
  if (pooledFitsOf(job) !== 1) throw new Error('recipe: pooledFits > 1 runs through runRecipeForecast or driveRecipe, not recipeCore');
  const c = baseSimConfig(job.basePreset ?? (job.pathogen === 'mpox' ? 'sars2-wild' : (job.pathogen as string)));
  const indOpt = job.individual;
  const indInfo = recipeSizing(job.observed, job.cutoff, indOpt);
  c.size = indInfo.side; c.seed = job.seed; c.geometry = job.geometry ?? 'square';
  if (job.immunityDays !== undefined) c.strain = { ...c.strain, immunityDays: job.immunityDays };
  if (job.susceptibilityCV !== undefined) c.susceptibilityCV = job.susceptibilityCV;
  const dur = job.durations;
  const tnOpt = job.turns;
  const multCap: number = tnOpt.multCap;
  const backend = job.backend as FitBackend;
  const cases = job.observed.filter((p) => p.category === 'cumulative_infections');
  const deaths = job.observed.filter((p) => p.category === 'cumulative_deaths');
  const lastC = (cases.at(-1) as ObservedPoint).value, lastD = deaths.length ? (deaths.at(-1) as ObservedPoint).value : 0;
  const ifr = indOpt.ifr ?? Math.min(0.9, Math.max(0.0001, (deaths.length ? lastD / Math.max(1, lastC) : 0.001) * indOpt.asc[1]));
  let offset = Math.max(0, Math.min(job.offsetMax as number, job.firstCaseGap ?? 0));
  const offGrid: number[] = job.offsetGrid ?? [offset];
  const cpTicks: number[] = (job.changePoints ?? []).map((x) => x.tick);
  if (tnOpt.earlyChangePoint && !cpTicks.length && job.cutoff < 49 && job.cutoff - 14 >= 1) cpTicks.push(job.cutoff - 14);
  const terms = incidentCountTerms(job.observed);
  const horizon = job.horizonDays ?? DEFAULT_HORIZON;
  let simulations = 0; const trials: any[] = [];
  // Training loss: λ = asc × M × share for cases and ascD × M × share for deaths, each scale profiled (Σobs/Σsim) and
  // clamped to its range. N = asc × M is the case scale; deaths rows carry sim × ND/N so N × sim is their λ downstream.
  // `off` = the candidate's start offset (ticks before data day 0).
  const ascDOpt = indOpt.ascD ?? 1;
  const evalTrain = (curves: any, off: number): Eval => {
    const M = c.size * c.size; let soC = 0, ssC = 0, soD = 0, ssD = 0; const raw: { obs: number; sim: number; d: boolean }[] = [];
    for (const t of terms) {
      const cur = curves[t.category]?.[t.day + off], prev = t.previousDay === null ? 0 : curves[t.category]?.[t.previousDay + off];
      if (!Number.isFinite(cur) || !Number.isFinite(prev)) return { loss: Infinity, N: NaN, rows: raw.map(r => ({ obs: r.obs, sim: r.sim })) };
      const sim = Math.max(cur - prev, 0); const d = t.category === 'cumulative_deaths'; raw.push({ obs: t.value, sim, d });
      if (d) { soD += t.value; ssD += sim; } else { soC += t.value; ssC += sim; }
    }
    const [lo, , hi] = indOpt.asc;
    if (!(ssC > 0)) return { loss: Infinity, N: NaN, rows: raw.map(r => ({ obs: r.obs, sim: r.sim })) };
    let asc = Math.min(hi, Math.max(lo, soC / (ssC * M))); let priorPen = 0;
    if (indOpt.ascPrior) {
      const ap = indOpt.ascPrior; const uc = Math.log(indOpt.asc[1]); const sg = typeof ap === 'number' ? ap : Math.log(hi / lo) / 3.29;
      const S = ssC * M; const g = (u: number) => Math.exp(u) * S - soC + (u - uc) / (sg * sg);
      let a = Math.log(lo), b = Math.log(hi); let u: number;
      if (g(a) >= 0) u = a; else if (g(b) <= 0) u = b; else { for (let i = 0; i < 60; i++) { const mid = (a + b) / 2; if (g(mid) > 0) b = mid; else a = mid; } u = (a + b) / 2; }
      asc = Math.exp(u); priorPen = (u - uc) ** 2 / (2 * sg * sg);
    }
    const ascD = typeof ascDOpt === 'number' ? ascDOpt : (ssD > 0 ? Math.min(ascDOpt[2], Math.max(ascDOpt[0], soD / (ssD * M))) : ascDOpt[1]);
    const N = asc * M, ND = ascD * M; let loss = 0;
    const rows = raw.map(r => ({ obs: r.obs, sim: r.d ? r.sim * ND / N : r.sim }));
    for (const r of rows) { const lam = Math.max(N * r.sim, 1e-9); loss += lam - r.obs * Math.log(lam); }
    loss += priorPen;
    return { loss, N, rows, asc, ascD };
  };
  const meanReq = (cfg: SimConfig, d: number, K: number, seed: number, sched: number[] | undefined): RecipeSimRequest => ({ kind: 'mean', config: cfg, days: d, K, seed, schedule: sched, backend });
  const blockReq = (cfg: SimConfig, d: number, k0: number, n: number, sched: number[] | undefined): RecipeSimRequest => ({ kind: 'block', config: cfg, days: d, k0, n, seed: ensSeedB, schedule: sched, backend });
  // Survivor conditioning: active only when the observed case increment over the last SURV_W training days is > 0.
  const survOpt = !!job.survive;
  let survActive = false; let survDataInc = 0;
  if (survOpt) { const obsAt = (d: number) => { let v = 0; for (const p of cases) if (p.day <= d) v = p.value; return v; }; survDataInc = obsAt(job.cutoff) - obsAt(job.cutoff - SURV_W); survActive = survDataInc > 0; }
  const survFit = { candidates: 0, extinctFirstK: 0, toppedUp: 0, capBound: 0, inadmissible: 0, drawn: 0 };
  const indFit = { candidates: 0, overshootTrials: 0, aborted: 0 };
  // One fit candidate (8 trials, survivor-conditioned, overshoot-stopped) at start offset `off` under change points `cps`.
  const simReq = (attack: number, mixing: number, mults: number[], seedFrac: number, off: number, cps: number[]): RecipeSimRequest => {
    const cfg = structuredClone(c); cfg.seedInfections = seedFrac; cfg.strain = { ...cfg.strain, attackRate: attack, incubation: dur.incubation, infectious: dur.infectious, ifr, range: 1, mixing };
    const sched = mults.length ? changePointSchedule(cps, mults, job.cutoff + off + 1, off) : undefined;
    return { kind: 'indiv', config: cfg, days: job.cutoff + off, K: 8, cap: 32, seed: job.seed, schedule: sched, w0: job.cutoff - SURV_W + off, w1: job.cutoff + off,
      survive: survActive, osLimit: indInfo.osLimit, osTick: job.cutoff + off, backend };
  };
  function* simRun(req: RecipeSimRequest) { const [r] = yield* simsOf([req]); return r as IndivRes; }
  // A finished candidate as the fit reads it (pure), and its bookkeeping (applied by the core, in the serial order).
  const simView = (r: IndivRes) => ({ result: r as SimResult, surv: survActive ? r.surv : undefined, aborted: r.os.aborted });
  const simCount = (r: IndivRes) => {
    indFit.candidates++; if (r.os.overshot) indFit.overshootTrials += r.os.overshot; if (r.os.aborted) indFit.aborted++;
    if (survActive) { survFit.candidates++; survFit.extinctFirstK += r.surv.extinctFirstK / 8; survFit.drawn += r.surv.drawn; if (r.surv.drawn > 8) survFit.toppedUp++; if (r.surv.survivors < 8) survFit.capBound++; if (r.surv.survivors === 0) survFit.inadmissible++; }
    simulations++;
  };
  const survOf = new Map<any, { drawn: number; survivors: number; extinctFirstK: number }>();
  // Forecast survivor selection: survivors among `base` (trial-index order), topped up by forecast trials kStart, kStart + 1, …
  // until `target` survivors or `cap` trials; ≥ target → the first `target`; ≥ minUse → all survivors; else `base`. Top-ups are
  // requested in batches of min(survivors still missing, trials left): one draw at a time would draw every one of them too.
  function* survSelect(base: SimCurves[], offs: number, target: number, cap: number, minUse: number, kStart: number, draw: (k: number) => RecipeSimRequest) {
    const w1 = job.cutoff + offs, w0 = Math.max(0, job.cutoff - SURV_W + offs);
    const alive = (cv: SimCurves) => cv.cumulative_infections[w1] - cv.cumulative_infections[w0] > 0;
    const surv = base.filter(alive); const extinct = base.length - surv.length; let drawn = base.length; let k = kStart;
    while (surv.length < target && drawn < cap) {
      const m = Math.min(target - surv.length, cap - drawn); const batch: Batch = [];
      for (let j = 0; j < m; j++) batch.push(draw(k + j));
      for (const r of yield* simsOf(batch)) { const cv = (r as BlockRes).perTrial[0]; k++; drawn++; if (alive(cv)) surv.push(cv); }
    }
    const fallback = surv.length < target && surv.length < minUse;
    const sel = surv.length >= target ? surv.slice(0, target) : fallback ? base : surv;
    return { sel, info: { base: base.length, extinct, drawn, survivors: surv.length, used: sel.length, capBound: surv.length < target, fallback }, next: k };
  }
  const evalSim = (r: { result: SimResult; surv?: { survivors: number }; aborted?: boolean }, off: number): Eval => { if (r.aborted) return { loss: Infinity, N: NaN, rows: [] as Row[] }; const e = evalTrain(r.result.curves, off); return r.surv && r.surv.survivors === 0 ? { loss: Infinity, N: NaN, rows: e.rows } : e; };
  // Grid: offset × attack × mixing (mean-field: mixing 0 only). Every cell is independent.
  const minInd = 0; const cells = c.size * c.size;
  const lastWeekInd = (curves: any, off: number) => { const cum = curves.cumulative_infections; return (cum[job.cutoff + off] - cum[job.cutoff - 7 + off]) * cells; };
  const mults = cpTicks.map(() => 1); const grid: any[] = [];
  const attackGrid: number[] = job.attackGrid ?? [0.02, 0.05, 0.1, 0.2, 0.4];
  const mixGrid: number[] = job.mixingGrid ?? [0, 0.2, 0.5];
  const gridSpec: { off: number; seedFrac: number; attack: number; mixing: number }[] = [];
  for (const off of offGrid) for (const seedFrac of [0]) for (const attack of attackGrid) for (const mixing of (c.geometry === 'meanfield' ? [0] : mixGrid)) gridSpec.push({ off, seedFrac, attack, mixing });
  const gridRaw = yield* groupOf('grid', 0, 1, gridSpec.map((g) => simRun(simReq(g.attack, g.mixing, mults, g.seedFrac, g.off, cpTicks))));
  for (let i = 0; i < gridSpec.length; i++) {
    const { off, seedFrac, attack, mixing } = gridSpec[i]; offset = off;
    simCount(gridRaw[i]); const r = simView(gridRaw[i]); const e = evalSim(r, offset); const ind = lastWeekInd(r.result.curves, offset);
    const share = r.result.curves.cumulative_infections[job.cutoff + offset];
    trials.push({ step: 'grid', attack, mixing, seedFrac, mults: [...mults], loss: e.loss, N: e.N, individuals: ind, share });
    grid.push({ attack, mixing, seedFrac, off: offset, loss: e.loss, N: e.N, rows: e.rows, ind, share, asc: e.asc, ascD: e.ascD });
    if (r.surv) survOf.set(grid[grid.length - 1], r.surv);
  }
  const pool = grid.length ? grid : [grid.reduce((a, b) => (b.share < a.share ? b : a))];
  const admissible = pool.filter(g => g.ind >= minInd && Number.isFinite(g.loss));
  const best: any = admissible.length ? admissible.reduce((a, b) => (b.loss < a.loss ? b : a)) : pool.reduce((a, b) => (b.ind > a.ind ? b : a));
  offset = best.off ?? offset;
  const caseTerms = terms.map((t, i) => ({ t, i })).filter(({ t }) => t.category === 'cumulative_infections');
  const paLog: { cell: number | null; gridLoss: number; rounds: any[] }[] = [];
  // Grid-posterior averaging.
  const bmaOpt = job.bma;
  const T: number = bmaOpt.trials ?? 64; const argmin = best;
  let x2 = 0; for (const r of argmin.rows) { const lam = Math.max(argmin.N * r.sim, bmaOpt.pearsonMinMean); x2 += (r.obs - lam) ** 2 / lam; }
  const dfB = Math.max(1, argmin.rows.length - bmaOpt.dfParams); const phiRaw = x2 / dfB; const phi = Math.max(bmaOpt.phiFloor, phiRaw);
  const gi = new Map(grid.map((g, i) => [g, i]));
  const cand = admissible.length ? [...admissible].sort((a, b) => a.loss - b.loss || (gi.get(a) as number) - (gi.get(b) as number)) : [argmin];
  if (cand[0] !== argmin) throw new Error('bma: argmin ordering');
  const Lmin = argmin.loss;
  // Turns: loss-checked multiplier rounds on the top cells, then weights from the post-turn penalised losses. The rounds of one
  // cell depend on each other; different cells (and different profiled dates) do not.
  const pre = new Map<any, { cb: any; cm: number[]; pl: number; log: any }>();
  const rwPen = tnOpt.rwPenalty ?? 0.5; const [f0, f1] = tnOpt.factor;
  const penOf = (m: number[]) => { let sq = 0, prev = 0; for (const v of m) { const l = Math.log(v); sq += (l - prev) ** 2; prev = l; } return rwPen * sq; };
  const top = cand.slice(0, tnOpt.cells ?? 8);
  const mFloorT: number = tnOpt.multFloor ?? 0.02;
  const propose = (cb: any, cm: number[], gam: number, cps: number[]) => {
    const K = cps.length; const next = [...cm]; const so = new Array(K).fill(0), ss = new Array(K).fill(0);
    for (let k = 0; k < K; k++) {
      const lo = cps[k], hi = k + 1 < K ? cps[k + 1] : Infinity;
      for (const { t, i } of caseTerms) if (t.day > lo && t.day <= hi) { so[k] += cb.rows[i].obs; ss[k] += cb.rows[i].sim * cb.N; }
    }
    for (let k = 0; k < K; k++) if (ss[k] > 0 && so[k] > 0) next[k] = Math.min(multCap, Math.max(mFloorT, cm[k] * Math.pow(Math.min(f1, Math.max(f0, so[k] / ss[k])), gam)));
    return next;
  };
  // One cell's rounds under change points `cps`. Its trial-log entries and candidate bookkeeping are returned, not applied.
  function* runTurns(cell: any, cb: any, cm: number[], cur: number, nR: number, log: any, tag: string, cps: number[]) {
    const off: number = cell.off ?? offset; let gam = 1; const tr: any[] = []; const recs: IndivRes[] = [];
    for (let round = 0; round < nR && cps.length && Number.isFinite(cur); round++) {
      const next = propose(cb, cm, gam, cps);
      if (next.every((v, k) => Math.abs(v - cm[k]) < 1e-9)) break;
      const raw = yield* simRun(simReq(cb.attack, cb.mixing, next, cb.seedFrac ?? 0, off, cps)); recs.push(raw);
      const e = evalSim(simView(raw), off); const pl = e.loss + penOf(next);
      const ok = pl < cur; if (log) log.rounds.push({ round: log.rounds.length + 1, loss: e.loss, pen: pl, N: e.N, gam, accepted: ok, tag });
      tr.push({ step: tag + '-phase' + (round + 1), attack: cb.attack, mixing: cb.mixing, mults: [...next], loss: e.loss, pen: pl, N: e.N, accepted: ok });
      if (!ok) { gam /= 2; if (gam < 0.125) break; continue; }
      gam = 1; cm = next; cur = pl; cb = { ...cb, loss: e.loss, N: e.N, rows: e.rows, mults: [...next], asc: e.asc, ascD: e.ascD };
    }
    return { cb, cm, pl: cur, tr, recs };
  }
  const applyTurns = (cell: any, res: { tr: any[]; recs: IndivRes[] }) => {
    for (const r of res.recs) simCount(r);
    for (const x of res.tr) trials.push(x);
    offset = cell.off ?? offset;
  };
  const nT = top.length + (tnOpt.cpProfile ? 2 : 0);
  const logs = top.map((cell, ci) => ({ cell: ci, gridLoss: cell.loss, rounds: [] as any[] }));
  const tOut = yield* groupOf('turns', 0, top.length / nT, top.map((cell, ci) => runTurns(cell, cell, cpTicks.map(() => 1), cell.loss, tnOpt.rounds, logs[ci], 'turns' + ci, [...cpTicks])));
  for (let ci = 0; ci < top.length; ci++) {
    const cell = top[ci]; const res = tOut[ci]; applyTurns(cell, res);
    pre.set(cell, { cb: res.cb, cm: res.cm, pl: res.pl, log: logs[ci] }); paLog.push(logs[ci]);
  }
  // One extra change point: its date profiled on the post-turns argmin, inserted for every top cell, then refined.
  let cpProf: any = null;
  if (tnOpt.cpProfile) {
    const cpo = tnOpt.cpProfile; const fin = top.filter(g => Number.isFinite((pre.get(g) as any).pl));
    const amC = fin.length ? fin.reduce((a, b) => ((pre.get(b) as any).pl < (pre.get(a) as any).pl ? b : a)) : null;
    const base = [...cpTicks]; const prof: { tau: number; pl: number }[] = [];
    const insertAt = (tau: number) => base.filter(x => x < tau).length;
    const withTau = (cm: number[], pos: number) => [...cm.slice(0, pos), pos > 0 ? cm[pos - 1] : 1, ...cm.slice(pos)];
    if (amC) {
      const A = pre.get(amC) as any; const taus: number[] = [];
      for (let tau = job.cutoff - cpo.from; tau <= job.cutoff - cpo.to; tau += cpo.step) {
        if (tau < (cpo.min ?? 14) || base.includes(tau)) continue;
        taus.push(tau);
      }
      const pOut = yield* groupOf('turns', top.length / nT, (top.length + 1) / nT, taus.map((tau) => {
        const pos = insertAt(tau);
        return runTurns(amC, A.cb, withTau(A.cm, pos), A.pl, cpo.rounds ?? 3, null, 'cpprof' + tau, [...base.slice(0, pos), tau, ...base.slice(pos)]);
      }));
      for (let i = 0; i < taus.length; i++) { applyTurns(amC, pOut[i]); prof.push({ tau: taus[i], pl: pOut[i].pl }); }
    }
    cpTicks.splice(0, cpTicks.length, ...base);
    const bestP = prof.length ? prof.reduce((a, b) => (b.pl < a.pl ? b : a)) : null;
    cpProf = { base, prof, tau: bestP ? bestP.tau : null, gain: bestP && amC ? (pre.get(amC) as any).pl - bestP.pl : null };
    if (bestP) {
      const pos = insertAt(bestP.tau); cpTicks.splice(0, cpTicks.length, ...base.slice(0, pos), bestP.tau, ...base.slice(pos));
      const P = top.map((cell) => pre.get(cell) as any);
      const rOut = yield* groupOf('turns', (top.length + 1) / nT, 1, top.map((cell, ci) => runTurns(cell, P[ci].cb, withTau(P[ci].cm, pos), P[ci].pl, cpo.refine ?? tnOpt.rounds, P[ci].log, 'cpref' + ci, [...cpTicks])));
      for (let ci = 0; ci < top.length; ci++) {
        const res = rOut[ci]; applyTurns(top[ci], res);
        pre.set(top[ci], { cb: res.cb, cm: res.cm, pl: res.pl, log: P[ci].log });
      }
    }
  }
  const post = top.filter(g => Number.isFinite((pre.get(g) as any).pl)).sort((a, b) => (pre.get(a) as any).pl - (pre.get(b) as any).pl || (gi.get(a) as number) - (gi.get(b) as number));
  const am = post.length ? (pre.get(post[0]) as any) : null;
  let x2T = 0; if (am) for (const r of am.cb.rows) { const lam = Math.max(am.cb.N * r.sim, bmaOpt.pearsonMinMean); x2T += (r.obs - lam) ** 2 / lam; }
  const phiT = am ? Math.max(bmaOpt.phiFloor, x2T / Math.max(1, am.cb.rows.length - bmaOpt.dfParams - cpTicks.length)) : 1;
  const wT = (g: any) => Math.exp(-((pre.get(g) as any).pl - am.pl) / phiT);
  const kept = am ? post.filter(g => wT(g) >= bmaOpt.rel).slice(0, bmaOpt.maxCells) : [argmin];
  const turnsInfo = { phi: phiT, x2: x2T, top: top.length, kept: kept.length, argminGridRank: am ? top.indexOf(post[0]) : null, cps: [...cpTicks], cpProfile: cpProf, w: kept.map(g => (am ? wT(g) : 1)) };
  const wk = kept.map(g => (am ? wT(g) : 1)); const wSum = wk.reduce((a, b) => a + b, 0); const q = wk.map(w => (T * w) / wSum);
  const nTr = q.map(Math.floor); let rest = T - nTr.reduce((a, b) => a + b, 0);
  const order = kept.map((_, i) => i).sort((a, b) => (q[b] - nTr[b]) - (q[a] - nTr[a]) || wk[b] - wk[a] || a - b);
  for (const i of order) { if (rest <= 0) break; nTr[i]++; rest--; }
  const ensSeedB = job.fitTopology ? job.seed : (job.seed ^ 0x46555452) >>> 0;
  let paths: number[][] = []; let deathPaths: number[][] | undefined = deaths.length ? [] : undefined;
  let deathPathsSaB: number[][] | undefined = job.stateAnchor && deaths.length ? [] : undefined;
  const cellsOut: any[] = []; let first: any = null;
  // Forecast, per kept cell with trials: (A) damping bisection, then the cell's forecast trials (cell ci owns trial indices
  // k0[ci] … k0[ci] + n − 1); (B) survivor top-ups from the shared index counter kTop (serial: a cell's top-ups start where the
  // previous cell's ended); (C) the anchors, with the state anchor's re-runs (each re-run uses the cell's own indices and its
  // kTop start), and the reporting thinning. (A) and (C) are independent across cells.
  const info0 = kept.map((cell, ci) => ({ off: cell.off, attack: cell.attack, mixing: cell.mixing, loss: cell.loss, dL: cell.loss - Lmin, w: wk[ci] / wSum, trials: nTr[ci], ind: cell.ind, share: cell.share, Ngrid: cell.N } as any));
  const k0Of: number[] = []; { let k0 = 0; for (let ci = 0; ci < kept.length; ci++) { k0Of.push(k0); k0 += nTr[ci]; } }
  const live = kept.map((_, ci) => ci).filter((ci) => nTr[ci] > 0);
  function* forecastSetup(ci: number) {
    const cell = kept[ci]; const n = nTr[ci];
    const offC: number = cell.off ?? offset; const daysC = job.cutoff + offC + horizon;
    const preC = pre.get(cell); if (!preC) throw new Error('recipe: kept cell without turns');
    const cb = preC.cb; const cm = preC.cm;
    const Nc = cb.N;
    const cfgC = structuredClone(c); cfgC.seedInfections = cb.seedFrac ?? 0; cfgC.strain = { ...cfgC.strain, attackRate: cb.attack, incubation: dur.incubation, infectious: dur.infectious, ifr, range: 1, mixing: cb.mixing };
    const held = cpTicks.length ? changePointSchedule(cpTicks, cm, daysC + 1, offC) : undefined;
    const damped = (mPost: number, tau: number, len: number) => {
      const base = held ?? new Array(daysC + 1).fill(1); const mLast = base[job.cutoff + offC];
      return base.slice(0, len).map((m, t) => { const d = t - offC; if (d <= job.cutoff) return m; const w = tau === 0 ? 1 : 1 - Math.exp(-(d - job.cutoff) / tau); return Math.max(0.02, Math.min(multCap, mLast * Math.pow(mPost / mLast, w))); });
    };
    // Damping: m_flat = the constant post-cutoff multiplier under which weeks +2..+3 match the last training week.
    let mF: number | undefined; const tauC: number | undefined = job.dampTau; let sims = 0;
    function* ratio(m: number, len: number) {
      sims++; const [res] = yield* simsOf([meanReq(cfgC, len - 1, 8, job.seed, damped(m, 0, len))]);
      const cum = (res as SimResult).curves.cumulative_infections; const I = (a: number, b: number) => cum[b + offC] - cum[a + offC]; const w0 = I(job.cutoff - 7, job.cutoff); return w0 > 0 ? I(job.cutoff + 7, job.cutoff + 21) / 2 / w0 : NaN;
    }
    if (tauC !== undefined) {
      const len = job.cutoff + offC + 23;
      if (!((yield* ratio(multCap, len)) > 1)) mF = multCap; else if (!((yield* ratio(0.02, len)) < 1)) mF = 0.02;
      else { let lo = Math.log(0.02), hi = Math.log(multCap); for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if ((yield* ratio(Math.exp(mid), len)) > 1) hi = mid; else lo = mid; } mF = Math.exp((lo + hi) / 2); }
    }
    const mH = (held ?? [1])[Math.min((held ?? [1]).length - 1, job.cutoff + offC)];
    const dOn = tauC !== undefined && mF !== undefined && !(job.dampDownOnly && mF >= mH);
    const schedC = dOn ? damped(mF as number, tauC as number, daysC + 1) : held;
    // The cell's forecast trials, one request each (trial k is a pure function of k; the block's R₀ is its first trial's).
    const k0S = k0Of[ci]; const batch: Batch = [];
    for (let j = 0; j < n; j++) batch.push(blockReq(cfgC, daysC, k0S + j, 1, schedC));
    const parts = (yield* simsOf(batch)) as BlockRes[];
    const ens = { perTrial: parts.map((p) => p.perTrial[0]), rNaught: parts[0].rNaught };
    return { ci, cell, n, offC, daysC, preC, cb, cm, Nc, cfgC, held, mF, dOn, schedC, k0S, ens, sims, kTopS: 0, perC: ens.perTrial };
  }
  type Setup = ReturnType<typeof forecastSetup> extends Generator<any, infer R, any> ? R : never;
  const aOut = yield* groupOf('forecast', 0, 0.5, live.map((ci) => forecastSetup(ci)));
  const fa: (Setup | null)[] = kept.map(() => null);
  live.forEach((ci, i) => { fa[ci] = aOut[i]; simulations += aOut[i].sims; });
  function* topUps() {
    let kTop = T; // the shared survivor top-up counter
    for (const ci of live) {
      const a = fa[ci] as Setup; a.kTopS = kTop;
      if (survActive) {
        const sv = yield* survSelect(a.ens.perTrial, a.offC, a.n, 4 * a.n, Math.ceil(a.n / 8), kTop, (k) => blockReq(a.cfgC, a.daysC, k, 1, a.schedC));
        kTop = sv.next; a.perC = sv.sel; info0[ci].survive = { ...sv.info, fit: survOf.get(a.cell) ?? null };
      }
    }
    return kTop;
  }
  yield* groupOf('forecast', 0.5, 0.6, [topUps()]);
  function* forecastAnchors(ci: number) {
    const a = fa[ci] as Setup; const info = info0[ci];
    const { n, offC, daysC, cfgC, held, dOn, schedC, k0S, kTopS, cb, cm, Nc, preC, mF } = a; const perC = a.perC;
    // State anchor (G1): re-run this block's trials with the multiplier × β on the ticks of the last W training days.
    function* saRun(beta: number, W: number) {
      const t0b = job.cutoff - W + offC, t1b = job.cutoff - 1 + offC;
      const bst = (s: number[] | undefined) => { const b0 = s ?? new Array(daysC + 1).fill(1); return b0.map((m, t) => (t >= t0b && t <= t1b ? m * beta : m)); };
      const nd = job.stateAnchor?.noDampUp && beta > 1 && dOn;
      const schedB = bst(nd ? held : schedC);
      const batch: Batch = []; for (let j = 0; j < n; j++) batch.push(blockReq(cfgC, daysC, k0S + j, 1, schedB));
      const e2 = ((yield* simsOf(batch)) as BlockRes[]).map((p) => p.perTrial[0]);
      if (!survActive) return e2;
      return (yield* survSelect(e2, offC, n, 4 * n, Math.ceil(n / 8), kTopS, (k) => blockReq(cfgC, daysC, k, 1, schedB))).sel;
    }
    let dcB: number[][] | undefined;
    const anc: Record<string, number> = {};
    // Persons = share × M; reported = Binomial thinning by asc up to the cutoff and asc·k after it, k the case anchor
    // clamped so asc·k ∈ [lo, hi] ∩ asc·[0.25, 4]. Deaths: Binomial by ascD (none when ascD = 1), then the death anchor.
    const asc = cb.asc ?? Nc / cells; const ascD = cb.ascD ?? (typeof ascDOpt === 'number' ? ascDOpt : ascDOpt[1]);
    const [aLo, , aHi] = indOpt.asc;
    const persons = perC.map(curve => Array.from(curve.cumulative_infections.slice(offC), v => Math.round(v * cells)));
    const dpersons = perC.map(curve => Array.from(curve.cumulative_deaths.slice(offC), v => Math.round(v * cells)));
    let dpBase: number[][] | undefined;
    let kC = 1;
    if (job.anchorLastWeek && cases.length >= 2) {
      const b = cases.at(-1) as ObservedPoint; const a = (job.anchorDays ? ([...cases].reverse().find((p) => p.day <= b.day - (job.anchorDays as number)) ?? cases.at(-2)) : cases.at(-2)) as ObservedPoint;
      const obs = b.value - a.value, mod = asc * persons.reduce((s, p) => s + p[b.day] - p[a.day], 0) / persons.length;
      if (obs > 0 && mod > 0) { kC = Math.min(Math.min(4, aHi / asc), Math.max(Math.max(0.25, aLo / asc), obs / mod)); anc.cases = kC; }
      // Residual r = (obs/mod)/kC when kC sits at its upper bound (with `sym`, also its lower bound); β over the last W
      // days (W 'gen' = round(incubation + infectious), ≥ 7) by up to `iters` power-law secant steps so the window's mean
      // simulated persons grow by r (capped to [1/maxR, maxR]); the closest run is kept and the anchor recomputed on it.
      const sa = job.stateAnchor;
      if (sa && obs > 0 && mod > 0) {
        const kHi = Math.min(4, aHi / asc), kLo = Math.max(0.25, aLo / asc); const raw = obs / mod;
        let rT = 1; if (raw > kHi * (1 + 1e-9)) rT = raw / kHi; else if (sa.sym && raw < kLo * (1 - 1e-9)) rT = raw / kLo;
        const maxR = sa.maxR ?? 4; rT = Math.min(maxR, Math.max(1 / maxR, rT));
        const W = sa.W === 'gen' ? Math.max(7, Math.round(dur.incubation + dur.infectious)) : (sa.W ?? 7);
        const saI: any = { raw, kHi, kLo, rT, W, runs: [] as any[] };
        if (Math.abs(Math.log(rT)) > (sa.tol ?? 0.05)) {
          const win = (pc0: SimCurves[]) => { const ps = pc0.map(curve => Array.from(curve.cumulative_infections.slice(offC), v => Math.round(v * cells))); return { ps, m: ps.reduce((s, p) => s + p[b.day] - p[a.day], 0) / ps.length }; };
          const m0 = mod / asc; let lb = Math.log(rT); let bestR: any = null;
          for (let it = 0; it < (sa.iters ?? 3); it++) {
            lb = Math.max(-Math.log(16), Math.min(Math.log(16), lb));
            const pr = yield* saRun(Math.exp(lb), W); const w2 = win(pr); const ach = w2.m / m0; const err = Math.abs(Math.log(Math.max(1e-9, ach)) - Math.log(rT));
            saI.runs.push({ beta: Math.exp(lb), ach, err });
            if (!bestR || err < bestR.err) bestR = { pr, w2, err, beta: Math.exp(lb), ach };
            if (err < (sa.tol ?? 0.05)) break;
            const g = ach > 0 && Math.abs(Math.log(ach)) > 1e-6 && lb !== 0 ? Math.log(ach) / lb : 1;
            if (g < 0.05 || Math.abs(lb) >= Math.log(16) - 1e-9) { saI.saturated = true; break; } // the window's transmission is saturated
            lb = Math.log(rT) / Math.min(4, Math.max(0.25, g > 0 ? g : 1));
          }
          if (bestR) {
            dpBase = dpersons.map(p => p.slice()); saI.beta = bestR.beta; saI.ach = bestR.ach;
            persons.splice(0, persons.length, ...bestR.w2.ps);
            if (sa.deaths !== 'base') dpersons.splice(0, dpersons.length, ...bestR.pr.map((curve: SimCurves) => Array.from(curve.cumulative_deaths.slice(offC), v => Math.round(v * cells))));
            const mod2 = asc * bestR.w2.m; kC = Math.min(kHi, Math.max(kLo, obs / mod2)); anc.cases = kC; saI.kC = kC;
          }
        }
        info.stateAnchor = saI;
      }
    }
    // Reporting thinning: one dedicated Rng per path, keyed by the path's position after this cell's block (k0 + n).
    const kAfter = k0S + n;
    const thin = (ps: number[][], p0: number, p1: number, salt: number) => ps.map((p, i) => {
      const rng = new Rng(((ensSeedB ^ salt) ^ Math.imul(kAfter + i + 1, 0x9e3779b1)) >>> 0); const out = new Array(p.length); let acc = 0;
      for (let t = 0; t < p.length; t++) { const inc = t === 0 ? p[0] : p[t] - p[t - 1]; acc += binomial(rng, Math.max(0, inc), t <= job.cutoff ? p0 : p1); out[t] = acc; }
      return out;
    });
    const pc = thin(persons, asc, asc * kC, 0x494e4443);
    const dc = deaths.length ? (ascD < 1 ? thin(dpersons, ascD, ascD, 0x494e4444) : dpersons.map(p => p.slice())) : undefined;
    const deathAnchorWindow = () => { const b = deaths.at(-1) as ObservedPoint; const wd = job.anchorDaysDeaths ?? job.anchorDays; const a = (wd ? ([...deaths].reverse().find((p) => p.day <= b.day - wd) ?? deaths.at(-2)) : deaths.at(-2)) as ObservedPoint; return { a, b }; };
    if (job.anchorLastWeek && dc && deaths.length >= 2) {
      const { a, b } = deathAnchorWindow();
      const obs = b.value - a.value, mod = dc.reduce((s, p) => s + p[b.day] - p[a.day], 0) / dc.length;
      if (obs > 0 && mod > 0) { const k = Math.min(4, Math.max(0.25, obs / mod)); anc.deaths = k; for (const p of dc) { const base = p[job.cutoff]; for (let t = job.cutoff + 1; t < p.length; t++) p[t] = base + k * (p[t] - base); } }
    }
    // The same death pipeline on the unboosted run (deathPathsSaBase); equals dc when no boost was applied.
    if (job.stateAnchor && dc) {
      if (!dpBase) dcB = dc.map(p => p.slice());
      else {
        dcB = ascD < 1 ? thin(dpBase, ascD, ascD, 0x494e4444) : dpBase.map(p => p.slice());
        if (job.anchorLastWeek && deaths.length >= 2) {
          const { a, b } = deathAnchorWindow();
          const obs = b.value - a.value, mod = dcB.reduce((s, p) => s + p[b.day] - p[a.day], 0) / dcB.length;
          if (obs > 0 && mod > 0) { const k = Math.min(4, Math.max(0.25, obs / mod)); for (const p of dcB) { const base = p[job.cutoff]; for (let t = job.cutoff + 1; t < p.length; t++) p[t] = base + k * (p[t] - base); } }
        }
      }
    }
    info.indiv = { asc, ascD, kCases: kC, ascPost: asc * kC, shareCut: persons.reduce((s, p) => s + p[job.cutoff], 0) / persons.length / cells, M: cells };
    Object.assign(info, { N: Nc, mults: cm, mFlat: mF ?? null, dampApplied: dOn, anchors: anc, lossPhase: cb.loss });
    info.phaseRejected = preC.log.rounds.filter((x: any) => !x.accepted).length; info.penLoss = preC.pl;
    return { pc, dc, dcB, anc };
  }
  const bOut = yield* groupOf('forecast', 0.6, 0.95, live.map((ci) => forecastAnchors(ci)));
  const fb = new Map(live.map((ci, i) => [ci, bOut[i]]));
  for (let ci = 0; ci < kept.length; ci++) {
    const info = info0[ci]; const a = fa[ci]; const b = fb.get(ci);
    if (!a || !b) { cellsOut.push(info); continue; }
    offset = a.offC;
    paths = paths.concat(b.pc); if (deathPaths && b.dc) deathPaths = deathPaths.concat(b.dc);
    if (deathPathsSaB) deathPathsSaB = deathPathsSaB.concat(b.dcB ?? b.dc ?? []);
    cellsOut.push(info);
    if (ci === 0) first = { cb: a.cb, cm: a.cm, Nc: a.Nc, cfgC: a.cfgC, schedC: a.schedC, offC: a.offC, daysC: a.daysC, mF: a.mF, dOn: a.dOn, anc: b.anc, r0: a.ens.rNaught };
  }
  offset = first.offC;
  const [[trainRes]] = yield* groupOf('forecast', 0.95, 1, [simsOf([meanReq(first.cfgC, job.cutoff + offset, 8, job.seed, first.schedC ? first.schedC.slice(0, job.cutoff + offset + 1) : undefined)])]);
  const trainB = trainRes as SimResult;
  const trainMeanB = Array.from(trainB.curves.cumulative_infections.slice(offset), v => v * first.Nc);
  const NDB = (first.cb.ascD ?? (typeof ascDOpt === 'number' ? ascDOpt : ascDOpt[1])) * cells;
  const trainMeanDeathsB = deaths.length ? Array.from(trainB.curves.cumulative_deaths.slice(offset), v => v * NDB) : undefined;
  const bmaInfo = { phi, phiRaw, x2, df: dfB, rows: argmin.rows.length, candidates: cand.length, kept: kept.length, withTrials: nTr.filter(v => v > 0).length, cells: cellsOut };
  const b0 = first.cb;
  return {
    job, engine: job.backend, wasmAvailable: env.wasmAvailable(), fitMs: performance.now() - start, totalMs: performance.now() - start, simulations, cacheHits: 0, forecastSeed: (job.seed ^ 0x46555452) >>> 0,
    params: [{ name: 'attackRate', label: 'Attack rate', value: b0.attack }, { name: 'mixing', label: 'Mixing', value: b0.mixing }, { name: 'ifr', label: 'IFR', value: ifr }],
    config: first.cfgC as SimConfig, indexOffset: offset as number, offsetMax: job.offsetMax, fittedPopulation: first.Nc as number, transmissionMultipliers: first.cm as number[], changePoints: job.changePoints ?? [], penalty: 0,
    fitLoss: b0.loss as number, awarenessInfo: null, persistInfo: null, anchors: first.anc as Record<string, number>, anchorWide: false, resampleInfo: null, extinctInfo: null, gridShare: b0.share as number, seedFrac: b0.seedFrac ?? 0, dampApplied: first.dOn as boolean, trendInfo: null, minIndividuals: minInd, gridIndividuals: b0.ind as number, dampTau: job.dampTau ?? null, mFlat: (first.mF ?? null) as number | null, r0: first.r0 as number | null, r0CI: null, ifr, arm: 'manual', optimizer: 'manual', trials, casesFrames: [], deathsFrames: [],
    trainMean: trainMeanB, trainMeanDeaths: trainMeanDeathsB, paths, deathPaths, mapPaths: paths, mapDeathPaths: deathPaths, bmaInfo,
    ...(deathPathsSaB ? { deathPathsSaBase: deathPathsSaB } : {}),
    ...(survOpt ? { surviveInfo: survActive ? { active: true, dataInc: survDataInc, fit: survFit, chosen: survOf.get(argmin) ?? null, cells: cellsOut.map(x => x.survive ?? null) } : { active: false, dataInc: survDataInc } } : {}),
    phaseAcceptInfo: paLog,
    indivInfo: { ...indInfo, fit: indFit },
    turnsInfo,
  };
}
/** One estimator run's result (the return value of `recipeCore`). */
export type RecipeCoreResult = ReturnType<typeof recipeCore> extends Generator<any, infer R, any> ? R : never;
/** Pooled fits: the seeds and each fit's own result, in fit order (fit 0 = the job's seed). */
export interface RecipePool { fits: number; seeds: number[]; results: RecipeCoreResult[] }
/** A driver's result: one estimator run, or with `job.pooledFits` > 1 the pooled forecast (`pool` set; see poolRecipeResults). */
export type RecipeResult = RecipeCoreResult & { pool?: RecipePool };

// ─── Pooled fits (opt-in, off by default) ─────────────────────────────────────────────────────────────────────
//
// With `job.pooledFits` = K > 1 the drivers run K independent estimator runs of the job that differ only in seed (fit j at
// seed + POOL_SEED_STEP·j; fit 0 is exactly the single run) and pool their forecast trials by plain concatenation in fit order.
// Nothing is reweighted or resampled: the pooled sample has K × 64 trials. Absent or 1, the drivers run the single estimator
// exactly as before (same requests, same random streams, same result).

/** Seed step between pooled fits. */
export const POOL_SEED_STEP = 100;
/** Largest accepted `pooledFits`. */
export const POOL_MAX_FITS = 8;

/** The job's pooled-fit count: 1 when absent; an integer in [1, POOL_MAX_FITS] otherwise (anything else throws). */
export function pooledFitsOf(job: Pick<RecipeJob, 'pooledFits'>): number {
  const k = job.pooledFits;
  if (k === undefined) return 1;
  if (!Number.isInteger(k) || k < 1 || k > POOL_MAX_FITS) throw new Error(`recipe: pooledFits must be an integer in [1, ${POOL_MAX_FITS}]`);
  return k;
}

/** The estimator runs of a job: [job] itself when pooledFits is absent or 1; otherwise K copies without `pooledFits`, copy j
 *  at seed (job.seed + POOL_SEED_STEP·j) >>> 0 (copy 0 keeps the job's seed). Every other field is shared unchanged. */
export function pooledFitJobs(job: RecipeJob): RecipeJob[] {
  const K = pooledFitsOf(job);
  if (K === 1) return [job];
  return Array.from({ length: K }, (_, j) => {
    const sub: RecipeJob = { ...job, seed: j === 0 ? job.seed : (job.seed + POOL_SEED_STEP * j) >>> 0 };
    delete sub.pooledFits;
    return sub;
  });
}

/** Pools K fits of `job` (from pooledFitJobs, in that order). Forecast paths (cases, deaths, state-anchor base deaths and the
 *  map copies) are the concatenation of the fits' paths in fit order; every other field (fitted settings, diagnostics,
 *  training means) is fit 0's, and `simulations` is the total. `ms` = the pooled run's time. Each fit's own result is kept
 *  in `pool.results`. */
export function poolRecipeResults(job: RecipeJob, fits: RecipeCoreResult[], ms?: number): RecipeResult {
  if (!fits.length) throw new Error('recipe: nothing to pool');
  const A = fits[0];
  const cat = (pick: (r: RecipeCoreResult) => number[][] | undefined) => fits.flatMap((r) => pick(r) ?? []);
  const paths = cat((r) => r.paths);
  const deathPaths = A.deathPaths ? cat((r) => r.deathPaths) : undefined;
  const out: RecipeResult = {
    ...A, job, paths, deathPaths, mapPaths: paths, mapDeathPaths: deathPaths,
    simulations: fits.reduce((s, r) => s + r.simulations, 0),
    fitMs: ms ?? fits.reduce((s, r) => s + r.fitMs, 0), totalMs: ms ?? fits.reduce((s, r) => s + r.totalMs, 0),
    pool: { fits: fits.length, seeds: fits.map((r) => r.job.seed), results: fits },
  };
  if (A.deathPathsSaBase) out.deathPathsSaBase = cat((r) => r.deathPathsSaBase);
  return out;
}

/** Progress of K pooled fits as one run: per stage, the mean of the fits' fractions of that stage. */
export function pooledProgress(K: number, onProgress: (stage: 'grid' | 'turns' | 'forecast', frac: number) => void) {
  const at = { grid: new Array<number>(K).fill(0), turns: new Array<number>(K).fill(0), forecast: new Array<number>(K).fill(0) };
  return (j: number, stage: 'grid' | 'turns' | 'forecast', frac: number) => {
    at[stage][j] = frac; onProgress(stage, at[stage].reduce((a, b) => a + b, 0) / K);
  };
}

/** Runs the recipe on one job, synchronously in the calling thread: every request in order, chains in order. With the same
 *  runners this is the original single-thread estimator call for call (grid cells, then each cell's rounds, …). With
 *  `job.pooledFits` > 1, the fits run one after another and are pooled (poolRecipeResults). */
export function runRecipeForecast(job: RecipeJob, runners: RecipeRunners = defaultRecipeRunners()): RecipeResult {
  const jobs = pooledFitJobs(job);
  if (jobs.length === 1) return runRecipeOnce(job, runners);
  const t0 = performance.now(); const prog = runners.onProgress ? pooledProgress(jobs.length, runners.onProgress) : null;
  const fits = jobs.map((j, i) => runRecipeOnce(j, prog ? { ...runners, onProgress: (stage, frac) => prog(i, stage, frac) } : runners));
  return poolRecipeResults(job, fits, performance.now() - t0);
}

function runRecipeOnce(job: RecipeJob, runners: RecipeRunners): RecipeCoreResult {
  const core = recipeCore(job);
  let step = core.next();
  while (!step.done) {
    const g = step.value; const outs: unknown[] = [];
    for (let i = 0; i < g.chains.length; i++) {
      const ch = g.chains[i]; let s = ch.next();
      while (!s.done) s = ch.next(s.value.map((req) => execRecipeRequest(runners, req)));
      outs.push(s.value);
      if (runners.onProgress) runners.onProgress(g.stage, g.from + ((g.to - g.from) * (i + 1)) / g.chains.length);
    }
    step = core.next(outs);
  }
  return step.value;
}

// ─── App-facing inputs, defaults and summary ──────────────────────────────────────────────────────────────────

/** What the app knows about an outbreak. Every optional field falls back to RECIPE_DEFAULTS (or the strain genes). */
export interface RecipeInputs {
  /** Cumulative reported cases (and optionally deaths), day 0 = the first day of the series. */
  observed: ObservedPoint[];
  /** Last training day (default: the last observed day). Points after it are ignored. */
  cutoff?: number;
  /** App preset id the base world comes from (engine defaults, defences off). */
  presetId: string;
  /** Strain genes: durations always, IFR as the deaths link when deaths are observed. */
  strain: { incubation: number; infectious: number; ifr: number };
  /** Days to forecast past the cutoff. */
  horizonDays: number;
  seed: number;
  /** Per-outbreak overrides. */
  ascertainment?: [number, number, number];
  populationAtRisk?: number;
  /** Engine IFR for the deaths link (default: strain.ifr when deaths are observed). */
  ifr?: number;
  maxSide?: number;
  geometry?: SimConfig['geometry'];
  susceptibilityCV?: number;
  attackGrid?: number[];
  /** Days between the start of the series and its first report (default 0). */
  firstCaseGap?: number;
  backend?: FitBackend;
  /** Pooled fits (opt-in; default 1 = off): see RecipeJob.pooledFits. 1 leaves the job without the field. */
  pooledFits?: number;
}

/** Generic change points every `every` days back from the cutoff, first segment ≥ `firstSegment` days. */
export function genericChangePoints(cutoff: number, every = RECIPE_DEFAULTS.changePointEvery, firstSegment = RECIPE_DEFAULTS.firstSegmentDays): { tick: number }[] {
  const t: { tick: number }[] = [];
  for (let k = 1; cutoff - every * k >= firstSegment; k++) t.unshift({ tick: cutoff - every * k });
  return t;
}

/** Builds the validated recipe job from app inputs and RECIPE_DEFAULTS. */
export function recipeJob(inp: RecipeInputs): RecipeJob {
  const cutoff = inp.cutoff ?? Math.max(...inp.observed.map((p) => p.day));
  const observed = inp.observed.filter((p) => p.day <= cutoff && (p.category === 'cumulative_infections' || p.category === 'cumulative_deaths'));
  if (observed.filter((p) => p.category === 'cumulative_infections').length < 2) throw new Error('recipe: needs at least two case reports up to the cutoff');
  const a = inp.ascertainment ?? RECIPE_DEFAULTS.ascertainment;
  const asc: [number, number, number] = [a[0], Math.min(a[1], Math.min(a[2], 1)), Math.min(a[2], 1)];
  const hasDeaths = observed.some((p) => p.category === 'cumulative_deaths');
  const ifr = inp.ifr ?? (hasDeaths ? inp.strain.ifr : undefined);
  const gap = Math.max(0, inp.firstCaseGap ?? 0);
  const S = RECIPE_SETTINGS;
  return {
    pathogen: inp.presetId, basePreset: inp.presetId,
    durations: { incubation: inp.strain.incubation, infectious: inp.strain.infectious },
    immunityDays: RECIPE_DEFAULTS.immunityDays, cutoff, observed, firstCaseGap: gap, offsetMax: Math.max(RECIPE_DEFAULTS.offsetMaxFloor, gap),
    changePoints: genericChangePoints(cutoff), seed: inp.seed >>> 0, backend: inp.backend ?? 'auto', horizonDays: inp.horizonDays,
    anchorLastWeek: true, anchorDays: S.anchorDays, dampTau: S.dampTau, dampDownOnly: true, offsetGrid: [...RECIPE_DEFAULTS.offsetGrid],
    bma: { ...S.bma }, phaseAccept: true, survive: S.survive,
    individual: { asc, ...(ifr !== undefined ? { ifr } : {}), ...(inp.populationAtRisk !== undefined ? { nAtRisk: inp.populationAtRisk } : {}), maxSide: inp.maxSide ?? RECIPE_DEFAULTS.maxSide, ascPrior: S.ascPrior },
    turns: { ...S.turns, factor: [...S.turns.factor] as [number, number], cpProfile: { ...S.turns.cpProfile } },
    mixingGrid: [...S.mixingGrid],
    ...(inp.geometry ? { geometry: inp.geometry } : {}),
    ...(inp.susceptibilityCV !== undefined ? { susceptibilityCV: inp.susceptibilityCV } : {}),
    ...(inp.attackGrid ? { attackGrid: [...inp.attackGrid] } : {}),
    stateAnchor: { ...S.stateAnchor },
    ...(inp.pooledFits !== undefined && pooledFitsOf(inp) !== 1 ? { pooledFits: inp.pooledFits } : {}),
  };
}

/** Compact, transferable summary for the UI: forecast percentile rows (ENSEMBLE_PROBS order) per category on data days
 *  0 … cutoff + horizon, plus the fitted settings. */
export interface RecipeSummary {
  cutoff: number;
  side: number;
  probs: number[];
  bands: Partial<Record<FitCategory, number[][]>>;
  paths: number[][];
  deathPaths?: number[][];
  params: { attackRate: number; mixing: number; ifr: number };
  ascertainment: number;
  indexOffset: number;
  transmissionMultipliers: number[];
  changePoints: number[];
  r0: number | null;
  cellsKept: number;
  simulations: number;
  ms: number;
  /** Pooled fits only: the number of fits whose trials make up `paths` (fitted settings are the first fit's). */
  pooledFits?: number;
}
export function summarizeRecipe(r: RecipeResult): RecipeSummary {
  const band = (ps: number[][]) => percentileBands(ps.map((p) => ({ cumulative_infections: p, cumulative_deaths: p, active_infections: p })), ENSEMBLE_PROBS).cumulative_infections;
  const bands: Partial<Record<FitCategory, number[][]>> = { cumulative_infections: band(r.paths) };
  if (r.deathPaths && r.deathPaths.length) bands.cumulative_deaths = band(r.deathPaths);
  const cell0 = r.bmaInfo.cells.find((x: any) => x.trials > 0);
  return {
    cutoff: r.job.cutoff, side: r.indivInfo.side, probs: [...ENSEMBLE_PROBS], bands, paths: r.paths, deathPaths: r.deathPaths,
    params: { attackRate: r.params[0].value, mixing: r.params[1].value, ifr: r.ifr }, ascertainment: cell0?.indiv?.asc ?? NaN,
    indexOffset: r.indexOffset, transmissionMultipliers: r.transmissionMultipliers, changePoints: r.turnsInfo.cps, r0: r.r0,
    cellsKept: r.bmaInfo.withTrials, simulations: r.simulations, ms: r.totalMs,
    ...(r.pool ? { pooledFits: r.pool.fits } : {}),
  };
}

/** Worker protocol for the recipe estimator (fit.worker.ts). */
export interface RecipeWorkerCommand { kind: 'recipe'; id: number; job: RecipeJob; progress?: boolean }
export type RecipeWorkerMessage =
  | { kind: 'recipe-progress'; id: number; stage: 'grid' | 'turns' | 'forecast'; frac: number }
  | { kind: 'recipe-result'; id: number; ok: true; summary: RecipeSummary }
  | { kind: 'recipe-result'; id: number; ok: false; error: string };

/** Worker protocol for one candidate simulation of the parallel driver (fit-recipe-parallel.ts). `wasm` = the worker's
 *  wasmAvailable() after the request, reported in the result like the synchronous estimator's own. */
export interface RecipeSimCommand { kind: 'recipe-sim'; id: number; req: RecipeSimRequest }
export type RecipeSimMessage =
  | { kind: 'recipe-sim-result'; id: number; ok: true; res: RecipeSimResponse; wasm: boolean }
  | { kind: 'recipe-sim-result'; id: number; ok: false; error: string };
