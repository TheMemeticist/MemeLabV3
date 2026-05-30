// SEIR-D state encoding (one byte per cell).
export const enum CellState {
  Susceptible = 0,
  Exposed = 1,
  Infectious = 2,
  Recovered = 3,
  Dead = 4,
}

// Defense bitmask flags, packed into Uint8Array per cell.
export const enum DefenseFlag {
  None = 0,
  Mask = 1 << 0,
  Vaccine = 1 << 1,
}

export interface StrainGenes {
  attackRate: number; // 0..1 per-contact
  incubation: number; // days
  infectious: number; // days
  ifr: number; // 0..1 base infection-fatality rate
  range: number; // Manhattan radius
  /** Mean duration of post-infection immunity, in days. Use a very large value
   *  (e.g. 36500) for "lifelong" immunity. Daily wane probability = 1/immunityDays. */
  immunityDays: number;
  mutationRate: number; // 0..1 per-replication per-gene
}

export interface Strain extends StrainGenes {
  id: number;
  parentId: number | null;
  birthTick: number;
}

export interface DefenseSpec {
  id: string;
  label: string;
  /** Header quick-toggle. When false, this defense's per-cell flag is preserved
   *  in the buffer but its multipliers behave as identity (no effect). */
  enabled: boolean;
  /** Reduces incoming attack success against the wearer. 0..1. */
  protection: number;
  /** Reduces outgoing attack success from the wearer. 0..1. */
  sourceControl: number;
  /** Reduces IFR if infected. 0..1. */
  mortalityReduction: number;
  /** Population uptake. 0..1. */
  uptake: number;
}

export interface LockdownSpec {
  enabled: boolean;
  /** Probabilistically skips neighbor visits for compliant cells. 0..1. */
  mobilityReduction: number;
  /** Global multiplicative reduction on transmission. 0..1. */
  transmissionReduction: number;
  /** Per-cell stochastic adherence. 0..1. */
  compliance: number;
}

export interface QuarantineSpec {
  enabled: boolean;
  /** Per-tick probability that an infectious cell is detected. 0..1. */
  detectionRate: number;
  /** Manhattan radius of "close contacts" isolated alongside a detected case. */
  contactsRange: number;
  /** Reduces transmission INTO quarantined cells. 0..1. */
  protection: number;
  /** Reduces transmission FROM quarantined cells. 0..1. */
  sourceControl: number;
  /** Quarantine persistence, in ticks. */
  duration: number;
}

export type GeometryType = 'square' | 'triangular' | 'hexagonal' | 'meanfield' | 'voronoi';
export type VoronoiMode = 'uniform' | 'jittered' | 'relaxed' | 'settlements';
export interface VoronoiConfig {
  mode: VoronoiMode;
  irregularity: number; // 0..1
}

export interface VoronoiTopology {
  n: number;
  cx: Float32Array; // centroid x [0..1], length n
  cy: Float32Array; // centroid y [0..1], length n
  adjOffsets: Int32Array; // CSR, length n+1
  adjList: Int32Array; // absolute cell indices
  // Polygon data — built only when withPolygons=true, null otherwise.
  polyOffsets: Int32Array | null; // length n+1
  polyVerts: Float32Array | null; // flat [x0,y0,x1,y1,...] normalized
}

export interface SimConfig {
  seed: number; // 32-bit unsigned PRNG seed
  size: number; // grid edge length; population = size * size
  geometry?: GeometryType; // lattice topology; defaults to 'square'
  voronoiConfig?: VoronoiConfig; // only used when geometry === 'voronoi'
  seedInfections: number; // 0..1 fraction starting as Exposed
  birthRate: number; // 0..1 per-tick respawn chance for dead cells with healthy neighbors
  mutate: boolean;
  /** When true, force-import one infectious cell whenever E+I=0 and immunity
   *  is finite — mirrors external migration in a SEIRS model. Defaults to
   *  false so that effective measures actually end an outbreak instead of
   *  triggering perpetual reseeds. */
  reseedOnExtinction?: boolean;
  strain: StrainGenes;
  defenses: DefenseSpec[];
  lockdown: LockdownSpec;
  quarantine: QuarantineSpec;
}

