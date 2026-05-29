import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim';
import { findPreset, PRESETS } from '../src/sim/presets';
import {
  DEFAULT_COST_PROFILE,
  computeLedger,
  dailyCost,
  formatMoney,
  findCurrency,
} from '../src/lib/cost';
import type { LongStats, PathogenCostProfile, RetiredCostTotals, SimConfig } from '../src/types';

// Build a LongStats with only the fields the cost layer reads populated.
function longFrom(parts: Partial<Record<keyof LongStats, number[]>>): LongStats {
  const len = Math.max(0, ...Object.values(parts).map((a) => a?.length ?? 0));
  const zeros = () => new Array(len).fill(0);
  const tick = parts.tick ?? Array.from({ length: len }, (_, k) => k);
  return {
    tick,
    s: parts.s ?? zeros(),
    e: parts.e ?? zeros(),
    i: parts.i ?? zeros(),
    r: parts.r ?? zeros(),
    d: parts.d ?? zeros(),
    reff: parts.reff ?? zeros(),
    dnew: parts.dnew ?? zeros(),
    masked: parts.masked ?? zeros(),
    vaccinated: parts.vaccinated ?? zeros(),
    quarantined: parts.quarantined ?? zeros(),
    lockdownStringency: parts.lockdownStringency ?? zeros(),
    ecum: parts.ecum ?? zeros(),
    icum: parts.icum ?? zeros(),
    rcum: parts.rcum ?? zeros(),
    dcum: parts.dcum ?? zeros(),
  };
}

function profile(overrides: Partial<PathogenCostProfile>): PathogenCostProfile {
  return { ...DEFAULT_COST_PROFILE, ...overrides };
}

describe('cost model — formula wiring', () => {
  it('sums medical + death cost exactly', () => {
    // No productivity (gdp 0), all-outpatient (hosp 0), so medical/I/day = medMild.
    const p = profile({
      gdpPerCapitaAnnual: 0, hospitalizationRate: 0, symptomaticFraction: 1,
      medCostMild: 100, vsl: 1_000_000,
    });
    const long = longFrom({ i: [10, 20], dnew: [0, 1] });
    const { ledger } = computeLedger(long, p, 1000);
    expect(ledger.totalMedical).toBe(3000); // 10*100 + 20*100
    expect(ledger.totalDeaths).toBe(1_000_000); // 1 death * VSL
    expect(ledger.grandTotal).toBe(1_003_000);
    expect(ledger.totalSurge).toBe(0);
  });

  it('death cost is exactly Σdeaths × VSL', () => {
    const p = profile({ vsl: 7_000_000 });
    const long = longFrom({ i: [5, 5, 5], dnew: [2, 0, 3] });
    const { ledger } = computeLedger(long, p, 10_000);
    expect(ledger.totalDeaths).toBe(5 * 7_000_000);
  });

  it('amortizes vaccine dose cost over the immunity window', () => {
    const p = profile({
      gdpPerCapitaAnnual: 0, hospitalizationRate: 0, symptomaticFraction: 0,
      vaccineDosePrice: 20, vaccineDosesRequired: 2, vaccineDeliveryExtra: 15, immunityDays: 100,
    });
    // perDay per vaccinated = (20*2 + 15)/100 = 0.55
    const long = longFrom({ vaccinated: [10, 10] });
    const { ledger } = computeLedger(long, p, 1000);
    expect(ledger.totalVaccine).toBeCloseTo(2 * 10 * 0.55, 6);
  });

  it('returns a zeroed ledger for an empty run', () => {
    const { ledger, series } = computeLedger(longFrom({}), DEFAULT_COST_PROFILE, 100);
    expect(ledger.grandTotal).toBe(0);
    expect(series.tick.length).toBe(0);
  });

  it('total series is the running cumulative of all categories', () => {
    const p = profile({ gdpPerCapitaAnnual: 0, hospitalizationRate: 0, symptomaticFraction: 1, medCostMild: 10 });
    const long = longFrom({ i: [1, 2, 3] });
    const { series, ledger } = computeLedger(long, p, 100);
    expect(series.total).toEqual([10, 30, 60]);
    expect(ledger.grandTotal).toBe(60);
  });
});

