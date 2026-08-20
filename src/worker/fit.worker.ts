/// <reference lib="webworker" />
// Headless fitting worker for the R₀ Estimator. Runs K stochastic trials of a
// candidate SimConfig and returns the mean per-capita SEIR curves. The trial
// loop lives in `../lib/fit-sim.ts` (shared with the tests). This worker is
// fully isolated from the live `sim.worker.ts` engine — separate instances,
// separate RNG, no shared state — so it cannot perturb a running simulation.

import { runTrialEnsemble, runTrials } from '../lib/fit-sim';
import type { FitWorkerCommand, FitWorkerResult } from '../types';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (ev: MessageEvent<FitWorkerCommand>) => {
  const { id, config, days, K, seed, ensemble, schedule } = ev.data;
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
