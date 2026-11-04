// Individual-scale recipe estimator (fit-recipe.ts): input defaults, sizing, determinism and a pinned digest.
// The estimator's numerics are pinned against the validated version by the forecasting benchmark's parity checks;
// the digest here catches any drift inside the app alone.
import { describe, expect, it } from 'vitest';
import {
  POOL_SEED_STEP, RECIPE_DEFAULTS, RECIPE_SETTINGS, defaultRecipeRunners, genericChangePoints, pooledFitJobs, recipeCore, recipeJob,
  recipeSizing, runRecipeForecast, summarizeRecipe, type RecipeInputs, type RecipeResult,
} from '../src/lib/fit-recipe';
import { ENSEMBLE_PROBS, type ObservedPoint } from '../src/lib/fit';

// A small synthetic outbreak: daily cumulative cases growing ~7 %/day for five weeks, weekly cumulative deaths.
function synthetic(): ObservedPoint[] {
  const obs: ObservedPoint[] = [];
  for (let d = 0; d <= 35; d++) obs.push({ day: d, value: Math.round(5 * Math.exp(0.07 * d)), category: 'cumulative_infections' });
  for (let d = 7; d <= 35; d += 7) obs.push({ day: d, value: Math.round(0.05 * 5 * Math.exp(0.07 * (d - 5))), category: 'cumulative_deaths' });
  return obs;
}
const inputs = (over: Partial<RecipeInputs> = {}): RecipeInputs => ({
  observed: synthetic(), presetId: 'sars2-wild', strain: { incubation: 5, infectious: 7, ifr: 0.01 }, horizonDays: 28, seed: 7, ...over,
});
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
const withoutTiming = (r: ReturnType<typeof runRecipeForecast>) => { const c: Record<string, unknown> = { ...r }; delete c.fitMs; delete c.totalMs; return JSON.stringify(c); };

describe('recipe inputs and defaults', () => {
  it('fills every missing input from RECIPE_DEFAULTS and the strain genes', () => {
    const j = recipeJob(inputs());
    expect(j.individual.asc).toEqual(RECIPE_DEFAULTS.ascertainment);
    expect(j.individual.maxSide).toBe(512);
    expect(j.individual.ifr).toBe(0.01); // deaths observed → strain IFR is the deaths link
    expect(j.individual.nAtRisk).toBeUndefined(); // no population at risk → unbounded (sizing rule, capped by maxSide)
    expect(j.durations).toEqual({ incubation: 5, infectious: 7 });
    expect(j.offsetGrid).toEqual(RECIPE_DEFAULTS.offsetGrid);
    expect(j.changePoints).toEqual(genericChangePoints(35));
    expect(j.cutoff).toBe(35);
    expect(j.horizonDays).toBe(28);
    expect(j.turns.multFloor).toBe(0.5);
    expect(j.stateAnchor).toEqual({ ...RECIPE_SETTINGS.stateAnchor });
  });

  it('lets per-outbreak values override the defaults, caps ascertainment at 1 and omits the IFR without deaths', () => {
    const cases = synthetic().filter((p) => p.category === 'cumulative_infections');
    const j = recipeJob(inputs({ observed: cases, ascertainment: [0.1, 1.5, 2], populationAtRisk: 5000, maxSide: 256 }));
    expect(j.individual.asc).toEqual([0.1, 1, 1]);
    expect(j.individual.nAtRisk).toBe(5000);
    expect(j.individual.maxSide).toBe(256);
    expect(j.individual.ifr).toBeUndefined();
  });

  it('places generic change points every 21 days back from the cutoff, first segment ≥ 28 days', () => {
    expect(genericChangePoints(48)).toEqual([]);
    expect(genericChangePoints(49)).toEqual([{ tick: 28 }]);
    expect(genericChangePoints(100)).toEqual([{ tick: 37 }, { tick: 58 }, { tick: 79 }]);
  });
});

describe('recipe sizing (one cell = one person)', () => {
  const pts = (c: number): ObservedPoint[] => [{ day: 0, value: 0, category: 'cumulative_infections' }, { day: 10, value: c, category: 'cumulative_infections' }];
  it('takes the next power of two of √(H·C/asc_lo), at least 64', () => {
    expect(recipeSizing(pts(10), 10, { asc: [0.2, 0.45, 1] }).side).toBe(64);
    expect(recipeSizing(pts(100), 10, { asc: [0.2, 0.45, 1] }).side).toBe(256); // B = 10·max(100, 7·100)/0.2 = 35 000, √B ≈ 187
    expect(recipeSizing(pts(1000), 10, { asc: [0.2, 0.45, 1] }).side).toBe(1024); // √350 000 ≈ 592 (module default cap 1024)
  });
  it('is bounded by the population at risk and by maxSide', () => {
    expect(recipeSizing(pts(1e5), 10, { asc: [0.2, 0.45, 1], maxSide: 512 }).side).toBe(512);
    expect(recipeSizing(pts(1e5), 10, { asc: [0.2, 0.45, 1], nAtRisk: 10000, maxSide: 512 }).side).toBe(100);
  });
  it('rejects an ascertainment range outside (0, 1]', () => {
    expect(() => recipeSizing(pts(10), 10, { asc: [0.5, 0.6, 1.2] })).toThrow(/asc range/);
  });
});

