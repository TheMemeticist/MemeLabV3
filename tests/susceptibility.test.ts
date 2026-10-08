import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim';
import { WasmEngine, wasmAvailable } from '../src/sim/wasm-engine';
import { gpuCompatible } from '../src/sim/gpu-engine';
import { allocate, drawSusceptibility, seed, susceptibilityCVOf } from '../src/sim/population';
import { resolveDefenses } from '../src/sim/defense';
import { detExp, detLog, Rng } from '../src/sim/rng';
import { baseSimConfig } from '../src/sim/presets';
import { encode, decode, applyEncoded } from '../src/lib/url-state';
import { needsRebuild } from '../src/domain/config-policy';
import { restoreSimConfig } from '../src/sim/config';
import type { GeometryType, SimConfig, SimStats } from '../src/types';

// Heterogeneity in individual susceptibility (SimConfig.susceptibilityCV).
// Contract: off (undefined / 0 / invalid) ⇒ no draws, bit-identical engine;
// on ⇒ s_i ~ Gamma(mean 1, CV) drawn from the single main RNG right after the
// population seed draws, applied to every per-contact infection probability,
// with the WASM core drawing the same multipliers (portable log/exp, so the
// bits match) and stepping bit-identically to the TS engine.

/** The golden full-surface config (births, deaths, waning, both defenses,
 *  lockdown, quarantine) from engine-golden.test.ts, plus options. */
function fullConfig(geometry: GeometryType, extra: Partial<SimConfig> = {}, mixing = 0): SimConfig {
  return {
    seed: 0x5eed5eed >>> 0,
    size: 48,
    geometry,
    voronoiConfig: { mode: 'jittered', irregularity: 0.5 },
    seedInfections: 0.03,
    birthRate: 0.05,
    mutate: false,
    strain: { attackRate: 0.35, incubation: 3, infectious: 6, ifr: 0.05, range: 1, immunityDays: 45, mutationRate: 0, mixing },
    defenses: [
      { id: 'mask', label: 'Mask', enabled: true, protection: 0.3, sourceControl: 0.3, mortalityReduction: 0, uptake: 0.25 },
      { id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0.5, sourceControl: 0, mortalityReduction: 0.7, uptake: 0.35 },
    ],
    lockdown: { enabled: true, mobilityReduction: 0.2, transmissionReduction: 0.1, compliance: 0.5 },
    quarantine: { enabled: true, detectionRate: 0.05, contactsRange: 1, protection: 0.4, sourceControl: 0.6, duration: 10 },
    ...extra,
  };
}

const row = (s: SimStats) => [s.s, s.e, s.i, s.r, s.d, s.newInfections, s.newDeaths];

/** Bit-level equality of two f64 arrays (distinguishes -0/+0 and NaN payloads). */
function sameBits(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length * 2);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length * 2);
  for (let k = 0; k < ua.length; k++) if (ua[k] !== ub[k]) return false;
  return true;
}

