import { describe, expect, it } from 'vitest';
import { OUTBREAK_DATASETS } from '../src/lib/outbreak-datasets';
import { runTrials, runTrialEnsemble, bestTrialSeed, resolveFitBackend } from '../src/lib/fit-sim';
import { baseSimConfig } from '../src/sim/presets';

describe('sourced forecast presets', () => {
  it('contains only training observations, with reproducible source attribution', () => {
    expect(OUTBREAK_DATASETS).toHaveLength(4);
    for (const p of OUTBREAK_DATASETS) {
      expect(p.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(p.sourceUrl).toMatch(/^https:\/\//);
      expect(p.points.length).toBeGreaterThan(5);
      expect(Math.max(...p.points.map(x => x.day))).toBeLessThanOrEqual(56);
      expect(p.population).toBe(Math.max(1000, 4 * p.points.at(-1)!.value));
      expect(p.points.every(x => Number.isFinite(x.value) && x.value >= 0)).toBe(true);
    }
  });
  it('selects CPU/WASM without changing complete fitted or ensemble trajectories', () => {
    const config = { ...baseSimConfig('sars2-wild'), size: 24 };
    config.strain.attackRate = .6; config.strain.range = 2;
    const schedule = Array.from({length: 121}, (_,i) => i < 30 ? 1 : .3);
    expect(runTrials(config, 120, 4, 42, schedule, 'cpu')).toEqual(runTrials(config, 120, 4, 42, schedule, 'wasm'));
    expect(runTrialEnsemble(config, 120, 4, 42, schedule, 'cpu')).toEqual(runTrialEnsemble(config, 120, 4, 42, schedule, 'wasm'));
    expect(bestTrialSeed(config, 120, 4, 42, schedule, 'cpu')).toEqual(bestTrialSeed(config, 120, 4, 42, schedule, 'wasm'));
    config.mutate = true;
    expect(resolveFitBackend(config)).toBe('cpu');
    expect(() => runTrials(config, 2, 1, 42, undefined, 'wasm')).toThrow(/incompatible/);
  });
});
