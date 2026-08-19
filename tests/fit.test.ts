import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim';
import type { SimConfig, StrainGenes } from '../src/types';
import { runTrialEnsemble, runTrials } from '../src/lib/fit-sim';
import {
  FIT_PARAMS,
  analyticR0,
  findFitParam,
  goodnessOfFit,
  hasDownwardRevisions,
  mse,
  optimize,
  parseObservedCSV,
  multiplierAt,
  percentileBands,
  poissonNLL,
  quantileSorted,
  resolutionFitSize,
  revisionEnvelope,
  runFit,
  vintagedAdjust,
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

describe('fit must run at the live grid size to reproduce', () => {
  // A MemeLab outbreak spreads as a traveling wave from the single index case, so over
  // a fixed horizon the *absolute* spread is ~grid-size-independent ⇒ per-capita deaths
  // scale as 1/N. The R₀ Estimator therefore fits at the live grid size (R0Modal
  // `fitBaseConfig`), not a fixed small grid — otherwise the fitted per-capita death
  // curve wouldn't reproduce after Apply. A lethal, spreading strain so deaths matter.
  const lethal: Partial<StrainGenes> = { attackRate: 0.25, range: 2, infectious: 6, incubation: 2, ifr: 0.05 };
  const DAYS = 50;
  const K = 6;
  const mk = (size: number): SimConfig =>
    baseConfig({ size, seedInfections: 0, strain: { ...baseConfig().strain, ...lethal } });
  const finalDeaths = (cfg: SimConfig): number => {
    const c = runTrials(cfg, DAYS, K, cfg.seed).curves.cumulative_deaths;
    return c[c.length - 1];
  };

  it('per-capita deaths are size-dependent under single-index seeding', () => {
    // The core reason the fit must use the live size. If this ever stops holding (e.g.
    // seeding switched to a dense fraction), fitting on a small grid would be valid —
    // but the model would no longer be a spatial wave.
    const small = finalDeaths(mk(64));
    const large = finalDeaths(mk(96));
    // Both produce a real epidemic (guards a degenerate match at ~0); the smaller grid
    // has the higher per-capita toll because the wave fills more of it.
    expect(small).toBeGreaterThan(0.01);
    expect(large).toBeGreaterThan(0.004);
    expect(small / large).toBeGreaterThan(1.5); // ≈ (96/64)² as the wave fills less of a bigger grid
  }, 30_000);

  it('reproduces exactly when the fit and live grid sizes match', () => {
    // Fitting at the live size makes the fit config == the live config, so the
    // per-capita death curve is identical — deterministic, bit-for-bit.
    const a = runTrials(mk(96), DAYS, K, mk(96).seed).curves.cumulative_deaths;
    const b = runTrials(mk(96), DAYS, K, mk(96).seed).curves.cumulative_deaths;
    expect(b).toEqual(a);
  }, 30_000);
});

describe('revised-cumulative envelope + fit-grid resolution', () => {
  const pts = (pairs: [number, number][], category = 'cumulative_infections' as const): ObservedPoint[] =>
    pairs.map(([day, value]) => ({ day, value, category }));

  it('clips each cumulative value to the minimum of all later values', () => {
    // The Ebola revision shape: 1262 (day 14) later revised down via 681 → 352.
    const raw = pts([[10, 1042], [14, 1262], [16, 681], [17, 352], [18, 359], [20, 378]]);
    const cleaned = revisionEnvelope(raw);
    expect(cleaned.map((p) => p.value)).toEqual([352, 352, 352, 352, 359, 378]);
    // Non-destructive: the input is untouched.
    expect(raw.map((p) => p.value)).toEqual([1042, 1262, 681, 352, 359, 378]);
    // Result is monotone non-decreasing in day order.
    const sorted = cleaned.slice().sort((a, b) => a.day - b.day);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].value).toBeGreaterThanOrEqual(sorted[i - 1].value);
  });

  it('is a no-op on monotone data and never touches active_infections', () => {
    const mono = pts([[0, 1], [5, 10], [9, 50]]);
    expect(revisionEnvelope(mono).map((p) => p.value)).toEqual([1, 10, 50]);
    expect(hasDownwardRevisions(mono)).toBe(false);
    const active: ObservedPoint[] = pts([[0, 5], [5, 90], [10, 20]], undefined)
      .map((p) => ({ ...p, category: 'active_infections' as const }));
    expect(revisionEnvelope(active).map((p) => p.value)).toEqual([5, 90, 20]);
    expect(hasDownwardRevisions(active)).toBe(false);
  });

  it('detects downward revisions and cleans categories independently', () => {
    const mixed = [
      ...pts([[0, 100], [5, 60], [9, 80]]),
      ...pts([[0, 10], [5, 20], [9, 30]], 'cumulative_infections').map((p) => ({ ...p, category: 'cumulative_deaths' as const })),
    ];
    expect(hasDownwardRevisions(mixed)).toBe(true);
    const cleaned = revisionEnvelope(mixed);
    expect(cleaned.slice(0, 3).map((p) => p.value)).toEqual([60, 60, 80]); // infections clipped
    expect(cleaned.slice(3).map((p) => p.value)).toEqual([10, 20, 30]);   // deaths untouched
  });

  it('sizes the fit grid so one cell never exceeds the smallest observed value', () => {
    // The regression scenario: 8×8 live grid, census-scale population. One cell
    // was 1e6/64 = 15,625 people; the floor must push size to ≥ 84 so that
    // pop/size² ≤ 144 (the smallest data point).
    const size = resolutionFitSize(8, 1_000_000, 144, 128);
    expect(size).toBeGreaterThanOrEqual(84);
    expect(1_000_000 / (size * size)).toBeLessThanOrEqual(144);
    // Live size already sufficient → fit at the live size (reproduce-on-Apply).
    expect(resolutionFitSize(100, 80_000, 50, 128)).toBe(100);
    // Cap respected in both directions.
    expect(resolutionFitSize(200, 80_000, 50, 128)).toBe(128);
    expect(resolutionFitSize(8, 1_000_000, 10, 128)).toBe(128); // floor beyond cap → cap (UI warns)
    // Degenerate inputs fall back to the live size (min 8).
    expect(resolutionFitSize(40, 1_000_000, Number.NaN, 128)).toBe(40);
    expect(resolutionFitSize(2, 0, 0, 128)).toBe(8);
  });
});

