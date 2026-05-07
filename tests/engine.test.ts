import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim';
import type { SimConfig } from '../src/types';

function baseConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    seed: 0xdeadbeef,
    size: 32,
    seedInfections: 0,
    birthRate: 0,
    mutate: false,
    strain: {
      attackRate: 0.5,
      incubation: 2,
      infectious: 4,
      ifr: 0.0,
      range: 1,
      immunityDays: 36500,
      mutationRate: 0,
    },
    defenses: [
      { id: 'mask', label: 'Mask', protection: 0, sourceControl: 0, mortalityReduction: 0, uptake: 0 },
      { id: 'vaccine', label: 'Vaccine', protection: 0, sourceControl: 0, mortalityReduction: 0, uptake: 0 },
    ],
    ...overrides,
  };
}

describe('Engine', () => {
  it('preserves the population conservation invariant S+E+I+R+D = N', () => {
    const cfg = baseConfig({ seedInfections: 0.05 });
    const engine = new Engine(cfg);
    const n = cfg.size * cfg.size;
    for (let t = 0; t < 50; t++) {
      const stats = engine.step();
      expect(stats.s + stats.e + stats.i + stats.r + stats.d).toBe(n);
      expect(stats.s).toBeGreaterThanOrEqual(0);
      expect(stats.d).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic from a fixed seed', () => {
    const cfg = baseConfig({ seedInfections: 0.02, mutate: true });
    const a = new Engine(cfg);
    const b = new Engine(cfg);
    for (let t = 0; t < 30; t++) {
      const sa = a.step();
      const sb = b.step();
      expect(sb.s).toBe(sa.s);
      expect(sb.e).toBe(sa.e);
      expect(sb.i).toBe(sa.i);
      expect(sb.r).toBe(sa.r);
      expect(sb.d).toBe(sa.d);
      expect(sb.strains).toBe(sa.strains);
    }
  });

  it('makes Dead a terminal state when birthRate=0', () => {
    const cfg = baseConfig({
      seedInfections: 0.5,
      strain: { attackRate: 0.95, incubation: 1, infectious: 1, ifr: 1.0, range: 4, immunityDays: 36500, mutationRate: 0 },
    });
    const engine = new Engine(cfg);
    let lastDead = 0;
    for (let t = 0; t < 30; t++) {
      const s = engine.step();
      expect(s.d).toBeGreaterThanOrEqual(lastDead);
      lastDead = s.d;
    }
  });

  it('R0 estimation produces a non-negative number for a well-formed strain', () => {
    const cfg = baseConfig();
    const engine = new Engine(cfg);
    expect(engine.rNaught).not.toBeNull();
    expect(engine.rNaught!).toBeGreaterThanOrEqual(0);
  });

  it('does not infect when attack rate is zero', () => {
    const cfg = baseConfig({
      seedInfections: 0.05,
      strain: { ...baseConfig().strain, attackRate: 0 },
    });
    const engine = new Engine(cfg);
    const initialNonS = engine.longStats.s.length;
    void initialNonS;
    let infections = 0;
    for (let t = 0; t < 30; t++) {
      const s = engine.step();
      infections = Math.max(infections, s.e + s.i);
    }
    // Without attack, exposed cells incubate and recover but never produce new infections.
    // Total ever-infected ≤ initially seeded.
    const stats = engine.longStats;
    const peakSick = Math.max(...stats.e.map((x, k) => x + (stats.i[k] ?? 0)));
    expect(peakSick).toBeLessThanOrEqual(Math.ceil(0.06 * cfg.size * cfg.size));
  });
});
