// URL hash state codec — compact, diff-against-preset query string.
//
// A permalink is a transmissible spec of a run, so we keep it as short as
// possible (smaller QR codes scan far more reliably): the URL only carries the
// fields that DIFFER from the named preset's factory defaults — see
// baseSimConfig() in presets.ts for that baseline. Anything absent is restored
// from the base on decode, so determinism is preserved. A disabled intervention
// is dropped entirely.
//
// Keys are terse but inline-editable. Map:
//   p   preset id        s   seed            z   grid size       g   geometry
//   si  seed infections  br  birth rate      mu  mutate          n   custom name
//   t   theme            sp  speed index
//   strain: at attack · ic incubation · if infectious · fr ifr · rg range
//           im immunity days · mr mutation rate
//   voronoi (only when g=voronoi): vm mode · vi irregularity
//   mask: mk on · mku uptake · mkp protection · mks source · mkm mortality
//   vaccine: vx on · vxu uptake · vxp protection · vxs source · vxm mortality
//   lockdown: ld on · ldm mobility · ldt transmission · ldc compliance
//   quarantine: q on · qr detection · qg contacts range · qp protection
//               qs source · qd duration
//   cost: cR region · cC currency · crt rate · then per-profile c* fields
//
// Example: #/sim?p=sars2-delta&z=96&mk=1&mku=0.6
//   = Delta on a 96² grid with masks on at 60% uptake; everything else preset.

import type { CostConfig, GeometryType, VoronoiMode, SimConfig } from '../types';
import { findCurrency, costConfigFromProfile } from './cost';
import { baseSimConfig, findPreset } from '../sim/presets';

const VALID_GEOMETRIES = new Set<string>(['square', 'triangular', 'hexagonal', 'meanfield', 'voronoi']);
const VALID_VORONOI_MODES = new Set<string>(['uniform', 'jittered', 'relaxed', 'settlements']);

export interface PermalinkOptions {
  config: SimConfig;
  theme: string;
  speed: number;
  presetId: string;
  customName?: string | null;
  costConfig?: CostConfig;
}

