import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim';
import type { SimConfig, StrainGenes } from '../src/types';
import { runTrials } from '../src/lib/fit-sim';
import {
  FIT_PARAMS,
  analyticR0,
  findFitParam,
  goodnessOfFit,
  mse,
  optimize,
  parseObservedCSV,
  poissonNLL,
  runFit,
} from '../src/lib/fit';
import type { ObservedPoint, SimCurves, SimResult } from '../src/lib/fit';

function baseConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    seed: 0xc0ffee,
    size: 40,
    seedInfections: 0,
    birthRate: 0,
    mutate: false,
    strain: {
      attackRate: 0.3,
      incubation: 2,
      infectious: 4,
      ifr: 0.0,
      range: 1,
      immunityDays: 36500,
      mutationRate: 0,
    },
    defenses: [
      { id: 'mask', label: 'Mask', enabled: true, protection: 0, sourceControl: 0, mortalityReduction: 0, uptake: 0 },
      { id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0, sourceControl: 0, mortalityReduction: 0, uptake: 0 },
    ],
    lockdown: { enabled: false, mobilityReduction: 0, transmissionReduction: 0, compliance: 0 },
    quarantine: { enabled: false, detectionRate: 0, contactsRange: 1, protection: 0, sourceControl: 0, duration: 14 },
    ...overrides,
  };
}

// The same in-process simulate used by both data generation and fitting, so the
// ground-truth candidate reproduces the observed curve exactly (deterministic).
const simulate = (cfg: SimConfig, days: number, K: number, seed: number): Promise<SimResult> =>
  Promise.resolve(runTrials(cfg, days, K, seed));

describe('loss functions', () => {
  const N = 1000;
  const curves: SimCurves = {
    cumulative_infections: [0, 0.1, 0.2, 0.3],
    cumulative_deaths: [0, 0, 0.01, 0.02],
    active_infections: [0.001, 0.05, 0.08, 0.04],
  };
  const obs = (frac: number, day: number): ObservedPoint => ({
    day,
    value: frac * N,
    category: 'cumulative_infections',
  });

  it('MSE is zero at a perfect match and positive otherwise', () => {
    const perfect = [obs(0.1, 1), obs(0.2, 2), obs(0.3, 3)];
    expect(mse(perfect, curves, N)).toBeCloseTo(0, 6);
    const off = [obs(0.5, 1)];
    expect(mse(off, curves, N)).toBeGreaterThan(0);
  });

  it('Poisson NLL is minimized when the simulated mean matches the count', () => {
    // Fixed observation; vary the simulated curve. NLL(λ) for fixed k is
    // minimized at λ = k, so the matching curve must score below a divergent one.
    const observation = [{ day: 3, value: 0.3 * N, category: 'cumulative_infections' as const }];
    const matched: SimCurves = { ...curves, cumulative_infections: [0, 0, 0, 0.3] }; // λ = 0.3N = k
    const divergent: SimCurves = { ...curves, cumulative_infections: [0, 0, 0, 0.9] }; // λ = 0.9N ≫ k
    expect(poissonNLL(observation, divergent, N)).toBeGreaterThan(poissonNLL(observation, matched, N));
  });

  it('goodnessOfFit reports R²≈1 for a near-perfect fit', () => {
    const perfect = [obs(0.1, 1), obs(0.2, 2), obs(0.3, 3)];
    const gof = goodnessOfFit(perfect, curves, N);
    expect(gof.r2).toBeCloseTo(1, 6);
    expect(gof.rmse).toBeCloseTo(0, 6);
  });
});

describe('parseObservedCSV', () => {
  it('parses comma and tab rows, applies aliases, and skips junk', () => {
    const text = [
      'day,value,category', // header → skipped
      '0,12,cumulative_infections',
      '5\t140\tcases', // tab-delimited, alias → cumulative_infections
      '5,2,deaths', // alias → cumulative_deaths
      '', // blank → skipped
      'oops', // junk → skipped
    ].join('\n');
    const { points, skipped } = parseObservedCSV(text);
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ day: 0, value: 12, category: 'cumulative_infections' });
    expect(points[1].category).toBe('cumulative_infections');
    expect(points[2].category).toBe('cumulative_deaths');
    expect(skipped).toBe(2); // header + 'oops'
  });

  it('falls back to the default category when none is given', () => {
    const { points } = parseObservedCSV('3,99', 'active_infections');
    expect(points[0].category).toBe('active_infections');
  });
});

describe('analyticR0', () => {
  it('matches Engine.estimateR0 for a square-grid genome', () => {
    const cfg = baseConfig({ size: 80, strain: { ...baseConfig().strain, attackRate: 0.25, range: 2, infectious: 5 } });
    const engine = new Engine(cfg);
    const analytic = analyticR0(cfg.strain, 'square', cfg.size);
    expect(analytic).not.toBeNull();
    expect(analytic!).toBeCloseTo(engine.rNaught!, 6);
  });

  it('returns null for voronoi (no closed form here)', () => {
    expect(analyticR0(baseConfig().strain, 'voronoi')).toBeNull();
  });

  it('the registry exposes the core 2-param fit by default', () => {
    const core = FIT_PARAMS.filter((p) => p.core).map((p) => p.name);
    expect(core).toEqual(['attackRate', 'range']);
    expect(findFitParam('attackRate').bounds[0]).toBeLessThan(findFitParam('attackRate').bounds[1]);
  });
});

