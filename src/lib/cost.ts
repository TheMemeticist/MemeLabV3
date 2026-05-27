// Germ-agnostic economic cost model — a PURE derived layer.
//
// Cost is computed on the UI thread from the raw per-tick counts the engine
// records into LongStats (infectious, new deaths, masked/vaccinated/quarantined
// cells, lockdown stringency). It never enters the engine, the worker, or the
// PRNG, so it has no effect on the simulation or its determinism. Because cost
// is a pure function of counts × profile, editing any unit cost — or switching
// currency — re-prices the entire run instantly, with no re-simulation.

import type {
  CostConfig,
  CostLedger,
  CurrencySpec,
  LongStats,
  PathogenCostProfile,
  RegionPreset,
  RetiredCostTotals,
} from '../types';

// ─── Region & currency reference data ─────────────────────────────────────────

export const REGION_PRESETS: RegionPreset[] = [
  { id: 'low', label: 'Low income (DRC, Sierra Leone)', gdpPerCapitaAnnual: 1_200, vsl: 700_000 },
  { id: 'lower-mid', label: 'Lower-middle (Nigeria, India)', gdpPerCapitaAnnual: 5_000, vsl: 2_000_000 },
  { id: 'upper-mid', label: 'Upper-middle (Brazil, China)', gdpPerCapitaAnnual: 15_000, vsl: 5_000_000 },
  { id: 'high', label: 'High income (US, EU, Japan)', gdpPerCapitaAnnual: 55_000, vsl: 10_000_000 },
];

export const DEFAULT_REGION_ID = 'high';

export function findRegion(id: string): RegionPreset {
  return REGION_PRESETS.find((r) => r.id === id) ?? REGION_PRESETS[REGION_PRESETS.length - 1];
}

/** Region id whose GDP+VSL match a profile, or 'custom' if none does. */
export function matchRegionId(p: PathogenCostProfile): string {
  const r = REGION_PRESETS.find(
    (x) => x.gdpPerCapitaAnnual === p.gdpPerCapitaAnnual && x.vsl === p.vsl,
  );
  return r ? r.id : 'custom';
}

/** Cost config seeded from a disease preset's bundled profile. */
export function costConfigFromProfile(profile: PathogenCostProfile): CostConfig {
  return {
    profile: { ...profile },
    regionId: matchRegionId(profile),
    currencyCode: DEFAULT_CURRENCY_CODE,
    currencyRate: findCurrency(DEFAULT_CURRENCY_CODE).rateVsUsd,
  };
}

// Approximate exchange rates vs USD. Editable in the cost menu — these are only
// defaults so figures land in a familiar order of magnitude.
export const CURRENCIES: CurrencySpec[] = [
  { code: 'USD', symbol: '$', rateVsUsd: 1 },
  { code: 'EUR', symbol: '€', rateVsUsd: 0.92 },
  { code: 'GBP', symbol: '£', rateVsUsd: 0.79 },
  { code: 'JPY', symbol: '¥', rateVsUsd: 157 },
  { code: 'CNY', symbol: '¥', rateVsUsd: 7.2 },
  { code: 'INR', symbol: '₹', rateVsUsd: 83 },
  { code: 'BRL', symbol: 'R$', rateVsUsd: 5.1 },
];

export const DEFAULT_CURRENCY_CODE = 'USD';