export function encode(opts: PermalinkOptions): string {
  const c = opts.config;
  const b = baseSimConfig(opts.presetId);
  const params = new URLSearchParams();

  // Diff helpers: emit a key only when it differs from the preset baseline.
  const num = (key: string, val: number, base: number) => {
    if (round3(val) !== round3(base)) params.set(key, String(round3(val)));
  };
  const ival = (key: string, val: number, base: number) => {
    if ((val | 0) !== (base | 0)) params.set(key, String(val | 0));
  };
  const flag = (key: string, val: boolean, base: boolean) => {
    if (val !== base) params.set(key, val ? '1' : '0');
  };
  const str = (key: string, val: string, base: string) => {
    if (val !== base) params.set(key, val);
  };

  // The preset id anchors the whole base, so it's always present.
  params.set('p', opts.presetId);
  if ((c.seed >>> 0) !== (b.seed >>> 0)) params.set('s', (c.seed >>> 0).toString());
  ival('z', c.size, b.size);
  str('g', c.geometry ?? 'square', b.geometry ?? 'square');
  num('si', c.seedInfections, b.seedInfections);
  num('br', c.birthRate, b.birthRate);
  flag('mu', c.mutate, b.mutate);

  // Strain genes.
  const sg = c.strain, bg = b.strain;
  num('at', sg.attackRate, bg.attackRate);
  ival('ic', sg.incubation, bg.incubation);
  ival('if', sg.infectious, bg.infectious);
  num('fr', sg.ifr, bg.ifr);
  ival('rg', sg.range, bg.range);
  ival('im', sg.immunityDays, bg.immunityDays);
  num('mr', sg.mutationRate, bg.mutationRate);

  // Voronoi tuning is only meaningful under voronoi geometry.
  if ((c.geometry ?? 'square') === 'voronoi') {
    str('vm', c.voronoiConfig?.mode ?? 'jittered', b.voronoiConfig?.mode ?? 'jittered');
    num('vi', c.voronoiConfig?.irregularity ?? 0.5, b.voronoiConfig?.irregularity ?? 0.5);
  }

  // Interventions — a disabled one is dropped entirely (its absence decodes
  // back to "off" with preset defaults). Enabled ones carry only their changes.
  const mask = c.defenses.find((d) => d.id === 'mask');
  const bMask = b.defenses.find((d) => d.id === 'mask')!;
  if (mask?.enabled) {
    params.set('mk', '1');
    num('mku', mask.uptake, bMask.uptake);
    num('mkp', mask.protection, bMask.protection);
    num('mks', mask.sourceControl, bMask.sourceControl);
    num('mkm', mask.mortalityReduction, bMask.mortalityReduction);
  }
  const vax = c.defenses.find((d) => d.id === 'vaccine');
  const bVax = b.defenses.find((d) => d.id === 'vaccine')!;
  if (vax?.enabled) {
    params.set('vx', '1');
    num('vxu', vax.uptake, bVax.uptake);
    num('vxp', vax.protection, bVax.protection);
    num('vxs', vax.sourceControl, bVax.sourceControl);
    num('vxm', vax.mortalityReduction, bVax.mortalityReduction);
  }
  if (c.lockdown.enabled) {
    params.set('ld', '1');
    num('ldm', c.lockdown.mobilityReduction, b.lockdown.mobilityReduction);
    num('ldt', c.lockdown.transmissionReduction, b.lockdown.transmissionReduction);
    num('ldc', c.lockdown.compliance, b.lockdown.compliance);
  }
  if (c.quarantine.enabled) {
    params.set('q', '1');
    num('qr', c.quarantine.detectionRate, b.quarantine.detectionRate);
    ival('qg', c.quarantine.contactsRange, b.quarantine.contactsRange);
    num('qp', c.quarantine.protection, b.quarantine.protection);
    num('qs', c.quarantine.sourceControl, b.quarantine.sourceControl);
    ival('qd', c.quarantine.duration, b.quarantine.duration);
  }

  // UI prefs (defaults: petri theme, speed index 2).
  str('t', opts.theme, 'petri');
  ival('sp', opts.speed, 2);
  if (opts.customName) params.set('n', opts.customName);

  // Cost model — diffed against the preset's bundled cost profile, so an
  // untouched cost model adds nothing to the URL.
  if (opts.costConfig) {
    const cc = opts.costConfig;
    const cb = costConfigFromProfile(findPreset(opts.presetId).cost);
    str('cR', cc.regionId, cb.regionId);
    str('cC', cc.currencyCode, cb.currencyCode);
    num('crt', cc.currencyRate, cb.currencyRate);
    const pf = cc.profile, pb = cb.profile;
    num('chr', pf.hospitalizationRate, pb.hospitalizationRate);
    num('cic', pf.icuRate, pb.icuRate);
    num('csy', pf.symptomaticFraction, pb.symptomaticFraction);
    num('cwk', pf.workCapacityLoss, pb.workCapacityLoss);
    ival('cgd', pf.gdpPerCapitaAnnual, pb.gdpPerCapitaAnnual);
    num('clb', pf.laborParticipationRate, pb.laborParticipationRate);
    ival('cmd', pf.medCostMild, pb.medCostMild);
    ival('cwd', pf.medCostHospWard, pb.medCostHospWard);
    ival('ciu', pf.medCostICU, pb.medCostICU);
    ival('cvs', pf.vsl, pb.vsl);
    num('cmk', pf.maskCostPerDayPerPerson, pb.maskCostPerDayPerPerson);
    ival('cvp', pf.vaccineDosePrice, pb.vaccineDosePrice);
    ival('cvn', pf.vaccineDosesRequired, pb.vaccineDosesRequired);
    ival('cvd', pf.vaccineDeliveryExtra, pb.vaccineDeliveryExtra);
    ival('cqc', pf.quarantineDailyCommunity, pb.quarantineDailyCommunity);
    ival('cqh', pf.quarantineDailyHospital, pb.quarantineDailyHospital);
    flag('cqx', pf.quarantineIsHospital, pb.quarantineIsHospital);
    num('clk', pf.lockdownGdpFractionPerUnit, pb.lockdownGdpFractionPerUnit);
    ival('cim', pf.immunityDays, pb.immunityDays);
    // Beds-per-capita is ~1e-3; round3 would collapse it, so compare/emit raw.
    if (pf.hospitalBedsPerCapita !== pb.hospitalBedsPerCapita) {
      params.set('cbd', String(pf.hospitalBedsPerCapita));
    }
    num('csm', pf.surgeCostMultiplier, pb.surgeCostMultiplier);
    ival('csd', pf.surgeMortalityCostPerOverflowCase, pb.surgeMortalityCostPerOverflowCase);
  }
  return '#/sim?' + params.toString();
}