describe('inverse fit recovers known parameters', () => {
  it('recovers attackRate + range from a self-generated curve', async () => {
    // A moderate population keeps the Poisson likelihood from being so razor-sharp
    // that the 95% CI collapses to a single point (it does at N=1e6 on noise-free
    // synthetic data) — this mimics a realistic, finite-confidence dataset.
    const POP = 50_000;
    const K = 6;
    const truth: StrainGenes = { ...baseConfig().strain, attackRate: 0.3, range: 1 };
    const truthCfg = baseConfig({ strain: truth });
    const days = 40;

    // Generate "observed" cumulative infections from the ground-truth genes.
    const truthCurves = runTrials(truthCfg, days, K, truthCfg.seed).curves;
    const observed: ObservedPoint[] = [];
    for (let d = 0; d <= days; d += 5) {
      observed.push({ day: d, value: Math.round(truthCurves.cumulative_infections[d] * POP), category: 'cumulative_infections' });
    }

    const params = [
      { ...findFitParam('attackRate'), bounds: [0.05, 0.6] as [number, number] },
      { ...findFitParam('range'), bounds: [1, 3] as [number, number] },
    ];

    const result = await runFit({
      observed,
      baseConfig: baseConfig({ strain: { ...truth, attackRate: 0.5, range: 2 } }), // wrong start
      params,
      population: POP,
      K,
      loss: 'poisson',
      simulate,
      budget: 24,
      nmIters: 15,
    });

    const fitAttack = result.params.find((p) => p.name === 'attackRate')!.value;
    const fitRange = result.params.find((p) => p.name === 'range')!.value;

    expect(fitRange).toBe(1);
    expect(fitAttack).toBeGreaterThan(0.2);
    expect(fitAttack).toBeLessThan(0.4);

    // R₀ + CI sanity: true R₀ lies within the reported 95% interval.
    const trueR0 = analyticR0(truth, 'square', truthCfg.size)!;
    expect(result.r0).not.toBeNull();
    expect(result.r0CI).not.toBeNull();
    const [lo, hi] = result.r0CI!;
    expect(lo).toBeLessThanOrEqual(hi);
    // The point estimate is close to truth, and the 95% CI brackets it (small
    // tolerance absorbs the optimizer's finite convergence + grid discretization).
    expect(Math.abs(result.r0! - trueR0)).toBeLessThan(0.1);
    const tol = 0.05;
    expect(trueR0).toBeGreaterThanOrEqual(lo - tol);
    expect(trueR0).toBeLessThanOrEqual(hi + tol);

    // Good fit overall.
    expect(result.gof.r2).toBeGreaterThan(0.9);
  }, 30_000);

  it('the genetic optimizer recovers the same curve and returns a valid result', async () => {
    const POP = 50_000;
    const K = 6;
    const truth: StrainGenes = { ...baseConfig().strain, attackRate: 0.3, range: 1 };
    const truthCfg = baseConfig({ strain: truth });
    const days = 40;
    const truthCurves = runTrials(truthCfg, days, K, truthCfg.seed).curves;
    const observed: ObservedPoint[] = [];
    for (let d = 0; d <= days; d += 5) {
      observed.push({ day: d, value: Math.round(truthCurves.cumulative_infections[d] * POP), category: 'cumulative_infections' });
    }
    const params = [
      { ...findFitParam('attackRate'), bounds: [0.05, 0.6] as [number, number] },
      { ...findFitParam('range'), bounds: [1, 3] as [number, number] },
    ];

    const result = await runFit({
      observed,
      baseConfig: baseConfig({ strain: { ...truth, attackRate: 0.5, range: 2 } }),
      params,
      population: POP,
      K,
      loss: 'poisson',
      simulate,
      optimizer: 'genetic',
      gaPopulation: 16,
      gaGenerations: 8,
    });

    // Dispatch produced a valid FitResult with the shared downstream (R₀ + CI + gof).
    expect(result.r0).not.toBeNull();
    expect(['interval', 'exact', 'none']).toContain(result.r0CIKind);
    expect(result.params.find((p) => p.name === 'range')!.value).toBe(1);
    const fitAttack = result.params.find((p) => p.name === 'attackRate')!.value;
    expect(fitAttack).toBeGreaterThan(0.2);
    expect(fitAttack).toBeLessThan(0.4);
    expect(result.gof.r2).toBeGreaterThan(0.9);
  }, 30_000);
});

