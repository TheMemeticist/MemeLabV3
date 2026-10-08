import { describe, expect, it } from 'vitest';
import { restoreSimConfig } from '../src/sim/config';
import { baseSimConfig } from '../src/sim/presets';
import { Engine } from '../src/sim/engine';

describe('saved simulation configuration', () => {
  it('preserves exact fit values, disabled controls, inactive topology tuning and reseeding', () => {
    const base = baseSimConfig('bdbv');
    const saved = structuredClone(base);
    saved.size = 48;
    saved.seedInfections = 0.03456789;
    saved.birthRate = 0.01234567;
    saved.strain = { ...saved.strain, attackRate: 0.123456789, ifr: 0.0004, mutationRate: 0.0000123 };
    saved.voronoiConfig = { mode: 'settlements', irregularity: 0.87654321 };
    saved.reseedOnExtinction = true;
    saved.defenses[0] = { ...saved.defenses[0], enabled: false, protection: 0.9876543, uptake: 0.83 };
    saved.lockdown = { ...saved.lockdown, enabled: false, compliance: 0.99999 };
    saved.quarantine = { ...saved.quarantine, enabled: false, detectionRate: 0.87654321 };
    const restored = restoreSimConfig(JSON.parse(JSON.stringify(saved)), base);
    expect(restored).toEqual(saved);
    const original = new Engine(saved);
    const reloaded = new Engine(restored);
    for (let tick = 0; tick < 200; tick++) expect(reloaded.step()).toEqual(original.step());
    expect(reloaded.buffers().state).toEqual(original.buffers().state);
    restored.strain.attackRate = 1;
    expect(saved.strain.attackRate).toBe(0.123456789);
    expect(base.strain.attackRate).not.toBe(1);
  });

  it.each([null, [], {}, { strain: [], lockdown: {}, quarantine: {}, defenses: [] }])(
    'uses an independent trusted default for malformed saved structures: %j', (saved) => {
      const base = baseSimConfig('bdbv');
      const restored = restoreSimConfig(saved, base);
      expect(restored).toEqual(base);
      expect(restored).not.toBe(base);
      expect(restored.strain).not.toBe(base.strain);
    },
  );

  it('bounds hostile allocations and rejects wrong-type/nonfinite values without integer wraparound', () => {
    const base = baseSimConfig('bdbv');
    const saved = {
      ...base, seed: NaN, size: 2 ** 40, geometry: 'bad', mutate: 'false', birthRate: Infinity,
      strain: { ...base.strain, incubation: 2 ** 40, infectious: -1, ifr: '0.3', attackRate: 8, range: 100 },
      defenses: [null, { id: 'mask', enabled: 'false', uptake: -3 }],
      quarantine: { ...base.quarantine, duration: 2 ** 40, contactsRange: 500 },
    };
    const restored = restoreSimConfig(saved, base);
    expect(restored).toMatchObject({ seed: base.seed, size: 320, geometry: base.geometry, mutate: base.mutate, birthRate: base.birthRate });
    expect(restored.strain).toMatchObject({ incubation: 365, infectious: 1, ifr: base.strain.ifr, attackRate: 1, range: 8 });
    expect(restored.quarantine).toMatchObject({ duration: 365, contactsRange: 5 });
    expect(restored.defenses[0]).toMatchObject({ enabled: base.defenses[0].enabled, uptake: 0 });
    expect(restored.defenses[1]).toEqual(base.defenses[1]);
  });
  it('keeps the long-range mixing gene of a saved strain', () => {
    const base = baseSimConfig('plague-pneumonic');
    expect(base.strain.mixing).toBe(0.2);
    const restored = restoreSimConfig(JSON.parse(JSON.stringify(base)), baseSimConfig('bdbv'));
    expect(restored.strain.mixing).toBe(0.2);
    const plain = restoreSimConfig(JSON.parse(JSON.stringify(baseSimConfig('sars2-wild'))), base);
    expect(plain.strain.mixing ?? 0).toBe(0);
  });
});
