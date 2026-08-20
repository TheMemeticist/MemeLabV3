import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim';
import type { GeometryType, SimConfig, SimStats } from '../src/types';

// Golden-trajectory + engine-contract tests.
//
// The digest suite pins a bit-exact fingerprint of the full per-tick stats
// stream for every geometry under a config that exercises every subsystem at
// once (births, deaths, waning, both defenses, lockdown, quarantine). This is
// the cross-implementation determinism anchor called for by docs/wasm-plan.md
// §4: any future engine variant (refactor, WASM, GPU) must reproduce these
// digests or explicitly re-pin them with a documented reason.
//
// Re-pinning is legitimate ONLY when the RNG trajectory is deliberately
// redefined (e.g. an algorithm change that alters draw order). A digest change
// from an "equivalent" refactor means the determinism invariant broke.

function goldenConfig(geometry: GeometryType): SimConfig {
  return {
    seed: 0x5eed5eed >>> 0,
    size: 48,
    geometry,
    voronoiConfig: { mode: 'jittered', irregularity: 0.5 },
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

/** FNV-1a over the integer fields of the per-tick stats stream. */
function trajectoryDigest(engine: Engine, ticks: number): string {
  let h = 0x811c9dc5 >>> 0;
  const mix = (v: number) => {
    h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 24) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (let t = 0; t < ticks; t++) {
    const s: SimStats = engine.step();
    mix(s.s); mix(s.e); mix(s.i); mix(s.r); mix(s.d);
    mix(s.newInfections); mix(s.newDeaths); mix(s.strains);
  }
  return `0x${h.toString(16)}`;
}

// Re-pin history:
//   2026-08-20  initial pin against the three-pass sweep engine.
//   2026-08-20  re-pinned for the perf-plan.md Phase 1 event-driven core.
//               Deliberate trajectory redefinition: R→S waning draws one
//               geometric sample at recovery instead of one Bernoulli per tick
//               (identical distribution), mean-field folds the mobility roll
//               and per-cohort pow into one draw per susceptible, and pass
//               iteration follows active lists instead of ascending index.
//               Distributions are unchanged; realizations are not.
const GOLDEN: Record<GeometryType, string> = {
  square: '0x171f6f71',
  triangular: '0xa71f4ff4',
  hexagonal: '0xb691e1b5',
  voronoi: '0x456e8bf5',
  meanfield: '0xa9dc2854',
};

describe('golden trajectory digests (cross-implementation determinism anchor)', () => {
  for (const geometry of Object.keys(GOLDEN) as GeometryType[]) {
    it(`${geometry}: 150-tick stats stream matches the pinned digest`, () => {
      const engine = new Engine(goldenConfig(geometry));
      expect(trajectoryDigest(engine, 150)).toBe(GOLDEN[geometry]);
    });
  }
});

describe('conservation and determinism on the untested geometries', () => {
  for (const geometry of ['triangular', 'hexagonal', 'meanfield'] as GeometryType[]) {
    it(`${geometry}: preserves S+E+I+R+D = N under full churn`, () => {
      const cfg = goldenConfig(geometry);
      const engine = new Engine(cfg);
      const n = cfg.size * cfg.size;
      for (let t = 0; t < 80; t++) {
        const s = engine.step();
        expect(s.s + s.e + s.i + s.r + s.d).toBe(n);
      }
    });

    it(`${geometry}: is deterministic from a fixed seed`, () => {
      const cfg = goldenConfig(geometry);
      const a = new Engine(cfg);
      const b = new Engine(cfg);
      for (let t = 0; t < 40; t++) {
        const sa = a.step();
        const sb = b.step();
        expect([sa.s, sa.e, sa.i, sa.r, sa.d]).toEqual([sb.s, sb.e, sb.i, sb.r, sb.d]);
      }
    });
  }
});

// Minimal single-cell config: patient zero only, no churn, no randomness in
// the life-cycle timing itself.
function timingConfig(overrides: Partial<SimConfig['strain']> = {}): SimConfig {
  return {
    seed: 1,
    size: 16,
    seedInfections: 0,
    birthRate: 0,
    mutate: false,
    strain: { attackRate: 0, incubation: 3, infectious: 5, ifr: 0, range: 1, immunityDays: 36500, mutationRate: 0, ...overrides },
    defenses: [
      { id: 'mask', label: 'Mask', enabled: true, protection: 0, sourceControl: 0, mortalityReduction: 0, uptake: 0 },
      { id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0, sourceControl: 0, mortalityReduction: 0, uptake: 0 },
    ],
    lockdown: { enabled: false, mobilityReduction: 0, transmissionReduction: 0, compliance: 0 },
    quarantine: { enabled: false, detectionRate: 0, contactsRange: 1, protection: 0, sourceControl: 0, duration: 14 },
  };
}

describe('exact SEIR life-cycle timing', () => {
  it('E→I fires after exactly `incubation` ticks', () => {
    const engine = new Engine(timingConfig({ incubation: 3 }));
    // Patient zero seeds as Exposed with infectedAge 0.
    let s = engine.step(); // infectedAge 1
    expect(s.e).toBe(1); expect(s.i).toBe(0);
    s = engine.step(); // infectedAge 2
    expect(s.e).toBe(1); expect(s.i).toBe(0);
    s = engine.step(); // infectedAge 3 → Infectious
    expect(s.e).toBe(0); expect(s.i).toBe(1);
  });

  it('I→R fires after exactly `incubation + infectious` ticks when ifr=0', () => {
    const engine = new Engine(timingConfig({ incubation: 2, infectious: 4 }));
    const seen: string[] = [];
    for (let t = 0; t < 8; t++) {
      const s = engine.step();
      seen.push(s.e ? 'E' : s.i ? 'I' : s.r ? 'R' : '?');
    }
    // ticks 1..2 exposed, 3..6 infectious, 7+ recovered
    expect(seen).toEqual(['E', 'I', 'I', 'I', 'I', 'R', 'R', 'R']);
  });

  it('ifr=1 makes I→D certain, and Dead is absorbing at birthRate=0', () => {
    const engine = new Engine(timingConfig({ incubation: 1, infectious: 2, ifr: 1 }));
    for (let t = 0; t < 4; t++) engine.step();
    const s = engine.step();
    expect(s.d).toBe(1);
    expect(s.i).toBe(0);
    for (let t = 0; t < 20; t++) expect(engine.step().d).toBe(1);
  });

  it('immunityDays=1 wanes R back to S on the next tick', () => {
    const engine = new Engine(timingConfig({ incubation: 1, infectious: 1, immunityDays: 1 }));
    const n = 16 * 16;
    let sawRecovered = false;
    for (let t = 0; t < 4; t++) {
      const s = engine.step();
      if (s.r === 1) sawRecovered = true;
      if (sawRecovered && s.r === 0) {
        // Waned: everyone susceptible again, nobody stuck.
        expect(s.s).toBe(n);
        return;
      }
    }
    throw new Error('R never appeared or never waned');
  });

  it('lifelong immunity holds R stable across a long run', () => {
    const engine = new Engine(timingConfig({ incubation: 1, infectious: 1, immunityDays: 36500 }));
    for (let t = 0; t < 200; t++) engine.step();
    const s = engine.step();
    expect(s.r).toBe(1); // patient zero recovered and stays recovered
  });
});

describe('EngineOptions', () => {
  it('rNaught reuse: engine steps bit-identically with and without a precomputed estimate', () => {
    const cfg = goldenConfig('square');
    const reference = new Engine(cfg);
    expect(reference.rNaught).not.toBeNull();
    const reused = new Engine(cfg, null, { rNaught: reference.rNaught });
    expect(reused.rNaught).toBe(reference.rNaught);
    for (let t = 0; t < 40; t++) {
      const sa = reference.step();
      const sb = reused.step();
      expect([sa.s, sa.e, sa.i, sa.r, sa.d, sa.newInfections]).toEqual(
        [sb.s, sb.e, sb.i, sb.r, sb.d, sb.newInfections],
      );
    }
  });

  it('indexCell places patient zero at the requested cell', () => {
    const cfg = timingConfig();
    const engine = new Engine(cfg, null, { indexCell: 5 });
    const buf = engine.buffers();
    expect(buf.state[5]).toBe(1); // Exposed
    const center = (cfg.size >> 1) * cfg.size + (cfg.size >> 1);
    expect(buf.state[center]).toBe(0);
  });

  it('out-of-range indexCell falls back to the grid center', () => {
    const cfg = timingConfig();
    const engine = new Engine(cfg, null, { indexCell: cfg.size * cfg.size + 100 });
    const center = (cfg.size >> 1) * cfg.size + (cfg.size >> 1);
    expect(engine.buffers().state[center]).toBe(1);
  });

  it('txSchedule of all 1s is bit-identical to no schedule', () => {
    const cfg = goldenConfig('square');
    const plain = new Engine(cfg);
    const scheduled = new Engine(cfg, null, { txSchedule: [1, 1, 1] });
    for (let t = 0; t < 40; t++) {
      const sa = plain.step();
      const sb = scheduled.step();
      expect([sa.s, sa.e, sa.i, sa.r, sa.d]).toEqual([sb.s, sb.e, sb.i, sb.r, sb.d]);
    }
  });

  it('txSchedule of 0 halts all transmission and clamps to its last entry', () => {
    const cfg = goldenConfig('square');
    cfg.birthRate = 0;
    const engine = new Engine(cfg, null, { txSchedule: [0] }); // clamped forever
    let newInf = 0;
    for (let t = 0; t < 30; t++) newInf += engine.step().newInfections;
    expect(newInf).toBe(0);
  });

  it('txSchedule scales transmission down monotonically vs baseline', () => {
    const cfg = goldenConfig('square');
    const base = new Engine(cfg);
    const damped = new Engine(cfg, null, { txSchedule: [0.25] });
    let baseInf = 0, dampedInf = 0;
    for (let t = 0; t < 30; t++) {
      baseInf += base.step().newInfections;
      dampedInf += damped.step().newInfections;
    }
    expect(dampedInf).toBeLessThan(baseInf);
  });
});

describe('patchConfig trajectory contract', () => {
  it('a no-op patch (identical config) does not perturb the subsequent trajectory', () => {
    const cfg = goldenConfig('square');
    const control = new Engine(cfg);
    const patched = new Engine(cfg);
    for (let t = 0; t < 20; t++) { control.step(); patched.step(); }
    patched.patchConfig(structuredClone(cfg)); // no distribution changed → no RNG draws
    for (let t = 0; t < 30; t++) {
      const sa = control.step();
      const sb = patched.step();
      expect([sa.s, sa.e, sa.i, sa.r, sa.d]).toEqual([sb.s, sb.e, sb.i, sb.r, sb.d]);
    }
  });
});

describe('quarantine contact tracing', () => {
  it('contactsRange isolates the neighbors of a detected case', () => {
    const cfg = timingConfig({ incubation: 1, infectious: 10, attackRate: 0 });
    cfg.quarantine = { enabled: true, detectionRate: 1, contactsRange: 1, protection: 1, sourceControl: 1, duration: 30 };
    const engine = new Engine(cfg);
    engine.step(); // E → I
    engine.step(); // detection fires, contacts traced
    const q = engine.buffers().quarantined;
    let count = 0;
    for (let i = 0; i < q.length; i++) if (q[i]) count++;
    // Patient zero + its 4 square-lattice range-1 contacts.
    expect(count).toBe(5);
  });
});

describe('buffers() exposes live views', () => {
  it('reflects engine state without copying', () => {
    const cfg = goldenConfig('square');
    const engine = new Engine(cfg);
    const before = engine.buffers().state;
    const sumBefore = before.reduce((a, b) => a + b, 0);
    for (let t = 0; t < 10; t++) engine.step();
    // Same accessor after stepping reflects the current (swapped) buffer.
    const after = engine.buffers().state;
    const sumAfter = after.reduce((a, b) => a + b, 0);
    expect(sumAfter).not.toBe(sumBefore);
    expect(after.length).toBe(cfg.size * cfg.size);
  });
});
