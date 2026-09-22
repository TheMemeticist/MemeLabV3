import { describe, it, expect } from 'vitest';
import { runFit, transmissionSchedule, changePointSchedule } from '../src/lib/fit';
import type { ObservedPoint, SimResult, InterventionSpec, FitRequest } from '../src/lib/fit';
import { baseSimConfig } from '../src/sim/presets';

// Deterministic stand-in for the simulator: a fixed per-capita logistic curve.
// The fitted scale is then the only thing that can move the loss, so the test
// pins the loss-side dimension without any stochastic engine involved.
const DAYS = 90;
const curve = Array.from({ length: DAYS + 1 }, (_, d) => 0.6 / (1 + Math.exp(-0.15 * (d - 40))));
const fake = (seen: (number[] | undefined)[] = []) => async (_c: unknown, days: number, _K: number, _s: number, schedule?: number[]): Promise<SimResult> => {
  seen.push(schedule);
  const c = curve.slice(0, days + 1);
  return { curves: { cumulative_infections: c, cumulative_deaths: c.map(() => 0), active_infections: c.map(() => 0) }, rNaught: 2 };
};
const TRUE_N = 50_000;
const observed: ObservedPoint[] = [0, 7, 14, 21, 28, 35, 42, 49, 56].map((day) => ({ day, value: Math.round(curve[day] * TRUE_N), category: 'cumulative_infections' }));
const base = (over: Partial<FitRequest> = {}): FitRequest => ({
  observed,
  baseConfig: { ...baseSimConfig('sars2-wild'), seed: 7 },
  params: [],
  K: 2,
  K0: 2,
  budget: 24,
  nmIters: 30,
  restarts: 2,
  loss: 'poisson_incident',
  population: 4000,
  optimizer: 'local',
  simulate: fake(),
  ...over,
});

describe('fitted comparison scale', () => {
  it('recovers the scale the counts were generated at, under both objectives', async () => {
    for (const loss of ['poisson_incident', 'poisson'] as const) {
      const r = await runFit(base({ loss, scale: { bounds: [1_000, 10_000_000] } }));
      expect(r.fittedPopulation).toBeGreaterThan(TRUE_N * 0.97);
      expect(r.fittedPopulation).toBeLessThan(TRUE_N * 1.03);
      expect(r.population).toBe(r.fittedPopulation);
      expect(r.gof.r2).toBeGreaterThan(0.99);
    }
  });
  it('profiles the scale analytically to the same optimum, with no search dimension', async () => {
    for (const loss of ['poisson_incident', 'poisson', 'mse'] as const) {
      const r = await runFit(base({ loss, scale: { bounds: [1_000, 10_000_000], profile: true }, posterior: { draws: 10, burn: 40 } }));
      expect(r.fittedPopulation).toBeGreaterThan(TRUE_N * 0.99);
      expect(r.fittedPopulation).toBeLessThan(TRUE_N * 1.01);
      expect(r.posteriorDraws?.names).toEqual(['populationScale']);
      for (const d of r.posteriorDraws!.draws) expect(Math.pow(10, d[0])).toBeCloseTo(TRUE_N, -2);
    }
    const clamped = await runFit(base({ scale: { bounds: [1_000, 20_000], profile: true } }));
    expect(clamped.fittedPopulation).toBe(20_000);
  });
  it('leaves population fixed and fittedPopulation absent when scale is not requested', async () => {
    const r = await runFit(base());
    expect(r.population).toBe(4000);
    expect(r.fittedPopulation).toBeUndefined();
    expect(r.gof.r2).toBeLessThan(0.5);
  });
  it('rejects invalid scale bounds', async () => {
    await expect(runFit(base({ scale: { bounds: [0, 10] } }))).rejects.toThrow(/scale bounds/);
    await expect(runFit(base({ scale: { bounds: [100, 10] } }))).rejects.toThrow(/scale bounds/);
  });
  it('returns the retained posterior draws with named columns', async () => {
    const r = await runFit(base({ scale: { bounds: [1_000, 10_000_000] }, posterior: { draws: 12, burn: 40 } }));
    expect(r.posteriorDraws?.names).toEqual(['populationScale']);
    expect(r.posteriorDraws?.draws).toHaveLength(12);
    for (const d of r.posteriorDraws!.draws) expect(Math.pow(10, d[0])).toBeGreaterThan(TRUE_N * 0.8);
  });
});

const lockdown = (tr: number): InterventionSpec => ({
  id: 'ld', intervention: 'lockdown', label: 'test', enabled: true, transmissionReduction: tr,
  params: { mobilityReduction: 0, compliance: 0 },
  keyframes: [
    { tick: 9, transmissionReduction: 0, params: {} },
    { tick: 10, transmissionReduction: tr, params: {} },
  ],
});

describe('fitted intervention intensity', () => {
  it('scales every scheduled reduction by s and reports s', async () => {
    const seen: (number[] | undefined)[] = [];
    const r = await runFit(base({ simulate: fake(seen), interventions: [lockdown(0.5)], interventionIntensity: { bounds: [0.4, 0.4] } }));
    expect(r.interventionIntensity).toBe(0.4);
    const sched = seen.find((s) => s);
    expect(sched![5]).toBe(1);
    expect(sched![20]).toBeCloseTo(1 - 0.4 * 0.5, 12);
    expect(seen.every((s) => !s || Math.abs(s[20] - 0.8) < 1e-12)).toBe(true);
  });
  it('uses the nominal schedule when no intensity is fitted', async () => {
    const seen: (number[] | undefined)[] = [];
    const r = await runFit(base({ simulate: fake(seen), interventions: [lockdown(0.5)] }));
    expect(r.interventionIntensity).toBeUndefined();
    expect(seen.find((s) => s)![20]).toBeCloseTo(0.5, 12);
    expect(transmissionSchedule([lockdown(0.5)], 30)![20]).toBeCloseTo(0.5, 12);
  });
  it('rejects intensity without interventions or outside [0, 1]', async () => {
    await expect(runFit(base({ interventionIntensity: { bounds: [0, 1] } }))).rejects.toThrow(/requires interventions/);
    await expect(runFit(base({ interventions: [lockdown(0.5)], interventionIntensity: { bounds: [0, 2.5] } }))).rejects.toThrow(/bounds/);
  });
  it('floors the scaled multiplier at 0.02 when s pushes past a full reduction', async () => {
    const seen: (number[] | undefined)[] = [];
    await runFit(base({ simulate: fake(seen), interventions: [lockdown(0.9)], interventionIntensity: { bounds: [1.5, 1.5] } }));
    expect(seen.find((s) => s)![20]).toBeCloseTo(0.02, 12);
  });
});

