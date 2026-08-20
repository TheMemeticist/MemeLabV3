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
  EBOLA_ADJUST,
  EBOLA_INTERVENTIONS,
  mse,
  optimize,
  parseObservedCSV,
  metropolisChain,
  migrateInterventionSpecs,
  multiplierAt,
  percentileBands,
  poissonNLL,
  profileOffsetCI,
  quantileSorted,
  resolutionFitSize,
  revisionEnvelope,
  runFit,
  effectiveReduction,
  effectiveReductionAt,
  specAtDay,
  specFromEvents,
  syncSpecsWithToggle,
  transmissionSchedule,
  valueAt,
  vintagedAdjust,
} from '../src/lib/fit';
import type { ObservedPoint, SimCurves, SimResult } from '../src/lib/fit';
import type { InterventionEvent, InterventionSpec } from '../src/types';

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
const simulate = (cfg: SimConfig, days: number, K: number, seed: number, schedule?: number[]): Promise<SimResult> =>
  Promise.resolve(runTrials(cfg, days, K, seed, schedule));

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

describe('index-date offset: evolved param + profile-likelihood CI', () => {
  it('profileOffsetCI applies 2·ln(Lmax/L) ≤ χ²₁ correctly (hand-checked)', () => {
    // Poisson loss IS the NLL, so deviance = loss and 2Δdev = 2·ln(Lmax/L).
    // loss(o) = 100 + 0.3·(o−5)² → 2Δ = 0.6·(o−5)²:
    //   o=4/6 → 0.6, o=3/7 → 2.4 (≤3.84, in 95%), o=2/8 → 5.4 (out).
    //   68% (2Δ ≤ 1.0): only o ∈ {4,5,6}.
    const profile = [];
    for (let o = 0; o <= 8; o++) profile.push({ offset: o, loss: 100 + 0.3 * (o - 5) ** 2 });
    // Disconnected below-threshold pocket at o=10 must NOT extend the interval
    // (o=9 is far above threshold, so the outward walk stops at 7).
    profile.push({ offset: 9, loss: 108 });
    profile.push({ offset: 10, loss: 100.1 });
    const ci = profileOffsetCI(profile, 5, 'poisson', 10);
    expect(ci.mode).toBe(5);
    expect(ci.ci95).toEqual([3, 7]);
    expect(ci.ci68).toEqual([4, 6]);
  });

  it('evolves the offset to the true head start and the CI brackets it', async () => {
    const POP = 50_000;
    const K = 6;
    const TRUE_OFFSET = 8;
    const truthCfg = baseConfig();
    const truthCurves = runTrials(truthCfg, 48, K, truthCfg.seed).curves;
    // Reports start TRUE_OFFSET days after the model outbreak: raw day = model day − 8.
    const observed: ObservedPoint[] = [];
    for (let m = 10; m <= 40; m += 5) {
      observed.push({
        day: m - TRUE_OFFSET,
        value: Math.round(truthCurves.cumulative_infections[m] * POP),
        category: 'cumulative_infections',
      });
    }
    const params = [
      { ...findFitParam('attackRate'), bounds: [0.05, 0.6] as [number, number] },
      { ...findFitParam('range'), bounds: [1, 3] as [number, number] },
    ];
    const run = () => runFit({
      observed,
      baseConfig: baseConfig({ strain: { ...baseConfig().strain, attackRate: 0.5, range: 2 } }),
      params,
      offset: { bounds: [0, 16] },
      population: POP,
      K,
      loss: 'poisson',
      simulate,
      budget: 24,
      nmIters: 15,
    });
    const r = await run();
    expect(r.indexOffset).toBeDefined();
    expect(Math.abs(r.indexOffset! - TRUE_OFFSET)).toBeLessThanOrEqual(2);
    // Point estimate is the mode of the profile, and the CIs bracket it.
    expect(r.offsetCI).not.toBeNull();
    expect(r.offsetCI!.mode).toBe(r.indexOffset);
    expect(r.offsetCI!.ci95[0]).toBeLessThanOrEqual(r.indexOffset!);
    expect(r.offsetCI!.ci95[1]).toBeGreaterThanOrEqual(r.indexOffset!);
    expect(r.offsetCI!.ci68[0]).toBeGreaterThanOrEqual(r.offsetCI!.ci95[0]);
    expect(r.offsetCI!.ci68[1]).toBeLessThanOrEqual(r.offsetCI!.ci95[1]);
    // result.observed is shifted by the fitted offset; the fit is good.
    expect(Math.min(...r.observed.map((p) => p.day))).toBe(10 - TRUE_OFFSET + r.indexOffset!);
    expect(r.gof.r2).toBeGreaterThan(0.9);
    // Deterministic: same seed → identical offset and CI.
    const r2 = await run();
    expect(r2.indexOffset).toBe(r.indexOffset);
    expect(r2.offsetCI).toEqual(r.offsetCI);
  }, 40_000);
});

