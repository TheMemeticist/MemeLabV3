// URL hash state codec — readable query-string format. Anyone who sees the
// permalink can read off the parameters at a glance, edit them inline, and
// share the result.
//
// Format:
//   #/sim?seed=12648430&size=96&geo=square&attack=0.10&inc=2&inf=4&ifr=0.03&range=2
//        &immDays=180&mut=0.01&seedInf=0.001&birth=0
//        &maskRate=0.50&maskProt=0.20&maskSrc=0.81&maskMort=0
//        &vaxRate=0.12&vaxProt=0.80&vaxSrc=0&vaxMort=0.80
//        &theme=petri&speed=2&preset=sars2-delta&mutate=0

import type { GeometryType, SimConfig } from '../types';

const VALID_GEOMETRIES = new Set<string>(['square', 'triangular', 'hexagonal', 'meanfield']);

export interface PermalinkOptions {
  config: SimConfig;
  theme: string;
  speed: number;
  presetId: string;
  customName?: string | null;
}

export function encode(opts: PermalinkOptions): string {
  const c = opts.config;
  const m = c.defenses.find((d) => d.id === 'mask');
  const v = c.defenses.find((d) => d.id === 'vaccine');
  const params = new URLSearchParams();
  params.set('preset', opts.presetId);
  params.set('seed', (c.seed >>> 0).toString());
  params.set('size', String(c.size));
  params.set('geo', c.geometry ?? 'square');
  params.set('seedInf', round3(c.seedInfections).toString());
  params.set('birth', round3(c.birthRate).toString());
  params.set('mutate', c.mutate ? '1' : '0');
  // Strain genes
  params.set('attack', round3(c.strain.attackRate).toString());
  params.set('inc', String(c.strain.incubation));
  params.set('inf', String(c.strain.infectious));
  params.set('ifr', round3(c.strain.ifr).toString());
  params.set('range', String(c.strain.range));
  params.set('immDays', String(c.strain.immunityDays));
  params.set('mutRate', round3(c.strain.mutationRate).toString());
  // Defenses — mask
  if (m) {
    params.set('maskOn', m.enabled ? '1' : '0');
    params.set('maskRate', round3(m.uptake).toString());
    params.set('maskProt', round3(m.protection).toString());
    params.set('maskSrc', round3(m.sourceControl).toString());
    params.set('maskMort', round3(m.mortalityReduction).toString());
  }
  if (v) {
    params.set('vaxOn', v.enabled ? '1' : '0');
    params.set('vaxRate', round3(v.uptake).toString());
    params.set('vaxProt', round3(v.protection).toString());
    params.set('vaxSrc', round3(v.sourceControl).toString());
    params.set('vaxMort', round3(v.mortalityReduction).toString());
  }
  // Lockdown
  params.set('ldOn', c.lockdown.enabled ? '1' : '0');
  params.set('ldM', round3(c.lockdown.mobilityReduction).toString());
  params.set('ldT', round3(c.lockdown.transmissionReduction).toString());
  params.set('ldC', round3(c.lockdown.compliance).toString());
  // Quarantine
  params.set('qOn', c.quarantine.enabled ? '1' : '0');
  params.set('qRate', round3(c.quarantine.detectionRate).toString());
  params.set('qRange', String(c.quarantine.contactsRange));
  params.set('qProt', round3(c.quarantine.protection).toString());
  params.set('qSrc', round3(c.quarantine.sourceControl).toString());
  params.set('qDur', String(c.quarantine.duration));
  // UI
  params.set('theme', opts.theme);
  params.set('speed', String(opts.speed));
  if (opts.customName) params.set('name', opts.customName);
  return '#/sim?' + params.toString();
}

export function decode(hash: string): URLSearchParams | null {
  if (!hash) return null;
  const idx = hash.indexOf('?');
  if (idx < 0) return null;
  try {
    return new URLSearchParams(hash.slice(idx + 1));
  } catch {
    return null;
  }
}