describe('optimize: LHS + successive-halving + Nelder–Mead', () => {
  it('locates the optimum of a deterministic objective', async () => {
    const params = [
      { ...findFitParam('attackRate'), bounds: [0, 1] as [number, number] },
      { ...findFitParam('incubation'), bounds: [0, 20] as [number, number] },
    ];
    const targetA = 0.42;
    const targetB = 7;
    // Convex bowl; K is ignored (deterministic), so the racing rungs just confirm
    // the ranking and the multi-start NM drives onto the minimum.
    const evaluate = (v: number[]): Promise<number> =>
      Promise.resolve((v[0] - targetA) ** 2 + ((v[1] - targetB) / 20) ** 2);

    const res = await optimize({ params, evaluate, Kfull: 10, seed: 123, budget: 40, nmIters: 60 });
    expect(res.best.values[0]).toBeCloseTo(targetA, 2);
    expect(res.best.values[1]).toBeCloseTo(targetB, 1);
  });

  it('is deterministic — identical seeds give identical optima', async () => {
    const params = [{ ...findFitParam('attackRate'), bounds: [0, 1] as [number, number] }];
    const evaluate = (v: number[]): Promise<number> => Promise.resolve((v[0] - 0.3) ** 2);
    const a = await optimize({ params, evaluate, Kfull: 5, seed: 7, budget: 20 });
    const b = await optimize({ params, evaluate, Kfull: 5, seed: 7, budget: 20 });
    expect(b.best.values).toEqual(a.best.values);
  });
});

describe('R₀ confidence interval — loss-correct, honest degeneracy', () => {
  const truth: StrainGenes = { ...baseConfig().strain, attackRate: 0.3, range: 1 };
  const truthCfg = baseConfig({ strain: truth });
  const days = 40;
  const K = 6;
  // Same seed as the fit baseline, so the optimizer can reproduce this curve exactly.
  const truthCurves = runTrials(truthCfg, days, K, truthCfg.seed).curves;

  const sampleObserved = (pop: number, noise = 0): ObservedPoint[] => {
    const pts: ObservedPoint[] = [];
    for (let d = 0; d <= days; d += 5) {
      const base = truthCurves.cumulative_infections[d] * pop;
      // Deterministic, reproducible perturbation (no RNG) so the test stays stable.
      const f = noise === 0 ? 1 : 1 + noise * Math.sin(d * 1.3);
      pts.push({ day: d, value: Math.max(0, Math.round(base * f)), category: 'cumulative_infections' });
    }
    return pts;
  };

  const run = (observed: ObservedPoint[], population: number, loss: 'poisson' | 'mse') =>
    runFit({
      observed,
      baseConfig: baseConfig({ strain: { ...truth, attackRate: 0.5, range: 2 } }),
      params: [
        { ...findFitParam('attackRate'), bounds: [0.05, 0.6] as [number, number] },
        { ...findFitParam('range'), bounds: [1, 3] as [number, number] },
      ],
      population,
      K,
      loss,
      simulate,
      budget: 24,
      nmIters: 15,
    });

  it('MSE on over-determined data reports an honest "exact", not a fake interval', async () => {
    // Old behavior: the χ²-on-raw-MSE threshold collapsed this to an equal-bounds
    // "95% CI x – x". Now it is labeled exact (or a negligibly tight interval).
    const result = await run(sampleObserved(1_000_000, 0), 1_000_000, 'mse');
    const negligible = result.r0CIKind === 'exact'
      || (result.r0CI != null && result.r0CI[1] - result.r0CI[0] < 0.05);
    expect(negligible).toBe(true);
    if (result.r0CIKind === 'exact') expect(result.r0CI).toBeNull();
  }, 30_000);

  it('MSE on noisy data yields a positive-width CI that brackets the truth', async () => {
    // The key fix: under least-squares the deviance is (n/2)·ln(MSE), so the χ²₁
    // threshold is meaningful and the interval no longer collapses.
    const POP = 20_000;
    const result = await run(sampleObserved(POP, 0.06), POP, 'mse');
    const trueR0 = analyticR0(truth, 'square', truthCfg.size)!;
    expect(result.r0CIKind).toBe('interval');
    expect(result.r0CI).not.toBeNull();
    const [lo, hi] = result.r0CI!;
    expect(hi).toBeGreaterThan(lo);
    const tol = 0.15;
    expect(trueR0).toBeGreaterThanOrEqual(lo - tol);
    expect(trueR0).toBeLessThanOrEqual(hi + tol);
  }, 30_000);

  it('a full-fidelity fit is reproducible end-to-end', async () => {
    const observed = sampleObserved(50_000, 0.04);
    const a = await run(observed, 50_000, 'poisson');
    const b = await run(observed, 50_000, 'poisson');
    expect(b.params).toEqual(a.params);
    expect(b.r0).toEqual(a.r0);
    expect(b.r0CI).toEqual(a.r0CI);
    expect(b.r0CIKind).toBe(a.r0CIKind);
  }, 30_000);
});
