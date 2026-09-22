import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim';
import { estimateAnalyticR0 } from '../src/sim/engine';
import { WasmEngine, wasmAvailable } from '../src/sim/wasm-engine';
import { makeGeometry } from '../src/sim/neighbors';
import { baseSimConfig } from '../src/sim/presets';
import { gpuCompatible } from '../src/sim/gpu-engine';
import { encode, applyEncoded, decode } from '../src/lib/url-state';
import type { GeometryType, SimConfig, SimStats } from '../src/types';

function cfg(geometry: GeometryType, mixing: number, size = 96): SimConfig {
  const c = baseSimConfig('sars2-wild');
  c.size = size; c.seed = 0x1234abcd; c.geometry = geometry; c.seedInfections = 0;
  c.strain = { ...c.strain, attackRate: 0.25, incubation: 5, infectious: 7, mutationRate: 0, immunityDays: 36500, mixing };
  return c;
}
const stats = (s: SimStats) => [s.s, s.e, s.i, s.r, s.d, s.newInfections, s.newDeaths];
function weekly(engine: Engine | WasmEngine, weeks: number): number[] {
  const out: number[] = [];
  for (let w = 0; w < weeks; w++) { let acc = 0; for (let d = 0; d < 7; d++) acc += engine.step().newInfections; out.push(acc); }
  return out;
}

describe('long-range mixing gene', () => {
  it('mixing 0 (or absent) leaves the RNG stream untouched', () => {
    const a = new Engine(cfg('square', 0));
    const c0 = cfg('square', 0); delete c0.strain.mixing;
    const b = new Engine(c0);
    for (let t = 0; t < 120; t++) expect(stats(a.step())).toEqual(stats(b.step()));
  });
  it('is deterministic and conserves population with mixing on', () => {
    const a = new Engine(cfg('square', 0.1));
    const b = new Engine(cfg('square', 0.1));
    const n = 96 * 96;
    for (let t = 0; t < 120; t++) {
      const sa = a.step(), sb = b.step();
      expect(stats(sa)).toEqual(stats(sb));
      expect(sa.s + sa.e + sa.i + sa.r + sa.d).toBe(n);
    }
  });
  it('turns the lattice wave into exponential growth', () => {
    const local = weekly(new Engine(cfg('square', 0)), 8);
    const mixed = weekly(new Engine(cfg('square', 0.1)), 8);
    // Local spread: roughly linear weekly incidence. Mixed: sustained multiplicative growth.
    const ratio = (w: number[]) => w[7] / Math.max(1, w[4]);
    expect(ratio(mixed)).toBeGreaterThan(2.5);
    expect(ratio(mixed)).toBeGreaterThan(ratio(local) * 1.5);
    expect(mixed[7]).toBeGreaterThan(local[7] * 3);
  });
  it('lockdown mobility skips long-range trips for compliant cells', () => {
    const open = cfg('square', 0.2);
    const locked = cfg('square', 0.2);
    locked.lockdown = { enabled: true, mobilityReduction: 1, transmissionReduction: 0, compliance: 1 };
    const a = weekly(new Engine(open), 6).reduce((x, y) => x + y, 0);
    const b = weekly(new Engine(locked), 6).reduce((x, y) => x + y, 0);
    expect(b).toBeLessThan(a * 0.5);
  });
  it('raises the analytic R0 by mixing × infectious days × attack rate', () => {
    const geo = makeGeometry('square');
    const c0 = cfg('square', 0), c1 = cfg('square', 0.1);
    const r0 = estimateAnalyticR0(c0, geo, null)!, r1 = estimateAnalyticR0(c1, geo, null)!;
    expect(r1 - r0).toBeCloseTo(0.1 * 7 * 0.25, 10);
  });
  it('is gated off the GPU and round-trips through permalinks', () => {
    expect(gpuCompatible(cfg('square', 0))).toBe(true);
    expect(gpuCompatible(cfg('square', 0.05))).toBe(false);
    const c = cfg('square', 0.123);
    const back = applyEncoded(decode(encode({ config: c, presetId: 'sars2-wild', theme: 'petri', speed: 1 }))!, baseSimConfig('sars2-wild'));
    expect(back.config.strain.mixing).toBeCloseTo(0.123, 6);
  });
  for (const geometry of ['square', 'voronoi', 'hexagonal'] as GeometryType[]) {
    it(`${geometry}: WASM stays bit-identical to the TS engine with mixing on`, () => {
      if (!wasmAvailable()) throw new Error('wasm unavailable');
      const c = cfg(geometry, 0.08, 48);
      c.lockdown = { enabled: true, mobilityReduction: 0.3, transmissionReduction: 0.1, compliance: 0.5 };
      c.quarantine = { enabled: true, detectionRate: 0.05, contactsRange: 1, protection: 0.4, sourceControl: 0.6, duration: 10 };
      const ts = new Engine(c), wa = new WasmEngine(c);
      for (let t = 0; t < 150; t++) expect(stats(ts.step())).toEqual(stats(wa.step()));
      expect(wa.buffers().state).toEqual(ts.buffers().state);
    });
  }
});