export function findCurrency(code: string): CurrencySpec {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

// ─── Default cost profile ─────────────────────────────────────────────────────
// Calibrated to a high-income, COVID-severity baseline. Disease presets override
// this with archetype-specific severity + unit costs (see presets.ts).

export const DEFAULT_COST_PROFILE: PathogenCostProfile = {
  hospitalizationRate: 0.05,
  icuRate: 0.15,
  symptomaticFraction: 0.70,
  workCapacityLoss: 0.65,

  gdpPerCapitaAnnual: 55_000,
  laborParticipationRate: 0.65,

  medCostMild: 180,
  medCostHospWard: 1_500,
  medCostICU: 6_500,

  vsl: 10_000_000,

  maskCostPerDayPerPerson: 0.10,
  vaccineDosePrice: 20,
  vaccineDosesRequired: 2,
  vaccineDeliveryExtra: 15,
  quarantineDailyCommunity: 50,
  quarantineDailyHospital: 600,
  quarantineIsHospital: false,
  lockdownGdpFractionPerUnit: 0.30,
  immunityDays: 180,

  hospitalBedsPerCapita: 0.003,
  surgeCostMultiplier: 2.0,
  surgeMortalityCostPerOverflowCase: 50_000,
};

export function defaultCostConfig(): CostConfig {
  return {
    profile: { ...DEFAULT_COST_PROFILE },
    regionId: DEFAULT_REGION_ID,
    currencyCode: DEFAULT_CURRENCY_CODE,
    currencyRate: findCurrency(DEFAULT_CURRENCY_CODE).rateVsUsd,
  };
}

// ─── Per-day cost for a single tick ───────────────────────────────────────────

export interface DailyCost {
  medical: number;
  deaths: number;
  quarantine: number;
  mask: number;
  vaccine: number;
  lockdown: number;
  surge: number;
  total: number;
}

/** Cost (USD) incurred on one day given that day's counts. Pure + branchless. */
export function dailyCost(
  p: PathogenCostProfile,
  n: number,
  counts: {
    infectious: number;
    newDeaths: number;
    masked: number;
    vaccinated: number;
    quarantined: number;
    lockdownStringency: number;
  },
): DailyCost {
  const gdpDaily = p.gdpPerCapitaAnnual / 365;
  const prodDay = gdpDaily * p.laborParticipationRate;

  // Medical + productivity, split across care arms (per infectious cell/day).
  const outpatient =
    (1 - p.hospitalizationRate) *
    p.symptomaticFraction *
    (p.medCostMild + prodDay * p.workCapacityLoss * p.workCapacityLoss);
  const ward =
    p.hospitalizationRate * (1 - p.icuRate) * (p.medCostHospWard + prodDay);
  const icu = p.hospitalizationRate * p.icuRate * (p.medCostICU + prodDay);
  const medical = counts.infectious * (outpatient + ward + icu);

  // Healthcare-capacity surge — a cost-side overlay. When hospitalized demand
  // exceeds bed capacity, overflow cases cost extra (surge multiplier on ICU
  // care) and carry a modeled excess-mortality charge. This does NOT change the
  // simulated death count; it only prices the strain on the system.
  const hospDemand = p.hospitalizationRate * counts.infectious;
  const capacity = p.hospitalBedsPerCapita * n;
  const overflow = Math.max(0, hospDemand - capacity);
  const surge =
    overflow *
    (p.medCostICU * Math.max(0, p.surgeCostMultiplier - 1) +
      p.surgeMortalityCostPerOverflowCase);

  const deaths = counts.newDeaths * p.vsl;
  const quarantine =
    counts.quarantined *
    (p.quarantineIsHospital ? p.quarantineDailyHospital : p.quarantineDailyCommunity);
  const mask = counts.masked * p.maskCostPerDayPerPerson;
  const vaccineAmortized =
    p.immunityDays > 0
      ? (p.vaccineDosePrice * p.vaccineDosesRequired + p.vaccineDeliveryExtra) / p.immunityDays
      : 0;
  const vaccine = counts.vaccinated * vaccineAmortized;
  const lockdown =
    gdpDaily * n * p.lockdownGdpFractionPerUnit * counts.lockdownStringency;

  const total = medical + deaths + quarantine + mask + vaccine + lockdown + surge;
  return { medical, deaths, quarantine, mask, vaccine, lockdown, surge, total };
}

// ─── Whole-run ledger + chart series ──────────────────────────────────────────

export interface CostSeries {
  tick: number[];
  medical: number[];
  deaths: number[];
  quarantine: number[];
  mask: number[];
  vaccine: number[];
  lockdown: number[];
  surge: number[];
  total: number[];
}

const ZERO_LEDGER: CostLedger = {
  dailyMedical: 0, dailyDeaths: 0, dailyQuarantine: 0, dailyMask: 0,
  dailyVaccine: 0, dailyLockdown: 0, dailySurge: 0, dailyTotal: 0,
  totalMedical: 0, totalDeaths: 0, totalQuarantine: 0, totalMask: 0,
  totalVaccine: 0, totalLockdown: 0, totalSurge: 0, grandTotal: 0,
};

/**
 * Cost contributed by ticks that have aged out of the LongStats window. Linear
 * categories (medical, deaths, quarantine, mask, vaccine, lockdown) are exact —
 * they're linear in counts, so the per-tick sum equals pricing the summed counts.
 * Surge is nonlinear in I, so it's approximated from the average over retired
 * ticks. All of it reprices on a profile/currency change (it's a pure function
 * of the retired count-sums × the current profile).
 */
function retiredContribution(r: RetiredCostTotals | undefined, p: PathogenCostProfile, n: number): DailyCost {
  if (!r || r.ticks <= 0) {
    return { medical: 0, deaths: 0, quarantine: 0, mask: 0, vaccine: 0, lockdown: 0, surge: 0, total: 0 };
  }
  // Pricing the summed counts gives the exact total for the linear categories.
  const lin = dailyCost(p, n, {
    infectious: r.i, newDeaths: r.dnew, masked: r.masked,
    vaccinated: r.vaccinated, quarantined: r.quarantined, lockdownStringency: r.lockdownStringency,
  });
  // Surge is convex in I, so price it at the average I over retired ticks × count.
  const avgSurge = dailyCost(p, n, {
    infectious: r.i / r.ticks, newDeaths: 0, masked: 0, vaccinated: 0, quarantined: 0, lockdownStringency: 0,
  }).surge * r.ticks;
  const total = lin.medical + lin.deaths + lin.quarantine + lin.mask + lin.vaccine + lin.lockdown + avgSurge;
  return {
    medical: lin.medical, deaths: lin.deaths, quarantine: lin.quarantine,
    mask: lin.mask, vaccine: lin.vaccine, lockdown: lin.lockdown, surge: avgSurge, total,
  };
}

/**
 * Price an entire run. Returns the current ledger (latest day's flows + running
 * cumulative totals, all USD) and per-category cumulative time series for the
 * chart. O(T) — trivial to recompute every frame or on every cost-param edit.
 * `retired` (optional) folds in cost from ticks that aged out of the window so
 * the cumulative total stays correct and monotonic on runs past LONG_CAP days.
 */
export function computeLedger(
  long: LongStats,
  p: PathogenCostProfile,
  n: number,
  retired?: RetiredCostTotals,
): { ledger: CostLedger; series: CostSeries } {
  const T = long.tick.length;
  const series: CostSeries = {
    tick: [], medical: [], deaths: [], quarantine: [],
    mask: [], vaccine: [], lockdown: [], surge: [], total: [],
  };
  const ret = retiredContribution(retired, p, n);
  if (T === 0) {
    if (ret.total === 0) return { ledger: { ...ZERO_LEDGER }, series };
    // Window empty but cost was retired (rare): report the retired totals.
    return {
      ledger: {
        ...ZERO_LEDGER,
        totalMedical: ret.medical, totalDeaths: ret.deaths, totalQuarantine: ret.quarantine,
        totalMask: ret.mask, totalVaccine: ret.vaccine, totalLockdown: ret.lockdown,
        totalSurge: ret.surge, grandTotal: ret.total,
      },
      series,
    };
  }

  // Seed cumulative accumulators with the retired baseline so the chart lines and
  // the grand total both reflect the full run, not just the visible window.
  let cMed = ret.medical, cDeath = ret.deaths, cQuar = ret.quarantine,
    cMask = ret.mask, cVax = ret.vaccine, cLock = ret.lockdown, cSurge = ret.surge;
  let last: DailyCost = { medical: 0, deaths: 0, quarantine: 0, mask: 0, vaccine: 0, lockdown: 0, surge: 0, total: 0 };

  for (let t = 0; t < T; t++) {
    last = dailyCost(p, n, {
      infectious: long.i[t],
      newDeaths: long.dnew[t],
      masked: long.masked[t],
      vaccinated: long.vaccinated[t],
      quarantined: long.quarantined[t],
      lockdownStringency: long.lockdownStringency[t],
    });
    cMed += last.medical;
    cDeath += last.deaths;
    cQuar += last.quarantine;
    cMask += last.mask;
    cVax += last.vaccine;
    cLock += last.lockdown;
    cSurge += last.surge;
    series.tick.push(long.tick[t]);
    series.medical.push(cMed);
    series.deaths.push(cDeath);
    series.quarantine.push(cQuar);
    series.mask.push(cMask);
    series.vaccine.push(cVax);
    series.lockdown.push(cLock);
    series.surge.push(cSurge);
    series.total.push(cMed + cDeath + cQuar + cMask + cLock + cVax + cSurge);
  }

  const grandTotal = cMed + cDeath + cQuar + cMask + cVax + cLock + cSurge;
  const ledger: CostLedger = {
    dailyMedical: last.medical,
    dailyDeaths: last.deaths,
    dailyQuarantine: last.quarantine,
    dailyMask: last.mask,
    dailyVaccine: last.vaccine,
    dailyLockdown: last.lockdown,
    dailySurge: last.surge,
    dailyTotal: last.total,
    totalMedical: cMed,
    totalDeaths: cDeath,
    totalQuarantine: cQuar,
    totalMask: cMask,
    totalVaccine: cVax,
    totalLockdown: cLock,
    totalSurge: cSurge,
    grandTotal,
  };
  return { ledger, series };
}

// ─── Display helpers ──────────────────────────────────────────────────────────

/** Format a USD value in the chosen currency, auto-scaled to k/M/B/T. */
export function formatMoney(usdValue: number, currency: CurrencySpec, rate?: number): string {
  const v = usdValue * (rate ?? currency.rateVsUsd);
  const sym = currency.symbol;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${sign}${sym}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${sym}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${sym}${abs.toFixed(0)}`;
}
