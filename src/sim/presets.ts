import type { PathogenCostProfile, StrainGenes } from '../types';
import { DEFAULT_COST_PROFILE } from '../lib/cost';

export interface DiseasePreset {
  id: string;
  label: string;
  blurb: string;
  genes: StrainGenes;
  /** Economic cost profile bundled with the disease. Severity + unit costs are
   *  disease-specific; the embedded gdp/vsl reflect where the pathogen typically
   *  circulates (overridable via the region selector in the cost menu). */
  cost: PathogenCostProfile;
}

// Build a cost profile from severity/unit-cost overrides on the default. The
// vaccine-amortization window (immunityDays) mirrors the strain's own immunity.
function mkCost(immunityDays: number, overrides: Partial<PathogenCostProfile>): PathogenCostProfile {
  return { ...DEFAULT_COST_PROFILE, immunityDays, ...overrides };
}

// Mean post-infection immunity is expressed as `immunityDays` — the original
// CDA insight is that many pathogens are SEIS-like, not SEIR. With a finite
// immunity window plus a large enough population, infections persist endemically.
export const PRESETS: DiseasePreset[] = [
  {
    id: 'bdbv',
    label: 'Bundibugyo ebolavirus (BDBV)',
    blurb: 'Sudan lineage Ebola variant. High IFR, direct-contact transmission. First identified Uganda 2007.',
    genes: { attackRate: 0.07, incubation: 6, infectious: 9, ifr: 0.34, range: 1, immunityDays: 3650, mutationRate: 0.008 },
    cost: mkCost(3650, {
      hospitalizationRate: 0.95, icuRate: 0.45, symptomaticFraction: 0.99, workCapacityLoss: 1.0,
      gdpPerCapitaAnnual: 1_200, vsl: 700_000,
      medCostMild: 150, medCostHospWard: 2_000, medCostICU: 8_000,
      quarantineIsHospital: true, hospitalBedsPerCapita: 0.0008,
    }),
  },
  {
    id: 'hanta-andes',
    label: 'Andes Hantavirus',
    blurb: 'Rare person-to-person transmission via prolonged close contact. Long incubation (9–40 days). High fatality.',
    // immunityDays = 1/0.10 annual ≈ 3650 days at 10% wane; the user spec said
    // 10% wane so we use that as the implied annual rate floor (~10 years).
    genes: { attackRate: 0.22, incubation: 18, infectious: 3, ifr: 0.32, range: 1, immunityDays: 3650, mutationRate: 0.005 },
    cost: mkCost(3650, {
      hospitalizationRate: 0.80, icuRate: 0.40, symptomaticFraction: 0.95, workCapacityLoss: 1.0,
      gdpPerCapitaAnnual: 15_000, vsl: 5_000_000,
      medCostMild: 150, medCostHospWard: 2_000, medCostICU: 8_000,
      quarantineIsHospital: true, hospitalBedsPerCapita: 0.002,
    }),
  },
  {
    id: 'sars2-wild',
    label: 'SARS-2: Wild-Type',
    blurb: 'The original lineage. Reinfection within months.',
    genes: { attackRate: 0.12, incubation: 6, infectious: 4, ifr: 0.01, range: 1, immunityDays: 180, mutationRate: 0.01 },
    cost: mkCost(180, {
      hospitalizationRate: 0.05, icuRate: 0.15, symptomaticFraction: 0.70, workCapacityLoss: 0.65,
      medCostMild: 180, medCostHospWard: 1_500, medCostICU: 6_500,
    }),
  },
  {
    id: 'sars2-delta',
    label: 'SARS-2: Delta',
    blurb: 'Higher transmission, longer range. ~6-month immunity.',
    genes: { attackRate: 0.10, incubation: 2, infectious: 4, ifr: 0.03, range: 2, immunityDays: 180, mutationRate: 0.01 },
    cost: mkCost(180, {
      hospitalizationRate: 0.06, icuRate: 0.18, symptomaticFraction: 0.72, workCapacityLoss: 0.68,
      medCostMild: 180, medCostHospWard: 1_500, medCostICU: 6_500,
    }),
  },
  {
    id: 'sars2-delta-plus',
    label: 'SARS-2: Delta+',
    blurb: 'Higher attack rate. Reinfection within 3 months.',
    genes: { attackRate: 0.17, incubation: 2, infectious: 4, ifr: 0.03, range: 2, immunityDays: 90, mutationRate: 0.01 },
    cost: mkCost(90, {
      hospitalizationRate: 0.06, icuRate: 0.18, symptomaticFraction: 0.72, workCapacityLoss: 0.68,
      medCostMild: 180, medCostHospWard: 1_500, medCostICU: 6_500,
    }),
  },
  {
    id: 'sars1',
    label: 'SARS-1',
    blurb: '2003 outbreak. Higher IFR, ~2-year immunity.',
    genes: { attackRate: 0.18, incubation: 7, infectious: 4, ifr: 0.11, range: 1, immunityDays: 700, mutationRate: 0.005 },
    cost: mkCost(700, {
      hospitalizationRate: 0.25, icuRate: 0.22, symptomaticFraction: 0.95, workCapacityLoss: 0.85,
      medCostMild: 200, medCostHospWard: 1_800, medCostICU: 7_500,
    }),
  },
  {
    id: 'measles',
    label: 'Measles',
    blurb: 'Airborne, extreme range. Lifelong immunity.',
    genes: { attackRate: 0.13, incubation: 14, infectious: 5, ifr: 0.001, range: 4, immunityDays: 36500, mutationRate: 0.002 },
    cost: mkCost(36500, {
      hospitalizationRate: 0.025, icuRate: 0.05, symptomaticFraction: 0.90, workCapacityLoss: 0.55,
      medCostMild: 90, medCostHospWard: 900, medCostICU: 4_000,
    }),
  },
  {
    id: 'tb',
    label: 'Tuberculosis',
    blurb: 'Slow burn. Latent reactivation. ~10-year immunity.',
    genes: { attackRate: 0.47, incubation: 60, infectious: 14, ifr: 0.08, range: 2, immunityDays: 3650, mutationRate: 0.003 },
    cost: mkCost(3650, {
      hospitalizationRate: 0.10, icuRate: 0.05, symptomaticFraction: 0.80, workCapacityLoss: 0.50,
      gdpPerCapitaAnnual: 15_000, vsl: 5_000_000,
      medCostMild: 60, medCostHospWard: 800, medCostICU: 3_500,
    }),
  },
  {
    id: 'syphilis',
    label: 'Syphilis',
    blurb: 'Contact-bound. Reinfection possible after treatment.',
    genes: { attackRate: 0.16, incubation: 20, infectious: 13, ifr: 0.08, range: 1, immunityDays: 365, mutationRate: 0.002 },
    cost: mkCost(365, {
      hospitalizationRate: 0.02, icuRate: 0.01, symptomaticFraction: 0.60, workCapacityLoss: 0.20,
      medCostMild: 40, medCostHospWard: 600, medCostICU: 3_000,
    }),
  },
  {
    id: 'nipah',
    label: 'Nipah',
    blurb: 'Rare zoonotic. High IFR, ~5-year immunity.',
    genes: { attackRate: 0.02, incubation: 11, infectious: 6, ifr: 0.75, range: 1, immunityDays: 1825, mutationRate: 0.005 },
    cost: mkCost(1825, {
      hospitalizationRate: 0.90, icuRate: 0.50, symptomaticFraction: 0.99, workCapacityLoss: 1.0,
      gdpPerCapitaAnnual: 5_000, vsl: 2_000_000,
      medCostMild: 200, medCostHospWard: 2_500, medCostICU: 9_000,
      quarantineIsHospital: true, hospitalBedsPerCapita: 0.0012,
    }),
  },
  {
    id: 'omega',
    label: 'Omega Virus',
    blurb: 'Hypothetical worst-case. Endless reinfection (~30 day immunity).',
    genes: { attackRate: 0.90, incubation: 14, infectious: 21, ifr: 0.80, range: 5, immunityDays: 30, mutationRate: 0.05 },
    cost: mkCost(30, {
      hospitalizationRate: 0.70, icuRate: 0.30, symptomaticFraction: 0.98, workCapacityLoss: 0.95,
      medCostMild: 200, medCostHospWard: 3_000, medCostICU: 10_000,
      quarantineIsHospital: true,
    }),
  },
];

export const DEFAULT_PRESET_ID = 'bdbv';

export function findPreset(id: string): DiseasePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;
}
