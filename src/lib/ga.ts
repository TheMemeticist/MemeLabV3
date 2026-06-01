// ─── Genetic-algorithm optimizer for the R₀ Estimator ───────────────────────
//
// A global, population-based alternative to `fit.ts`'s local search (grid/LHS →
// Nelder–Mead). On the rugged, stochastic, multimodal loss surfaces MemeLab
// produces — Voronoi "settlements" especially — the local refiner traps in
// corners and *worsens* as parameters are added. A GA searches the whole space:
// it breeds a population of candidate genomes, selects the fittest, recombines
// and mutates them, generation after generation.
//
// This is deliberately the same machinery the simulation itself uses to evolve
// strains: the mutation operator mirrors `StrainPool.spawnChild` (per-gene
// Bernoulli-gated Gaussian drift, `src/sim/strain.ts`). The fit becomes a literal
// natural-selection search over disease genomes.
//
// `runGA` is a drop-in for `optimize`: same injected `evaluate(values, K)`
// objective, same seeded determinism, same `OptimizeResult` return — so `runFit`
// dispatches between them and everything downstream (loss, CI, R₀, the live
// overlay via the injected objective) is reused unchanged.

import type { FitParamDef, GridSample, OptimizeResult } from './fit';
import { clamp, latinHypercube } from './fit';
import { Rng } from '../sim/rng';

export interface GAOptions {
  params: FitParamDef[];
  /** Objective at a chosen trial count K (routes through the worker pool; the pool
   *  memoizes by (genes, K), so carried elites and repeats are free). */
  evaluate: (values: number[], K: number) => Promise<number>;
  /** Full-fidelity trial count — the final generations + the returned best run here. */
  Kfull: number;
  /** Seed for the deterministic GA RNG. */
  seed: number;
  /** Population size (default 40). */
  population?: number;
  /** Generations (default 25). */
  generations?: number;
  /** Per-gene mutation probability (default 0.2). */
  mutationRate?: number;
  /** Per-pair crossover probability (default 0.9). */
  crossoverRate?: number;
  /** Elite genomes carried unchanged each generation (default 2). */
  elitism?: number;
  /** Tournament size for selection (default 3). */
  tournament?: number;
  /** Trial count for the earliest generation; ramps up to Kfull (default ⌈Kfull/4⌉). */
  K0?: number;
  /** Stop early after this many generations with no global-best improvement. */
  patience?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: { aborted: boolean };
}