describe('percentile bands (fan chart)', () => {
  it('quantileSorted interpolates linearly and handles edges', () => {
    expect(quantileSorted([10], 50)).toBe(10);
    expect(quantileSorted([0, 10], 50)).toBe(5);
    expect(quantileSorted([0, 10, 20, 30, 40], 25)).toBe(10);
    expect(quantileSorted([0, 10, 20, 30, 40], 37.5)).toBe(15);
    expect(quantileSorted([0, 10, 20, 30, 40], 0)).toBe(0);
    expect(quantileSorted([0, 10, 20, 30, 40], 100)).toBe(40);
  });

  it('percentileBands aggregates per day and per category', () => {
    const trial = (a: number, b: number): SimCurves => ({
      cumulative_infections: [a, b],
      cumulative_deaths: [0, a],
      active_infections: [a, 0],
    });
    const bands = percentileBands([trial(0, 0), trial(10, 20), trial(20, 40)], [50, 100]);
    expect(bands.cumulative_infections[0]).toEqual([10, 20]); // day-wise medians
    expect(bands.cumulative_infections[1]).toEqual([20, 40]); // day-wise maxima
    expect(bands.cumulative_deaths[0]).toEqual([0, 10]);
  });

  it('ensemble: deterministic, N=1 equals the plain trial-0 curve, index cases differ', () => {
    const cfg = baseConfig({ size: 24, strain: { ...baseConfig().strain, attackRate: 0.25, ifr: 0.2 } });
    const a = runTrialEnsemble(cfg, 30, 4, cfg.seed);
    const b = runTrialEnsemble(cfg, 30, 4, cfg.seed);
    expect(a).toEqual(b); // same seed + N → identical bands input
    // N=1 → exactly the deterministic single trial (default center index case),
    // which is also runTrials' trial 0: the K=1 mean IS trial 0.
    const single = runTrialEnsemble(cfg, 30, 1, cfg.seed);
    expect(single.perTrial).toHaveLength(1);
    expect(single.perTrial[0]).toEqual(runTrials(cfg, 30, 1, cfg.seed).curves);
    // Different index cases genuinely vary the trajectories.
    const t1 = a.perTrial[1].cumulative_infections;
    const t2 = a.perTrial[2].cumulative_infections;
    expect(t1).not.toEqual(t2);
  });
});

