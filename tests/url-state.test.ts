import { describe, expect, it } from 'vitest';
import { encode, decode, applyEncoded, decodeCostConfig } from '../src/lib/url-state';
import { PRESETS, baseSimConfig, findPreset } from '../src/sim/presets';
import { costConfigFromProfile } from '../src/lib/cost';
import type { SimConfig } from '../src/types';

function roundTrip(config: SimConfig, presetId: string, opts?: { theme?: string; speed?: number }) {
  const url = encode({
    config,
    presetId,
    theme: opts?.theme ?? 'petri',
    speed: opts?.speed ?? 2,
    costConfig: costConfigFromProfile(findPreset(presetId).cost),
  });
  const params = decode(url)!;
  const applied = applyEncoded(params, baseSimConfig('bdbv'));
  return { url, params, applied };
}

describe('url-state codec', () => {
  it('round-trips every preset baseline to an identical config', () => {
    for (const preset of PRESETS) {
      const base = baseSimConfig(preset.id);
      const { applied } = roundTrip(base, preset.id);
      expect(applied.presetId).toBe(preset.id);
      expect(applied.config).toEqual(base);
    }
  });

  it('omits everything but the preset id when nothing differs from the baseline', () => {
    const { params } = roundTrip(baseSimConfig('sars2-delta'), 'sars2-delta');
    // Preset id is always present; nothing else should be (defaults elided).
    expect([...params.keys()]).toEqual(['p']);
  });

  it('round-trips a heavily customised config exactly', () => {
    const cfg = baseSimConfig('sars2-delta');
    cfg.seed = 0xABCDEF12 >>> 0;
    cfg.size = 128;
    cfg.geometry = 'hexagonal';
    cfg.seedInfections = 0.01;
    cfg.mutate = true;
    cfg.strain.attackRate = 0.234;
    cfg.strain.range = 3;
    cfg.defenses[0]!.enabled = true;
    cfg.defenses[0]!.uptake = 0.6;
    cfg.defenses[1]!.enabled = true;
    cfg.quarantine.enabled = true;
    cfg.quarantine.duration = 21;

    const { applied } = roundTrip(cfg, 'sars2-delta', { theme: 'lab', speed: 5 });
    expect(applied.config).toEqual(cfg);
    expect(applied.theme).toBe('lab');
    expect(applied.speed).toBe(5);
  });

  it('drops disabled interventions from the URL entirely', () => {
    const cfg = baseSimConfig('measles');
    cfg.defenses[0]!.enabled = false;
    cfg.defenses[0]!.uptake = 0.99; // tuned-but-off values must not leak in
    cfg.lockdown.enabled = false;
    cfg.lockdown.compliance = 0.42;
    const { url, applied } = roundTrip(cfg, 'measles');
    expect(url).not.toMatch(/[?&]mk=/);
    expect(url).not.toMatch(/[?&]mku=/);
    expect(url).not.toMatch(/[?&]ld[mc]?=/);
    // Decodes back to the disabled baseline, not the tuned-off values.
    expect(applied.config.defenses[0]!.enabled).toBe(false);
    expect(applied.config.defenses[0]!.uptake).toBe(baseSimConfig('measles').defenses[0]!.uptake);
  });

  it('reconstructs the preset baseline even when the recipient base differs', () => {
    // Encode a measles run, decode against a bdbv-loaded session: the URL's own
    // preset must win so genes are not silently inherited from the recipient.
    const cfg = baseSimConfig('measles');
    const url = encode({ config: cfg, presetId: 'measles', theme: 'petri', speed: 2 });
    const applied = applyEncoded(decode(url)!, baseSimConfig('bdbv'));
    expect(applied.config.strain).toEqual(findPreset('measles').genes);
  });

  it('omits an untouched cost model and restores it from the preset', () => {
    const presetId = 'nipah';
    const cost = costConfigFromProfile(findPreset(presetId).cost);
    const url = encode({ config: baseSimConfig(presetId), presetId, theme: 'petri', speed: 2, costConfig: cost });
    expect(url).not.toMatch(/[?&]c[A-Za-z]/); // no cost keys at all
    const decoded = decodeCostConfig(decode(url)!, cost);
    expect(decoded).toEqual(cost);
  });

  it('round-trips an edited cost field', () => {
    const presetId = 'sars2-wild';
    const cost = costConfigFromProfile(findPreset(presetId).cost);
    cost.profile.vsl = 9_000_000;
    cost.profile.hospitalBedsPerCapita = 0.0008;
    const url = encode({ config: baseSimConfig(presetId), presetId, theme: 'petri', speed: 2, costConfig: cost });
    const decoded = decodeCostConfig(decode(url)!, costConfigFromProfile(findPreset(presetId).cost));
    expect(decoded.profile.vsl).toBe(9_000_000);
    expect(decoded.profile.hospitalBedsPerCapita).toBe(0.0008);
  });
});