describe('cancel, prediction horizon, Bayesian band, Ebola keyframe defaults', () => {
  const obsPts = (pairs: [number, number][]): ObservedPoint[] =>
    pairs.map(([day, value]) => ({ day, value, category: 'cumulative_infections' as const }));

  it('runFit settles promptly when cancel rejects in-flight simulations (no hang)', async () => {
    const signal = { aborted: false };
    let calls = 0;
    const cancellingSimulate = (cfg: SimConfig, days: number, K: number, seed: number): Promise<SimResult> => {
      calls++;
      if (signal.aborted) return Promise.reject(new Error('fit cancelled'));
      if (calls >= 3) {
        // Simulate the Cancel click: abort flag set, then the pool rejects
        // everything still pending — exactly what FitPool.cancelAll does.
        signal.aborted = true;
        return Promise.reject(new Error('fit cancelled'));
      }
      return Promise.resolve(runTrials(cfg, days, K, seed));
    };
    const result = await runFit({
      observed: obsPts([[0, 5], [10, 60], [20, 200]]),
      baseConfig: baseConfig({ size: 16 }),
      params: [findFitParam('attackRate')],
      population: 1_000,
      K: 4,
      loss: 'poisson',
      simulate: cancellingSimulate,
      signal,
      budget: 16,
      nmIters: 4,
    });
    expect(result).toBeDefined(); // resolved — nothing awaited a dead worker
    expect(signal.aborted).toBe(true);
  }, 10_000);

  it('extraDays extends the projected curves beyond the data end', async () => {
    const r = await runFit({
      observed: obsPts([[0, 5], [10, 60], [20, 200]]),
      baseConfig: baseConfig({ size: 16 }),
      params: [findFitParam('attackRate')],
      extraDays: 15,
      population: 1_000,
      K: 3,
      loss: 'poisson',
      simulate,
      budget: 8,
      nmIters: 3,
    });
    expect(r.days).toBe(35); // 20 data days + 15 prediction
    expect(r.simulated.cumulative_infections).toHaveLength(36);
  }, 20_000);

  it('metropolisChain samples a known Gaussian posterior (calibrated + deterministic)', async () => {
    const param = { name: 'attackRate' as const, label: 'x', bounds: [-10, 10] as [number, number], get: () => 0, set: () => {} };
    const nll = (v: number[]): number => 0.5 * (v[0] - 2) ** 2; // N(2, 1) log-density
    const a = await metropolisChain(nll, [2], [param], 123, 4500, 500);
    const b = await metropolisChain(nll, [2], [param], 123, 4500, 500);
    expect(b).toEqual(a); // seeded → bit-identical
    const xs = a.map((v) => v[0]).sort((p, q) => p - q);
    const q = (p: number): number => xs[Math.floor(p * (xs.length - 1))];
    expect(Math.abs(q(0.5) - 2)).toBeLessThan(0.15); // median ≈ mode
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    expect(sd).toBeGreaterThan(0.75); // ≈ σ = 1 (loose for MC error)
    expect(sd).toBeLessThan(1.3);
    expect(Math.abs(q(0.05) - (2 - 1.645))).toBeLessThan(0.35); // 5th ≈ μ−1.645σ
    expect(Math.abs(q(0.95) - (2 + 1.645))).toBeLessThan(0.35); // 95th ≈ μ+1.645σ
  }, 20_000);

  it('runFit posterior band: reproducible, ordered LOW ≤ CENTRAL ≤ HIGH, central sane', async () => {
    const run = () => runFit({
      observed: obsPts([[0, 5], [8, 40], [16, 130], [24, 260]]),
      baseConfig: baseConfig({ size: 16 }),
      params: [findFitParam('attackRate')],
      posterior: { draws: 24 },
      population: 1_000,
      K: 3,
      loss: 'poisson',
      simulate,
      budget: 8,
      nmIters: 3,
    });
    const r1 = await run();
    const r2 = await run();
    expect(r1.bayes).not.toBeNull();
    expect(r2.bayes).toEqual(r1.bayes); // seeded → same band
    const rows = r1.bayes!.cumulative_infections;
    expect(rows).toHaveLength(3);
    for (let d = 0; d < rows[0].length; d++) {
      expect(rows[0][d]).toBeLessThanOrEqual(rows[1][d] + 1e-12);
      expect(rows[1][d]).toBeLessThanOrEqual(rows[2][d] + 1e-12);
    }
    const last = rows[0].length - 1;
    // central inside its own band and in the same ballpark as the point fit
    expect(rows[1][last]).toBeGreaterThan(0);
    const point = r1.simulated.cumulative_infections[last];
    expect(rows[0][last]).toBeLessThanOrEqual(point + 1e-12);
    expect(rows[2][last]).toBeGreaterThanOrEqual(point - 1e-12);
  }, 30_000);

  it('Ebola default keyframes: midpoints ≥ 1, interpolation + clamping incl. outside the data', () => {
    expect(EBOLA_ADJUST.cases.every((f) => f.m >= 1)).toBe(true);
    expect(EBOLA_ADJUST.deaths.every((f) => f.m >= 1)).toBe(true);
    expect(multiplierAt(EBOLA_ADJUST.cases, -20)).toBe(5.0);                 // clamp before day −8
    expect(multiplierAt(EBOLA_ADJUST.cases, -4)).toBeCloseTo(4.9, 9);        // midpoint of [−8, 0]
    expect(multiplierAt(EBOLA_ADJUST.cases, 50)).toBeCloseTo(3.0 + (1.9 - 3.0) * (5 / 23), 9);
    expect(multiplierAt(EBOLA_ADJUST.cases, 200)).toBe(1.25);                // clamp beyond day 110
    expect(multiplierAt(EBOLA_ADJUST.deaths, 64)).toBeCloseTo(1.6, 9);       // halfway 60→68
    const pts = obsPts([[17, 352], [30, 729], [96, 5042]]);
    const { upper, central } = vintagedAdjust(pts, { cumulative_infections: EBOLA_ADJUST.cases }, EBOLA_ADJUST.t0);
    pts.forEach((p, i) => {
      expect(central[i].value).toBeGreaterThanOrEqual(p.value);
      expect(upper[i].value).toBeGreaterThanOrEqual(central[i].value);
    });
  });
});