describe('keyframe multipliers + vintaged accumulation', () => {
  const frames = [{ day: 0, m: 5.0 }, { day: 42, m: 3.8 }]; // the pseudocode ramp

  it('multiplierAt: linear between keyframes, clamped outside (incl. before t0 / after data)', () => {
    expect(multiplierAt(frames, -30)).toBe(5.0); // before t0 → clamp to m0
    expect(multiplierAt(frames, 0)).toBe(5.0);
    expect(multiplierAt(frames, 7)).toBeCloseTo(4.8, 12); // 1 week into the 6-week ramp
    expect(multiplierAt(frames, 21)).toBeCloseTo(4.4, 12); // halfway
    expect(multiplierAt(frames, 42)).toBeCloseTo(3.8, 12);
    expect(multiplierAt(frames, 500)).toBeCloseTo(3.8, 12); // far past the data → clamp to m6
    // Multi-keyframe interpolation works too.
    const multi = [{ day: 0, m: 4 }, { day: 10, m: 2 }, { day: 20, m: 1 }];
    expect(multiplierAt(multi, 5)).toBe(3);
    expect(multiplierAt(multi, 15)).toBe(1.5);
  });

  it('vintaged accumulation applies multipliers to INCREMENTS at their report date', () => {
    // Hand-checked: upper(0)=100·5=500; Δ(7)=100 at m(7)=4.8 → upper(7)=980;
    // Δ(50)=60 at clamped m=3.8 → upper(50)=1208. central(7)=(200+980)/2=590.
    const pts = (pairs: [number, number][]): ObservedPoint[] =>
      pairs.map(([day, value]) => ({ day, value, category: 'cumulative_infections' as const }));
    const observed = pts([[0, 100], [7, 200], [50, 260]]);
    const { upper, central } = vintagedAdjust(observed, { cumulative_infections: frames }, 0);
    expect(upper.map((p) => p.value)).toEqual([500, 980, 1208]);
    expect(central.map((p) => p.value)).toEqual([300, 590, 734]);
    // floor ≤ central ≤ upper at every point (multipliers ≥ 1).
    observed.forEach((p, i) => {
      expect(central[i].value).toBeGreaterThanOrEqual(p.value);
      expect(upper[i].value).toBeGreaterThanOrEqual(central[i].value);
    });
    // NOT the naive cumulative×multiplier: 200·4.8=960 ≠ 980 — vintaging matters.
    expect(upper[1].value).not.toBe(200 * 4.8);
  });

  it('initial stock uses the multiplier at the midpoint of [t0, t_first]', () => {
    const pts: ObservedPoint[] = [{ day: 21, value: 100, category: 'cumulative_infections' }];
    // t0 = 0, first obs day 21 → midpoint 10.5 → m = 5 + (3.8-5)·(10.5/42) = 4.7
    const { upper } = vintagedAdjust(pts, { cumulative_infections: frames }, 0);
    expect(upper[0].value).toBeCloseTo(470, 9);
    // Categories without frames pass through untouched.
    const death: ObservedPoint[] = [{ day: 21, value: 50, category: 'cumulative_deaths' }];
    const out = vintagedAdjust(death, { cumulative_infections: frames }, 0);
    expect(out.upper[0].value).toBe(50);
    expect(out.central[0].value).toBe(50);
  });
});