describe('susceptibilityCV off: bit-identical to the homogeneous engine', () => {
  for (const geometry of ['square', 'meanfield', 'voronoi'] as GeometryType[]) {
    it(`${geometry}: undefined, 0, negative and NaN all step identically`, () => {
      const ref = new Engine(fullConfig(geometry, {}, 0.05));
      const variants = [0, -1, Number.NaN].map((v) => new Engine(fullConfig(geometry, { susceptibilityCV: v }, 0.05)));
      for (const e of variants) expect(e.susceptibilityBuffer()).toBeNull();
      for (let t = 0; t < 200; t++) {
        const r = row(ref.step());
        for (const e of variants) expect(row(e.step())).toEqual(r);
      }
      for (const e of variants) expect(e.buffers().state).toEqual(ref.buffers().state);
    });
  }

  it('WASM with the option off matches the TS engine and allocates nothing', () => {
    if (!wasmAvailable()) throw new Error('wasm unavailable');
    const c = fullConfig('square', { susceptibilityCV: 0 }, 0.05);
    const ts = new Engine(c), wa = new WasmEngine(c);
    expect(wa.susceptibilityBuffer()).toBeNull();
    for (let t = 0; t < 200; t++) expect(row(wa.step())).toEqual(row(ts.step()));
  });

  it('the draws come after every setup draw: seed() buffers are identical on and off', () => {
    const off = new Engine(fullConfig('square'));
    const on = new Engine(fullConfig('square', { susceptibilityCV: 1.5 }));
    expect(on.buffers().defenses).toEqual(off.buffers().defenses);
    expect(on.buffers().state).toEqual(off.buffers().state);
    expect(on.susceptibilityBuffer()).not.toBeNull();
  });

  it('susceptibilityCVOf only accepts finite positive values', () => {
    const c = fullConfig('square');
    expect(susceptibilityCVOf(c)).toBe(0);
    for (const v of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(susceptibilityCVOf({ ...c, susceptibilityCV: v })).toBe(0);
    expect(susceptibilityCVOf({ ...c, susceptibilityCV: 0.7 })).toBe(0.7);
  });
});

describe('susceptibilityCV on', () => {
  it('is deterministic, conserves population and differs from the homogeneous run', () => {
    const c = fullConfig('square', { susceptibilityCV: 1 }, 0.05);
    const a = new Engine(c), b = new Engine(c), off = new Engine(fullConfig('square', {}, 0.05));
    let differs = false;
    for (let t = 0; t < 200; t++) {
      const sa = a.step(), sb = b.step(), so = off.step();
      expect(row(sa)).toEqual(row(sb));
      expect(sa.s + sa.e + sa.i + sa.r + sa.d).toBe(48 * 48);
      if (row(sa).join() !== row(so).join()) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('draws the multipliers from the main RNG right after seed() (reset reproduces them)', () => {
    const c = fullConfig('voronoi', { susceptibilityCV: 2 });
    const e = new Engine(c);
    const first = Float64Array.from(e.susceptibilityBuffer()!);
    for (let t = 0; t < 50; t++) e.step();
    e.reset(c);
    expect(sameBits(e.susceptibilityBuffer()!, first)).toBe(true);
    // Replay the reset's draw sequence by hand: seed() then the Gamma draws.
    const rng = new Rng(c.seed);
    const D = resolveDefenses(c.defenses);
    seed(allocate(c.size), rng, {
      seedInfections: c.seedInfections, maskUptake: D.uptake[0], vaccineUptake: D.uptake[1],
      lockdownCompliance: c.lockdown.enabled ? c.lockdown.compliance : 0, patientZero: true,
    });
    const direct = new Float64Array(48 * 48);
    drawSusceptibility(direct, 2, rng);
    expect(sameBits(direct, first)).toBe(true);
  });

  it('portable detLog/detExp agree with the platform on the sampler domain', () => {
    // detLog/detExp are fdlibm ports (bit-exact across JS engines and Rust);
    // V8's Math.log/Math.exp are fdlibm too, so here they agree exactly.
    const r = new Rng(42);
    for (let k = 0; k < 5000; k++) {
      const u = r.random();
      expect(detLog(u)).toBe(Math.log(u));
      const x = -40 * r.random();
      expect(detExp(x)).toBe(Math.exp(x));
    }
    expect(detLog(0)).toBe(-Infinity);
    expect(detExp(-Infinity)).toBe(0);
  });

  it('round-trips through permalinks and saved state, and forces a rebuild', () => {
    const base = baseSimConfig('sars2-wild');
    const c = { ...base, susceptibilityCV: 1.25 };
    const link = encode({ config: c, presetId: 'sars2-wild', theme: 'petri', speed: 1 });
    expect(link).toContain('sv=1.25');
    expect(applyEncoded(decode(link)!, base).config.susceptibilityCV).toBe(1.25);
    // Off: no key, and the decoded object carries no field (unchanged shape).
    const offLink = encode({ config: base, presetId: 'sars2-wild', theme: 'petri', speed: 1 });
    expect(offLink).not.toContain('sv=');
    expect('susceptibilityCV' in applyEncoded(decode(offLink)!, base).config).toBe(false);
    expect(restoreSimConfig(JSON.parse(JSON.stringify(c)), base).susceptibilityCV).toBe(1.25);
    expect(restoreSimConfig(JSON.parse(JSON.stringify(base)), base).susceptibilityCV).toBeUndefined();
    expect(needsRebuild(base, c)).toBe(true);
    expect(needsRebuild(c, { ...c })).toBe(false);
    expect(needsRebuild(base, { ...base, susceptibilityCV: 0 })).toBe(false);
  });

  it('treats values too small to share or to draw as off', () => {
    for (const tiny of ['1e-200', '1e-160', '0.0004']) {
      const cfg = applyEncoded(new URLSearchParams(`p=sars2-wild&sv=${tiny}`), baseSimConfig('sars2-wild')).config;
      expect(cfg.susceptibilityCV).toBe(0);
    }
    expect(applyEncoded(new URLSearchParams('p=sars2-wild&sv=0.001'), baseSimConfig('sars2-wild')).config.susceptibilityCV).toBe(0.001);
    expect(applyEncoded(new URLSearchParams('p=sars2-wild&sv=99'), baseSimConfig('sars2-wild')).config.susceptibilityCV).toBe(10);
  });

  it('is refused by the GPU engine', () => {
    const c = fullConfig('square', { reseedOnExtinction: false });
    expect(gpuCompatible(c)).toBe(true);
    expect(gpuCompatible({ ...c, susceptibilityCV: 0 })).toBe(true);
    expect(gpuCompatible({ ...c, susceptibilityCV: 1 })).toBe(false);
  });

  // Distribution on 128×128 grids. The standard error of one grid's sample
  // mean is CV/128 (0.004 / 0.008 / 0.016 for CV 0.5 / 1 / 2), so the task's
  // ±0.02 mean tolerance is only ~1.3 SE for CV = 2: about 1 grid in 4 misses
  // it by chance (the golden seed's grid gives 0.971). Therefore: the ±0.02
  // mean and ±5 % CV tolerances are asserted on 16 pooled 128×128 grids
  // (262 144 draws; SE ≤ 0.004), and the single engine-drawn grid is held to
  // ±5 % on the CV and 4 SE on the mean. Seeds are fixed, not tuned.
  for (const cv of [0.5, 1, 2]) {
    it(`Gamma draws have mean 1 and CV ${cv} on a 128×128 grid`, () => {
      const stats = (a: Float64Array) => {
        let m = 0; for (let k = 0; k < a.length; k++) m += a[k]; m /= a.length;
        let v = 0; for (let k = 0; k < a.length; k++) v += (a[k] - m) ** 2; v /= a.length - 1;
        return { mean: m, cv: Math.sqrt(v) / m };
      };
      const c = { ...baseSimConfig('sars2-wild'), size: 128, seed: 0x5eed5eed >>> 0, susceptibilityCV: cv };
      const s = new Engine(c).susceptibilityBuffer()!;
      expect(s.length).toBe(128 * 128);
      let min = Infinity; for (let k = 0; k < s.length; k++) min = Math.min(min, s[k]);
      expect(min).toBeGreaterThanOrEqual(0);
      const one = stats(s);
      expect(Math.abs(one.mean - 1)).toBeLessThan(Math.max(0.02, (4 * cv) / 128));
      expect(Math.abs(one.cv / cv - 1)).toBeLessThan(0.05);
      const pooled = new Float64Array(16 * 128 * 128);
      const tmp = new Float64Array(128 * 128);
      for (let k = 0; k < 16; k++) { drawSusceptibility(tmp, cv, new Rng(1000 + k)); pooled.set(tmp, k * tmp.length); }
      const all = stats(pooled);
      expect(Math.abs(all.mean - 1)).toBeLessThan(0.02);
      expect(Math.abs(all.cv / cv - 1)).toBeLessThan(0.05);
    });
  }
});

describe('susceptibilityCV on: WASM ↔ TS bit-parity', () => {
  const cases: Array<{ name: string; cfg: SimConfig }> = [
    { name: 'square, CV 1, no mixing', cfg: fullConfig('square', { susceptibilityCV: 1 }) },
    { name: 'square, CV 2, mixing 0.08', cfg: fullConfig('square', { susceptibilityCV: 2 }, 0.08) },
    { name: 'hexagonal, CV 0.5, mixing 0.08', cfg: fullConfig('hexagonal', { susceptibilityCV: 0.5 }, 0.08) },
    { name: 'triangular, CV 1.5, no mixing', cfg: fullConfig('triangular', { susceptibilityCV: 1.5 }) },
    { name: 'voronoi, CV 1, no mixing', cfg: fullConfig('voronoi', { susceptibilityCV: 1 }) },
    { name: 'voronoi, CV 2, mixing 0.08', cfg: fullConfig('voronoi', { susceptibilityCV: 2 }, 0.08) },
    { name: 'meanfield, CV 1', cfg: fullConfig('meanfield', { susceptibilityCV: 1 }) },
    // Extinction-reseed path (low attack rate ⇒ repeated extinctions).
    {
      name: 'square, CV 1.5, reseed on',
      cfg: fullConfig('square', { susceptibilityCV: 1.5, reseedOnExtinction: true, seedInfections: 0, birthRate: 0,
        strain: { attackRate: 0.1, incubation: 3, infectious: 6, ifr: 0.05, range: 1, immunityDays: 45, mutationRate: 0 },
        lockdown: { enabled: false, mobilityReduction: 0.2, transmissionReduction: 0.1, compliance: 0.5 } }),
    },
    {
      name: 'meanfield, CV 1.5, reseed on',
      cfg: fullConfig('meanfield', { susceptibilityCV: 1.5, reseedOnExtinction: true, seedInfections: 0, birthRate: 0,
        strain: { attackRate: 0.1, incubation: 3, infectious: 6, ifr: 0.05, range: 1, immunityDays: 45, mutationRate: 0 },
        lockdown: { enabled: false, mobilityReduction: 0.2, transmissionReduction: 0.1, compliance: 0.5 } }),
    },
  ];
  for (const { name, cfg } of cases) {
    it(`${name}: identical multipliers, stats and state over 250 ticks`, () => {
      if (!wasmAvailable()) throw new Error('wasm unavailable');
      const ts = new Engine(cfg), wa = new WasmEngine(cfg);
      expect(sameBits(wa.susceptibilityBuffer()!, ts.susceptibilityBuffer()!)).toBe(true);
      let infections = 0;
      for (let t = 0; t < 250; t++) {
        const a = ts.step(), b = wa.step();
        expect(row(b)).toEqual(row(a));
        infections += a.newInfections;
      }
      expect(infections).toBeGreaterThan(0);
      expect(wa.buffers().state).toEqual(ts.buffers().state);
    });
  }
});

// Behaviour against theory (qualitative). Closed 128×128 square population, no
// births/waning/interventions, mixing on, identical transmissibility; only CV
// varies. Heterogeneous susceptibility depletes the most susceptible first, so
// the final attack rate must fall as CV grows (well-mixed SIR theory:
// z = 1 − (1 + R0·CV²·z)^(−1/CV²)). FINAL.md reports the full table.
describe('susceptibilityCV behaviour (closed population, mixing on)', () => {
  function closed(seed: number, cv: number): SimConfig {
    const c = baseSimConfig('sars2-wild');
    // ~33 initial exposures (seedInfections 0.002) so no run dies out by
    // chance before take-off — a lone index case often has s≈0 at CV 2.
    c.size = 128; c.seed = seed; c.geometry = 'square'; c.seedInfections = 0.002; c.birthRate = 0;
    c.reseedOnExtinction = false; c.susceptibilityCV = cv;
    c.strain = { ...c.strain, attackRate: 0.1, incubation: 3, infectious: 6, ifr: 0, immunityDays: 36500, mutationRate: 0, mixing: 0.2 };
    c.defenses = c.defenses.map((d) => ({ ...d, enabled: false, uptake: 0 }));
    c.lockdown = { ...c.lockdown, enabled: false };
    c.quarantine = { ...c.quarantine, enabled: false };
    return c;
  }
  function run(seed: number, cv: number): { attack: number; took: boolean } {
    const e = new Engine(closed(seed, cv));
    const n = 128 * 128;
    let s = n;
    for (let t = 0; t < 3000; t++) {
      const st = e.step();
      s = st.s;
      if (st.e + st.i === 0) break;
    }
    const attack = (n - s) / n;
    return { attack, took: attack > 0.01 };
  }
  it('final attack rate: CV 0 > CV 1 > CV 2 (mean over 5 seeds)', () => {
    const seeds = [11, 22, 33, 44, 55];
    const mean: number[] = [];
    for (const cv of [0, 1, 2]) {
      const rs = seeds.map((sd) => run(sd, cv)).filter((r) => r.took);
      expect(rs.length).toBe(seeds.length);
      mean.push(rs.reduce((a, r) => a + r.attack, 0) / rs.length);
    }
    expect(mean[1]).toBeLessThan(mean[0]);
    expect(mean[2]).toBeLessThan(mean[1]);
  });

  // Well-mixed reference: the mean-field pass is a stochastic SEIR with per-tick
  // hazard 2·I/n·(−ln(1−p)) per susceptible, so R0 = 2·D·(−ln(1−p)) exactly and
  // the gamma-susceptibility final-size equation should hold; the early growth
  // rate depends only on mean susceptibility (1), so it should barely move.
  it('mean-field: final size tracks z = 1 − (1 + R0·CV²·z)^(−1/CV²); early growth similar', () => {
    const P = 0.15, D = 6, n = 128 * 128;
    const R0 = 2 * D * -Math.log(1 - P);
    const theory = (cv: number) => {
      let z = 0.99;
      for (let k = 0; k < 10000; k++) {
        z = cv === 0 ? 1 - Math.exp(-R0 * z) : 1 - Math.pow(1 + R0 * cv * cv * z, -1 / (cv * cv));
      }
      return z;
    };
    const one = (seed: number, cv: number) => {
      const c = closed(seed, cv);
      c.geometry = 'meanfield';
      c.strain = { ...c.strain, attackRate: P, infectious: D, mixing: 0 };
      const e = new Engine(c);
      let s = n, tA = -1, tB = -1;
      for (let t = 0; t < 3000; t++) {
        const st = e.step();
        s = st.s;
        if (tA < 0 && n - s >= 66) tA = st.tick;
        if (tB < 0 && n - s >= 528) tB = st.tick;
        if (st.e + st.i === 0) break;
      }
      return { attack: (n - s) / n, r: Math.log(8) / (tB - tA) };
    };
    const seeds = [11, 22, 33, 44, 55];
    const res = [0, 1, 2].map((cv) => {
      const rs = seeds.map((sd) => one(sd, cv));
      return { cv, attack: rs.reduce((a, r) => a + r.attack, 0) / rs.length, r: rs.reduce((a, r) => a + r.r, 0) / rs.length };
    });
    for (const x of res) expect(Math.abs(x.attack - theory(x.cv))).toBeLessThan(0.02);
    expect(res[1].r / res[0].r).toBeGreaterThan(0.8);
    expect(res[1].r / res[0].r).toBeLessThan(1.2);
    expect(res[2].r / res[0].r).toBeGreaterThan(0.8);
    expect(res[2].r / res[0].r).toBeLessThan(1.2);
  });
});