export type InterventionKey = 'mask' | 'vaccine' | 'lockdown' | 'quarantine';

export interface InterventionEvent {
  tick: number;
  intervention: InterventionKey;
  on: boolean;
  label?: string;
}

export interface SimStats {
  tick: number;
  s: number;
  e: number;
  i: number;
  r: number;
  d: number;
  newInfections: number;
  /** New I→D deaths this tick (not net of births). Drives the cost layer. */
  newDeaths: number;
  reff: number;
  strains: number;
}

export interface TopologyMessage {
  type: 'topology';
  topo: VoronoiTopology;
}

export interface FrameMessage {
  type: 'frame';
  tick: number;
  /** Transferable view onto the population state byte buffer. */
  state: Uint8Array;
  /** Defense bitmask byte buffer, transferable. */
  defenses: Uint8Array;
  /** Per-cell quarantined flag (0/1). Null when quarantine isn't active. */
  quarantined: Uint8Array | null;
  size: number;
  stats: SimStats;
  longStats: LongStats;
  /** Cost-count sums for ticks aged out of the LongStats window (cumulative). */
  retiredCost: RetiredCostTotals;
  rNaught: number | null;
}

export interface LongStats {
  tick: number[];
  s: number[];
  e: number[];
  i: number[];
  r: number[];
  d: number[];
  reff: number[];
  // Raw per-tick counts consumed by the (UI-thread) cost layer. Cost is a pure
  // function of these series × the cost profile, so editing unit costs or
  // currency re-prices the entire history without re-simulating.
  dnew: number[]; // new I→D deaths this tick
  masked: number[]; // living cells masking (only while mask intervention enabled)
  vaccinated: number[]; // living cells vaccinated (only while vaccine enabled)
  quarantined: number[]; // living cells currently isolated
  lockdownStringency: number[]; // mobilityReduction × compliance while enabled, else 0
  // Cumulative arrivals into each compartment up to that tick (monotonic,
  // absolute totals — survive the window shift correctly since they're not
  // running sums of the window). Power the chart's "Total" (vs "Active") view:
  // ecum = everyone who has ever been infected (cumulative incidence),
  // dcum = total deaths ever (≠ current Dead count, which births can lower).
  ecum: number[]; // cumulative new exposures (total infected)
  icum: number[]; // cumulative E→I transitions (total ever-infectious)
  rcum: number[]; // cumulative I→R recoveries (total ever-recovered)
  dcum: number[]; // cumulative deaths
}

// ─── Economic cost model ──────────────────────────────────────────────────────
// The cost layer is a pure derived overlay computed on the UI thread from the
// per-tick counts in LongStats. It never enters the engine, the worker, or the
// PRNG, so it has zero effect on the simulation or its determinism.

export interface PathogenCostProfile {
  // Severity — splits infectious cells across care arms.
  hospitalizationRate: number; // [0..1] fraction of I needing inpatient care
  icuRate: number; // [0..1] of hospitalized, fraction needing ICU
  symptomaticFraction: number; // [0..1] fraction of I with noticeable symptoms
  workCapacityLoss: number; // [0..1] 1 = fully bedridden

  // Economic context.
  gdpPerCapitaAnnual: number; // USD/year — drives productivity loss
  laborParticipationRate: number; // [0..1]

  // Medical unit costs (USD/day).
  medCostMild: number; // outpatient / home care per symptomatic day
  medCostHospWard: number; // general hospital bed-day
  medCostICU: number; // ICU bed-day

  // Mortality.
  vsl: number; // Value of a Statistical Life (one-time per death)

