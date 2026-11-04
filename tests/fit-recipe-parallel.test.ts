// Parallel recipe driver (fit-recipe-parallel.ts): the same result as the synchronous estimator, bit for bit, whatever the
// number of workers and the order in which their answers arrive. Workers are stood in for by an in-process executor that
// runs each request on structured clones (as postMessage would) and completes it after a random number of event-loop turns,
// with at most N requests in flight.
import { describe, expect, it } from 'vitest';
import { defaultRecipeRunners, execRecipeRequest, recipeJob, runRecipeForecast, summarizeRecipe, type RecipeInputs, type RecipeResult } from '../src/lib/fit-recipe';
import { defaultRecipeWorkers, driveRecipe, runRecipeForecastParallel, type RecipeExecutor } from '../src/lib/fit-recipe-parallel';
import type { ObservedPoint } from '../src/lib/fit';
import { Rng } from '../src/sim/rng';
import { wasmAvailable } from '../src/sim/wasm-engine';

function synthetic(): ObservedPoint[] {
  const obs: ObservedPoint[] = [];
  for (let d = 0; d <= 35; d++) obs.push({ day: d, value: Math.round(5 * Math.exp(0.07 * d)), category: 'cumulative_infections' });
  for (let d = 7; d <= 35; d += 7) obs.push({ day: d, value: Math.round(0.05 * 5 * Math.exp(0.07 * (d - 5))), category: 'cumulative_deaths' });
  return obs;
}
const inputs: RecipeInputs = { observed: synthetic(), presetId: 'sars2-wild', strain: { incubation: 5, infectious: 7, ifr: 0.01 }, horizonDays: 28, seed: 7 };
const withoutTiming = (r: ReturnType<typeof runRecipeForecast>) => { const c: Record<string, unknown> = { ...r }; delete c.fitMs; delete c.totalMs; return JSON.stringify(c); };

/** N slots; each request runs on a structured clone, its response is cloned back and delivered after 0–3 extra macrotask
 *  turns (a seeded Rng picks the delay), so chains and batches complete out of order whenever N > 1. */
function shuffledExecutor(n: number, seed: number): RecipeExecutor & { requests: number; maxInFlight: number } {
  const runners = defaultRecipeRunners(); const rng = new Rng(seed);
  let active = 0; const queue: (() => void)[] = [];
  const ex = {
    requests: 0, maxInFlight: 0,
    wasmAvailable: () => wasmAvailable(),
    run(req: Parameters<RecipeExecutor['run']>[0]) {
      ex.requests++;
      return new Promise<ReturnType<typeof execRecipeRequest>>((resolve) => {
        const start = () => {
          active++; ex.maxInFlight = Math.max(ex.maxInFlight, active);
          const res = structuredClone(execRecipeRequest(runners, structuredClone(req)));
          let turns = rng.intRange(4);
          const tick = () => { if (turns-- > 0) { setTimeout(tick, 0); return; } active--; resolve(res); const nx = queue.shift(); if (nx) nx(); };
          setTimeout(tick, 0);
        };
        if (active < n) start(); else queue.push(start);
      });
    },
  };
  return ex;
}

describe('parallel recipe driver', () => {
  const job = recipeJob(inputs);
  const serial = runRecipeForecast(job);
  const serialJson = withoutTiming(serial);

  for (const n of [1, 3]) {
    it(`gives the synchronous result bit for bit with ${n} worker${n > 1 ? 's' : ''} (answers out of order)`, async () => {
      const ex = shuffledExecutor(n, 0x5eed + n);
      const par = await driveRecipe(job, ex);
      expect(ex.maxInFlight).toBe(n);
      expect(withoutTiming(par)).toBe(serialJson);
      expect(JSON.stringify(summarizeRecipe(par).bands)).toBe(JSON.stringify(summarizeRecipe(serial).bands));
    }, 120_000);
  }

  it('reports progress per stage and runs through runRecipeForecastParallel with a caller executor', async () => {
    const seen = new Set<string>(); let last = -1, monotone = true;
    const par = await runRecipeForecastParallel(job, { executor: shuffledExecutor(2, 11), onProgress: (stage, frac) => { seen.add(stage); if (stage === 'grid') { if (frac < last) monotone = false; last = frac; } } });
    expect(withoutTiming(par)).toBe(serialJson);
    expect([...seen].sort()).toEqual(['forecast', 'grid', 'turns']);
    expect(monotone).toBe(true);
    expect(last).toBe(1);
  }, 120_000);

  it('rejects the run when a request fails', async () => {
    const failing: RecipeExecutor = { wasmAvailable: () => true, run: () => Promise.reject(new Error('worker lost')) };
    await expect(driveRecipe(job, failing)).rejects.toThrow('worker lost');
  });

  it('pools three fits on one executor (fits interleaved, answers out of order) exactly as the synchronous driver does', async () => {
    const noTiming = (r: RecipeResult): string => {
      const c: Record<string, unknown> = { ...r }; delete c.fitMs; delete c.totalMs;
      if (r.pool) c.pool = { ...r.pool, results: r.pool.results.map((x) => JSON.parse(noTiming(x))) };
      return JSON.stringify(c);
    };
    const j3 = { ...job, pooledFits: 3 };
    const syncPooled = runRecipeForecast(j3);
    const ex = shuffledExecutor(4, 0x3f1); const seen = new Set<string>(); let last = -1, monotone = true;
    const par = await runRecipeForecastParallel(j3, { executor: ex, onProgress: (stage, frac) => { seen.add(stage); if (stage === 'grid') { if (frac < last) monotone = false; last = frac; } } });
    expect(par.pool?.seeds).toEqual([7, 107, 207]);
    expect(noTiming(par)).toBe(noTiming(syncPooled));
    expect(withoutTiming(par.pool!.results[0])).toBe(serialJson);
    expect(ex.maxInFlight).toBe(4);
    expect([...seen].sort()).toEqual(['forecast', 'grid', 'turns']);
    expect(monotone).toBe(true);
    expect(last).toBe(1);
  }, 240_000);

  it('rejects a pooled run when one fit\'s request fails, and stops the other fits', async () => {
    const runners = defaultRecipeRunners(); let failed = false; const kinds = new Set<string>();
    const flaky: RecipeExecutor = {
      wasmAvailable: () => true,
      run: (req) => {
        kinds.add(req.kind);
        if (req.seed === 107 && !failed) { failed = true; return Promise.reject(new Error('worker lost')); }
        return new Promise((r) => setTimeout(() => r(execRecipeRequest(runners, req)), 0));
      },
    };
    await expect(driveRecipe({ ...job, pooledFits: 3 }, flaky)).rejects.toThrow('worker lost');
    expect(failed).toBe(true);
    expect([...kinds]).toEqual(['indiv']); // every fit stopped after the grid: no forecast trials or means were requested
  }, 120_000);

  it('defaults to hardwareConcurrency − 1 workers, between 1 and 8', () => {
    expect(defaultRecipeWorkers(16)).toBe(8);
    expect(defaultRecipeWorkers(8)).toBe(7);
    expect(defaultRecipeWorkers(4)).toBe(3);
    expect(defaultRecipeWorkers(2)).toBe(1);
    expect(defaultRecipeWorkers(1)).toBe(1);
  });
});
