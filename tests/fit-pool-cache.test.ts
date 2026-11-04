// FitPool memo key: two pool commands may share a cached result only if they would run identical trials.
// Regression for the key that ignored the long-range mixing gene (and susceptibility spread, initial seeding,
// waning immunity, defences, and schedule values differing only above the low 16 bits of their rounding).
import { describe, expect, it } from 'vitest';
import { fitPoolCacheKey } from '../src/lib/fit-pool';
import { baseSimConfig } from '../src/sim/presets';
import type { FitWorkerCommand, SimConfig } from '../src/types';

const cmd = (edit: (c: SimConfig) => void = () => {}, schedule?: number[]): FitWorkerCommand => {
  const config = baseSimConfig('sars2-wild');
  config.size = 64;
  edit(config);
  return { id: 1, config, days: 60, K: 8, seed: 12345, schedule };
};

describe('fitPoolCacheKey', () => {
  it('is stable for identical commands', () => {
    expect(fitPoolCacheKey(cmd())).toBe(fitPoolCacheKey(cmd()));
  });

  it('keeps the gene quantization (near-identical GA candidates still share a result)', () => {
    const a = cmd((c) => { c.strain.attackRate = 0.123401; });
    const b = cmd((c) => { c.strain.attackRate = 0.123404; });
    expect(fitPoolCacheKey(a)).toBe(fitPoolCacheKey(b));
  });

  it.each([
    ['mixing', (c: SimConfig) => { c.strain.mixing = 0.2; }],
    ['susceptibilityCV', (c: SimConfig) => { c.susceptibilityCV = 2; }],
    ['seedInfections', (c: SimConfig) => { c.seedInfections = 0.01; }],
    ['immunityDays', (c: SimConfig) => { c.strain.immunityDays = 30; }],
    ['a defence uptake', (c: SimConfig) => { c.defenses[0].enabled = true; }],
  ])('separates commands that differ only in %s', (_name, edit) => {
    expect(fitPoolCacheKey(cmd((c) => { c.strain.mixing = 0; }))).not.toBe(fitPoolCacheKey(cmd((c) => { c.strain.mixing = 0; edit(c); })));
  });

  it('separates schedules that differ only above the low 16 bits', () => {
    // round(0.5e6) and round(0.565536e6) agree in their low 16 bits.
    expect(fitPoolCacheKey(cmd(undefined, [1, 0.5]))).not.toBe(fitPoolCacheKey(cmd(undefined, [1, 0.565536])));
  });
});
