import { describe, expect, it } from 'vitest';
import { runGA } from '../src/lib/ga';
import { findFitParam } from '../src/lib/fit';
import type { FitParamDef } from '../src/lib/fit';

// Deterministic objectives (K ignored): the GA is exercised purely as an optimizer,
// independent of the stochastic simulator. Each returns a loss to minimize.

function attackParam(bounds: [number, number]): FitParamDef {
  return { ...findFitParam('attackRate'), bounds };
}
function incubationParam(bounds: [number, number]): FitParamDef {
  return { ...findFitParam('incubation'), bounds };
}

describe('runGA: genetic-algorithm optimizer', () => {
  it('recovers the optimum of a smooth convex objective', async () => {
    const params = [attackParam([0, 1]), incubationParam([0, 20])];
    const targetA = 0.42;
    const targetB = 7;
    const evaluate = (v: number[]): Promise<number> =>
      Promise.resolve((v[0] - targetA) ** 2 + ((v[1] - targetB) / 20) ** 2);

    const res = await runGA({ params, evaluate, Kfull: 10, seed: 1, population: 40, generations: 30 });
    expect(res.best.values[0]).toBeCloseTo(targetA, 2);
    expect(res.best.values[1]).toBeCloseTo(targetB, 1);
  });

  it('escapes a deceptive multimodal trap a local search would fall into', async () => {
    // Two basins: a wide shallow decoy near x=0.2 and the true narrow global min at
    // x=0.85. A local refiner started low gets stuck in the decoy; the GA should find
    // the global optimum from its space-filling population.
    const params = [attackParam([0, 1])];
    const evaluate = (v: number[]): Promise<number> => {
      const x = v[0];
      const decoy = 0.3 + 0.4 * (x - 0.2) ** 2;        // shallow bowl, min ≈ 0.3 at x=0.2
      const global = 0.05 + 8 * (x - 0.85) ** 2;       // deep narrow bowl, min ≈ 0.05 at x=0.85
      return Promise.resolve(Math.min(decoy, global));
    };
    const res = await runGA({ params, evaluate, Kfull: 5, seed: 3, population: 48, generations: 30 });
    expect(res.best.values[0]).toBeCloseTo(0.85, 1);
    expect(res.best.loss).toBeLessThan(0.1);
  });

  it('is deterministic — identical seeds give identical results', async () => {
    const params = [attackParam([0, 1]), incubationParam([0, 20])];
    const evaluate = (v: number[]): Promise<number> => Promise.resolve((v[0] - 0.3) ** 2 + (v[1] - 5) ** 2);
    const a = await runGA({ params, evaluate, Kfull: 5, seed: 9, population: 24, generations: 12 });
    const b = await runGA({ params, evaluate, Kfull: 5, seed: 9, population: 24, generations: 12 });
    expect(b.best.values).toEqual(a.best.values);
    expect(b.best.loss).toEqual(a.best.loss);
  });

  it('more parameters never hurt: a 5-D fit reaches loss ≤ the 2-D fit', async () => {
    // Separable quadratic bowl. The first two coords carry the only signal the 2-D
    // search can touch; the extra three coords have their own minima the 5-D search
    // can also drive to zero. With a global optimizer, freeing more genes can only
    // lower the achievable loss — the exact property the user found violated.
    const targets = [0.4, 6, 9, 5, 0.2];
    const all: FitParamDef[] = [
      attackParam([0, 1]),
      incubationParam([0, 20]),
      { ...findFitParam('infectious'), bounds: [0, 20] as [number, number] },
      { ...findFitParam('range'), bounds: [1, 12] as [number, number] },
      { ...findFitParam('ifr'), bounds: [0, 1] as [number, number] },
    ];
    // Objective over the full 5-vector; the 2-D run holds coords 2–4 at a fixed
    // (sub-optimal) value, so its residual on those terms is baked in.
    const fixed = [0, 8, 1, 0.5];
    const sq = (x: number, target: number) => ((x - target)) ** 2;
    const loss5 = (v: number[]): number =>
      sq(v[0], targets[0]) + (sq(v[1], targets[1]) + sq(v[2], targets[2]) + sq(v[3], targets[3]) + sq(v[4], targets[4])) / 100;
    const loss2 = (v: number[]): number =>
      sq(v[0], targets[0]) + (sq(v[1], targets[1]) + sq(fixed[0], targets[2]) + sq(fixed[1], targets[3]) + sq(fixed[2], targets[4])) / 100;

    const res5 = await runGA({ params: all, evaluate: (v) => Promise.resolve(loss5(v)), Kfull: 5, seed: 5, population: 60, generations: 40 });
    const res2 = await runGA({ params: all.slice(0, 2), evaluate: (v) => Promise.resolve(loss2(v)), Kfull: 5, seed: 5, population: 60, generations: 40 });

    expect(res5.best.loss).toBeLessThanOrEqual(res2.best.loss + 1e-6);
  });

  it('rounds integer genes in the returned best', async () => {
    const params = [{ ...findFitParam('range'), bounds: [1, 6] as [number, number] }];
    const evaluate = (v: number[]): Promise<number> => Promise.resolve((v[0] - 4) ** 2);
    const res = await runGA({ params, evaluate, Kfull: 5, seed: 2, population: 20, generations: 15 });
    expect(Number.isInteger(res.best.values[0])).toBe(true);
    expect(res.best.values[0]).toBe(4);
  });
});