describe('runRecipeForecast', () => {
  const job = recipeJob(inputs());
  const r1 = runRecipeForecast(job);

  it('is deterministic (same job → same result, field for field)', () => {
    expect(withoutTiming(runRecipeForecast(job, defaultRecipeRunners()))).toBe(withoutTiming(r1));
  });

  it('forecasts 64 trials on a lattice of at most 512² people', () => {
    expect(r1.paths).toHaveLength(64);
    expect(r1.deathPaths).toHaveLength(64);
    expect(r1.indivInfo.side).toBeLessThanOrEqual(512);
    expect(r1.config.size).toBe(r1.indivInfo.side);
    for (const p of r1.paths) expect(p.length).toBeGreaterThan(job.cutoff + 28);
  });

  it('summarizes into monotone percentile bands for the UI', () => {
    const s = summarizeRecipe(r1);
    expect(s.probs).toEqual(ENSEMBLE_PROBS);
    const rows = s.bands.cumulative_infections as number[][];
    expect(rows).toHaveLength(ENSEMBLE_PROBS.length);
    const d = job.cutoff + 28;
    for (let i = 1; i < rows.length; i++) expect(rows[i][d]).toBeGreaterThanOrEqual(rows[i - 1][d]);
    expect(s.side).toBe(r1.indivInfo.side);
  });

  it('matches its pinned digest', () => {
    expect(fnv(JSON.stringify([r1.paths, r1.deathPaths, r1.params, r1.transmissionMultipliers, r1.bmaInfo.cells]))).toBe(DIGEST);
  });

  it('refuses a job without the recipe pieces', () => {
    expect(() => runRecipeForecast({ ...job, turns: undefined as never })).toThrow(/required/);
  });
});

const DIGEST = '35543908';

// Pooled fits (opt-in `pooledFits`, off by default).
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (x) => x.toString(16).padStart(2, '0')).join('');
// Pinned before pooledFits existed (sha256 of the job, the whole result without fitMs/totalMs, the summary without ms):
// with the option absent or 1, the estimator's job, result and summary must stay byte-identical.
const BEFORE = {
  job: '069cc9f78a277bd48133f3f24cabcde344d5541742610495a9fd058248f157c9',
  result: '4941b5cf3e125cfaf13bfd6613738f6dea5a4e4412487657d9224205f480b222',
  summary: 'f51c78d1fff610513497ac2bfabf348db86fa40a1f0bd894636c330e2ba50068',
};
const summaryNoMs = (r: RecipeResult) => { const s: Record<string, unknown> = { ...summarizeRecipe(r) }; delete s.ms; return JSON.stringify(s); };