export function applyEncoded(p: URLSearchParams, base: SimConfig): {
  config: SimConfig;
  theme?: string;
  speed?: number;
  presetId?: string;
} {
  const m = base.defenses.find((d) => d.id === 'mask') ?? {
    id: 'mask', label: 'Mask', enabled: true, protection: 0.2, sourceControl: 0.81, mortalityReduction: 0, uptake: 0.5,
  };
  const v = base.defenses.find((d) => d.id === 'vaccine') ?? {
    id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0.8, sourceControl: 0, mortalityReduction: 0.8, uptake: 0.12,
  };
  const rawGeo = p.get('geo') ?? '';
  const geometry: GeometryType = VALID_GEOMETRIES.has(rawGeo)
    ? (rawGeo as GeometryType)
    : (base.geometry ?? 'square');

  const config: SimConfig = {
    seed: int(p, 'seed', base.seed) >>> 0,
    size: clampInt(int(p, 'size', base.size), 8, 1024),
    geometry,
    seedInfections: clamp01(num(p, 'seedInf', base.seedInfections)),
    birthRate: clamp01(num(p, 'birth', base.birthRate)),
    mutate: bool(p, 'mutate', base.mutate),
    strain: {
      attackRate: clamp01(num(p, 'attack', base.strain.attackRate)),
      incubation: Math.max(1, int(p, 'inc', base.strain.incubation)),
      infectious: Math.max(1, int(p, 'inf', base.strain.infectious)),
      ifr: clamp01(num(p, 'ifr', base.strain.ifr)),
      range: clampInt(int(p, 'range', base.strain.range), 1, 8),
      immunityDays: clampInt(int(p, 'immDays', base.strain.immunityDays), 1, 36500),
      mutationRate: clamp01(num(p, 'mutRate', base.strain.mutationRate)),
    },
    defenses: [
      {
        ...m,
        enabled: bool(p, 'maskOn', m.enabled ?? true),
        uptake: clamp01(num(p, 'maskRate', m.uptake)),
        protection: clamp01(num(p, 'maskProt', m.protection)),
        sourceControl: clamp01(num(p, 'maskSrc', m.sourceControl)),
        mortalityReduction: clamp01(num(p, 'maskMort', m.mortalityReduction)),
      },
      {
        ...v,
        enabled: bool(p, 'vaxOn', v.enabled ?? true),
        uptake: clamp01(num(p, 'vaxRate', v.uptake)),
        protection: clamp01(num(p, 'vaxProt', v.protection)),
        sourceControl: clamp01(num(p, 'vaxSrc', v.sourceControl)),
        mortalityReduction: clamp01(num(p, 'vaxMort', v.mortalityReduction)),
      },
    ],
    lockdown: {
      enabled: bool(p, 'ldOn', base.lockdown.enabled),
      mobilityReduction: clamp01(num(p, 'ldM', base.lockdown.mobilityReduction)),
      transmissionReduction: clamp01(num(p, 'ldT', base.lockdown.transmissionReduction)),
      compliance: clamp01(num(p, 'ldC', base.lockdown.compliance)),
    },
    quarantine: {
      enabled: bool(p, 'qOn', base.quarantine.enabled),
      detectionRate: clamp01(num(p, 'qRate', base.quarantine.detectionRate)),
      contactsRange: clampInt(int(p, 'qRange', base.quarantine.contactsRange), 1, 5),
      protection: clamp01(num(p, 'qProt', base.quarantine.protection)),
      sourceControl: clamp01(num(p, 'qSrc', base.quarantine.sourceControl)),
      duration: clampInt(int(p, 'qDur', base.quarantine.duration), 1, 365),
    },
  };
  return {
    config,
    theme: p.get('theme') ?? undefined,
    speed: p.has('speed') ? int(p, 'speed', 2) : undefined,
    presetId: p.get('preset') ?? undefined,
  };
}

function num(p: URLSearchParams, key: string, fallback: number): number {
  const raw = p.get(key);
  if (raw == null) return fallback;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}
function int(p: URLSearchParams, key: string, fallback: number): number {
  const raw = p.get(key);
  if (raw == null) return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}
function bool(p: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = p.get(key);
  if (raw == null) return fallback;
  return raw === '1' || raw === 'true';
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampInt(v: number, lo: number, hi: number): number {
  const n = v | 0;
  return n < lo ? lo : n > hi ? hi : n;
}