describe('interventions: time-varying transmission R(t)', () => {
  // A keyframe = a day + a FULL param snapshot. Custom uses the defense
  // quartet; protection ramps 0 → 0.5 over days 10–20 and HOLDS.
  const snap = (protection: number) => ({ uptake: 1, protection, sourceControl: 0, mortalityReduction: 0 });
  const kf = (tick: number, protection: number) => ({ tick, params: snap(protection) });
  const iv = (over: Record<string, unknown> = {}): InterventionSpec => ({
    id: 'iv-1', intervention: 'custom', label: 'test', enabled: true,
    transmissionReduction: 0.5,
    params: snap(0.5),
    keyframes: [kf(10, 0), kf(20, 0.5)],
    ...over,
  } as InterventionSpec);

  it('transmissionSchedule: keyframed-param interpolation, hold, multiplication, offset (hand-checked)', () => {
    const s = transmissionSchedule([iv()], 31)!;
    expect(s[0]).toBe(1);                 // before the first keyframe → held at 0
    expect(s[10]).toBe(1);                // ramp start
    expect(s[15]).toBeCloseTo(0.75, 12);  // halfway: 1 − 0.25
    expect(s[20]).toBeCloseTo(0.5, 12);   // ramp end: 1 − 0.5
    expect(s[30]).toBeCloseTo(0.5, 12);   // HELD past the last keyframe
    // Two interventions multiply: (1 − 0.5)·(1 − 0.2) at their ends.
    const two = transmissionSchedule([iv(), iv({ id: 'iv-2', params: snap(0.2), keyframes: [kf(10, 0), kf(20, 0.2)] })], 31)!;
    expect(two[25]).toBeCloseTo(0.4, 12);
    // Index-date offset shifts the mapping: model tick t ↔ data day t − offset.
    const shifted = transmissionSchedule([iv()], 31, 5)!;
    expect(shifted[20]).toBeCloseTo(s[15], 12);
    // Disabled / all-zero / empty → undefined (unscheduled fast path).
    expect(transmissionSchedule([iv({ enabled: false })], 10)).toBeUndefined();
    expect(transmissionSchedule([iv({ params: snap(0), keyframes: [kf(0, 0)] })], 10)).toBeUndefined();
    expect(transmissionSchedule([], 10)).toBeUndefined();
    // valueAt + specAtDay resolve keyframed params; effectiveReductionAt honors them.
    expect(valueAt([{ tick: 10, value: 0 }, { tick: 20, value: 0.5 }], 15)).toBeCloseTo(0.25, 12);
    expect(specAtDay(iv(), 15).params!.protection).toBeCloseTo(0.25, 12);
    expect(effectiveReductionAt(iv(), 40)).toBeCloseTo(0.5, 12);
  });

  it('engine honors the schedule: all-1s is bit-identical, a reduction lowers spread, deterministic', () => {
    const cfg = baseConfig({ size: 24, strain: { ...baseConfig().strain, attackRate: 0.35 } });
    const bare = runTrials(cfg, 40, 4, cfg.seed);
    const ones = runTrials(cfg, 40, 4, cfg.seed, new Array(41).fill(1));
    expect(ones.curves).toEqual(bare.curves); // ×1 is IEEE-exact — bit-identical
    // Strong intervention from day 10: cumulative infections must end lower.
    const sched = transmissionSchedule(
      [iv({ transmissionReduction: 0.8, params: snap(0.8), keyframes: [kf(5, 0), kf(10, 0.8)] })], 41)!;
    const damped = runTrials(cfg, 40, 4, cfg.seed, sched);
    const bareEnd = bare.curves.cumulative_infections[40];
    const dampedEnd = damped.curves.cumulative_infections[40];
    expect(dampedEnd).toBeLessThan(bareEnd * 0.8);
    // Same inputs → same outputs.
    expect(runTrials(cfg, 40, 4, cfg.seed, sched).curves).toEqual(damped.curves);
    // R₀ stays the intervention-free basic number by convention.
    expect(damped.rNaught).toBe(bare.rNaught);
  });

  it('runFit with interventions: settles, deterministic, schedule reaches the sims', async () => {
    const observed = [[0, 5], [10, 60], [20, 200]].map(([day, value]) =>
      ({ day, value, category: 'cumulative_infections' as const }));
    const run = () => runFit({
      observed,
      baseConfig: baseConfig({ size: 16 }),
      params: [findFitParam('attackRate')],
      interventions: [iv({ transmissionReduction: 0.6, params: snap(0.6), keyframes: [kf(8, 0), kf(14, 0.6)] })],
      population: 1_000,
      K: 3,
      loss: 'poisson',
      simulate,
      budget: 8,
      nmIters: 3,
    });
    const a = await run();
    const b = await run();
    expect(b.params).toEqual(a.params);
    expect(b.simulated).toEqual(a.simulated);
    // The same fitted genes WITHOUT the schedule must spread more — proof the
    // schedule flowed through runFit into the simulations.
    const bare = await simulate(a.config, a.days, 3, a.config.seed);
    const last = a.simulated.cumulative_infections.length - 1;
    expect(a.simulated.cumulative_infections[last])
      .toBeLessThan(bare.curves.cumulative_infections[last]);
  }, 20_000);

  it('EBOLA_INTERVENTIONS: real params + keyframe tracks, schedule-equivalent to the calibration', () => {
    expect(EBOLA_INTERVENTIONS.length).toBeGreaterThanOrEqual(4);
    for (const d of EBOLA_INTERVENTIONS) {
      expect(d.transmissionReduction).toBeGreaterThanOrEqual(0);
      expect(d.keyframes!.length).toBeGreaterThanOrEqual(2); // day + full snapshot each
      expect(d.params).toBeDefined(); // ONE shared schema — every card renders rich controls
      for (const k of d.keyframes!) expect(k.params).toBeDefined();
    }
    const ring = EBOLA_INTERVENTIONS.find((d) => d.id === 'ring-vaccination')!;
    expect(ring.enabled).toBe(false);
    expect(Math.min(...ring.keyframes!.map((f) => f.tick))).toBeGreaterThan(96);
    // Schedule-equivalence to the previously calibrated strengths (verified
    // endpoints of the old model): factor 0.887 at model day 0 (offset 6) and
    // 0.412 at the horizon.
    const sched = transmissionSchedule(EBOLA_INTERVENTIONS, 155, 6)!;
    expect(sched[0]).toBeCloseTo(0.887, 3);
    expect(sched[154]).toBeCloseTo(0.412, 3);
  });
});