describe('cost model — retired (windowed) cost', () => {
  function retired(parts: Partial<RetiredCostTotals>): RetiredCostTotals {
    return { ticks: 0, i: 0, dnew: 0, masked: 0, vaccinated: 0, quarantined: 0, lockdownStringency: 0, ...parts };
  }

  it('adds retired cost to the cumulative total (keeps it monotonic past the cap)', () => {
    const p = profile({ gdpPerCapitaAnnual: 0, hospitalizationRate: 0, symptomaticFraction: 1, medCostMild: 100, vsl: 1_000_000 });
    const long = longFrom({ i: [10], dnew: [0] });
    const windowOnly = computeLedger(long, p, 1000).ledger.grandTotal; // 10*100 = 1000
    // 5 retired deaths + 200 retired infectious-days should add 5e6 + 200*100.
    const withRetired = computeLedger(long, p, 1000, retired({ ticks: 50, i: 200, dnew: 5 })).ledger;
    expect(windowOnly).toBe(1000);
    expect(withRetired.totalDeaths).toBe(5 * 1_000_000);
    expect(withRetired.totalMedical).toBe((200 + 10) * 100); // retired + window, exact (linear)
    expect(withRetired.grandTotal).toBe(5_000_000 + 21_000);
    expect(withRetired.grandTotal).toBeGreaterThan(windowOnly);
  });

  it('reprices retired cost when the profile changes (retroactive)', () => {
    const r = retired({ ticks: 10, dnew: 4 });
    const a = computeLedger(longFrom({ i: [0] }), profile({ vsl: 1_000_000 }), 100, r).ledger.grandTotal;
    const b = computeLedger(longFrom({ i: [0] }), profile({ vsl: 5_000_000 }), 100, r).ledger.grandTotal;
    expect(a).toBe(4_000_000);
    expect(b).toBe(20_000_000); // same retired counts, new VSL → fully repriced
  });
});

describe('cost model — germ-agnostic severity', () => {
  it('prices a severe pathogen far above a mild one per infectious day', () => {
    // The whole point: same unit costs, severity (hosp/ICU split) drives cost.
    const bdbv = findPreset('bdbv').cost;
    const measles = findPreset('measles').cost;
    const severe = dailyCost(bdbv, 1_000_000, baseCounts(100)).medical;
    const mild = dailyCost(measles, 1_000_000, baseCounts(100)).medical;
    expect(severe).toBeGreaterThan(mild * 10);
  });

  it('every preset carries a usable cost profile', () => {
    for (const preset of PRESETS) {
      expect(preset.cost.hospitalizationRate).toBeGreaterThanOrEqual(0);
      expect(preset.cost.hospitalizationRate).toBeLessThanOrEqual(1);
      expect(preset.cost.vsl).toBeGreaterThan(0);
      expect(preset.cost.immunityDays).toBe(preset.genes.immunityDays);
    }
  });
});

describe('cost model — healthcare capacity surge', () => {
  it('charges more when hospital demand exceeds capacity', () => {
    // hosp demand = 0.5 * 1000 = 500 cases. Capacity below vs above that.
    const p = profile({ hospitalizationRate: 0.5, surgeCostMultiplier: 3, surgeMortalityCostPerOverflowCase: 10_000 });
    const long = longFrom({ i: [1000] });
    const n = 100_000;
    const overCapacity = computeLedger(longFrom({ i: [1000] }), { ...p, hospitalBedsPerCapita: 0.001 }, n); // 100 beds < 500
    const underCapacity = computeLedger(long, { ...p, hospitalBedsPerCapita: 0.02 }, n); // 2000 beds > 500
    expect(underCapacity.ledger.totalSurge).toBe(0);
    expect(overCapacity.ledger.totalSurge).toBeGreaterThan(0);
    expect(overCapacity.ledger.grandTotal).toBeGreaterThan(underCapacity.ledger.grandTotal);
  });
});

