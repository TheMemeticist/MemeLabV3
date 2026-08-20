import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim';
import { WasmEngine, wasmAvailable, wasmCompatible, createEngine } from '../src/sim/wasm-engine';
import type { GeometryType, SimConfig, SimStats } from '../src/types';

// The WASM engine's determinism contract is BIT-EQUALITY with the TS reference
// engine: same config → identical SimStats stream, forever. These tests
// enforce it by stepping both engines side by side under the same full-surface
// config the golden digests use (births, deaths, waning, both defenses,
// lockdown, quarantine). Because parity is exact, the TS golden digests in
// engine-golden.test.ts pin the wasm engine too — no separate digest family.

function goldenConfig(geometry: GeometryType): SimConfig {
  return {
    seed: 0x5eed5eed >>> 0,
    size: 48,
    geometry,
    seedInfections: 0.03,
    birthRate: 0.05,
    mutate: false,
    strain: { attackRate: 0.35, incubation: 3, infectious: 6, ifr: 0.05, range: 1, immunityDays: 45, mutationRate: 0 },
    defenses: [
      { id: 'mask', label: 'Mask', enabled: true, protection: 0.3, sourceControl: 0.3, mortalityReduction: 0, uptake: 0.25 },
      { id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0.5, sourceControl: 0, mortalityReduction: 0.7, uptake: 0.35 },
    ],
    lockdown: { enabled: true, mobilityReduction: 0.2, transmissionReduction: 0.1, compliance: 0.5 },
    quarantine: { enabled: true, detectionRate: 0.05, contactsRange: 1, protection: 0.4, sourceControl: 0.6, duration: 10 },
  };
}

function expectSameStats(sa: SimStats, sb: SimStats): void {
  expect([sa.s, sa.e, sa.i, sa.r, sa.d, sa.newInfections, sa.newDeaths]).toEqual(
    [sb.s, sb.e, sb.i, sb.r, sb.d, sb.newInfections, sb.newDeaths],
  );
}

const WASM_GEOMETRIES: GeometryType[] = ['square', 'triangular', 'hexagonal', 'meanfield'];

describe('WasmEngine ↔ Engine bit-parity', () => {
  it('wasm is available in this runtime', () => {
    expect(wasmAvailable()).toBe(true);
  });

  for (const geometry of WASM_GEOMETRIES) {
    it(`${geometry}: 200-tick stats stream is bit-identical to the TS engine`, () => {
      const ts = new Engine(goldenConfig(geometry));
      const wa = new WasmEngine(goldenConfig(geometry));
      for (let t = 0; t < 200; t++) expectSameStats(ts.step(), wa.step());
      // Cell-level state too, not just aggregates.
      expect(wa.buffers().state).toEqual(ts.buffers().state);
      expect(wa.buffers().quarantined).toEqual(ts.buffers().quarantined);
    });
  }

  it('patchConfig mid-run stays bit-identical (uptake, strain genes, quarantine off)', () => {
    const ts = new Engine(goldenConfig('square'));
    const wa = new WasmEngine(goldenConfig('square'));
    for (let t = 0; t < 30; t++) expectSameStats(ts.step(), wa.step());

    const p1 = goldenConfig('square');
    p1.defenses[0].uptake = 0.7; // grants flags stochastically
    p1.strain.attackRate = 0.5; // rate gene — no reschedule
    ts.patchConfig(structuredClone(p1));
    wa.patchConfig(structuredClone(p1));
    for (let t = 0; t < 30; t++) expectSameStats(ts.step(), wa.step());

    const p2 = structuredClone(p1);
    p2.strain.incubation = 5; // timing gene — deterministic reschedule
    p2.strain.immunityDays = 20; // wane hazard — geometric resample
    ts.patchConfig(structuredClone(p2));
    wa.patchConfig(structuredClone(p2));
    for (let t = 0; t < 30; t++) expectSameStats(ts.step(), wa.step());

    const p3 = structuredClone(p2);
    p3.quarantine.enabled = false; // clears buffers on both sides
    ts.patchConfig(structuredClone(p3));
    wa.patchConfig(structuredClone(p3));
    for (let t = 0; t < 30; t++) expectSameStats(ts.step(), wa.step());
  });

  it('EngineOptions parity: txSchedule and indexCell behave identically', () => {
    const cfg = goldenConfig('square');
    const opts = { txSchedule: [1, 0.5, 0.25], indexCell: 123 };
    const ts = new Engine(cfg, null, opts);
    const wa = new WasmEngine(cfg, null, opts);
    expect(wa.rNaught).toBe(ts.rNaught);
    for (let t = 0; t < 60; t++) expectSameStats(ts.step(), wa.step());
  });

  it('extinction reseed parity', () => {
    const cfg = goldenConfig('square');
    cfg.seedInfections = 0;
    cfg.reseedOnExtinction = true;
    cfg.strain = { attackRate: 0.15, incubation: 2, infectious: 3, ifr: 0.1, range: 1, immunityDays: 40, mutationRate: 0 };
    const ts = new Engine(cfg);
    const wa = new WasmEngine(cfg);
    for (let t = 0; t < 150; t++) expectSameStats(ts.step(), wa.step());
  });

  it('reset() reuse is bit-identical to a fresh WasmEngine', () => {
    const dirty = new WasmEngine(goldenConfig('square'));
    for (let t = 0; t < 40; t++) dirty.step();
    const cfg2 = goldenConfig('hexagonal');
    cfg2.seed = 0x0dd5eed >>> 0;
    dirty.reset(cfg2);
    const fresh = new WasmEngine(goldenConfig('hexagonal'));
    fresh.reset(cfg2); // same path for both
    for (let t = 0; t < 60; t++) expectSameStats(dirty.step(), fresh.step());
  });

  it('conservation holds: S+E+I+R+D = N every tick', () => {
    const cfg = goldenConfig('triangular');
    const wa = new WasmEngine(cfg);
    const n = cfg.size * cfg.size;
    for (let t = 0; t < 100; t++) {
      const s = wa.step();
      expect(s.s + s.e + s.i + s.r + s.d).toBe(n);
    }
  });
});

describe('createEngine factory + compatibility gate', () => {
  it('routes voronoi and mutation to the TS reference engine', () => {
    const voronoi = goldenConfig('square');
    voronoi.geometry = 'voronoi';
    voronoi.voronoiConfig = { mode: 'jittered', irregularity: 0.5 };
    expect(wasmCompatible(voronoi)).toBe(false);
    expect(createEngine(voronoi, null, undefined, true)).toBeInstanceOf(Engine);

    const mutating = goldenConfig('square');
    mutating.mutate = true;
    expect(wasmCompatible(mutating)).toBe(false);
    expect(createEngine(mutating, null, undefined, true)).toBeInstanceOf(Engine);
  });

  it('returns the wasm engine for compatible configs when preferred', () => {
    const e = createEngine(goldenConfig('square'), null, undefined, true);
    expect(e).toBeInstanceOf(WasmEngine);
  });

  it('returns the TS engine when wasm is not preferred', () => {
    const e = createEngine(goldenConfig('square'), null, undefined, false);
    expect(e).toBeInstanceOf(Engine);
  });
});