/** Decode cost params, falling back to `base` (the active preset's cost) for
 *  any field the URL omitted. */
export function decodeCostConfig(p: URLSearchParams, base: CostConfig): CostConfig {
  const b = base.profile;
  const currencyCode = p.get('cC') ?? base.currencyCode;
  return {
    regionId: p.get('cR') ?? base.regionId,
    currencyCode,
    currencyRate: num(p, 'crt', p.has('cC') ? findCurrency(currencyCode).rateVsUsd : base.currencyRate),
    profile: {
      hospitalizationRate: clamp01(num(p, 'chr', b.hospitalizationRate)),
      icuRate: clamp01(num(p, 'cic', b.icuRate)),
      symptomaticFraction: clamp01(num(p, 'csy', b.symptomaticFraction)),
      workCapacityLoss: clamp01(num(p, 'cwk', b.workCapacityLoss)),
      gdpPerCapitaAnnual: Math.max(0, num(p, 'cgd', b.gdpPerCapitaAnnual)),
      laborParticipationRate: clamp01(num(p, 'clb', b.laborParticipationRate)),
      medCostMild: Math.max(0, num(p, 'cmd', b.medCostMild)),
      medCostHospWard: Math.max(0, num(p, 'cwd', b.medCostHospWard)),
      medCostICU: Math.max(0, num(p, 'ciu', b.medCostICU)),
      vsl: Math.max(0, num(p, 'cvs', b.vsl)),
      maskCostPerDayPerPerson: Math.max(0, num(p, 'cmk', b.maskCostPerDayPerPerson)),
      vaccineDosePrice: Math.max(0, num(p, 'cvp', b.vaccineDosePrice)),
      vaccineDosesRequired: Math.max(0, int(p, 'cvn', b.vaccineDosesRequired)),
      vaccineDeliveryExtra: Math.max(0, num(p, 'cvd', b.vaccineDeliveryExtra)),
      quarantineDailyCommunity: Math.max(0, num(p, 'cqc', b.quarantineDailyCommunity)),
      quarantineDailyHospital: Math.max(0, num(p, 'cqh', b.quarantineDailyHospital)),
      quarantineIsHospital: bool(p, 'cqx', b.quarantineIsHospital),
      lockdownGdpFractionPerUnit: Math.max(0, num(p, 'clk', b.lockdownGdpFractionPerUnit)),
      immunityDays: Math.max(1, int(p, 'cim', b.immunityDays)),
      hospitalBedsPerCapita: Math.max(0, num(p, 'cbd', b.hospitalBedsPerCapita)),
      surgeCostMultiplier: Math.max(1, num(p, 'csm', b.surgeCostMultiplier)),
      surgeMortalityCostPerOverflowCase: Math.max(0, num(p, 'csd', b.surgeMortalityCostPerOverflowCase)),
    },
  };
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

export function applyEncoded(p: URLSearchParams, baseArg: SimConfig): {
  config: SimConfig;
  theme?: string;
  speed?: number;
  presetId?: string;
} {
  // The base is rebuilt from the URL's own preset so omitted fields decode to
  // that preset's defaults (not whatever the recipient happens to have loaded).
  const presetId = p.get('p') ?? undefined;
  const base = presetId ? baseSimConfig(presetId) : baseArg;
  const bMask = base.defenses.find((d) => d.id === 'mask') ?? {
    id: 'mask', label: 'Mask', enabled: false, protection: 0.2, sourceControl: 0.81, mortalityReduction: 0, uptake: 0.5,
  };
  const bVax = base.defenses.find((d) => d.id === 'vaccine') ?? {
    id: 'vaccine', label: 'Vaccine', enabled: false, protection: 0.8, sourceControl: 0, mortalityReduction: 0.8, uptake: 0.12,
  };

  const rawGeo = p.get('g') ?? '';
  const geometry: GeometryType = VALID_GEOMETRIES.has(rawGeo)
    ? (rawGeo as GeometryType)
    : (base.geometry ?? 'square');

  const rawVMode = p.get('vm') ?? '';
  const voronoiMode: VoronoiMode = VALID_VORONOI_MODES.has(rawVMode)
    ? (rawVMode as VoronoiMode)
    : (base.voronoiConfig?.mode ?? 'jittered');

  const config: SimConfig = {
    seed: int(p, 's', base.seed) >>> 0,
    size: clampInt(int(p, 'z', base.size), 8, 1024),
    geometry,
    voronoiConfig: {
      mode: voronoiMode,
      irregularity: clamp01(num(p, 'vi', base.voronoiConfig?.irregularity ?? 0.5)),
    },
    seedInfections: clamp01(num(p, 'si', base.seedInfections)),
    birthRate: clamp01(num(p, 'br', base.birthRate)),
    mutate: bool(p, 'mu', base.mutate),
    reseedOnExtinction: base.reseedOnExtinction,
    strain: {
      attackRate: clamp01(num(p, 'at', base.strain.attackRate)),
      incubation: Math.max(1, int(p, 'ic', base.strain.incubation)),
      infectious: Math.max(1, int(p, 'if', base.strain.infectious)),
      ifr: clamp01(num(p, 'fr', base.strain.ifr)),
      range: clampInt(int(p, 'rg', base.strain.range), 1, 8),
      immunityDays: clampInt(int(p, 'im', base.strain.immunityDays), 1, 36500),
      mutationRate: clamp01(num(p, 'mr', base.strain.mutationRate)),
    },
    defenses: [
      {
        ...bMask,
        enabled: bool(p, 'mk', bMask.enabled ?? false),
        uptake: clamp01(num(p, 'mku', bMask.uptake)),
        protection: clamp01(num(p, 'mkp', bMask.protection)),
        sourceControl: clamp01(num(p, 'mks', bMask.sourceControl)),
        mortalityReduction: clamp01(num(p, 'mkm', bMask.mortalityReduction)),
      },
      {
        ...bVax,
        enabled: bool(p, 'vx', bVax.enabled ?? false),
        uptake: clamp01(num(p, 'vxu', bVax.uptake)),
        protection: clamp01(num(p, 'vxp', bVax.protection)),
        sourceControl: clamp01(num(p, 'vxs', bVax.sourceControl)),
        mortalityReduction: clamp01(num(p, 'vxm', bVax.mortalityReduction)),
      },
    ],
    lockdown: {
      enabled: bool(p, 'ld', base.lockdown.enabled),
      mobilityReduction: clamp01(num(p, 'ldm', base.lockdown.mobilityReduction)),
      transmissionReduction: clamp01(num(p, 'ldt', base.lockdown.transmissionReduction)),
      compliance: clamp01(num(p, 'ldc', base.lockdown.compliance)),
    },
    quarantine: {
      enabled: bool(p, 'q', base.quarantine.enabled),
      detectionRate: clamp01(num(p, 'qr', base.quarantine.detectionRate)),
      contactsRange: clampInt(int(p, 'qg', base.quarantine.contactsRange), 1, 5),
      protection: clamp01(num(p, 'qp', base.quarantine.protection)),
      sourceControl: clamp01(num(p, 'qs', base.quarantine.sourceControl)),
      duration: clampInt(int(p, 'qd', base.quarantine.duration), 1, 365),
    },
  };
  return {
    config,
    theme: p.get('t') ?? undefined,
    speed: p.has('sp') ? int(p, 'sp', 2) : undefined,
    presetId,
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
