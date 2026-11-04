// Parallel driver for the individual-scale recipe estimator (fit-recipe.ts). Opt-in and off by default: nothing in the app
// calls it unless asked to.
//
// The estimator is one coroutine (`recipeCore`); this driver runs it with its candidate simulations spread over a pool of fit
// workers (fit.worker.ts, command `recipe-sim`). The independent work runs concurrently: the grid cells, the top cells'
// phase rounds (each cell's rounds stay in order), the profiled change-point dates, each kept cell's damping bisection,
// the forecast trials, survivor top-ups and the state-anchor re-runs. Everything the result depends on (the trial log,
// counters, kept-cell order, floating-point sums) is applied by the core after each group, in the same order as the
// synchronous `runRecipeForecast`, so the result is identical bit for bit for any number of workers. Pooled fits (opt-in
// `job.pooledFits`) run as concurrent cores on the same pool: K× the work, so about the wall time of one fit when the pool
// has K× the workers one fit keeps busy (a single fit also leaves workers idle at its group barriers, which the others fill).
//
// Its own pool rather than FitPool: FitPool memoizes by a quantized key that would not separate these requests (trial
// windows, overshoot limits, trial indices), lives as long as the R₀ Estimator, and is sized for that estimator. A recipe run
// needs no cache, its workers hold one engine each (about 250 MB at 512²), and they are released when the run ends.

import {
  poolRecipeResults, pooledFitJobs, pooledProgress, recipeCore, type RecipeCoreResult, type RecipeJob, type RecipeResult,
  type RecipeSimCommand, type RecipeSimMessage, type RecipeSimRequest, type RecipeSimResponse,
} from './fit-recipe';

/** Default worker count: hardwareConcurrency − 1 (one core stays with the page), at most 8, at least 1. */
export function defaultRecipeWorkers(hardwareConcurrency?: number): number {
  const hc = hardwareConcurrency ?? ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2);
  return Math.max(1, Math.min(8, Math.floor(hc) - 1));
}

/** Runs candidate simulations. `wasmAvailable` reports the executing engines' backend availability. */
export interface RecipeExecutor {
  run(req: RecipeSimRequest): Promise<RecipeSimResponse>;
  wasmAvailable(): boolean;
}

interface Pending { cmd: RecipeSimCommand; resolve: (r: RecipeSimResponse) => void; reject: (e: Error) => void }

/** A pool of fit workers for the recipe's candidate simulations: first come, first served, one request per worker. */
export class RecipeWorkerPool implements RecipeExecutor {
  readonly size: number;
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Pending[] = [];
  private inFlight = new Map<Worker, Pending>();
  private nextId = 1;
  private wasm = false;
  private closed: Error | null = null;

  constructor(size = defaultRecipeWorkers()) {
    this.size = Math.max(1, Math.floor(size));
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL('../worker/fit.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<RecipeSimMessage>) => this.onMessage(w, ev.data);
      w.onerror = (ev: ErrorEvent) => { ev.preventDefault(); this.fail(new Error('recipe worker error: ' + (ev.message || 'unknown'))); };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(req: RecipeSimRequest): Promise<RecipeSimResponse> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd: { kind: 'recipe-sim', id: this.nextId++, req }, resolve, reject });
      this.pump();
    });
  }

  wasmAvailable(): boolean { return this.wasm; }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const job = this.queue.shift() as Pending; const w = this.idle.shift() as Worker;
      this.inFlight.set(w, job);
      w.postMessage(job.cmd);
    }
  }

  private onMessage(w: Worker, m: RecipeSimMessage): void {
    const job = this.inFlight.get(w);
    this.inFlight.delete(w);
    this.idle.push(w);
    if (job && job.cmd.id === m.id) {
      if (m.ok) { this.wasm = m.wasm; job.resolve(m.res); } else job.reject(new Error(m.error));
    }
    this.pump();
  }

  private fail(err: Error): void {
    if (!this.closed) this.closed = err;
    for (const [, job] of this.inFlight) job.reject(err);
    for (const job of this.queue) job.reject(err);
    this.inFlight.clear();
    this.queue = [];
  }

  /** Terminates every worker; pending and later requests are rejected. */
  dispose(): void {
    for (const w of this.workers) { w.onmessage = null; w.onerror = null; w.terminate(); }
    this.workers = [];
    this.idle = [];
    this.fail(new Error('recipe cancelled'));
  }
}