describe('shared intervention shape + instant cancel', () => {
  it('fit-modal interventions ARE the live-sim shape: InterventionEvent converts losslessly', () => {
    // The live sim records binary toggle events (App.recordInterventionToggle);
    // the shared spec generalizes `on` to intensity — on→1, off→0.
    const events: InterventionEvent[] = [
      { tick: 12, intervention: 'lockdown', on: true, label: 'Lockdown' },
      { tick: 40, intervention: 'lockdown', on: false },
    ];
    const spec = specFromEvents('lockdown', events, 0.4);
    const expected: InterventionSpec = {
      id: 'lockdown',
      intervention: 'lockdown', // the live sim's InterventionKey taxonomy
      label: 'Lockdown',
      enabled: true,            // DefenseSpec-style field
      transmissionReduction: 0.4, // LockdownSpec's field name + semantics
      // Toggles become keyframes of full snapshots with step-preserving
      // hold-points; for the lockdown taxonomy the toggle keyframes the
      // transmission-reduction dial (on → 0.4, off → 0).
      params: { mobilityReduction: 0, compliance: 0 },
      keyframes: [
        { tick: 11, transmissionReduction: 0, params: { mobilityReduction: 0, compliance: 0 } },
        { tick: 12, transmissionReduction: 0.4, params: { mobilityReduction: 0, compliance: 0 } },
        { tick: 39, transmissionReduction: 0.4, params: { mobilityReduction: 0, compliance: 0 } },
        { tick: 40, transmissionReduction: 0, params: { mobilityReduction: 0, compliance: 0 } },
      ],
    };
    expect(spec).toEqual(expected);
    // And the fit consumes it directly — full effect inside the on-window only.
    const sched = transmissionSchedule([spec], 60)!;
    expect(sched[0]).toBe(1);               // before the toggle-on: off
    expect(sched[12]).toBeCloseTo(0.6, 12); // on → 1 − 0.4·1
    expect(sched[30]).toBeCloseTo(0.6, 12); // HELD at full effect mid-window
    expect(sched[50]).toBeCloseTo(1, 12);   // after toggle-off (clamped 0)
    // EBOLA defaults use the same taxonomy buckets.
    const buckets = new Set(EBOLA_INTERVENTIONS.map((d) => d.intervention));
    expect(buckets.has('quarantine')).toBe(true);
    expect(buckets.has('lockdown')).toBe(true);
    expect(buckets.has('vaccine')).toBe(true);
  });

  it('cancel settles fast at every phase — mid-search, mid-profile-grid, mid-MCMC', async () => {
    const observed: ObservedPoint[] = [[0, 5], [10, 60], [20, 200]].map(([day, value]) =>
      ({ day, value, category: 'cumulative_infections' as const }));
    // Abort after N real sims; post-abort the "pool" keeps working (models the
    // respawned pool) — the fix must never issue another sim once aborted.
    const runWithAbortAt = async (abortAtCall: number): Promise<{ post: number; ms: number }> => {
      const signal = { aborted: false };
      let calls = 0;
      let abortTime = 0;
      let postAbortCalls = 0;
      const sim = (cfg: SimConfig, days: number, K: number, seed: number, schedule?: number[]): Promise<SimResult> => {
        calls++;
        if (signal.aborted) postAbortCalls++;
        if (calls === abortAtCall) { signal.aborted = true; abortTime = performance.now(); }
        return Promise.resolve(runTrials(cfg, days, K, seed, schedule));
      };
      await runFit({
        observed,
        baseConfig: baseConfig({ size: 16 }),
        params: [findFitParam('attackRate')],
        offset: { bounds: [0, 10] },
        posterior: { draws: 60 },
        population: 1_000,
        K: 3,
        loss: 'poisson',
        simulate: sim,
        signal,
        budget: 16,
        nmIters: 6,
      });
      return { post: postAbortCalls, ms: abortTime ? performance.now() - abortTime : 0 };
    };
    for (const at of [5, 40, 90]) { // mid-search, mid-profile-grid, mid-MCMC
      const { post, ms } = await runWithAbortAt(at);
      expect(post).toBe(0);       // not one simulation issued after the abort
      expect(ms).toBeLessThan(100); // settles within a few frames
    }
  }, 30_000);
});

