/// <reference lib="webworker" />
// Headless fitting worker for the R₀ Estimator. Runs K stochastic trials of a
// candidate SimConfig and returns the mean per-capita SEIR curves. The trial
// loop lives in `../lib/fit-sim.ts` (shared with the tests). This worker is
// fully isolated from the live `sim.worker.ts` engine — separate instances,
// separate RNG, no shared state — so it cannot perturb a running simulation.

import { bestTrialSeed, runTrialEnsemble, runTrials } from '../lib/fit-sim';
import {
  defaultRecipeRunners, execRecipeRequest, runRecipeForecast, summarizeRecipe,
  type RecipeRunners, type RecipeSimCommand, type RecipeSimMessage, type RecipeWorkerCommand, type RecipeWorkerMessage,
} from '../lib/fit-recipe';
import { wasmAvailable } from '../sim/wasm-engine';
import type { FitWorkerCommand, FitWorkerResult } from '../types';

declare const self: DedicatedWorkerGlobalScope;

/** Individual-scale recipe estimator (fit-recipe.ts): one whole estimator run per command, synchronous inside this
 *  worker, with optional progress posts. Opt-in; the R₀ Estimator's own path never sends this command. */
function runRecipe(cmd: RecipeWorkerCommand): void {
  const runners = defaultRecipeRunners();
  if (cmd.progress) {
    let last = -1;
    runners.onProgress = (stage, frac) => {
      const pct = Math.floor(frac * 100);
      if (pct === last && frac < 1) return;
      last = pct;
      const msg: RecipeWorkerMessage = { kind: 'recipe-progress', id: cmd.id, stage, frac };
      self.postMessage(msg);
    };
  }
  let msg: RecipeWorkerMessage;
  try {
    msg = { kind: 'recipe-result', id: cmd.id, ok: true, summary: summarizeRecipe(runRecipeForecast(cmd.job, runners)) };
  } catch (err) {
    msg = { kind: 'recipe-result', id: cmd.id, ok: false, error: String((err as Error)?.message ?? err) };
  }
  self.postMessage(msg);
}

/** One candidate simulation of the recipe's parallel driver (fit-recipe-parallel.ts). Pure: the same request gives the
 *  same response in any worker, in any order. */
let simRunners: RecipeRunners | null = null;
function runRecipeSim(cmd: RecipeSimCommand): void {
  let msg: RecipeSimMessage;
  try {
    const res = execRecipeRequest(simRunners ??= defaultRecipeRunners(), cmd.req);
    msg = { kind: 'recipe-sim-result', id: cmd.id, ok: true, res, wasm: wasmAvailable() };
  } catch (err) {
    msg = { kind: 'recipe-sim-result', id: cmd.id, ok: false, error: String((err as Error)?.message ?? err) };
  }
  self.postMessage(msg);
}

self.onmessage = (ev: MessageEvent<FitWorkerCommand | RecipeWorkerCommand | RecipeSimCommand>) => {
  if ('kind' in ev.data && ev.data.kind === 'recipe') { runRecipe(ev.data); return; }
  if ('kind' in ev.data && ev.data.kind === 'recipe-sim') { runRecipeSim(ev.data); return; }
  const { id, config, days, K, seed, ensemble, pickSeed, schedule } = ev.data as FitWorkerCommand;
  if (pickSeed) {
    // Representative-seed pass for Apply: pick the trial closest to the mean.
    const best = bestTrialSeed(config, days, K, seed, schedule);
    const { curves, rNaught } = runTrials(config, days, K, seed, schedule);
    const result: FitWorkerResult = { id, curves, rNaught, bestSeed: best.seed };
    self.postMessage(result);
    return;
  }
  if (ensemble) {
    // Fan-chart pass: per-trial curves, each trial from a different index case.
    const { perTrial, rNaught } = runTrialEnsemble(config, days, K, seed, schedule);
    const result: FitWorkerResult = { id, curves: perTrial[0], rNaught, perTrial };
    self.postMessage(result);
    return;
  }
  const { curves, rNaught } = runTrials(config, days, K, seed, schedule);
  const result: FitWorkerResult = { id, curves, rNaught };
  self.postMessage(result);
};

export {};