  // Intervention unit costs.
  maskCostPerDayPerPerson: number;
  vaccineDosePrice: number;
  vaccineDosesRequired: number;
  vaccineDeliveryExtra: number; // USD/dose delivery overhead
  quarantineDailyCommunity: number; // USD/person/day
  quarantineDailyHospital: number; // USD/person/day
  quarantineIsHospital: boolean;
  lockdownGdpFractionPerUnit: number; // fraction of daily GDP lost per unit stringency
  immunityDays: number; // amortization window for vaccine dose cost (from strain)

  // Healthcare capacity (cost-side surge overlay — does NOT alter simulated deaths).
  hospitalBedsPerCapita: number; // [0..1] beds as a fraction of population
  surgeCostMultiplier: number; // multiplier on care cost for overflow cases
  surgeMortalityCostPerOverflowCase: number; // modeled excess-mortality $ per overflow case-day
}

/** Cumulative + daily cost snapshot, all in USD (currency applied at display). */
export interface CostLedger {
  dailyMedical: number;
  dailyDeaths: number;
  dailyQuarantine: number;
  dailyMask: number;
  dailyVaccine: number;
  dailyLockdown: number;
  dailySurge: number;
  dailyTotal: number;

  totalMedical: number;
  totalDeaths: number;
  totalQuarantine: number;
  totalMask: number;
  totalVaccine: number;
  totalLockdown: number;
  totalSurge: number;
  grandTotal: number;
}

/**
 * Running sums of the cost-relevant per-tick counts that have been dropped from
 * the capped `LongStats` window. Lets the (UI-thread) cost layer price the full
 * run even past `LONG_CAP` days, without storing unbounded history. All linear
 * cost categories reprice exactly from these sums on a profile/currency change;
 * the nonlinear surge term is approximated from the average over retired ticks.
 */
export interface RetiredCostTotals {
  ticks: number;
  i: number;
  dnew: number;
  masked: number;
  vaccinated: number;
  quarantined: number;
  lockdownStringency: number;
}

export interface RegionPreset {
  id: string;
  label: string;
  gdpPerCapitaAnnual: number;
  vsl: number;
}

export interface CurrencySpec {
  code: string;
  symbol: string;
  rateVsUsd: number; // multiply a USD figure by this to display in the currency
}

export interface CostConfig {
  profile: PathogenCostProfile;
  regionId: string;
  currencyCode: string;
  currencyRate: number; // editable; defaults to the currency's rateVsUsd
}

export type WorkerCommand =
  | { cmd: 'init'; config: SimConfig }
  | { cmd: 'play'; tps: number }
  | { cmd: 'pause' }
  | { cmd: 'step'; n: number }
  | { cmd: 'reset'; config: SimConfig }
  | { cmd: 'updateConfig'; config: SimConfig }
  | { cmd: 'patchConfig'; config: SimConfig };

// ─── R₀ Estimator fitting-worker protocol ────────────────────────────────────
// A separate, isolated worker pool (`src/worker/fit.worker.ts`) runs headless
// Engine trials for inverse parameter fitting. It never touches the live
// `sim.worker.ts` engine, so the determinism / population-conservation
// invariants of a running simulation are untouched. The worker is pure: it runs
// K stochastic trials of a candidate config and returns the mean per-capita
// SEIR curves; the loss function and observed data live on the UI thread.

export interface FitWorkerCommand {
  /** Correlates the reply with the pending promise on the UI thread. */
  id: number;
  config: SimConfig;
  /** Number of days (ticks) to simulate; curve length is days + 1 (day 0..days). */
  days: number;
  /** Stochastic trials to average over. */
  K: number;
  /** Base seed; trial k uses a decorrelated derivative of it. */
  seed: number;
}

export interface FitWorkerResult {
  id: number;
  /** Per-capita fractions in [0..1], averaged over K trials, length days + 1. */
  curves: {
    cumulative_infections: number[];
    cumulative_deaths: number[];
    active_infections: number[];
  };
  /** The engine's analytic R₀ for this candidate (any geometry, incl. voronoi).
   *  Null only for degenerate configs (e.g. grid < 8). */
  rNaught: number | null;
}
