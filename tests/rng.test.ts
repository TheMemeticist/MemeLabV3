import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/rng';

// The RNG is the determinism invariant's foundation: any future second
// implementation (WASM/GPU) must reproduce these exact sequences. The pinned
// values below are the reference outputs of xoshiro128** seeded via splitmix32
// as implemented in src/sim/rng.ts — a cross-implementation golden anchor.

describe('Rng', () => {
  it('produces the pinned golden sequence for a fixed seed', () => {
    const r = new Rng(0x12345678);
    const got = Array.from({ length: 8 }, () => r.next());
    expect(got).toEqual([
      349100537, 2124053890, 1279890747, 2085039044,
      2578672771, 2987063879, 838459668, 2452818994,
    ]);
  });

  it('produces the pinned golden uniform doubles for seed 1', () => {
    const r = new Rng(1);
    const got = Array.from({ length: 4 }, () => r.random());
    expect(got).toEqual([
      0.5686059948349658, 0.8893939367683266,
      0.4705824180198359, 0.35296769838967534,
    ]);
  });

  it('is deterministic: two instances with the same seed emit identical streams', () => {
    const a = new Rng(0xcafe);
    const b = new Rng(0xcafe);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('different seeds diverge', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const same = Array.from({ length: 16 }, () => a.next() === b.next());
    expect(same.every(Boolean)).toBe(false);
  });

  it('seed 0 is remapped to a non-degenerate state', () => {
    const r = new Rng(0);
    expect(r.next()).toBe(1292791899);
    // And the stream is not stuck at zero.
    const vals = new Set(Array.from({ length: 8 }, () => r.next()));
    expect(vals.size).toBeGreaterThan(1);
  });

  it('random() stays within [0, 1)', () => {
    const r = new Rng(42);
    for (let i = 0; i < 10000; i++) {
      const v = r.random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('bernoulli edge probabilities consume no randomness', () => {
    // The engine relies on this: gating a pass on p<=0 or p>=1 must not
    // perturb the PRNG trajectory relative to calling bernoulli anyway.
    const r = new Rng(7);
    const before = r.snapshot();
    expect(r.bernoulli(0)).toBe(false);
    expect(r.bernoulli(-1)).toBe(false);
    expect(r.bernoulli(1)).toBe(true);
    expect(r.bernoulli(2)).toBe(true);
    expect(r.snapshot()).toEqual(before);
  });

  it('bernoulli(p) frequency approximates p', () => {
    const r = new Rng(1234);
    const n = 20000;
    let hits = 0;
    for (let i = 0; i < n; i++) if (r.bernoulli(0.3)) hits++;
    // ~6 sigma tolerance on a binomial(20000, 0.3).
    expect(hits / n).toBeGreaterThan(0.28);
    expect(hits / n).toBeLessThan(0.32);
  });

  it('intRange(n) covers [0, n) and only [0, n)', () => {
    const r = new Rng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = r.intRange(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it('gaussian() has approximately standard mean and variance', () => {
    const r = new Rng(2024);
    const n = 20000;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = r.gaussian();
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(variance).toBeGreaterThan(0.9);
    expect(variance).toBeLessThan(1.1);
  });

  it('snapshot/restore resumes the identical stream (R0 sandbox contract)', () => {
    const r = new Rng(55);
    for (let i = 0; i < 100; i++) r.next();
    const snap = r.snapshot();
    const branchA = Array.from({ length: 50 }, () => r.next());
    r.restore(snap);
    const branchB = Array.from({ length: 50 }, () => r.next());
    expect(branchB).toEqual(branchA);
    // snapshot() must be a copy, not a live view.
    snap[0] = 0xdeadbeef;
    r.restore(snap);
    const c1 = r.next();
    r.restore(snap);
    expect(r.next()).toBe(c1);
  });

  it('reseed() restarts the stream from scratch', () => {
    const r = new Rng(10);
    const first = Array.from({ length: 10 }, () => r.next());
    r.reseed(10);
    const again = Array.from({ length: 10 }, () => r.next());
    expect(again).toEqual(first);
  });
});
