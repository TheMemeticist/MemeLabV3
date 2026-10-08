import type { GeometryType, SimConfig, VoronoiMode } from '../types';

// Hard limits shared by every entry point that can set simulation parameters
// (URL permalink codec, localStorage restore, control-panel sliders, worker).
// Keeping them in one place guarantees a hostile or corrupt permalink cannot
// request a larger run than the UI would ever allow.

/** Grid edge length bounds; population = size². 320² ≈ 100k cells is the
 *  largest the renderer and the Voronoi builder are tuned for. */
export const MIN_GRID_SIZE = 8;
export const MAX_GRID_SIZE = 320;

/** Incubation / infectious period bounds (days). */
export const MIN_STAGE_DAYS = 1;
export const MAX_STAGE_DAYS = 365;

/** Upper bound on SimConfig.susceptibilityCV accepted from permalinks and
 *  saved state (CV 10 ⇒ Gamma shape 0.01: nearly all cells ~0, a few huge). */
export const MAX_SUSCEPTIBILITY_CV = 10;
/** Smallest non-zero heterogeneity the app accepts. Share links carry three
 *  decimals, and far smaller values overflow the Gamma shape (1/cv²) into
 *  non-finite multipliers, so anything below this is treated as off. */
export const MIN_SUSCEPTIBILITY_CV = 0.001;
export function clampSusceptibilityCV(v: number): number {
  if (!Number.isFinite(v) || v < MIN_SUSCEPTIBILITY_CV) return 0;
  return Math.min(MAX_SUSCEPTIBILITY_CV, v);
}

/** Maximum length of a fitted per-day transmission schedule (days). */
export const MAX_SCHEDULE_LEN = 10_000;

export function clampGridSize(v: number): number {
  const n = Math.round(Number.isFinite(v) ? v : MIN_GRID_SIZE);
  return n < MIN_GRID_SIZE ? MIN_GRID_SIZE : n > MAX_GRID_SIZE ? MAX_GRID_SIZE : n;
}

/** Truncate an over-long schedule; returns null for empty/invalid input. */
export function clampSchedule(s: unknown): number[] | null {
  if (!Array.isArray(s) || s.length === 0) return null;
  const out = s.slice(0, MAX_SCHEDULE_LEN).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : 1));
  return out;
}

/** Restore saved configuration without the permalink codec's rounding and
 * omission of disabled controls. Invalid structures fall back to trusted
 * defaults; individual values are bounded before they reach engine allocation. */
export function restoreSimConfig(value: unknown, fallback: SimConfig): SimConfig {
  const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const result = structuredClone(fallback);
  if (!object(value) || !object(value.strain) || !object(value.lockdown) ||
      !object(value.quarantine) || !Array.isArray(value.defenses)) return result;

  const bounded = (v: unknown, base: number, min: number, max: number, integer = false): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return base;
    const n = Math.max(min, Math.min(max, v));
    return integer ? Math.trunc(n) : n;
  };
  const fraction = (v: unknown, base: number) => bounded(v, base, 0, 1);
  const flag = (v: unknown, base: boolean) => typeof v === 'boolean' ? v : base;
  const geometries: GeometryType[] = ['square', 'triangular', 'hexagonal', 'meanfield', 'voronoi'];
  const modes: VoronoiMode[] = ['uniform', 'jittered', 'relaxed', 'settlements'];
  result.seed = typeof value.seed === 'number' && Number.isFinite(value.seed) ? value.seed >>> 0 : fallback.seed;
  result.size = bounded(value.size, fallback.size, MIN_GRID_SIZE, MAX_GRID_SIZE, true);
  if (geometries.includes(value.geometry as GeometryType)) result.geometry = value.geometry as GeometryType;
  if (object(value.voronoiConfig)) {
    const base = fallback.voronoiConfig ?? { mode: 'jittered' as const, irregularity: 0.5 };
    result.voronoiConfig = {
      mode: modes.includes(value.voronoiConfig.mode as VoronoiMode) ? value.voronoiConfig.mode as VoronoiMode : base.mode,
      irregularity: fraction(value.voronoiConfig.irregularity, base.irregularity),
    };
  }
  result.seedInfections = fraction(value.seedInfections, fallback.seedInfections);
  result.birthRate = fraction(value.birthRate, fallback.birthRate);
  result.mutate = flag(value.mutate, fallback.mutate);
  if (typeof value.reseedOnExtinction === 'boolean') result.reseedOnExtinction = value.reseedOnExtinction;
  if (typeof value.susceptibilityCV === 'number' && Number.isFinite(value.susceptibilityCV)) {
    result.susceptibilityCV = clampSusceptibilityCV(value.susceptibilityCV);
  }
  const strain = value.strain;
  const baseStrain = fallback.strain;
  result.strain = {
    attackRate: fraction(strain.attackRate, baseStrain.attackRate),
    incubation: bounded(strain.incubation, baseStrain.incubation, MIN_STAGE_DAYS, MAX_STAGE_DAYS, true),
    infectious: bounded(strain.infectious, baseStrain.infectious, MIN_STAGE_DAYS, MAX_STAGE_DAYS, true),
    ifr: fraction(strain.ifr, baseStrain.ifr),
    range: bounded(strain.range, baseStrain.range, 1, 8, true),
    immunityDays: bounded(strain.immunityDays, baseStrain.immunityDays, 1, 36500, true),
    mutationRate: fraction(strain.mutationRate, baseStrain.mutationRate),
  };
  if (typeof strain.mixing === 'number' && Number.isFinite(strain.mixing)) {
    result.strain.mixing = fraction(strain.mixing, baseStrain.mixing ?? 0);
  }
  const defenses = value.defenses;
  result.defenses = fallback.defenses.map((base) => {
    const defense = defenses.find((candidate) => object(candidate) && candidate.id === base.id);
    if (!object(defense)) return { ...base };
    return {
      id: base.id,
      label: typeof defense.label === 'string' ? defense.label : base.label,
      enabled: flag(defense.enabled, base.enabled),
      protection: fraction(defense.protection, base.protection),
      sourceControl: fraction(defense.sourceControl, base.sourceControl),
      mortalityReduction: fraction(defense.mortalityReduction, base.mortalityReduction),
      uptake: fraction(defense.uptake, base.uptake),
    };
  });
  const lockdown = value.lockdown;
  result.lockdown = {
    enabled: flag(lockdown.enabled, fallback.lockdown.enabled),
    mobilityReduction: fraction(lockdown.mobilityReduction, fallback.lockdown.mobilityReduction),
    transmissionReduction: fraction(lockdown.transmissionReduction, fallback.lockdown.transmissionReduction),
    compliance: fraction(lockdown.compliance, fallback.lockdown.compliance),
  };
  const quarantine = value.quarantine;
  result.quarantine = {
    enabled: flag(quarantine.enabled, fallback.quarantine.enabled),
    detectionRate: fraction(quarantine.detectionRate, fallback.quarantine.detectionRate),
    contactsRange: bounded(quarantine.contactsRange, fallback.quarantine.contactsRange, 1, 5, true),
    protection: fraction(quarantine.protection, fallback.quarantine.protection),
    sourceControl: fraction(quarantine.sourceControl, fallback.quarantine.sourceControl),
    duration: bounded(quarantine.duration, fallback.quarantine.duration, 1, 365, true),
  };
  return result;
}