describe('crossover store, future persistence, future Bayes band, full progress', () => {
  const dsnap = (protection: number) => ({ uptake: 1, protection, sourceControl: 0, mortalityReduction: 0 });
  const spec = (over: Partial<InterventionSpec> = {}): InterventionSpec => ({
    id: 'iv-x', intervention: 'custom', label: 'x', enabled: true,
    transmissionReduction: 0.5, params: dsnap(0.5),
    keyframes: [{ tick: 10, params: dsnap(0) }, { tick: 20, params: dsnap(0.5) }],
    ...over,
  });
  const obs3: ObservedPoint[] = [[0, 5], [10, 60], [20, 200]].map(([day, value]) =>
    ({ day, value, category: 'cumulative_infections' as const }));

  it('crossover: a main-sim toggle flips enabled on the SAME shared-store objects', () => {
    const store = [
      spec({ id: 'a', intervention: 'lockdown' }),
      spec({ id: 'b', intervention: 'lockdown', enabled: false }),
      spec({ id: 'c', intervention: 'quarantine' }),
    ];
    const a = store[0]; // same object identity, not a copy
    expect(syncSpecsWithToggle(store, 'lockdown', false)).toBe(true);
    expect(a.enabled).toBe(false);          // mutated in place — one store
    expect(store[1].enabled).toBe(false);
    expect(store[2].enabled).toBe(true);    // other taxonomy untouched
    expect(syncSpecsWithToggle(store, 'lockdown', false)).toBe(false); // idempotent
    expect(syncSpecsWithToggle(store, 'quarantine', false)).toBe(true);
    expect(store[2].enabled).toBe(false);
  });

  it('interventions PERSIST into the future: last intensity holds unless explicitly zeroed', () => {
    const cfg = baseConfig({ size: 24, strain: { ...baseConfig().strain, attackRate: 0.35 } });
    const horizon = 80; // well past the "data" — the prediction region
    const hold = transmissionSchedule([spec({ transmissionReduction: 0.8, params: dsnap(0.8), keyframes: [{ tick: 10, params: dsnap(0) }, { tick: 20, params: dsnap(0.8) }] })], horizon + 1)!;
    expect(hold[horizon]).toBeCloseTo(0.2, 12); // still fully active at the horizon
    const stopped = transmissionSchedule(
      [spec({ transmissionReduction: 0.8, params: dsnap(0.8), keyframes: [
        { tick: 10, params: dsnap(0) }, { tick: 20, params: dsnap(0.8) },
        { tick: 40, params: dsnap(0.8) }, { tick: 41, params: dsnap(0) }, // keyframed to 0 → releases
      ] })], horizon + 1)!;
    expect(stopped[horizon]).toBeCloseTo(1, 12); // released after the stop
    // Behavioral: the held intervention suppresses future growth; the stopped
    // one lets the epidemic resume — strictly more cumulative infections.
    const held = runTrials(cfg, horizon, 4, cfg.seed, hold);
    const released = runTrials(cfg, horizon, 4, cfg.seed, stopped);
    expect(released.curves.cumulative_infections[horizon])
      .toBeGreaterThan(held.curves.cumulative_infections[horizon]);
  });

  it('Bayes band extends across the future prediction region, ordered, and widens', async () => {
    const extraDays = 20;
    const r = await runFit({
      observed: obs3,
      baseConfig: baseConfig({ size: 16 }),
      params: [findFitParam('attackRate')],
      extraDays,
      posterior: { draws: 24 },
      population: 1_000,
      K: 3,
      loss: 'poisson',
      simulate,
      budget: 8,
      nmIters: 3,
    });
    const rows = r.bayes!.cumulative_infections;
    expect(rows[0]).toHaveLength(r.days + 1); // covers data + the full future horizon
    expect(r.days).toBe(20 + extraDays);
    for (let d = 0; d <= r.days; d++) {
      expect(rows[0][d]).toBeLessThanOrEqual(rows[1][d] + 1e-12);
      expect(rows[1][d]).toBeLessThanOrEqual(rows[2][d] + 1e-12);
    }
    const width = (d: number): number => rows[2][d] - rows[0][d];
    expect(rows[1][r.days]).toBeGreaterThan(0);           // central projects into the future
    expect(width(r.days)).toBeGreaterThanOrEqual(width(20)); // plausible range widens (or holds)
  }, 30_000);

  it('progress reaches 100% through ALL stages, monotonically (no 32% stall)', async () => {
    const fracs: number[] = [];
    await runFit({
      observed: obs3,
      baseConfig: baseConfig({ size: 16 }),
      params: [findFitParam('attackRate')],
      offset: { bounds: [0, 8] },
      posterior: { draws: 16 },
      population: 1_000,
      K: 3,
      loss: 'poisson',
      simulate,
      optimizer: 'genetic',
      gaPopulation: 10,
      gaGenerations: 20, // patience will stop the GA early — the old 32% trap
      onProgress: (f) => fracs.push(f),
    });
    for (let i = 1; i < fracs.length; i++) expect(fracs[i]).toBeGreaterThanOrEqual(fracs[i - 1]);
    expect(fracs[fracs.length - 1]).toBeGreaterThanOrEqual(0.999);
    // The post stages actually tick (more reports than the optimizer alone).
    expect(fracs.length).toBeGreaterThan(20);
  }, 30_000);
});

