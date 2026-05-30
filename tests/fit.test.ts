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
      gridSteps: 5,
      nmIters: 20,
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
});