/** Runs the recipe core with `exec` running the requests: every chain of a group concurrently, every request of a batch
 *  concurrently. The core applies results in its fixed order, so completion order does not matter. With `job.pooledFits` > 1
 *  the fits (pooledFitJobs) run concurrently on the same executor, each applying its own results in its own fixed order, and
 *  are pooled (poolRecipeResults): the same result as the synchronous `runRecipeForecast` bit for bit. If one fit fails, the
 *  others stop at their next step and the run rejects. */
export async function driveRecipe(job: RecipeJob, exec: RecipeExecutor,
  onProgress?: (stage: 'grid' | 'turns' | 'forecast', frac: number) => void): Promise<RecipeResult> {
  const jobs = pooledFitJobs(job);
  if (jobs.length === 1) return driveOne(job, exec, onProgress);
  const t0 = performance.now(); const prog = onProgress ? pooledProgress(jobs.length, onProgress) : null;
  const stop: { err: unknown } = { err: null };
  const fits = await Promise.all(jobs.map((j, i) =>
    driveOne(j, exec, prog ? (stage, frac) => prog(i, stage, frac) : undefined, stop).catch((e) => { if (!stop.err) stop.err = e; throw e; })));
  return poolRecipeResults(job, fits, performance.now() - t0);
}

async function driveOne(job: RecipeJob, exec: RecipeExecutor,
  onProgress?: (stage: 'grid' | 'turns' | 'forecast', frac: number) => void, stop?: { err: unknown }): Promise<RecipeCoreResult> {
  const core = recipeCore(job, { wasmAvailable: () => exec.wasmAvailable() });
  let step = core.next();
  while (!step.done) {
    const g = step.value; let done = 0;
    const outs = await Promise.all(g.chains.map(async (ch) => {
      let s = ch.next();
      while (!s.done) {
        if (stop?.err) throw stop.err;
        s = ch.next(await Promise.all(s.value.map((req) => exec.run(req))));
      }
      done++;
      if (onProgress) onProgress(g.stage, g.from + ((g.to - g.from) * done) / g.chains.length);
      return s.value;
    }));
    step = core.next(outs);
  }
  return step.value;
}

export interface RecipeParallelOptions {
  /** Worker count (default `defaultRecipeWorkers()`). Ignored when `executor` is given. */
  workers?: number;
  /** Runs the requests instead of a new worker pool (the caller owns it). */
  executor?: RecipeExecutor;
  onProgress?: (stage: 'grid' | 'turns' | 'forecast', frac: number) => void;
  /** Aborting terminates the pool and rejects the run. */
  signal?: AbortSignal;
}

/** The recipe estimator with its candidate simulations spread over `workers` fit workers. Same result as
 *  `runRecipeForecast(job)` (default runners) bit for bit, for any worker count. Runs on the calling thread between
 *  requests (bookkeeping only); the simulations run in the workers. */
export async function runRecipeForecastParallel(job: RecipeJob, opts: RecipeParallelOptions = {}): Promise<RecipeResult> {
  const pool = opts.executor ? null : new RecipeWorkerPool(opts.workers ?? defaultRecipeWorkers());
  const exec = opts.executor ?? (pool as RecipeWorkerPool);
  const abort = () => pool?.dispose();
  if (opts.signal) { if (opts.signal.aborted) abort(); else opts.signal.addEventListener('abort', abort, { once: true }); }
  try {
    return await driveRecipe(job, exec, opts.onProgress);
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    pool?.dispose();
  }
}