describe('rich intervention params: the model honors the FULL main-sim spec', () => {
  const base = (over: Partial<InterventionSpec> = {}): InterventionSpec => ({
    id: 'iv-r', intervention: 'custom', label: 'r', enabled: true,
    transmissionReduction: 0.3,
    ...over,
  });

  it('effectiveReduction derives from per-type params like the engine composes them', () => {
    // mask/vaccine (DefenseSpec): (1 − u·prot)(1 − u·src) — hand-checked:
    // u=1, prot=0.5, src=0.5 → 1 − 0.5·0.5 = 0.75 reduction.
    expect(effectiveReduction(base({ intervention: 'mask', params: { uptake: 1, protection: 0.5, sourceControl: 0.5, mortalityReduction: 1 } })))
      .toBeCloseTo(0.75, 12);
    // u=0.5, prot=0.2, src=0.8 → 1 − (0.9)(0.6) = 0.46.
    expect(effectiveReduction(base({ intervention: 'vaccine', params: { uptake: 0.5, protection: 0.2, sourceControl: 0.8 } })))
      .toBeCloseTo(0.46, 12);
    // mortalityReduction alone must NOT reduce transmission.
    expect(effectiveReduction(base({ intervention: 'mask', params: { uptake: 1, mortalityReduction: 1 } }))).toBe(0);
    // lockdown: 1 − (1−tr)(1−mob·comp): tr=0.3, mob=0.5, comp=0.8 → 1 − 0.7·0.6 = 0.58.
    expect(effectiveReduction(base({ intervention: 'lockdown', transmissionReduction: 0.3, params: { mobilityReduction: 0.5, compliance: 0.8 } })))
      .toBeCloseTo(0.58, 12);
    // quarantine: detectionRate·sourceControl = 0.6·0.7 = 0.42 (range/duration
    // shape live-sim spatial dynamics, not this population rate).
    expect(effectiveReduction(base({ intervention: 'quarantine', params: { detectionRate: 0.6, sourceControl: 0.7, contactsRange: 5, duration: 60 } })))
      .toBeCloseTo(0.42, 12);
    // Cap at 0.95; param-less falls back to the flat value (presets/custom).
    expect(effectiveReduction(base({ intervention: 'mask', params: { uptake: 1, protection: 1, sourceControl: 1 } }))).toBe(0.95);
    expect(effectiveReduction(base({ intervention: 'quarantine' }))).toBeCloseTo(0.3, 12); // no params → flat
    expect(effectiveReduction(base())).toBeCloseTo(0.3, 12);
  });

  it('keyframing a REAL param varies the model over time; releases when keyframed to 0', () => {
    // Mask with uptake keyframed: full early, keyframed to 0 at day 31.
    const mk = (uptake: number) => ({ uptake, protection: 0.5, sourceControl: 0.5, mortalityReduction: 0 });
    const rich = base({
      intervention: 'mask',
      params: mk(1),
      keyframes: [{ tick: 0, params: mk(1) }, { tick: 30, params: mk(1) }, { tick: 31, params: mk(0) }],
    });
    const sched = transmissionSchedule([rich], 81)!;
    expect(sched[3]).toBeCloseTo(0.25, 12);  // uptake 1 → eff 0.75
    expect(sched[60]).toBeCloseTo(1, 12);    // uptake keyframed to 0 → released
    // Behavioral: held vs released diverge in the projected region.
    const cfg = baseConfig({ size: 24, strain: { ...baseConfig().strain, attackRate: 0.35 } });
    const heldSpec = base({ intervention: 'mask', params: { uptake: 1, protection: 0.5, sourceControl: 0.5 } });
    const held = runTrials(cfg, 80, 4, cfg.seed, transmissionSchedule([heldSpec], 81)!);
    const released = runTrials(cfg, 80, 4, cfg.seed, sched);
    expect(released.curves.cumulative_infections[80])
      .toBeGreaterThan(held.curves.cumulative_infections[80]);
    // Main-sim toggle still flips the SAME object (crossover with rich params).
    expect(syncSpecsWithToggle([rich], 'mask', false)).toBe(true);
    expect(rich.enabled).toBe(false);
    expect(transmissionSchedule([rich], 5)).toBeUndefined(); // disabled → no schedule
    // Deterministic: same spec → same schedule.
    rich.enabled = true;
    expect(transmissionSchedule([rich], 81)).toEqual(sched);
    // Legacy persisted shapes migrate onto keyframed real params, schedule-equivalent.
    const migrated = migrateInterventionSpecs([
      { id: 'old', intervention: 'quarantine', label: 'o', enabled: true, effect: 0.5, intensity: [{ day: 10, m: 0 }, { day: 20, m: 1 }] },
    ]);
    expect(migrated[0].intervention).toBe('custom'); // param-less typed legacy → custom
    // Lossless defense mapping: keyframes of full snapshots with protection
    // carrying intensity·strength — schedules bit-identical.
    expect(migrated[0].keyframes).toEqual([
      { tick: 10, params: { uptake: 1, protection: 0, sourceControl: 0, mortalityReduction: 0 } },
      { tick: 20, params: { uptake: 1, protection: 0.5, sourceControl: 0, mortalityReduction: 0 } },
    ]);
    expect(transmissionSchedule(migrated, 31)![15]).toBeCloseTo(0.75, 12); // 0.5·0.5 at halfway
    // v3 per-param tracks also migrate exactly (union-of-ticks resolution).
    const v3 = migrateInterventionSpecs([{
      id: 'v3', intervention: 'custom', label: 'v', enabled: true, transmissionReduction: 0.5,
      params: { uptake: 1, protection: 0.5, sourceControl: 0, mortalityReduction: 0 },
      timeline: { protection: [{ tick: 10, value: 0 }, { tick: 20, value: 0.5 }] },
    }]);
    expect(v3[0].keyframes!.map((k) => [k.tick, k.params.protection])).toEqual([[10, 0], [20, 0.5]]);
    expect(transmissionSchedule(v3, 31)![15]).toBeCloseTo(0.75, 12);
  });

  it("'custom' shares the SAME defense param schema as mask/vaccine", () => {
    // With params, custom composes exactly like a defense measure...
    const custom = base({ intervention: 'custom', params: { uptake: 1, protection: 0.5, sourceControl: 0.5 } });
    const mask = base({ intervention: 'mask', params: { uptake: 1, protection: 0.5, sourceControl: 0.5 } });
    expect(effectiveReduction(custom)).toBeCloseTo(effectiveReduction(mask), 12);
    // ...and the lossless mapping reproduces the old flat strength exactly.
    const mapped = base({ intervention: 'custom', params: { uptake: 1, protection: 0.3, sourceControl: 0, mortalityReduction: 0 } });
    expect(effectiveReduction(mapped)).toBeCloseTo(0.3, 12);
    expect(effectiveReduction(base())).toBeCloseTo(0.3, 12); // param-less fallback unchanged
  });
});
