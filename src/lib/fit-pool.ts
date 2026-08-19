// Worker pool for the R₀ Estimator. Spreads candidate simulations across a
// handful of headless `fit.worker.ts` instances so the optimizer's grid scan and
// Nelder–Mead refine run in parallel. Results are memoized by a quantized config
// key, so the grid and the refine reuse overlapping candidates for free.
//
// This pool is wholly separate from `App`'s single live simulation worker — it
// owns its own workers and tears them down on `dispose()`.

import type { FitWorkerCommand, FitWorkerResult, SimConfig } from '../types';
import type { SimResult } from './fit';
import { clamp } from './fit';

interface Job {
  cmd: FitWorkerCommand;
  key: string;
  resolve: (result: SimResult) => void;
}

function poolSize(): number {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.round(clamp(hc, 2, 8));
}

function toResult(r: FitWorkerResult): SimResult {
  return {
    curves: {
      cumulative_infections: r.curves.cumulative_infections,
      cumulative_deaths: r.curves.cumulative_deaths,
      active_infections: r.curves.active_infections,
    },
    rNaught: r.rNaught,
    perTrial: r.perTrial,
  };
}

// Quantize the fit-relevant fields so near-identical candidates (and grid/refine
// overlaps) hit the cache. Only strain genes vary during a fit; seed/size/days/K
// are constant per run, but we include them so the key is self-contained.
function cacheKey(cmd: FitWorkerCommand): string {
  const g = cmd.config.strain;
  const q = (x: number, p = 1e4) => Math.round(x * p) / p;
  return [
    cmd.ensemble ? 'E' : 'M', // ensemble and mean results must never collide
    cmd.days,
    cmd.K,
    cmd.seed,
    cmd.config.size,
    cmd.config.geometry ?? 'square',
    q(g.attackRate),
    Math.round(g.range),
    q(g.incubation, 100),
    q(g.infectious, 100),
    q(g.ifr),
  ].join('|');
}

export class FitPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private inFlight = new Map<Worker, Job>();
  private pending = new Map<number, (result: SimResult) => void>();
  private cache = new Map<string, SimResult>();
  private nextId = 1;

  constructor(size = poolSize()) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('../worker/fit.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<FitWorkerResult>) => this.onMessage(w, ev.data);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Run K trials of `config` for `days` days; resolves to mean per-capita curves
   *  plus the candidate's analytic R₀. */
  simulate(config: SimConfig, days: number, K: number, seed: number): Promise<SimResult> {
    return this.enqueue({ id: this.nextId++, config, days, K, seed });
  }

  /** Run N trials each from a different index case; resolves with `perTrial`
   *  populated (for percentile/fan-chart aggregation). */
  simulateEnsemble(config: SimConfig, days: number, N: number, seed: number): Promise<SimResult> {
    return this.enqueue({ id: this.nextId++, config, days, K: N, seed, ensemble: true });
  }

  private enqueue(cmd: FitWorkerCommand): Promise<SimResult> {
    const key = cacheKey(cmd);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    return new Promise<SimResult>((resolve) => {
      this.queue.push({ cmd, key, resolve });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const job = this.queue.shift()!;
      // A duplicate may have been cached while queued.
      const cached = this.cache.get(job.key);
      if (cached) { job.resolve(cached); continue; }
      const w = this.idle.shift()!;
      this.inFlight.set(w, job);
      this.pending.set(job.cmd.id, job.resolve);
      w.postMessage(job.cmd);
    }
  }

  private onMessage(w: Worker, result: FitWorkerResult): void {
    const job = this.inFlight.get(w);
    const resolve = this.pending.get(result.id);
    this.inFlight.delete(w);
    this.pending.delete(result.id);
    this.idle.push(w);
    if (job && resolve) {
      const out = toResult(result);
      this.cache.set(job.key, out);
      resolve(out);
    }
    this.pump();
  }

  /** Terminate all workers and drop caches. */
  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.inFlight.clear();
    this.pending.clear();
    this.cache.clear();
  }
}