describe('pooled fits (opt-in)', () => {
  const job = recipeJob(inputs());
  const single = runRecipeForecast(job);

  it('is off by default: job, result and summary are byte-identical to the estimator before the option existed', async () => {
    expect(job.pooledFits).toBeUndefined();
    expect(await sha256(JSON.stringify(job))).toBe(BEFORE.job);
    expect(await sha256(withoutTiming(single))).toBe(BEFORE.result);
    expect(await sha256(summaryNoMs(single))).toBe(BEFORE.summary);
    expect(single.pool).toBeUndefined();
    expect(JSON.stringify(recipeJob(inputs({ pooledFits: 1 })))).toBe(JSON.stringify(job)); // 1 = off: no field on the job
    const one = runRecipeForecast({ ...job, pooledFits: 1 }); // set on the job directly: same run, the job echoes the field
    expect(one.pool).toBeUndefined();
    expect(JSON.stringify(one.paths)).toBe(JSON.stringify(single.paths));
    expect(withoutTiming({ ...one, job })).toBe(withoutTiming(single));
  }, 120_000);

  it('rejects counts outside [1, 8], and recipeCore refuses a pooled job', () => {
    for (const k of [0, 1.5, 9, -1]) expect(() => recipeJob(inputs({ pooledFits: k }))).toThrow(/pooledFits/);
    expect(() => recipeCore({ ...job, pooledFits: 3 }).next()).toThrow(/pooledFits/);
  });

  it('builds K jobs that differ only in seed: S, S + 100, S + 200', () => {
    const j3 = recipeJob(inputs({ pooledFits: 3 }));
    expect(j3.pooledFits).toBe(3);
    const subs = pooledFitJobs(j3);
    expect(subs.map((x) => x.seed)).toEqual([7, 7 + POOL_SEED_STEP, 7 + 2 * POOL_SEED_STEP]);
    for (const x of subs) { const y: Record<string, unknown> = { ...x, seed: job.seed }; expect(JSON.stringify(y)).toBe(JSON.stringify(job)); }
    expect(pooledFitJobs(job)).toEqual([job]);
  });

  describe('with 3 fits', () => {
    const j3 = recipeJob(inputs({ pooledFits: 3 }));
    const pooled = runRecipeForecast(j3);
    const fits = [0, 1, 2].map((j) => runRecipeForecast({ ...job, seed: job.seed + POOL_SEED_STEP * j }));

    it('each pooled fit is the plain estimator run at its seed, bit for bit (fit 0 = the default run)', () => {
      expect(pooled.pool?.fits).toBe(3);
      expect(pooled.pool?.seeds).toEqual([7, 107, 207]);
      expect(withoutTiming(pooled.pool!.results[0])).toBe(withoutTiming(single));
      for (let j = 0; j < 3; j++) expect(withoutTiming(pooled.pool!.results[j])).toBe(withoutTiming(fits[j]));
      expect(pooled.simulations).toBe(fits.reduce((s, r) => s + r.simulations, 0));
    });

    it('forecasts from the concatenation of the fits\' trials in fit order (cases, deaths, state-anchor base deaths)', () => {
      expect(pooled.paths).toHaveLength(192);
      expect(JSON.stringify(pooled.paths)).toBe(JSON.stringify(fits.flatMap((r) => r.paths)));
      expect(JSON.stringify(pooled.deathPaths)).toBe(JSON.stringify(fits.flatMap((r) => r.deathPaths ?? [])));
      expect(JSON.stringify(pooled.deathPathsSaBase)).toBe(JSON.stringify(fits.flatMap((r) => r.deathPathsSaBase ?? [])));
      expect(pooled.mapPaths).toBe(pooled.paths);
      // everything else is fit 0's
      expect(JSON.stringify([pooled.params, pooled.transmissionMultipliers, pooled.bmaInfo, pooled.config])).toBe(JSON.stringify([single.params, single.transmissionMultipliers, single.bmaInfo, single.config]));
      expect(pooled.job).toBe(j3);
      const s = summarizeRecipe(pooled);
      expect(s.pooledFits).toBe(3);
      expect(s.paths).toHaveLength(192);
      expect(summarizeRecipe(single).pooledFits).toBeUndefined();
    });

    it('gives the benchmark pooling\'s samples and quantiles on the same three fits', () => {
      // The benchmark's S3-F1 pooling, verbatim: per-fit samples = path[T] − path[cutoff] in the fit's trial order
      // (its stored message holds, per day, one value per trial), pooled by concatenation in fit order, quantiles by
      // linear interpolation between order statistics.
      const samplesOf = (rep: any, target: string, T: number, cut: number) => { const P = rep?.[target]; if (!P || !P[T] || !P[cut]) return null; return (P[T] as number[]).map((v, i) => v - P[cut][i]); };
      const poolFull = (arrs: (number[] | null)[]) => arrs.flatMap((a) => a ?? []);
      const quantile = (xs: number[], p: number) => { const a = [...xs].sort((a, b) => a - b), i = (a.length - 1) * p, l = Math.floor(i); return a[l] + (a[Math.ceil(i)] - a[l]) * (i - l); };
      const cut = job.cutoff; const days = [cut, cut + 7, cut + 14, cut + 21, cut + 28];
      const pick = (ps: number[][] | undefined) => (ps ? Object.fromEntries(days.map((d) => [d, ps.map((p) => p[d])])) : null);
      const reps = fits.map((r) => ({ cases: pick(r.paths), deaths: pick(r.deathPaths) }));
      for (const [target, ps] of [['cases', pooled.paths], ['deaths', pooled.deathPaths as number[][]]] as const) {
        for (const T of days.slice(1)) {
          const bench = poolFull(reps.map((rep) => samplesOf(rep, target, T, cut)));
          const app = ps.map((p) => p[T] - p[cut]);
          expect(app).toEqual(bench);
          for (const q of [0.025, 0.05, 0.25, 0.5, 0.75, 0.95, 0.975]) expect(quantile(app, q)).toBe(quantile(bench, q));
        }
      }
    });
  });
});