describe('quasi-Poisson tempered posterior', () => {
  // Overdispersed but still monotone: scale each weekly increment up or down.
  const noisy: ObservedPoint[] = observed.map((p, i, all) => {
    let acc = 0;
    for (let k = 0; k <= i; k++) acc += (all[k].value - (k ? all[k - 1].value : 0)) * (k % 2 ? 1.5 : 0.6);
    return { ...p, value: Math.round(acc) };
  });
  const spread = async (dispersion: 'quasi' | number) => {
    const r = await runFit(base({ observed: noisy, scale: { bounds: [1_000, 10_000_000] }, posterior: { draws: 40, burn: 60, dispersion } }));
    const Ns = r.posteriorDraws!.draws.map((d) => Math.pow(10, d[0])).sort((a, b) => a - b);
    return { phi: r.posteriorDispersion!, ratio: Ns[Ns.length - 1] / Ns[0] };
  };
  it('estimates a dispersion above one on overdispersed counts and widens the draws by it', async () => {
    const plain = await spread(1);
    const quasi = await spread('quasi');
    expect(plain.phi).toBe(1);
    expect(quasi.phi).toBeGreaterThan(5);
    expect(quasi.ratio).toBeGreaterThan(plain.ratio);
  });
  it('median variant is not dominated by one near-zero expected term', async () => {
    // Same noisy series but the first weekly increment is enormous relative to any
    // smooth curve: the mean-based φ explodes, the median-based one stays finite.
    const spiked = noisy.map((p, i) => ({ ...p, value: p.value + (i === 0 ? 50_000 : 50_000) }));
    const mean = await runFit(base({ observed: spiked, scale: { bounds: [1_000, 10_000_000] }, posterior: { draws: 10, burn: 40, dispersion: 'quasi' } }));
    const median = await runFit(base({ observed: spiked, scale: { bounds: [1_000, 10_000_000] }, posterior: { draws: 10, burn: 40, dispersion: 'quasi-median' } }));
    expect(median.posteriorDispersion!).toBeGreaterThanOrEqual(1);
    expect(median.posteriorDispersion!).toBeLessThan(mean.posteriorDispersion!);
  });
  it('reports dispersion one on exact counts', async () => {
    const r = await runFit(base({ scale: { bounds: [1_000, 10_000_000] }, posterior: { draws: 10, burn: 40, dispersion: 'quasi' } }));
    expect(r.posteriorDispersion).toBe(1);
  });
});

describe('dated change points with fitted multipliers', () => {
  it('builds a held step schedule in sim ticks from data-day ticks', () => {
    expect(changePointSchedule([10, 20], [0.5, 0.25], 30, 5)).toEqual([...Array(15).fill(1), ...Array(10).fill(0.5), ...Array(5).fill(0.25)]);
    expect(changePointSchedule([], [], 3)).toEqual([1, 1, 1]);
  });
  it('fits one multiplier per tick, applies them to the schedule, and reports them', async () => {
    const seen: (number[] | undefined)[] = [];
    const r = await runFit(base({ simulate: fake(seen), transmissionChangePoints: { ticks: [10, 30], bounds: [0.3, 0.3] } }));
    expect(r.transmissionMultipliers).toEqual([0.3, 0.3]);
    const sched = seen.find((s) => s)!;
    expect(sched[5]).toBe(1); expect(sched[15]).toBe(0.3); expect(sched[40]).toBe(0.3);
    expect(r.posteriorDraws ?? null).toBeNull();
  });
  it('composes on top of an intervention schedule and penalises jumps between multipliers', async () => {
    const seen: (number[] | undefined)[] = [];
    await runFit(base({ simulate: fake(seen), interventions: [lockdown(0.5)], transmissionChangePoints: { ticks: [20], bounds: [0.5, 0.5] } }));
    expect(seen.find((s) => s)![25]).toBeCloseTo(0.25, 12);
    const free = await runFit(base({ transmissionChangePoints: { ticks: [10, 30] } }));
    const penal = await runFit(base({ transmissionChangePoints: { ticks: [10, 30], penalty: 1e9 } }));
    const gap = (m: number[]) => Math.abs(Math.log(m[0]) - Math.log(m[1]));
    expect(gap(penal.transmissionMultipliers!)).toBeLessThanOrEqual(gap(free.transmissionMultipliers!) + 1e-9);
    expect(gap(penal.transmissionMultipliers!)).toBeLessThan(0.05);
  });
  it('rejects unsorted ticks and bad bounds', async () => {
    await expect(runFit(base({ transmissionChangePoints: { ticks: [30, 10] } }))).rejects.toThrow(/increasing/);
    await expect(runFit(base({ transmissionChangePoints: { ticks: [10], bounds: [0, 1] } }))).rejects.toThrow(/bounds/);
  });
});