export async function runGA(opts: GAOptions): Promise<OptimizeResult> {
  const { params, evaluate, Kfull } = opts;
  const P = Math.max(8, Math.round(opts.population ?? 40));
  const G = Math.max(1, Math.round(opts.generations ?? 25));
  const mutRate = opts.mutationRate ?? 0.2;
  const pc = opts.crossoverRate ?? 0.9;
  const t = Math.max(2, Math.round(opts.tournament ?? 3));
  const E = Math.min(Math.max(0, Math.round(opts.elitism ?? 2)), P - 1);
  const K0 = Math.max(1, Math.min(opts.K0 ?? Math.max(4, Math.ceil(Kfull / 4)), Kfull));
  const patience = Math.max(1, Math.round(opts.patience ?? Math.max(6, Math.round(G / 3))));
  // Refresh the worst ~10% with fresh blood each generation so the rugged surface
  // can't prematurely converge; never crowd out the elites.
  const immigrants = Math.min(Math.floor(P * 0.1), Math.max(0, P - E - 1));

  const rng = new Rng((opts.seed ^ 0x6a17ec05) >>> 0);
  const decode = (v: number[]): number[] => v.map((x, i) => clampGene(params[i], x));

  // Generation g runs at K_g, ramping K0 → Kfull and pinning the final ~20% of
  // generations at full fidelity so selection there is accurate. (Cheap, noisy
  // early exploration; precise late exploitation — the "many trials" engine.)
  const rampSpan = Math.max(1, Math.ceil(G * 0.8) - 1);
  const Kat = (g: number): number => {
    if (G <= 1) return Kfull;
    const k = Math.round(K0 + (Kfull - K0) * Math.min(1, g / rampSpan));
    return Math.max(1, Math.min(Kfull, k));
  };
  // Mutation step anneals from broad (explore) to fine (exploit), as a fraction of
  // each gene's bound range.
  const mutScaleAt = (g: number): number => (G <= 1 ? 0.1 : 0.18 - 0.15 * (g / (G - 1)));

  const total = P * G;
  let done = 0;
  const tick = (): void => { done++; opts.onProgress?.(Math.min(done, total), total); };

  // Seed: Latin-hypercube spread + one bound-midpoint individual (warm start).
  let pop: number[][] = latinHypercube(params, P, rng).map(decode);
  pop[0] = decode(params.map((p) => (p.bounds[0] + p.bounds[1]) / 2));

  // Global best refined at Kfull. The final generations run at Kfull, so this is
  // populated from a full-fidelity evaluation; we re-confirm it at the end.
  let fullBest: GridSample | null = null;
  let stale = 0;

  for (let g = 0; g < G; g++) {
    if (opts.signal?.aborted) break;
    const K = Kat(g);
    const losses = await Promise.all(
      pop.map(async (v) => {
        const loss = await evaluate(v, K);
        tick();
        return loss;
      }),
    );
    const scored: GridSample[] = pop
      .map((values, i) => ({ values, loss: losses[i] }))
      .sort((a, b) => a.loss - b.loss);

    // Track the best seen at full fidelity (comparable across generations).
    if (K >= Kfull && (fullBest === null || scored[0].loss < fullBest.loss)) {
      fullBest = { values: scored[0].values.slice(), loss: scored[0].loss };
      stale = 0;
    } else {
      stale++;
    }

    if (g === G - 1 || stale >= patience || opts.signal?.aborted) break;

    // ── Breed the next generation: elites + bred children + immigrants ──
    const next: number[][] = [];
    for (let i = 0; i < E; i++) next.push(scored[i].values.slice());
    const bred = P - E - immigrants;
    for (let k = 0; k < bred; k++) {
      const a = tournamentSelect(scored, t, rng);
      const b = tournamentSelect(scored, t, rng);
      const child = crossover(a, b, params, pc, rng);
      mutate(child, params, mutScaleAt(g), mutRate, rng);
      next.push(decode(child));
    }
    for (const imm of latinHypercube(params, immigrants, rng)) next.push(decode(imm));
    pop = next;
  }

  // Re-confirm the best at full fidelity (cache hit when the last gen was Kfull).
  if (fullBest) {
    fullBest = { values: fullBest.values, loss: await evaluate(fullBest.values, Kfull) };
  } else {
    // G so small no generation reached Kfull — evaluate the current population's best.
    const losses = await Promise.all(pop.map((v) => evaluate(v, Kfull)));
    let bi = 0;
    for (let i = 1; i < losses.length; i++) if (losses[i] < losses[bi]) bi = i;
    fullBest = { values: pop[bi], loss: losses[bi] };
  }

  return { best: fullBest, evaluations: done };
}

// ─── Genetic operators ───────────────────────────────────────────────────────

function clampGene(p: FitParamDef, v: number): number {
  const x = p.integer ? Math.round(v) : v;
  return clamp(x, p.bounds[0], p.bounds[1]);
}

/** Tournament selection: sample `t` genomes uniformly, return the fittest's genes. */
function tournamentSelect(scored: GridSample[], t: number, rng: Rng): number[] {
  let best = scored[rng.intRange(scored.length)];
  for (let i = 1; i < t; i++) {
    const c = scored[rng.intRange(scored.length)];
    if (c.loss < best.loss) best = c;
  }
  return best.values;
}

/** Per-gene recombination: BLX-α (α=0.5) blend for continuous genes — sampling
 *  within and slightly beyond the parents' interval — and a uniform parent pick
 *  for integer genes. With probability 1−pc the child is a clone of parent `a`. */
function crossover(a: number[], b: number[], params: FitParamDef[], pc: number, rng: Rng): number[] {
  const child = a.slice();
  if (!rng.bernoulli(pc)) return child;
  const alpha = 0.5;
  for (let i = 0; i < params.length; i++) {
    if (params[i].integer) {
      child[i] = rng.bernoulli(0.5) ? a[i] : b[i];
    } else {
      const lo = Math.min(a[i], b[i]);
      const hi = Math.max(a[i], b[i]);
      const d = hi - lo;
      child[i] = (lo - alpha * d) + rng.random() * (d * (1 + 2 * alpha));
    }
  }
  return child;
}

/** Per-gene Gaussian drift, mirroring `StrainPool.spawnChild`: each gene mutates
 *  with probability `rate` by `N(0,1)·scale·range`. Decoding clamps/rounds after. */
function mutate(genome: number[], params: FitParamDef[], scale: number, rate: number, rng: Rng): void {
  for (let i = 0; i < params.length; i++) {
    if (!rng.bernoulli(rate)) continue;
    const p = params[i];
    const range = p.bounds[1] - p.bounds[0];
    if (p.integer) {
      genome[i] += rng.gaussian() * Math.max(1, scale * range);
    } else {
      genome[i] += rng.gaussian() * scale * range;
    }
  }
}