describe('cost model — calibration (order-of-magnitude vs known outbreaks)', () => {
  // These assert the DIRECT modeled burden (medical + productivity + deaths +
  // surge) lands in the right order of magnitude. The model does not capture
  // broad macroeconomic spillover (trade, fear, closures) that inflates some
  // headline figures, so bands are deliberately wide.

  it('2014 West Africa Ebola: ~$10B direct (literature $53B incl. spillover)', () => {
    // ~28,600 cases × ~9 infectious days ≈ 257k infectious-cell-days; 11,300 deaths.
    const days = 365;
    const long = longFrom({
      i: new Array(days).fill(Math.round(257_400 / days)),
      dnew: new Array(days).fill(11_300 / days),
    });
    const p = findPreset('bdbv').cost; // low-income, hemorrhagic
    const { ledger } = computeLedger(long, p, 5_000_000);
    expect(ledger.grandTotal).toBeGreaterThan(3e9);
    expect(ledger.grandTotal).toBeLessThan(60e9);
  });

  it('COVID-19 US first wave: ~$1–3T, dominated by ~100k deaths', () => {
    const days = 120;
    const long = longFrom({
      // ~2M concurrent-ish infectious cell-days spread over the wave.
      i: new Array(days).fill(Math.round(30_000_000 / days)),
      dnew: new Array(days).fill(100_000 / days),
    });
    const p = findPreset('sars2-wild').cost; // high-income, COVID severity
    const { ledger } = computeLedger(long, p, 330_000_000);
    expect(ledger.grandTotal).toBeGreaterThan(0.8e12);
    expect(ledger.grandTotal).toBeLessThan(5e12);
  });
});

describe('cost model — display', () => {
  it('auto-scales and converts currency', () => {
    expect(formatMoney(1_500_000_000, findCurrency('USD'))).toBe('$1.50B');
    expect(formatMoney(2_400_000, findCurrency('USD'))).toBe('$2.40M');
    // EUR at 0.92 → 920 → €920
    expect(formatMoney(1000, findCurrency('EUR'))).toBe('€920');
  });
});

describe('engine — cost counts are deterministic', () => {
  function cfg(): SimConfig {
    return {
      seed: 0x1234abcd,
      size: 32,
      seedInfections: 0.1,
      birthRate: 0,
      mutate: false,
      strain: { attackRate: 0.4, incubation: 2, infectious: 4, ifr: 0.1, range: 1, immunityDays: 36500, mutationRate: 0 },
      defenses: [
        { id: 'mask', label: 'Mask', enabled: true, protection: 0.2, sourceControl: 0.5, mortalityReduction: 0, uptake: 0.5 },
        { id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0.8, sourceControl: 0, mortalityReduction: 0.5, uptake: 0.3 },
      ],
      lockdown: { enabled: true, mobilityReduction: 0.5, transmissionReduction: 0.3, compliance: 0.7 },
      quarantine: { enabled: true, detectionRate: 0.5, contactsRange: 1, protection: 0.4, sourceControl: 0.4, duration: 14 },
    };
  }

  it('produces identical count series from a fixed seed', () => {
    const a = new Engine(cfg());
    const b = new Engine(cfg());
    for (let t = 0; t < 80; t++) { a.step(); b.step(); }
    for (const key of ['dnew', 'masked', 'vaccinated', 'quarantined', 'lockdownStringency'] as const) {
      expect(b.longStats[key]).toEqual(a.longStats[key]);
    }
  });

  it('records lockdown stringency = mobilityReduction × compliance while enabled', () => {
    const e = new Engine(cfg());
    e.step();
    // 0.5 × 0.7 = 0.35
    expect(e.longStats.lockdownStringency[0]).toBeCloseTo(0.35, 6);
  });

  it('folds ticks aged out of the window into the retired aggregate', () => {
    const LONG_CAP = 4096;
    const e = new Engine(cfg());
    const steps = LONG_CAP + 200;
    for (let t = 0; t < steps; t++) e.step();
    expect(e.longStats.tick.length).toBe(LONG_CAP); // window stays capped
    expect(e.retiredCost.ticks).toBe(steps - LONG_CAP); // the overflow is retired
    expect(e.retiredCost.i).toBeGreaterThanOrEqual(0);
    // Determinism: a second engine retires identically.
    const e2 = new Engine(cfg());
    for (let t = 0; t < steps; t++) e2.step();
    expect(e2.retiredCost).toEqual(e.retiredCost);
  });
});

function baseCounts(infectious: number) {
  return { infectious, newDeaths: 0, masked: 0, vaccinated: 0, quarantined: 0, lockdownStringency: 0 };
}
