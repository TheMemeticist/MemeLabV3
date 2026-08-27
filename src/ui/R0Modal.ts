// R₀ Estimator — inverse parameter fitting panel.
//
// Paste an observed outbreak curve (cumulative cases / deaths over time), pick
// which strain genes to fit, and the panel searches for the genes whose
// simulated curve best matches the data, then reports the implied R₀ (with a
// confidence interval) and goodness of fit, overlaying observed vs simulated.
//
// Lifecycle mirrors AboutModal/CostModal (overlay appended to body, Esc +
// outside-click dismiss). The heavy lifting lives in the pure `fit.ts` core and
// the isolated `FitPool` worker pool; this file is just wiring + rendering.

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { InterventionParamName, SimConfig } from '../types';
import { FitPool } from '../lib/fit-pool';
import { Slider } from './Slider';
import { installFocusTrap } from './focus';
import { read, remove, write } from '../lib/storage';
import { icon } from './icons';
import {
  CATEGORY_LABELS,
  FIT_CATEGORIES,
  FIT_PARAMS,
  effectiveReductionAt,
  hasDownwardRevisions,
  interventionWindows,
  parseObservedCSV,
  percentileBands,
  BAND_CENTRAL,
  EBOLA_ADJUST,
  EBOLA_INTERVENTIONS,
  ENSEMBLE_CENTRAL,
  ENSEMBLE_PROBS,
  migrateInterventionSpecs,
  resolutionFitSize,
  revisionEnvelope,
  runFit,
  transmissionSchedule,
  vintagedAdjust,
} from '../lib/fit';
import type {
  FitCategory,
  InterventionSpec,
  FitParamDef,
  FitParamName,
  FitProgress,
  FitResult,
  Keyframe,
  LossType,
  ObservedPoint,
  SimCurves,
} from '../lib/fit';

interface R0ModalEvents {
  /** Current simulation config — the fit inherits its geometry and untouched genes. */
  getConfig: () => SimConfig;
  /** Push the fitted WORLD back into the simulation: the full fitted config
   *  (fit grid, patient-zero seeding, interventions-off baseline) plus the
   *  fitted R(t) schedule, its chart windows, the representative trial seed,
   *  and the fitted mean curves for the live-chart overlay. */
  onApply: (config: SimConfig, extras: import('../types').FitApplyExtras) => void;
  /** The SHARED intervention store (owned by App; same array/objects as the
   *  main sim). Optional so the modal still works standalone (local fallback). */
  getInterventions?: () => InterventionSpec[];
  /** Notify the owner after any mutation of the shared store (it persists). */
  onInterventionsChange?: () => void;
}

// Per-category overlay colors (line = simulated, dots = observed).
const CAT_COLOR: Record<FitCategory, string> = {
  cumulative_infections: 'rgb(59, 130, 246)',
  cumulative_deaths: 'rgb(239, 68, 68)',
  active_infections: 'rgb(34, 197, 94)',
};

// Greyed ink for raw points superseded by the revision cleaning.
const RAW_INK = 'rgba(148, 163, 184, 0.55)';

// Chart overlay layers the user can show/hide from the chip legend under the
// chart. 'raw' toggles the greyed raw-revision uPlot series; the rest gate
// their canvas-painted sections in paintOverlays.
type OverlayKey = 'itv' | 'raw' | 'adjust' | 'bayes' | 'ensemble' | 'offset';
const DEFAULT_OVERLAY_VIS: Record<OverlayKey, boolean> = {
  itv: true, raw: true, adjust: true, bayes: true, ensemble: true, offset: true,
};

/** 'rgb(r, g, b)' → 'rgba(r, g, b, a)' for the canvas-painted overlays. */
function withAlpha(rgb: string, a: number): string {
  return rgb.replace('rgb(', 'rgba(').replace(')', `, ${a})`);
}

// Short legend labels — the full CATEGORY_LABELS ("Cumulative infections") make the
// legend pills overflow and hide the value readout, so the chart uses these instead.
const CAT_SHORT: Record<FitCategory, string> = {
  cumulative_infections: 'Infections',
  cumulative_deaths: 'Deaths',
  active_infections: 'Active',
};

// The demo dataset is generated from the engine itself (via the worker pool) at
// a planted attackRate + range, sampled every few days and scaled to a
// population. Because it overrides only the two parameters the default fit
// searches, "Load demo → Run fit" recovers them with a high R² — a genuine,
// self-consistent showcase rather than a hand-drawn curve the spatial model
// can't reproduce.
const DEMO_POP = 1_000_000;
const DEMO_DAYS = 60;
const DEMO_SAMPLE = 5;
const DEMO_ATTACK = 0.08;
const DEMO_RANGE = 2;
const DEMO_K = 8;

// The fit runs at the *live grid size* so the fit's config matches the simulation the
// user will run after Apply — a MemeLab outbreak spreads as a traveling wave from the
// index case, so its per-capita curve is NOT scale-invariant (absolute spread over a
// fixed horizon is ~size-independent ⇒ per-capita deaths scale as 1/N). Fitting at any
// other grid size would therefore not reproduce. FIT_GRID_CAP only bounds the cost on
// very large grids; above it we fit at the cap and warn that reproduction degrades.
const FIT_GRID_CAP = 128;

// Historical outbreak datasets — sparse, real-world-flavored collections of
// cumulative cases/deaths. The `population` is an *effective susceptible pool*
// chosen so the spatial model can reproduce the curve (a country's full census
// would put the per-capita floor of one grid cell above the early counts), not
// a literal census figure. Approximate; for exploration, not epidemiology.
interface DemoPreset {
  id: string;
  label: string;
  population: number;
  points: ObservedPoint[];
  /** Default underreporting keyframes loaded (enabled) with the preset. */
  adjust?: { t0: number; cases: Keyframe[]; deaths: Keyframe[] };
  /** Default interventions (time-varying transmission) loaded with the preset. */
  interventions?: InterventionSpec[];
}

// Build observed points from [day, value] pairs for a single category.
function series(category: FitCategory, pairs: [number, number][]): ObservedPoint[] {
  return pairs.map(([day, value]) => ({ day, value, category }));
}

const HISTORICAL_PRESETS: DemoPreset[] = [
  {
    id: 'covid-kr',
    label: 'COVID-19 — South Korea, early 2020',
    population: 60_000,
    points: [
      ...series('cumulative_infections', [[0, 31], [5, 600], [10, 3700], [15, 7300], [20, 8500], [25, 9200], [30, 9800], [40, 10400], [55, 10700]]),
      ...series('cumulative_deaths', [[10, 20], [20, 75], [30, 150], [40, 200], [55, 250]]),
    ],
  },
  {
    id: 'ebola-wa',
    label: 'Ebola — West Africa, 2014–15',
    population: 80_000,
    points: [
      ...series('cumulative_infections', [[0, 50], [30, 400], [60, 1400], [90, 4300], [120, 9900], [150, 15300], [180, 20200], [240, 26600], [300, 28600]]),
      ...series('cumulative_deaths', [[30, 200], [90, 2300], [150, 6300], [240, 11000], [300, 11300]]),
    ],
  },
  {
    id: 'sars-03',
    label: 'SARS — global, 2003',
    population: 30_000,
    points: [
      ...series('cumulative_infections', [[0, 100], [20, 1800], [40, 3500], [60, 5700], [80, 7400], [100, 8000], [120, 8100]]),
      ...series('cumulative_deaths', [[40, 180], [80, 600], [120, 774]]),
    ],
  },
  {
    id: 'flu-1918',
    label: '1918 Influenza — Philadelphia (deaths)',
    population: 120_000,
    points: series('cumulative_deaths', [[0, 0], [7, 120], [14, 1600], [21, 6800], [28, 11700], [35, 14200], [42, 15400], [49, 16000]]),
  },
  // Stored RAW, downward revisions and all (days 12–16 were revised down as
  // duplicates/misdiagnoses were removed). The "honor downward revisions"
  // cleaning — on by default — fits against the running-min envelope, and the
  // chart greys the superseded raw points. Toggle it off to fit the raw series.
  {
    id: 'ebola-rev',
    label: 'Ebola — 2026 outbreak (revised counts)',
    population: 15_000,
    // Default sitrep-phase underreporting keyframes (user-provided tables;
    // ranges → midpoints, all ≥ 1). Loaded enabled; fully editable.
    adjust: EBOLA_ADJUST,
    // Real-2014-response intervention defaults (see EBOLA_INTERVENTIONS).
    interventions: EBOLA_INTERVENTIONS,
    points: [
      ...series('cumulative_infections', [
        [0, 653], [5, 968], [6, 1010], [10, 1042], [12, 1205], [13, 1038], [14, 1262],
        [16, 681], [17, 352], [18, 359], [20, 378], [21, 397], [22, 471], [23, 507],
        [24, 534], [25, 569], [26, 617], [27, 654], [28, 695], [30, 729], [36, 975],
        [37, 1022], [38, 1067], [40, 1114], [41, 1139], [42, 1176], [43, 1224],
        [45, 1295], [46, 1328], [47, 1354], [51, 1549], [52, 1582], [53, 1645],
        [54, 1729], [55, 1780], [59, 1813], [60, 1851], [61, 1894], [62, 1947],
        [63, 1984], [68, 2444], [69, 2494], [70, 2557], [72, 2926], [73, 2994],
        [74, 3096], [75, 3221], [76, 3283], [77, 3381], [78, 3463], [79, 3553],
        [80, 3626], [81, 3695], [82, 3769], [83, 3823], [84, 3895], [85, 3994],
        [86, 4074], [88, 4141], [91, 4470], [92, 4587], [94, 4864], [95, 4966],
        [96, 5042],
      ]),
      ...series('cumulative_deaths', [
        [0, 144], [5, 216], [6, 231], [10, 240], [12, 264], [13, 241], [14, 241],
        [16, 56], [17, 49], [18, 61], [20, 63], [21, 65], [22, 84], [23, 88],
        [24, 93], [25, 103], [26, 117], [27, 129], [28, 138], [30, 151], [36, 249],
        [37, 256], [38, 269], [40, 279], [41, 293], [42, 306], [43, 323], [45, 362],
        [46, 379], [47, 401], [51, 494], [52, 508], [53, 523], [54, 582], [55, 602],
        [59, 627], [60, 650], [61, 674], [62, 704], [63, 721], [68, 969], [69, 1001],
        [70, 1035], [72, 1271], [73, 1311], [74, 1356], [75, 1407], [76, 1439],
        [77, 1489], [78, 1523], [79, 1558], [80, 1589], [81, 1623], [82, 1659],
        [83, 1709], [84, 1753], [85, 1803], [86, 1852], [88, 1889], [91, 2063],
        [92, 2130], [94, 2274], [95, 2327], [96, 2380],
      ]),
    ],
  },
  {
    // Alternative reading of the same feed: the day 0–16 block's magnitudes
    // match the day 36–47 sitreps, so the early block looks like a mis-dated
    // duplicate of later data (or a different case definition), not real early
    // counts. From day 17 the series is strictly monotone (the day 63 → 68 jump
    // of ~460 cases is a plausible batch reporting catch-up, which a cumulative
    // series allows), so the preset keeps the full day 17–96 backbone verbatim.
    // Population is the effective susceptible pool (see note above): at census
    // scale one 128-grid cell is worth hundreds of people, the whole outbreak
    // collapses into a few cells, and the fitted curve degenerates into a
    // staircase.
    id: 'ebola-sitrep',
    label: 'Ebola — outbreak sitreps, days 17–96 (cleaned)',
    population: 80_000,
    // Same current-outbreak defaults as ebola-rev: the user's adjustment
    // keyframe tables + the real-2014-response interventions.
    adjust: EBOLA_ADJUST,
    interventions: EBOLA_INTERVENTIONS,
    points: [
      ...series('cumulative_infections', [
        [17, 352], [18, 359], [20, 378], [21, 397], [22, 471], [23, 507], [24, 534], [25, 569],
        [26, 617], [27, 654], [28, 695], [30, 729], [36, 975], [37, 1022], [38, 1067], [40, 1114],
        [41, 1139], [42, 1176], [43, 1224], [45, 1295], [46, 1328], [47, 1354], [51, 1549],
        [52, 1582], [53, 1645], [54, 1729], [55, 1780], [59, 1813], [60, 1851], [61, 1894],
        [62, 1947], [63, 1984], [68, 2444], [69, 2494], [70, 2557], [72, 2926], [73, 2994],
        [74, 3096], [75, 3221], [76, 3283], [77, 3381], [78, 3463], [79, 3553], [80, 3626],
        [81, 3695], [82, 3769], [83, 3823], [84, 3895], [85, 3994], [86, 4074], [88, 4141],
        [91, 4470], [92, 4587], [94, 4864], [95, 4966], [96, 5042],
      ]),
      ...series('cumulative_deaths', [
        [17, 49], [18, 61], [20, 63], [21, 65], [22, 84], [23, 88], [24, 93], [25, 103],
        [26, 117], [27, 129], [28, 138], [30, 151], [36, 249], [37, 256], [38, 269], [40, 279],
        [41, 293], [42, 306], [43, 323], [45, 362], [46, 379], [47, 401], [51, 494], [52, 508],
        [53, 523], [54, 582], [55, 602], [59, 627], [60, 650], [61, 674], [62, 704], [63, 721],
        [68, 969], [69, 1001], [70, 1035], [72, 1271], [73, 1311], [74, 1356], [75, 1407],
        [76, 1439], [77, 1489], [78, 1523], [79, 1558], [80, 1589], [81, 1623], [82, 1659],
        [83, 1709], [84, 1753], [85, 1803], [86, 1852], [88, 1889], [91, 2063], [92, 2130],
        [94, 2274], [95, 2327], [96, 2380],
      ]),
    ],
  },
];

// Persisted snapshot of the panel so a closed/reopened session restores exactly
// (settings *and* the observed dataset/preset). Versioned via storage.ts.
const STORAGE_KEY = 'r0-estimator';
type OptimizerKind = 'local' | 'genetic';
interface GASettings {
  population: number;
  generations: number;
  mutationRate: number;
  crossoverRate: number;
  elitism: number;
  tournament: number;
}
const DEFAULT_GA: GASettings = {
  population: 40, generations: 25, mutationRate: 0.2, crossoverRate: 0.9, elitism: 2, tournament: 3,
};

/** One completed fit, kept for the history table. `hash` identifies the exact
 *  effective dataset the loss saw (post-shift, post-cleaning, incl. population),
 *  so fits are only ranked against the same data. */
interface FitHistoryEntry {
  t: number; // wall-clock ms — display only, never feeds the sim
  hash: string;
  presetId: string;
  result: FitResult;
}
const HISTORY_CAP = 20;

// FNV-1a over the effective dataset + population — the comparability key for
// the history table.
function datasetHash(points: ObservedPoint[], population: number): string {
  const s = points
    .slice()
    .sort((a, b) => a.day - b.day || a.category.localeCompare(b.category) || a.value - b.value)
    .map((p) => `${p.day}:${p.value}:${p.category}`)
    .join('|') + `|${population}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Case/death underreporting adjustment (keyframe multipliers + vintaged
 *  accumulation). Frames are in raw data-day coordinates; null frames = build
 *  the pseudocode defaults from the data when first enabled. */
interface AdjustSettings {
  enabled: boolean;
  /** true → the fit targets the adjusted central; false → overlay only. */
  asTarget: boolean;
  /** Date of first confirmed case (initial-stock midpoint rule); null = first data day. */
  t0: number | null;
  cases: Keyframe[] | null;
  deaths: Keyframe[] | null;
}
const DEFAULT_ADJUST: AdjustSettings = { enabled: false, asTarget: true, t0: null, cases: null, deaths: null };
// Pseudocode defaults: 6-week linear ramp, cases 5.0 → 3.8, deaths 3.0 → 2.5.
const RAMP_DAYS = 42;
const ADJ_DEFAULTS: Record<'cases' | 'deaths', [number, number]> = { cases: [5.0, 3.8], deaths: [3.0, 2.5] };


interface R0Snapshot {
  population: number;
  selected: FitParamName[];
  bounds: [FitParamName, [number, number]][];
  K: number;
  loss: LossType;
  observed: ObservedPoint[];
  presetId: string;
  optimizer?: OptimizerKind;
  ga?: GASettings;
  indexOffset?: number;
  honorRevisions?: boolean;
  history?: FitHistoryEntry[];
  fanTrials?: number; // index-case ensemble trial count (key kept for compat)
  bayesDraws?: number;
  predictionDays?: number;
  interventions?: InterventionSpec[];
  adjust?: AdjustSettings;
  offsetEvolve?: boolean;
  offsetBounds?: [number, number];
  overlayVis?: Partial<Record<OverlayKey, boolean>>;
}

export class R0Modal {
  private el: HTMLDivElement | null = null;
  private pool: FitPool | null = null;
  private plot: uPlot | null = null;

  // Fit state.
  private observed: ObservedPoint[] = [];
  private population = DEMO_POP;
  private selected = new Set<FitParamName>(FIT_PARAMS.filter((p) => p.core).map((p) => p.name));
  private bounds = new Map<FitParamName, [number, number]>(
    FIT_PARAMS.map((p) => [p.name, [...p.bounds] as [number, number]]),
  );
  private K = 30;
  private loss: LossType = 'poisson';
  // Days to shift the dataset later in model time — gives the outbreak a head start
  // before the first reported case (corrects for early under-detection). 0 = none.
  // When offsetEvolve is on, the optimizer searches this within offsetBounds and
  // writes the fitted value back here (one field, evolved — not a duplicate).
  private indexOffset = 0;
  private offsetEvolve = true;
  private offsetBounds: [number, number] = [0, 28];
  // Genetic algorithm is the default search — global and robust on MemeLab's rugged,
  // multimodal loss surfaces, and it evolves the disease genome the way the sim does.
  private optimizer: OptimizerKind = 'genetic';
  private ga: GASettings = { ...DEFAULT_GA };
  private presetId = 'synthetic';
  // Fit against the revision-cleaned (right-to-left running-min) series when the
  // data has downward revisions. A no-op on monotone data, so on by default.
  private honorRevisions = true;
  private history: FitHistoryEntry[] = [];
  // Posterior draws for the FINAL Bayesian posterior-predictive band (seeded
  // Metropolis over the fitted params; 0/1 = band off). The live streaming line
  // stays the cheap path — this runs once, post-fit.
  private bayesDraws = 120;
  // Days to project the model beyond the data's last day.
  private predictionDays = 0;
  // Index-case ensemble trials for the post-fit density band (0/1 = off): the
  // winning config re-simulated N times, each trial seeding the outbreak at a
  // DIFFERENT board cell — predictive spread, distinct from the Bayes band.
  private ensembleTrials = 48;
  // Interventions: time-varying transmission R(t) — the MODEL dimension,
  // separate from the case/death DATA adjustment. The store is SHARED with the
  // main sim (App owns it + persistence); this getter always reads the live
  // array so both UIs act on the same objects. Local fallback for standalone use.
  private localInterventions: InterventionSpec[] = [];
  private get interventions(): InterventionSpec[] {
    return this.events.getInterventions?.() ?? this.localInterventions;
  }
  private notifyInterventions(): void {
    this.events.onInterventionsChange?.();
  }
  /** Re-render the interventions editor (main sim calls this after it mutates
   *  the shared store, e.g. an intervention toggle). No-op when closed. */
  refreshInterventions(): void {
    if (this.el) this.renderInterventions();
  }
  private itvSeq = 0; // display-only id counter (never feeds the sim)
  private adjust: AdjustSettings = { ...DEFAULT_ADJUST };
  private running = false;
  private signal = { aborted: false };
  private skipPersist = false;
  private result: FitResult | null = null;
  // Raw (pre-cleaning) points for the greyed preview overlay of the last fit.
  private lastRaw: ObservedPoint[] | null = null;
  // Floor/central/upper adjustment series of the last fit (chart overlay).
  private lastAdjust: { floor: ObservedPoint[]; central: ObservedPoint[]; upper: ObservedPoint[] } | null = null;
  // Percentile fan of the last fit's best config (transient — not persisted).
  private lastFan: Record<FitCategory, number[][]> | null = null;
  // Index-case ensemble percentiles of the last fit (ENSEMBLE_PROBS rows,
  // per-capita; transient) — painted as the density layer under the series.
  private lastEnsemble: Record<FitCategory, number[][]> | null = null;

  // Live-chart state (set by createChart, read by updateChartData) + an rAF
  // throttle so a burst of optimizer improvements coalesces into one redraw.
  private liveObserved: ObservedPoint[] = [];
  private liveCats: FitCategory[] = [];
  // Per-category greyed raw-overlay columns (null = category has no revisions);
  // parallel to liveCats, cached so live frames rebuild the same data shape.
  private liveRawCols: ((number | null)[] | null)[] = [];
  // Band rows (people-scaled, BAND_PROBS order: low/central/high) per category, and
  // sparse floor/central/upper vertices for the adjustment envelope — painted by
  // a custom uPlot draw hook so the chart's data columns / legend stay untouched.
  private liveFanCols: Partial<Record<FitCategory, number[][]>> | null = null;
  // Ensemble density rows (people-scaled, ENSEMBLE_PROBS order) per category.
  private liveEnsembleCols: Partial<Record<FitCategory, number[][]>> | null = null;
  private liveAdjustPts: Partial<Record<FitCategory, { floor: [number, number][]; central: [number, number][]; upper: [number, number][] }>> | null = null;
  // Highest overlay value (people) so y-autoscale includes bands above the data.
  private overlayMax = 0;
  // During an offset-evolving fit the chart lives in SIM days: the model curve
  // plots unshifted from outbreak day 0, and the DATA DOTS slide right by the
  // current best candidate's offset (data day d → sim day d + offset). This
  // keeps the head-start portion of every candidate visible instead of
  // clipping it off-canvas (the old approach shifted the model left).
  private liveDotShift = 0;
  // Vertical marker at the evolving index date (x = current offset, i.e. where
  // data day 0 sits in sim days). Null hides it — post-fit charts use the
  // profile-CI band (liveOffsetBand) instead.
  private liveIndexMarker: number | null = null;
  // Index-date profile-CI marker for the final chart (x = plausible positions of
  // the first observation given the CI; line = where it actually sits).
  private liveOffsetBand: { lo95: number; hi95: number; lo68: number; hi68: number; at: number } | null = null;
  // Intervention ramp windows (chart-day coords) for the shaded chart markers.
  private liveItvWindows: { from: number; to: number; label: string }[] = [];
  // Overlay-layer visibility, driven by the chip legend under the chart.
  // Survives chart rebuilds (renderOutput/createChart recreate the plot) and
  // persists in the panel snapshot.
  private overlayVis: Record<OverlayKey, boolean> = { ...DEFAULT_OVERLAY_VIS };
  // uPlot series indexes of the greyed raw-revision dot columns — the 'raw'
  // chip toggles these via setSeries (and setSeries syncs the chip back).
  private liveRawSeriesIdx: number[] = [];
  private liveDays = 0;
  private livePop = 0;
  private pendingSnapshot: FitProgress | null = null;
  private rafId = 0;
  private untrap: (() => void) | null = null;

  constructor(private events: R0ModalEvents) {}

  open(): void {
    if (this.el) return;
    const overlay = document.createElement('div');
    overlay.className = 'r0-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'R₀ Estimator');
    overlay.innerHTML = `
      <div class="r0-card">
        <button class="r0-close" type="button" aria-label="Close">${icon('close')}</button>
        <div class="r0-body">${TEMPLATE}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;
    this.pool = new FitPool();

    overlay.querySelector('.r0-close')?.addEventListener('click', () => this.close());
    // Outside-click dismiss — but only when the *press* started on the backdrop
    // too. Drag-selecting an input's value and releasing over the backdrop
    // dispatches the click on the overlay (nearest common ancestor of down/up
    // targets), which used to close the modal mid-edit.
    let pressOnOverlay = false;
    overlay.addEventListener('pointerdown', (ev) => { pressOnOverlay = ev.target === overlay; });
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay && pressOnOverlay) this.close();
      pressOnOverlay = false;
    });
    document.addEventListener('keydown', this.onKey);

    // Restore the previous session if one was saved; otherwise fall back to the
    // self-consistent, engine-generated demo on first open.
    const saved = read<R0Snapshot | null>(STORAGE_KEY, null);
    if (saved) this.hydrate(saved);

    this.bindControls();
    this.renderTable();
    this.renderParams();
    this.renderOutput();
    this.renderHistory();
    this.untrap = installFocusTrap(
      overlay.querySelector('.r0-card') as HTMLElement,
      overlay.querySelector('.r0-close') as HTMLElement,
    );
    if (saved) this.showRestoreBanner();
    if (!saved) void this.loadDemo();
  }

  close(): void {
    if (!this.el) return;
    if (!this.skipPersist) this.persist();
    this.untrap?.();
    this.untrap = null;
    document.removeEventListener('keydown', this.onKey);
    this.signal.aborted = true;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.pendingSnapshot = null;
    this.plot?.destroy();
    this.plot = null;
    this.pool?.dispose();
    this.pool = null;
    const e = this.el;
    this.el = null;
    e.classList.add('r0-out');
    setTimeout(() => e.remove(), 200);
  }

  // ── Persistence ──
  private persist(): void {
    write<R0Snapshot>(STORAGE_KEY, {
      population: this.population,
      selected: [...this.selected],
      bounds: [...this.bounds.entries()],
      K: this.K,
      loss: this.loss,
      observed: this.observed,
      presetId: this.presetId,
      optimizer: this.optimizer,
      ga: { ...this.ga },
      indexOffset: this.indexOffset,
      honorRevisions: this.honorRevisions,
      history: this.history,
      bayesDraws: this.bayesDraws,
      predictionDays: this.predictionDays,
      fanTrials: this.ensembleTrials,
      adjust: { ...this.adjust },
      offsetEvolve: this.offsetEvolve,
      offsetBounds: [...this.offsetBounds] as [number, number],
      overlayVis: { ...this.overlayVis },
    });
  }

  private hydrate(s: R0Snapshot): void {
    if (Number.isFinite(s.population) && s.population > 0) this.population = s.population;
    if (Array.isArray(s.selected)) this.selected = new Set(s.selected);
    if (Array.isArray(s.bounds)) {
      for (const [name, b] of s.bounds) {
        if (this.bounds.has(name) && Array.isArray(b) && b.length === 2) {
          this.bounds.set(name, [b[0], b[1]]);
        }
      }
    }
    if (Number.isFinite(s.K)) this.K = Math.round(s.K);
    if (s.loss === 'mse' || s.loss === 'poisson') this.loss = s.loss;
    if (Array.isArray(s.observed)) this.observed = s.observed.map((p) => ({ ...p }));
    if (typeof s.presetId === 'string') this.presetId = s.presetId;
    if (s.optimizer === 'local' || s.optimizer === 'genetic') this.optimizer = s.optimizer;
    if (s.ga && typeof s.ga === 'object') this.ga = { ...DEFAULT_GA, ...s.ga };
    if (Number.isFinite(s.indexOffset)) this.indexOffset = Math.max(0, Math.round(s.indexOffset!));
    if (typeof s.honorRevisions === 'boolean') this.honorRevisions = s.honorRevisions;
    if (Array.isArray(s.history)) this.history = s.history.slice(0, HISTORY_CAP);
    if (Number.isFinite(s.bayesDraws)) this.bayesDraws = Math.min(500, Math.max(0, Math.round(s.bayesDraws!)));
    if (Number.isFinite(s.predictionDays)) this.predictionDays = Math.min(365, Math.max(0, Math.round(s.predictionDays!)));
    if (Number.isFinite(s.fanTrials)) this.ensembleTrials = Math.min(256, Math.max(0, Math.round(s.fanTrials!)));
    if (s.overlayVis && typeof s.overlayVis === 'object') this.overlayVis = { ...DEFAULT_OVERLAY_VIS, ...s.overlayVis };
    if (Array.isArray(s.interventions) && this.interventions.length === 0) {
      // Migration: interventions used to live in this snapshot (older shapes
      // incl. the removed 'intensity' scalar). Seed the App-owned store once.
      const store = this.interventions;
      store.push(...migrateInterventionSpecs(s.interventions));
      this.notifyInterventions();
    }
  }

  // ── Restored-session banner + reset ──
  // Persisted settings (population, bounds, offset, dataset) silently shape every
  // new fit — e.g. a stale census-scale Population on a tiny grid. Surface the
  // restore visibly and offer a one-click way back to a clean slate.
  private showRestoreBanner(): void {
    const host = this.el?.querySelector<HTMLElement>('[data-r0="banner"]');
    if (!host) return;
    host.hidden = false;
    host.innerHTML = `
      <span>Restored your previous session — population, dataset, bounds and offsets persist between visits and quietly shape new fits.</span>
      <button class="btn ghost" type="button" data-r0="reset">Reset to defaults</button>
      <button class="r0-banner-x" type="button" aria-label="Dismiss">${icon('close')}</button>
    `;
    host.querySelector<HTMLButtonElement>('[data-r0="reset"]')!.addEventListener('click', () => this.resetToDefaults());
    host.querySelector<HTMLButtonElement>('.r0-banner-x')!.addEventListener('click', () => { host.hidden = true; });
  }

  /** Wipe the persisted snapshot and all panel state (including fit history),
   *  then reopen fresh — lands on the auto-generated demo, like a first visit. */
  private resetToDefaults(): void {
    remove(STORAGE_KEY);
    this.population = DEMO_POP;
    this.selected = new Set(FIT_PARAMS.filter((p) => p.core).map((p) => p.name));
    this.bounds = new Map(FIT_PARAMS.map((p) => [p.name, [...p.bounds] as [number, number]]));
    this.K = 30;
    this.loss = 'poisson';
    this.indexOffset = 0;
    this.optimizer = 'genetic';
    this.ga = { ...DEFAULT_GA };
    this.presetId = 'synthetic';
    this.observed = [];
    this.result = null;
    this.honorRevisions = true;
    this.history = [];
    this.bayesDraws = 120;
    this.predictionDays = 0;
    this.ensembleTrials = 48;
    this.interventions.length = 0; // shared store: clear contents in place
    this.notifyInterventions();
    this.adjust = { ...DEFAULT_ADJUST };
    this.offsetEvolve = true;
    this.offsetBounds = [0, 28];
    this.lastRaw = null;
    this.lastAdjust = null;
    this.lastFan = null;
    this.lastEnsemble = null;
    this.liveOffsetBand = null;
    // close() persists by default — that would immediately re-save the state we
    // just wiped, so gate it off for this teardown, then reopen after the 200ms
    // exit animation clears the old DOM.
    this.skipPersist = true;
    this.close();
    setTimeout(() => { this.skipPersist = false; this.open(); }, 220);
  }

  private onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') this.close();
  };

  // ── Control wiring ──
  private bindControls(): void {
    const q = <T extends HTMLElement>(sel: string) => this.el!.querySelector<T>(sel)!;

    const popInput = q<HTMLInputElement>('[data-r0="population"]');
    popInput.value = String(this.population);
    popInput.addEventListener('change', () => {
      const v = Number(popInput.value);
      if (Number.isFinite(v) && v > 0) { this.population = v; this.persist(); }
    });

    const offsetInput = q<HTMLInputElement>('[data-r0="offset"]');
    offsetInput.value = String(this.indexOffset);
    offsetInput.addEventListener('change', () => {
      const v = Number(offsetInput.value);
      this.indexOffset = Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
      offsetInput.value = String(this.indexOffset);
      this.persist();
    });

    // Evolve-index-date toggle + bounds (the offset above becomes the fitted value).
    const offEvolve = q<HTMLInputElement>('[data-r0="offset-evolve"]');
    const offLo = q<HTMLInputElement>('[data-r0="offset-lo"]');
    const offHi = q<HTMLInputElement>('[data-r0="offset-hi"]');
    offEvolve.checked = this.offsetEvolve;
    offLo.value = String(this.offsetBounds[0]);
    offHi.value = String(this.offsetBounds[1]);
    offEvolve.addEventListener('change', () => { this.offsetEvolve = offEvolve.checked; this.persist(); });
    const readBounds = (): void => {
      const lo = Math.max(0, Math.round(Number(offLo.value) || 0));
      const hi = Math.max(lo, Math.round(Number(offHi.value) || 0));
      this.offsetBounds = [lo, hi];
      offLo.value = String(lo);
      offHi.value = String(hi);
      this.persist();
    };
    offLo.addEventListener('change', readBounds);
    offHi.addEventListener('change', readBounds);

    q<HTMLButtonElement>('[data-r0="add-row"]').addEventListener('click', () => {
      const lastDay = this.observed.length ? Math.max(...this.observed.map((p) => p.day)) : 0;
      this.observed.push({ day: lastDay + 1, value: 0, category: 'cumulative_infections' });
      // Reveal the table so the new row is visible even when collapsed.
      const details = this.el!.querySelector<HTMLDetailsElement>('[data-r0="data-details"]');
      if (details) details.open = true;
      this.renderTable();
      this.persist();
    });

    // Populate the dataset picker with the historical presets and wire loading.
    const preset = q<HTMLSelectElement>('[data-r0="preset"]');
    for (const p of HISTORICAL_PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      preset.appendChild(opt);
    }
    preset.value = this.presetId;
    preset.addEventListener('change', () => {
      this.presetId = preset.value;
      if (preset.value === 'synthetic') { void this.loadDemo(); return; }
      const p = HISTORICAL_PRESETS.find((x) => x.id === preset.value);
      if (p) this.loadDataset(p);
    });

    q<HTMLButtonElement>('[data-r0="clear"]').addEventListener('click', () => {
      this.observed = [];
      this.result = null;
      this.renderTable();
      this.renderOutput();
      this.persist();
      this.note('Cleared — add rows or pick a dataset.');
    });

    q<HTMLButtonElement>('[data-r0="parse"]').addEventListener('click', () => {
      const ta = q<HTMLTextAreaElement>('[data-r0="paste"]');
      const append = q<HTMLInputElement>('[data-r0="paste-append"]').checked;
      const { points, skipped } = parseObservedCSV(ta.value);
      if (points.length === 0) { this.note(`No valid rows found${skipped ? ` (${skipped} skipped)` : ''}.`); return; }
      this.observed = append ? [...this.observed, ...points] : points;
      ta.value = '';
      this.renderTable();
      this.persist();
      this.note(`Loaded ${points.length} point${points.length === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`);
    });

    // Revised-cumulative toggle. A no-op on monotone data, so it stays on by
    // default; turning it off fits the raw series, revisions and all.
    const revInput = q<HTMLInputElement>('[data-r0="revfix"]');
    revInput.checked = this.honorRevisions;
    revInput.addEventListener('change', () => {
      this.honorRevisions = revInput.checked;
      this.persist();
      this.note(this.honorRevisions
        ? 'Downward revisions will be cleaned (running-min envelope) before fitting.'
        : 'Fitting the raw series — downward revisions left as-is.');
    });

    // Posterior draws for the final Bayesian band (0 = off).
    const fanInput = q<HTMLInputElement>('[data-r0="fan"]');
    fanInput.value = String(this.bayesDraws);
    fanInput.addEventListener('change', () => {
      const v = Number(fanInput.value);
      this.bayesDraws = Number.isFinite(v) ? Math.min(500, Math.max(0, Math.round(v))) : 120;
      fanInput.value = String(this.bayesDraws);
      this.persist();
    });

    // Index-case ensemble trials for the post-fit density band (0/1 = off).
    const ensInput = q<HTMLInputElement>('[data-r0="ens"]');
    ensInput.value = String(this.ensembleTrials);
    ensInput.addEventListener('change', () => {
      const v = Number(ensInput.value);
      this.ensembleTrials = Number.isFinite(v) ? Math.min(256, Math.max(0, Math.round(v))) : 48;
      ensInput.value = String(this.ensembleTrials);
      this.persist();
    });

    // Prediction horizon: project the model this many days past the data end.
    const predInput = q<HTMLInputElement>('[data-r0="pred"]');
    predInput.value = String(this.predictionDays);
    predInput.addEventListener('change', () => {
      const v = Number(predInput.value);
      this.predictionDays = Number.isFinite(v) ? Math.min(365, Math.max(0, Math.round(v))) : 0;
      predInput.value = String(this.predictionDays);
      this.persist();
    });

    // Underreporting adjustment controls.
    const adjEnabled = q<HTMLInputElement>('[data-adj="enabled"]');
    const adjTarget = q<HTMLInputElement>('[data-adj="astarget"]');
    const adjT0 = q<HTMLInputElement>('[data-adj="t0"]');
    adjEnabled.checked = this.adjust.enabled;
    adjTarget.checked = this.adjust.asTarget;
    adjT0.value = this.adjust.t0 == null ? '' : String(this.adjust.t0);
    adjEnabled.addEventListener('change', () => {
      this.adjust.enabled = adjEnabled.checked;
      if (this.adjust.enabled && (!this.adjust.cases || !this.adjust.deaths)) {
        // Materialize the pseudocode defaults so the editor shows real rows.
        const f = this.adjustFrames();
        this.adjust.cases = f.cases;
        this.adjust.deaths = f.deaths;
        this.renderAdjust();
      }
      this.persist();
      this.note(this.adjust.enabled
        ? 'Underreporting adjustment enabled — floor/central/upper will overlay the chart on the next fit.'
        : 'Underreporting adjustment disabled.');
    });
    adjTarget.addEventListener('change', () => { this.adjust.asTarget = adjTarget.checked; this.persist(); });
    adjT0.addEventListener('change', () => {
      const v = Number(adjT0.value);
      this.adjust.t0 = adjT0.value.trim() === '' || !Number.isFinite(v) ? null : Math.round(v);
      this.persist();
    });
    this.renderAdjust();

    // Interventions editor.
    q<HTMLButtonElement>('[data-r0="itv-add"]').addEventListener('click', () => {
      const lastObs = this.observed.length ? Math.max(...this.observed.map((p) => p.day)) : 28;
      this.itvSeq++;
      this.interventions.push({
        id: `iv-${this.itvSeq}`,
        intervention: 'custom',
        label: `Intervention ${this.interventions.length + 1}`,
        enabled: true,
        transmissionReduction: 0.3,
        params: { uptake: 1, protection: 0.3, sourceControl: 0, mortalityReduction: 0 },
        // Sensible default: two keyframes ramping in over two weeks, then held.
        keyframes: [
          { tick: Math.round(lastObs / 2), params: { uptake: 1, protection: 0, sourceControl: 0, mortalityReduction: 0 } },
          { tick: Math.round(lastObs / 2) + 14, params: { uptake: 1, protection: 0.3, sourceControl: 0, mortalityReduction: 0 } },
        ],
      });
      const details = this.el?.querySelector<HTMLDetailsElement>('[data-r0="itv-details"]');
      if (details) details.open = true;
      this.notifyInterventions();
      this.renderInterventions();
    });
    this.renderInterventions();

    const kInput = q<HTMLInputElement>('[data-r0="k"]');
    const kLabel = q<HTMLElement>('[data-r0="k-label"]');
    kInput.value = String(this.K);
    kLabel.textContent = String(this.K);
    kInput.addEventListener('input', () => {
      this.K = Math.round(Number(kInput.value));
      kLabel.textContent = String(this.K);
    });
    kInput.addEventListener('change', () => this.persist());

    this.el!.querySelectorAll<HTMLButtonElement>('[data-loss]').forEach((btn) => {
      // Reflect the restored loss in the toggle's active state.
      btn.classList.toggle('active', btn.dataset['loss'] === this.loss);
      btn.addEventListener('click', () => {
        this.loss = btn.dataset['loss'] as LossType;
        this.el!.querySelectorAll<HTMLButtonElement>('[data-loss]').forEach((b) =>
          b.classList.toggle('active', b === btn));
        this.persist();
      });
    });

    // Optimizer toggle (local vs genetic) + show/hide the GA controls.
    this.el!.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.optimizer = btn.dataset['opt'] as OptimizerKind;
        this.syncOptimizerUI();
        this.persist();
      });
    });

    // GA numeric controls — bind each to its GASettings field.
    const gaFields: [keyof GASettings, number, number][] = [
      ['population', 8, 200], ['generations', 1, 100], ['mutationRate', 0, 1],
      ['crossoverRate', 0, 1], ['elitism', 0, 20], ['tournament', 2, 10],
    ];
    for (const [key, lo, hi] of gaFields) {
      const input = this.el!.querySelector<HTMLInputElement>(`[data-ga="${key}"]`);
      if (!input) continue;
      input.value = String(this.ga[key]);
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) {
          this.ga[key] = Math.min(hi, Math.max(lo, v));
          input.value = String(this.ga[key]);
          this.persist();
        }
      });
    }
    this.syncOptimizerUI();

    q<HTMLButtonElement>('[data-r0="run"]').addEventListener('click', () => this.run());
    q<HTMLButtonElement>('[data-r0="cancel"]').addEventListener('click', () => {
      // Order matters: set the abort flag FIRST so the pool's rejections are
      // swallowed into +Inf losses, then hard-kill the workers — terminate is
      // the only real cancel for a busy worker — and reject every pending sim
      // so no await hangs on a reply that will never arrive. cancelAll also
      // respawns a fresh pool, so the next Run fit works immediately.
      this.signal.aborted = true;
      this.pool?.cancelAll();
      this.note('Cancelling…');
    });
    q<HTMLButtonElement>('[data-r0="apply"]').addEventListener('click', () => {
      if (!this.result) return;
      const result = this.result;
      void (async () => {
        this.note('Selecting the representative trial seed…');
        const extras = await this.applyExtras(result);
        this.events.onApply(result.config, extras);
        this.close(); // dismiss so the user lands back on the running simulation
      })();
    });
  }

  /** Everything beyond the config that the live sim needs to reproduce the
   *  fitted curve: the exact R(t) schedule the winning candidate ran under
   *  (same builder + fitted index offset the fit used), its window spans for
   *  chart shading, the fitted mean curves for the live overlay, and the
   *  REPRESENTATIVE trial seed — the fit's mean averages K trials at derived
   *  seeds, so applying the base seed would hand the live sim a world the fit
   *  never simulated (it can fizzle at patient zero). Replaying the trial
   *  closest to the mean makes the live run track the fitted curve
   *  bit-exactly on the CPU/WASM engines. */
  private async applyExtras(result: FitResult): Promise<import('../types').FitApplyExtras> {
    const o = result.indexOffset ?? 0;
    const schedule = transmissionSchedule(this.interventions, result.days + 1, o) ?? null;
    let seed = result.config.seed;
    try {
      const r = await this.pool?.bestSeed(result.config, result.days, this.K, result.config.seed, schedule ?? undefined);
      if (r?.bestSeed !== undefined) seed = r.bestSeed;
    } catch { /* pool busy/cancelled — fall back to the base seed */ }
    return {
      schedule,
      windows: schedule ? this.itvWindows(o) : [],
      offset: o,
      days: result.days,
      seed,
      overlay: result.simulated ?? null,
    };
  }

  // ── Observed-data table ──
  private renderTable(): void {
    const tbody = this.el!.querySelector<HTMLElement>('[data-r0="rows"]')!;
    tbody.innerHTML = '';
    this.observed.forEach((pt, idx) => {
      const row = document.createElement('div');
      row.className = 'r0-row';
      row.innerHTML = `
        <input class="r0-in" type="number" step="any" value="${pt.day}" data-col="day" aria-label="Day" />
        <input class="r0-in" type="number" step="any" value="${pt.value}" data-col="value" aria-label="Value" />
        <select class="r0-in" data-col="category" aria-label="Category">
          ${FIT_CATEGORIES.map((c) => `<option value="${c}"${c === pt.category ? ' selected' : ''}>${CATEGORY_LABELS[c]}</option>`).join('')}
        </select>
        <button class="r0-del" type="button" aria-label="Delete row" title="Delete">${icon('delete')}</button>
      `;
      row.querySelector<HTMLInputElement>('[data-col="day"]')!.addEventListener('change', (e) => {
        pt.day = Number((e.target as HTMLInputElement).value);
        this.persist();
      });
      row.querySelector<HTMLInputElement>('[data-col="value"]')!.addEventListener('change', (e) => {
        pt.value = Number((e.target as HTMLInputElement).value);
        this.persist();
      });
      row.querySelector<HTMLSelectElement>('[data-col="category"]')!.addEventListener('change', (e) => {
        pt.category = (e.target as HTMLSelectElement).value as FitCategory;
        this.persist();
      });
      row.querySelector<HTMLButtonElement>('.r0-del')!.addEventListener('click', () => {
        this.observed.splice(idx, 1);
        this.renderTable();
        this.persist();
      });
      tbody.appendChild(row);
    });
    const count = this.el!.querySelector<HTMLElement>('[data-r0="row-count"]');
    if (count) count.textContent = `${this.observed.length} point${this.observed.length === 1 ? '' : 's'}`;
    this.fillPasteBox();
  }

  /** Mirror the current dataset into the Paste CSV box so the user can see and copy
   *  the expected `day,value,category` format. Skipped while the box is focused so
   *  we never clobber what they're actively typing/pasting. */
  private fillPasteBox(): void {
    const ta = this.el?.querySelector<HTMLTextAreaElement>('[data-r0="paste"]');
    if (!ta || document.activeElement === ta) return;
    const header = 'day,value,category';
    const rows = this.observed.map((p) => `${p.day},${p.value},${p.category}`);
    // Header makes the columns self-evident; the parser skips it (non-numeric row).
    ta.value = [header, ...rows].join('\n');
  }

  // ── Parameter checkboxes + bounds ──
  private renderParams(): void {
    const host = this.el!.querySelector<HTMLElement>('[data-r0="params"]')!;
    host.innerHTML = '';
    for (const p of FIT_PARAMS) {
      const b = this.bounds.get(p.name)!;
      // Percent-display params (attack rate, IFR) edit as % in the UI while their
      // stored bounds stay fractions — toView/fromView bridge the two.
      const pct = p.display === 'percent';
      const toView = (v: number) => (pct ? Number((v * 100).toFixed(4)) : v);
      const fromView = (v: number) => (pct ? v / 100 : v);
      // Wrap each input with its (optional) % so the suffix hugs its number and
      // the two bound cells stay aligned across percent and non-percent rows.
      const suffix = pct ? '<span class="r0-param-suffix">%</span>' : '';
      const wrap = document.createElement('label');
      wrap.className = 'r0-param';
      wrap.innerHTML = `
        <input type="checkbox" ${this.selected.has(p.name) ? 'checked' : ''} />
        <span class="r0-param-name">${p.label}</span>
        <span class="r0-param-bounds">
          <span class="r0-bound"><input class="r0-in tiny" type="number" step="any" value="${toView(b[0])}" aria-label="${p.label} lower bound" />${suffix}</span>
          <span class="r0-sep">–</span>
          <span class="r0-bound"><input class="r0-in tiny" type="number" step="any" value="${toView(b[1])}" aria-label="${p.label} upper bound" />${suffix}</span>
        </span>
      `;
      const cb = wrap.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      const bounds = wrap.querySelectorAll<HTMLInputElement>('.r0-param-bounds input');
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(p.name);
        else this.selected.delete(p.name);
        this.persist();
      });
      bounds[0].addEventListener('change', () => { b[0] = fromView(Number(bounds[0].value)); this.persist(); });
      bounds[1].addEventListener('change', () => { b[1] = fromView(Number(bounds[1].value)); this.persist(); });
      host.appendChild(wrap);
    }
  }

  /** Active interventions' ramp windows (first → last intensity keyframe) in
   *  chart-day coordinates (data day + the given offset shift). */
  // Interventions persist indefinitely: a span extends to the chart's right
  // edge (Infinity, clamped when painting) unless the end state is keyframed
  // down to zero effect (see interventionWindows in lib/fit).
  private itvWindows(offset: number): { from: number; to: number; label: string }[] {
    return interventionWindows(this.interventions, offset);
  }

  /** Interventions editor. Card layout: header (enable / name / taxonomy /
   *  remove) → the param sliders (the intervention's BASE values, used when no
   *  keyframes exist) → the KEYFRAME section at the bottom. A keyframe is a
   *  DAY plus a full param snapshot: each row shows its day input and expands
   *  (row click) into that keyframe's own param sliders — the same sliders as
   *  the top of the card — then collapses. Params interpolate linearly between
   *  keyframe days and are HELD outside the first/last. No extra knobs. */
  private renderInterventions(): void {
    const host = this.el?.querySelector<HTMLElement>('[data-r0="itv-list"]');
    const count = this.el?.querySelector<HTMLElement>('[data-r0="itv-count"]');
    if (!host) return;
    if (count) {
      const on = this.interventions.filter((iv) => iv.enabled).length;
      count.textContent = this.interventions.length === 0
        ? 'none'
        : `${on} of ${this.interventions.length} active`;
    }
    host.innerHTML = '';
    if (this.interventions.length === 0) {
      host.innerHTML = '<p class="r0-history-empty">No interventions — the model transmits at full strength for the whole run. The Ebola presets load real-2014-response defaults.</p>';
      return;
    }
    this.interventions.forEach((iv, idx) => {
      if (!iv.params) this.seedParams(iv);
      const card = document.createElement('div');
      card.className = 'r0-itv';
      card.innerHTML = `
        <div class="r0-itv-head">
          <label class="r0-check" title="Include this intervention in the fit's transmission schedule.">
            <input type="checkbox" data-iv="on" ${iv.enabled ? 'checked' : ''} />
          </label>
          <input class="r0-in r0-itv-name" type="text" value="${iv.label.replace(/"/g, '&quot;')}" data-iv="label" aria-label="Intervention name" />
          <select class="r0-in" data-iv="tax" title="The live sim's intervention taxonomy — selecting a type seeds the SAME rich controls the main sim uses (from the current sim config); main-sim toggles of this key sync the enabled state.">
            ${['custom', 'mask', 'vaccine', 'lockdown', 'quarantine']
              .map((k) => `<option value="${k}"${iv.intervention === k ? ' selected' : ''}>${k}</option>`).join('')}
          </select>
          <button class="r0-del" type="button" aria-label="Remove intervention" title="Remove">${icon('delete')}</button>
        </div>
        <div class="r0-itv-kf" data-iv="kf">
          <div class="r0-itv-kf-head">
            <span class="r0-history-group" title="A keyframe is a day plus this intervention's full param values on that day. Click a row to expand its sliders. Params interpolate linearly between keyframe days and HOLD outside the first/last — interventions persist into the prediction horizon unless keyframed to 0.">⏱ Keyframes</span>
            <span class="r0-itv-eff r0-muted" data-iv="eff" title="Derived max transmission reduction at the timeline's end state — what the model applies: R(t) = R0 × (1 − effectiveReduction(paramsAt(t)))."></span>
          </div>
          <div data-iv="kf-list"></div>
          <button class="btn ghost" type="button" data-iv="kf-add">+ Add keyframe</button>
        </div>
      `;
      const persist = (): void => { this.notifyInterventions(); };
      const effBadge = card.querySelector<HTMLElement>('[data-iv="eff"]')!;
      const refreshEff = (): void => {
        effBadge.textContent = `−${Math.round(effectiveReductionAt(iv, Number.MAX_SAFE_INTEGER) * 100)}% transmission (end state)`;
      };
      refreshEff();
      card.querySelector<HTMLInputElement>('[data-iv="on"]')!.addEventListener('change', (e) => {
        iv.enabled = (e.target as HTMLInputElement).checked;
        persist();
        this.renderInterventions();
      });
      card.querySelector<HTMLInputElement>('[data-iv="label"]')!.addEventListener('change', (e) => {
        iv.label = (e.target as HTMLInputElement).value || 'Intervention';
        persist();
      });
      card.querySelector<HTMLSelectElement>('[data-iv="tax"]')!.addEventListener('change', (e) => {
        iv.intervention = (e.target as HTMLSelectElement).value as InterventionSpec['intervention'];
        this.seedParams(iv);
        // The param fields changed shape — restart the timeline from one
        // seeded keyframe at the old first day.
        const firstTick = iv.keyframes?.[0]?.tick ?? 0;
        iv.keyframes = [{ tick: firstTick, transmissionReduction: iv.transmissionReduction, params: { ...(iv.params ?? {}) } }];
        persist();
        this.renderInterventions();
      });
      card.querySelector<HTMLButtonElement>('.r0-itv-head .r0-del')!.addEventListener('click', () => {
        this.interventions.splice(idx, 1);
        persist();
        this.renderInterventions();
      });

      // ── Keyframes — a day row each, expanding to ITS param sliders. The
      // sliders live ONLY inside keyframes: an intervention without any gets
      // one default keyframe at day 0 seeded from its base params (constant
      // behavior — specAtDay with a single keyframe holds it everywhere). ──
      const kfList = card.querySelector<HTMLElement>('[data-iv="kf-list"]')!;
      if (!iv.keyframes || iv.keyframes.length === 0) {
        iv.keyframes = [{ tick: 0, transmissionReduction: iv.transmissionReduction, params: { ...(iv.params ?? {}) } }];
      }
      const kfs = iv.keyframes.sort((a, b) => a.tick - b.tick);
      kfs.forEach((kf, ki) => {
        const row = document.createElement('div');
        row.className = 'r0-kf-row';
        row.innerHTML = `
          <div class="r0-kf-row-head" role="button" tabindex="0" aria-label="Toggle keyframe ${ki + 1} sliders">
            <button class="r0-kf-caret" type="button" aria-label="Expand or collapse this keyframe">${icon('caretRight')}</button>
            <label>day <input class="r0-in tiny" type="number" step="1" value="${kf.tick}" data-kf="day" aria-label="Keyframe day" /></label>
            <button class="r0-del" type="button" aria-label="Delete keyframe" ${kfs.length <= 1 ? 'disabled' : ''}>${icon('delete')}</button>
          </div>
          <div class="r0-kf-body" hidden></div>
        `;
        const head = row.querySelector<HTMLElement>('.r0-kf-row-head')!;
        const body = row.querySelector<HTMLElement>('.r0-kf-body')!;
        const caret = row.querySelector<HTMLElement>('.r0-kf-caret')!;
        const toggle = (): void => {
          body.hidden = !body.hidden;
          caret.innerHTML = body.hidden ? icon('caretRight') : icon('caretDown');
          if (!body.hidden && body.childElementCount === 0) {
            // This keyframe's OWN sliders — same set as the top of the card.
            this.renderParamSliders(body, iv, {
              idSuffix: `kf${ki}`,
              getTr: () => kf.transmissionReduction ?? iv.transmissionReduction,
              setTr: (v) => { kf.transmissionReduction = v; },
              getP: (f) => (kf.params[f] as number | undefined) ?? (iv.params?.[f] as number | undefined),
              setP: (f, v) => { kf.params[f] = v; },
              onEdit: () => { refreshEff(); persist(); },
            });
          }
        };
        head.addEventListener('click', (ev) => {
          const t = ev.target as HTMLElement;
          // The chevron button always toggles; the day input and the delete
          // button never do; anywhere else on the row toggles too.
          if (t.closest('.r0-kf-caret')) { toggle(); return; }
          if (t.closest('input') || t.closest('button')) return;
          toggle();
        });
        head.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
        });
        row.querySelector<HTMLInputElement>('[data-kf="day"]')!.addEventListener('change', (e) => {
          kf.tick = Math.round(Number((e.target as HTMLInputElement).value)) || 0;
          refreshEff();
          persist();
        });
        row.querySelector<HTMLButtonElement>('.r0-kf-row-head .r0-del')!.addEventListener('click', () => {
          kfs.splice(ki, 1);
          refreshEff();
          persist();
          this.renderInterventions();
        });
        kfList.appendChild(row);
      });
      card.querySelector<HTMLButtonElement>('[data-iv="kf-add"]')!.addEventListener('click', () => {
        const last = kfs[kfs.length - 1];
        iv.keyframes!.push({
          tick: (last?.tick ?? 0) + 14,
          transmissionReduction: last?.transmissionReduction,
          params: { ...(last?.params ?? iv.params ?? {}) },
        });
        persist();
        this.renderInterventions();
      });
      host.appendChild(card);
    });
  }

  /** The per-type param sliders — one shared renderer for the card's base
   *  values AND each keyframe's snapshot (the SAME sliders both places). */
  private renderParamSliders(
    host: HTMLElement,
    iv: InterventionSpec,
    io: {
      idSuffix: string;
      getTr: () => number;
      setTr: (v: number) => void;
      getP: (f: Exclude<InterventionParamName, 'transmissionReduction'>) => number | undefined;
      setP: (f: Exclude<InterventionParamName, 'transmissionReduction'>, v: number) => void;
      onEdit: () => void;
    },
  ): void {
    const pctSlider = (f: InterventionParamName, label: string, hint?: string): void => {
      host.appendChild(new Slider({
        id: `r0-${iv.id}-${io.idSuffix}-${f}`, label, min: 0, max: 100, step: 1, unit: '%',
        value: Math.round(((f === 'transmissionReduction' ? io.getTr() : io.getP(f as Exclude<InterventionParamName, 'transmissionReduction'>)) ?? 0) * 100),
        hint,
        onChange: (v) => {
          const frac = Math.min(1, Math.max(0, v / 100));
          if (f === 'transmissionReduction') io.setTr(Math.min(0.95, frac));
          else io.setP(f as Exclude<InterventionParamName, 'transmissionReduction'>, frac);
          io.onEdit();
        },
      }).el);
    };
    const rawSlider = (f: InterventionParamName, label: string, min: number, max: number, unit: 'days' | 'tiles', fallback: number, hint?: string): void => {
      host.appendChild(new Slider({
        id: `r0-${iv.id}-${io.idSuffix}-${f}`, label, min, max, step: 1, unit,
        value: io.getP(f as Exclude<InterventionParamName, 'transmissionReduction'>) ?? fallback,
        hint,
        onChange: (v) => { io.setP(f as Exclude<InterventionParamName, 'transmissionReduction'>, v); io.onEdit(); },
      }).el);
    };
    if (iv.intervention === 'lockdown') {
      pctSlider('mobilityReduction', 'Mobility reduction', 'Probabilistically skips neighbor visits for compliant cells.');
      pctSlider('transmissionReduction', 'Transmission reduction', 'Global multiplicative reduction on transmission.');
      pctSlider('compliance', 'Compliance', 'Per-cell adherence to the lockdown.');
    } else if (iv.intervention === 'quarantine') {
      pctSlider('detectionRate', 'Detection rate', 'Per-tick probability an infectious cell is detected.');
      rawSlider('contactsRange', 'Close-contacts range', 1, 5, 'tiles', 1, 'Radius of contacts isolated with a detected case (live-sim spatial dynamics; not in the fitted rate).');
      pctSlider('protection', 'Protection', 'Reduces transmission INTO quarantined cells.');
      pctSlider('sourceControl', 'Source control', 'Reduces transmission FROM quarantined cells.');
      rawSlider('duration', 'Duration', 1, 60, 'days', 14, 'Quarantine persistence (live-sim dynamics; not in the fitted rate).');
    } else {
      // mask / vaccine / custom — the canonical defense quartet.
      pctSlider('uptake', 'Rate', 'Population uptake — same control as the main sim.');
      pctSlider('protection', 'Protection', 'Reduces incoming attack success against the wearer.');
      pctSlider('sourceControl', 'Source control', 'Reduces outgoing attack success from the wearer.');
      pctSlider('mortalityReduction', 'Mortality reduction', 'Reduces IFR if infected — deaths in the live sim; not part of the fitted R(t).');
    }
  }

  /** Seed the rich per-type params from the CURRENT live sim config — true
   *  crossover: a new mask intervention starts at the main sim's mask sliders. */
  private seedParams(iv: InterventionSpec): void {
    const cfg = this.events.getConfig();
    switch (iv.intervention) {
      case 'mask':
      case 'vaccine': {
        const d = cfg.defenses.find((x) => x.id === iv.intervention);
        iv.params = {
          uptake: d?.uptake ?? 0.5,
          protection: d?.protection ?? 0.3,
          sourceControl: d?.sourceControl ?? 0.5,
          mortalityReduction: d?.mortalityReduction ?? 0,
        };
        break;
      }
      case 'lockdown':
        iv.params = { mobilityReduction: cfg.lockdown.mobilityReduction, compliance: cfg.lockdown.compliance };
        if (cfg.lockdown.transmissionReduction > 0) iv.transmissionReduction = cfg.lockdown.transmissionReduction;
        break;
      case 'quarantine':
        iv.params = {
          detectionRate: cfg.quarantine.detectionRate,
          contactsRange: cfg.quarantine.contactsRange,
          protection: cfg.quarantine.protection,
          sourceControl: cfg.quarantine.sourceControl,
          duration: cfg.quarantine.duration,
        };
        break;
      default: {
        // Custom shares the canonical defense schema. Map any existing flat
        // strength LOSSLESSLY: uptake 1, protection = strength, sourceControl 0
        // ⇒ eff = protection; a transmissionReduction keyframe track carries
        // over verbatim as a protection track (identical schedules).
        iv.params = {
          uptake: 1,
          protection: Math.min(0.95, Math.max(0, iv.transmissionReduction)),
          sourceControl: 0,
          mortalityReduction: 0,
        };
      }
    }
  }

  /** Keyframe editor for the underreporting multipliers: per category, one row
   *  per keyframe (day + multiplier ≥ 1, so floor ≤ central ≤ upper always
   *  holds), add/remove, any day allowed including outside the data bounds.
   *  Edits materialize onto this.adjust so they persist. */
  private renderAdjust(): void {
    const host = this.el?.querySelector<HTMLElement>('[data-r0="adjust-frames"]');
    if (!host) return;
    host.innerHTML = '';
    const defaults = this.adjustFrames();
    const groups: ['cases' | 'deaths', string][] = [['cases', 'Cases (infections) ×'], ['deaths', 'Deaths ×']];
    for (const [key, label] of groups) {
      const frames = (this.adjust[key] ?? defaults[key]).slice().sort((a, b) => a.day - b.day);
      const block = document.createElement('div');
      block.className = 'r0-adjust-block';
      const title = document.createElement('div');
      title.className = 'r0-history-group';
      title.textContent = label;
      block.appendChild(title);
      const write = (): void => { this.adjust[key] = frames; this.persist(); };
      frames.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'r0-adjust-row';
        row.innerHTML = `
          <label>day <input class="r0-in tiny" type="number" step="1" value="${f.day}" data-kf="day" aria-label="${label} keyframe day" /></label>
          <label>× <input class="r0-in tiny" type="number" step="0.1" min="1" value="${f.m}" data-kf="m" aria-label="${label} keyframe multiplier" /></label>
          <button class="r0-del" type="button" aria-label="Delete keyframe" ${frames.length <= 1 ? 'disabled' : ''}>${icon('delete')}</button>
        `;
        row.querySelector<HTMLInputElement>('[data-kf="day"]')!.addEventListener('change', (e) => {
          f.day = Math.round(Number((e.target as HTMLInputElement).value)) || 0;
          write();
        });
        row.querySelector<HTMLInputElement>('[data-kf="m"]')!.addEventListener('change', (e) => {
          f.m = Math.max(1, Number((e.target as HTMLInputElement).value) || 1);
          (e.target as HTMLInputElement).value = String(f.m);
          write();
        });
        row.querySelector<HTMLButtonElement>('.r0-del')!.addEventListener('click', () => {
          frames.splice(i, 1);
          write();
          this.renderAdjust();
        });
        block.appendChild(row);
      });
      const add = document.createElement('button');
      add.className = 'btn ghost';
      add.type = 'button';
      add.textContent = '+ keyframe';
      add.addEventListener('click', () => {
        const last = frames[frames.length - 1];
        frames.push({ day: (last?.day ?? 0) + 14, m: last?.m ?? 1.5 });
        write();
        this.renderAdjust();
      });
      block.appendChild(add);
      host.appendChild(block);
    }
  }

  /** The adjustment keyframes in raw data-day coordinates — the user's frames
   *  when set, otherwise the pseudocode defaults anchored at t0 (first data day
   *  unless overridden): cases 5.0 → 3.8 and deaths 3.0 → 2.5 over a 6-week ramp. */
  private adjustFrames(): { cases: Keyframe[]; deaths: Keyframe[]; t0: number } {
    const days = this.observed.filter((p) => Number.isFinite(p.day)).map((p) => p.day);
    const first = days.length ? Math.min(...days) : 0;
    const t0 = this.adjust.t0 ?? first;
    const mk = (key: 'cases' | 'deaths'): Keyframe[] =>
      this.adjust[key]?.length
        ? this.adjust[key]!.map((f) => ({ ...f }))
        : [{ day: t0, m: ADJ_DEFAULTS[key][0] }, { day: t0 + RAMP_DAYS, m: ADJ_DEFAULTS[key][1] }];
    return { cases: mk('cases'), deaths: mk('deaths'), t0 };
  }

  /** The dataset the loss actually sees. Pipeline (raw day coords, then the
   *  index-offset shift is applied to every output series):
   *    finite points → revision envelope (when downward revisions + toggle on)
   *    → keyframe/vintaged adjustment (when enabled; central replaces the
   *      target only in fit-target mode).
   *  `raw` = pre-cleaning points for the greyed overlay; `adjustBands` =
   *  floor/central/upper for the envelope overlay. Shared by run() and the
   *  history grouping. */
  private effectiveObserved(): {
    observed: ObservedPoint[];
    raw: ObservedPoint[] | null;
    adjustBands: { floor: ObservedPoint[]; central: ObservedPoint[]; upper: ObservedPoint[] } | null;
  } {
    // When the index date is evolved, the optimizer applies the shift itself —
    // the manual offset only pre-shifts in fixed mode.
    const off = this.offsetEvolve ? 0 : (this.indexOffset || 0);
    const finite = this.observed
      .filter((p) => Number.isFinite(p.day) && Number.isFinite(p.value))
      .map((p) => ({ ...p }));
    const revise = this.honorRevisions && hasDownwardRevisions(finite);
    const cleaned = revise ? revisionEnvelope(finite) : finite;

    let observed = cleaned;
    let bands: { floor: ObservedPoint[]; central: ObservedPoint[]; upper: ObservedPoint[] } | null = null;
    if (this.adjust.enabled) {
      const { cases, deaths, t0 } = this.adjustFrames();
      const { upper, central } = vintagedAdjust(
        cleaned,
        { cumulative_infections: cases, cumulative_deaths: deaths },
        t0,
      );
      bands = { floor: cleaned, central, upper };
      if (this.adjust.asTarget) observed = central;
    }

    const shift = (pts: ObservedPoint[]): ObservedPoint[] =>
      off ? pts.map((p) => ({ ...p, day: p.day + off })) : pts;
    return {
      observed: shift(observed),
      raw: revise ? shift(finite) : null,
      adjustBands: bands
        ? { floor: shift(bands.floor), central: shift(bands.central), upper: shift(bands.upper) }
        : null,
    };
  }

  // ── Run the fit ──
  private async run(): Promise<void> {
    if (this.running || !this.pool) return;
    if (this.observed.length < 2) { this.note('Add at least two observed points.'); return; }

    // The effective dataset: day-shifted by the index-case offset and, when the
    // data carries downward revisions (and the toggle is on), cleaned to the
    // running-min envelope. `raw` keeps the pre-cleaning points for the greyed
    // chart overlay; null when cleaning changed nothing.
    const { observed, raw, adjustBands } = this.effectiveObserved();
    // Curve timing (incubation, infectious) is what fits the rise + peak shape; if
    // the data clearly spans a peak/plateau and the user hasn't enabled those genes,
    // add them so R² isn't capped by attack-rate + range alone.
    const expanded = this.autoExpandShapeParams(observed);
    const params = this.activeParams();
    if (params.length === 0) { this.note('Select at least one parameter to fit.'); return; }

    this.running = true;
    this.signal = { aborted: false };
    this.setRunning(true);
    const bar = this.el!.querySelector<HTMLElement>('[data-r0="progress-fill"]')!;
    bar.style.width = '0%';

    this.lastRaw = raw;
    this.lastAdjust = adjustBands;
    this.lastFan = null; // computed after the fit lands
    this.lastEnsemble = null; // ditto — post-fit density layer
    this.liveOffsetBand = null;
    this.liveDotShift = 0;
    // Intervention windows in the LIVE chart's day coordinates (raw data days
    // while the offset is evolving; manual-shifted otherwise).
    this.liveItvWindows = this.itvWindows(this.offsetEvolve ? 0 : (this.indexOffset || 0));
    this.renderLive(observed, raw); // persistent chart + provisional metrics, updated live
    if (expanded) this.note('Timing params added (your data spans the peak) — fitting…');

    // Size the fit grid so one cell (population/size²) never exceeds the smallest
    // positive observed value — otherwise the model's day-0 index case alone
    // dwarfs the data and every curve is a giant staircase the loss can't fix.
    const base = this.fitBaseConfig();
    const liveSize = this.events.getConfig().size;
    const positives = observed.map((p) => p.value).filter((v) => v > 0);
    const minObs = positives.length ? Math.min(...positives) : Number.NaN;
    base.size = resolutionFitSize(liveSize, this.population, minObs, FIT_GRID_CAP);
    const cellPeople = this.population / (base.size * base.size);

    const warnings: string[] = [];
    if (raw) warnings.push('downward revisions detected — fitting the cleaned (running-min) series; raw points shown greyed');
    if (this.adjust.enabled) {
      warnings.push(this.adjust.asTarget
        ? 'underreporting adjustment ON — fitting the adjusted central estimate (floor/upper shown as envelope)'
        : 'underreporting adjustment shown as overlay only (fit targets the reported counts)');
    }
    if (base.size > liveSize) {
      warnings.push(`fit runs at ${base.size}×${base.size} for data resolution — Apply adopts that grid so the curve reproduces`);
    }
    if (liveSize > FIT_GRID_CAP) {
      warnings.push(`fitting on a ${FIT_GRID_CAP}×${FIT_GRID_CAP} grid for speed — Apply switches the live grid to it (outbreak timing is size-dependent)`);
    }
    if (this.interventions.some((iv) => iv.enabled && iv.transmissionReduction > 0)) {
      warnings.push('interventions active — modeled as time-varying transmission R(t); Apply to simulation replays the same schedule (shaded on the live chart)');
    }
    if (Number.isFinite(minObs) && cellPeople > minObs) {
      warnings.push(`one grid cell = ${fmtNum(cellPeople)} people — larger than your smallest data point (${fmtNum(minObs)}); raise grid size or lower Population`);
    }
    if (warnings.length) this.note(`⚠ ${warnings.join(' · ')}`);
    try {
      const result = await runFit({
        observed,
        baseConfig: base,
        params,
        population: this.population,
        K: this.K,
        loss: this.loss,
        offset: this.offsetEvolve ? { bounds: [...this.offsetBounds] as [number, number] } : undefined,
        extraDays: this.predictionDays,
        posterior: this.bayesDraws > 1 ? { draws: this.bayesDraws } : undefined,
        interventions: this.interventions,
        optimizer: this.optimizer,
        gaPopulation: this.ga.population,
        gaGenerations: this.ga.generations,
        gaMutationRate: this.ga.mutationRate,
        gaCrossoverRate: this.ga.crossoverRate,
        gaElitism: this.ga.elitism,
        gaTournament: this.ga.tournament,
        simulate: (cfg, days, K, seed, schedule) => this.pool!.simulate(cfg, days, K, seed, schedule),
        signal: this.signal,
        onProgress: (frac) => {
          const pct = Math.round(frac * 100);
          bar.style.width = `${pct}%`;
          const pctEl = this.el?.querySelector<HTMLElement>('[data-r0="progress-pct"]');
          if (pctEl) pctEl.textContent = `${pct}%`;
        },
        onImprove: (p) => this.onImprove(p),
      });
      if (this.signal.aborted) { this.note('Fit cancelled.'); }
      else {
        // The fit runs on a smaller grid for speed. For voronoi, R₀ scales with
        // the grid's node degree, so the reported R₀ would not match the value
        // the live sim shows after Apply. Recompute it on the user's real grid.
        this.note('Refining R₀ for your grid…');
        this.result = await this.reconcileR0(result);
        // Evolved index date: write the fitted offset back into the (single)
        // indexOffset field, re-anchor the transient overlays to the shifted
        // days, and stage the profile-CI marker for the chart.
        if (this.result.indexOffset != null) {
          const o = this.result.indexOffset;
          this.indexOffset = o;
          const oi = this.el?.querySelector<HTMLInputElement>('[data-r0="offset"]');
          if (oi) oi.value = String(o);
          const sh = (pts: ObservedPoint[]): ObservedPoint[] => pts.map((p) => ({ ...p, day: p.day + o }));
          if (this.lastRaw) this.lastRaw = sh(this.lastRaw);
          if (this.lastAdjust) {
            this.lastAdjust = {
              floor: sh(this.lastAdjust.floor),
              central: sh(this.lastAdjust.central),
              upper: sh(this.lastAdjust.upper),
            };
          }
          // Re-anchor the intervention windows to the fitted offset.
          this.liveItvWindows = this.itvWindows(o);
          const ci = this.result.offsetCI;
          if (ci) {
            const firstRaw = Math.min(...this.result.observed.map((p) => p.day)) - o;
            this.liveOffsetBand = {
              lo95: firstRaw + ci.ci95[0],
              hi95: firstRaw + ci.ci95[1],
              lo68: firstRaw + ci.ci68[0],
              hi68: firstRaw + ci.ci68[1],
              at: firstRaw + o,
            };
          }
        }
        // FINAL band = the Bayesian posterior-predictive band computed inside
        // runFit (seeded Metropolis, LOW/CENTRAL/HIGH = 5/50/95 across draws).
        // The old index-case ensemble percentiles are no longer displayed —
        // they were uncalibrated; the ensemble machinery remains in the lib.
        this.lastFan = this.result.bayes ?? null;
        // Record the fit in the history, keyed by the effective dataset it ran
        // against, so the table only ranks like-for-like.
        this.history.unshift({
          t: Date.now(),
          hash: datasetHash(observed, this.population),
          presetId: this.presetId,
          // The Bayesian band is bulky and transient — recompute by re-running.
          result: { ...this.result, bayes: undefined },
        });
        if (this.history.length > HISTORY_CAP) this.history.length = HISTORY_CAP;
        this.persist();
        this.renderOutput();
        this.renderHistory();
        const doneNote = warnings.length ? `Fit complete. ⚠ ${warnings.join(' · ')}` : 'Fit complete.';
        this.note(doneNote);
        // Post-fit density layer — async; repaints the chart when it lands.
        void this.computeEnsemble(this.result, doneNote);
      }
    } catch (err) {
      this.note(`Fit failed: ${(err as Error).message}`);
    } finally {
      if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
      this.pendingSnapshot = null;
      this.running = false;
      this.setRunning(false);
    }
  }

  /** Post-fit index-case ensemble: the WINNING config re-simulated N times,
   *  each trial seeding the outbreak at a DIFFERENT board cell (deterministic
   *  sample of index-case locations), under the same fitted R(t) schedule.
   *  Per-day percentiles across trials shade the final chart as a density —
   *  PREDICTIVE spread (stochastic path + starting cell), the honest sibling
   *  of the Bayes band's parameter uncertainty. Async and abort-safe: paints
   *  when ready, never blocks renderOutput. */
  private async computeEnsemble(result: FitResult, doneNote: string): Promise<void> {
    if (!this.pool || this.ensembleTrials < 2) return;
    const sig = this.signal;
    const N = this.ensembleTrials;
    this.note(`${doneNote} · simulating index-case ensemble (${N} trials)…`);
    try {
      const schedule = transmissionSchedule(this.interventions, result.days + 1, result.indexOffset ?? 0);
      const sim = await this.pool.simulateEnsemble(result.config, result.days, N, result.config.seed, schedule);
      // Stale guards: cancelled, modal closed, or a newer result landed.
      if (sig.aborted || !this.el || this.result !== result) return;
      if (!sim.perTrial?.length) { this.note(doneNote); return; }
      this.lastEnsemble = percentileBands(sim.perTrial, ENSEMBLE_PROBS);
      this.renderOutput();
      this.note(`${doneNote} · density = ${N}-trial index-case ensemble (predictive spread); saturated band = Bayes parameter uncertainty.`);
    } catch {
      // Pool cancelled/respawned mid-flight — leave the chart without the layer.
    }
  }

  /** Recompute the headline R₀ (and CI) on the user's *actual* grid so it matches
   *  what the live sim shows after Apply. Only voronoi is grid-size-dependent
   *  (lattice/mean-field R₀ is size-independent), so we skip the extra sim
   *  otherwise. R₀ = reachable-degree(grid) × infection-probability(genes); only
   *  the grid factor changes, so scaling the CI by liveR₀/fitR₀ is exact for the
   *  attack-rate axis and a good approximation when range is also profiled. */
  private async reconcileR0(result: FitResult): Promise<FitResult> {
    if (!this.pool || result.r0 == null || result.r0 === 0) return result;
    const live = structuredClone(this.events.getConfig());
    if ((live.geometry ?? 'square') !== 'voronoi') return result;
    if (live.size === result.config.size) return result;

    // Same intervention-free baseline the fit uses (R₀ is the basic, no-control
    // number), but at the live grid size + topology, with the fitted genes.
    live.strain = { ...live.strain, ...result.config.strain };
    live.mutate = false;
    live.defenses = live.defenses.map((d) => ({ ...d, enabled: false }));
    live.lockdown = { ...live.lockdown, enabled: false };
    live.quarantine = { ...live.quarantine, enabled: false };
    try {
      const { rNaught } = await this.pool.simulate(live, 1, 1, live.seed);
      if (rNaught == null) return result;
      const factor = rNaught / result.r0;
      return {
        ...result,
        r0: rNaught,
        r0CI: result.r0CI ? [result.r0CI[0] * factor, result.r0CI[1] * factor] : null,
      };
    } catch {
      return result; // fall back to the fit-grid R₀ rather than failing the run
    }
  }

  /** Throttled live redraw: coalesce a burst of optimizer improvements into one
   *  setData per animation frame so the overlay animates smoothly. */
  private onImprove(p: FitProgress): void {
    this.pendingSnapshot = p;
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      const s = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (!s) return;
      // Offset-evolving fit: slide the DATA DOTS to the candidate's index-date
      // offset (the model stays anchored at sim day 0, fully visible), move
      // the intervention windows with them (they're keyframed in data days),
      // and mark where the evolving index date currently sits.
      if (this.offsetEvolve) {
        const off = s.indexOffset ?? 0;
        if (off !== this.liveDotShift) this.liveItvWindows = this.itvWindows(off);
        this.liveDotShift = off;
        this.liveIndexMarker = off;
      }
      this.updateChartData(s.curves);
      const r0El = this.el?.querySelector<HTMLElement>('[data-r0="live-r0"]');
      if (r0El) r0El.textContent = `R₀ = ${s.r0 == null ? '—' : s.r0.toFixed(2)}`;
      const lossEl = this.el?.querySelector<HTMLElement>('[data-r0="live-loss"]');
      // '~' marks provisional (low-fidelity screening) frames — they animate the
      // search but their losses are noisier than full-fidelity ones.
      if (lossEl) lossEl.textContent = `${s.provisional ? '~' : ''}${fmtLoss(s.loss)}`;
      const subEl = this.el?.querySelector<HTMLElement>('[data-r0="live-sub"]');
      if (subEl) subEl.textContent = s.provisional ? 'screening (low fidelity)' : 'best full-fidelity fit';
    });
  }

  /** The config the fit perturbs: current sim genes/geometry, but with
   *  mutation off (stable gene interpretation), interventions off, and a grid
   *  large enough for statistical resolution without making each trial too slow.
   *  Interventions are disabled so the recovered genes and the analytic R₀
   *  (which assumes a fully susceptible, intervention-free neighbourhood) are
   *  mutually consistent — R₀ is conventionally the intervention-free number. */
  private fitBaseConfig(): SimConfig {
    const cfg = structuredClone(this.events.getConfig());
    cfg.mutate = false;
    // Fit at the live grid size (capped for performance) so the fitted curve reproduces
    // in the live sim — the spatial wave makes per-capita dynamics size-dependent.
    // run() may RAISE this above the live size for data resolution (one cell =
    // population/size² people must not exceed the smallest observed value) — see
    // resolutionFitSize; it warns that Apply then needs a larger live grid.
    cfg.size = Math.min(cfg.size, FIT_GRID_CAP);
    // Single index case (patient-zero only) — the most realistic outbreak start, and
    // the seeding the live sim uses by default. Anything else would shift the curve.
    cfg.seedInfections = 0;
    cfg.defenses = cfg.defenses.map((d) => ({ ...d, enabled: false }));
    cfg.lockdown = { ...cfg.lockdown, enabled: false };
    cfg.quarantine = { ...cfg.quarantine, enabled: false };
    return cfg;
  }

  /** Base config for the demo: the live disease with interventions off, but
   *  attackRate + range overridden to the planted demo values. Only those two
   *  params differ from the fit baseline, so the default 2-param fit recovers
   *  them exactly. */
  private demoConfig(): SimConfig {
    const cfg = this.fitBaseConfig();
    cfg.strain = { ...cfg.strain, attackRate: DEMO_ATTACK, range: DEMO_RANGE };
    return cfg;
  }

  /** Generate a self-consistent demo dataset from the engine (one short run via
   *  the worker pool), sampled and scaled to a population, and load it into the
   *  table. */
  private async loadDemo(): Promise<void> {
    if (!this.pool) return;
    this.note('Generating demo outbreak…');
    try {
      const { curves } = await this.pool.simulate(this.demoConfig(), DEMO_DAYS, DEMO_K, this.demoConfig().seed);
      const pts: ObservedPoint[] = [];
      for (let d = 0; d <= DEMO_DAYS; d += DEMO_SAMPLE) {
        pts.push({ day: d, value: Math.round(curves.cumulative_infections[d] * DEMO_POP), category: 'cumulative_infections' });
        pts.push({ day: d, value: Math.round(curves.cumulative_deaths[d] * DEMO_POP), category: 'cumulative_deaths' });
      }
      this.observed = pts;
      this.population = DEMO_POP;
      this.presetId = 'synthetic';
      const popInput = this.el?.querySelector<HTMLInputElement>('[data-r0="population"]');
      if (popInput) popInput.value = String(DEMO_POP);
      this.renderTable();
      this.persist();
      this.note('Demo outbreak loaded — press Run fit.');
    } catch {
      this.note('Could not generate demo.');
    }
  }

  /** Load a fixed observed dataset (a historical preset) into the table. A
   *  preset with default adjustment keyframes loads them ENABLED (editable);
   *  one without resets the adjustment so stale frames from another dataset
   *  can't silently distort the next fit. */
  private loadDataset(p: DemoPreset): void {
    this.observed = p.points.map((pt) => ({ ...pt }));
    this.population = p.population;
    const popInput = this.el?.querySelector<HTMLInputElement>('[data-r0="population"]');
    if (popInput) popInput.value = String(p.population);
    this.adjust = p.adjust
      ? {
          enabled: true,
          asTarget: true,
          t0: p.adjust.t0,
          cases: p.adjust.cases.map((f) => ({ ...f })),
          deaths: p.adjust.deaths.map((f) => ({ ...f })),
        }
      : { ...DEFAULT_ADJUST };
    const adjEnabled = this.el?.querySelector<HTMLInputElement>('[data-adj="enabled"]');
    if (adjEnabled) adjEnabled.checked = this.adjust.enabled;
    const adjTarget = this.el?.querySelector<HTMLInputElement>('[data-adj="astarget"]');
    if (adjTarget) adjTarget.checked = this.adjust.asTarget;
    const adjT0 = this.el?.querySelector<HTMLInputElement>('[data-adj="t0"]');
    if (adjT0) adjT0.value = this.adjust.t0 == null ? '' : String(this.adjust.t0);
    this.renderAdjust();
    const store = this.interventions; // shared with the main sim — replace contents
    store.length = 0;
    for (const iv of p.interventions ?? []) {
      store.push({
        ...iv,
        params: iv.params ? { ...iv.params } : undefined,
        keyframes: iv.keyframes?.map((k) => ({ tick: k.tick, transmissionReduction: k.transmissionReduction, params: { ...k.params } })),
      });
    }
    this.notifyInterventions();
    this.renderInterventions();
    this.result = null;
    this.renderTable();
    this.renderOutput();
    this.persist();
    this.note(p.adjust
      ? 'Dataset loaded with default underreporting keyframes (enabled, editable) — press Run fit.'
      : 'Dataset loaded — press Run fit.');
  }

  private activeParams(): FitParamDef[] {
    return FIT_PARAMS.filter((p) => this.selected.has(p.name)).map((p) => ({
      ...p,
      bounds: this.bounds.get(p.name)!,
    }));
  }

  /** Reflect the active optimizer in the toggle, and show the GA controls only when
   *  the genetic optimizer is selected. */
  private syncOptimizerUI(): void {
    if (!this.el) return;
    this.el.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((b) =>
      b.classList.toggle('active', b.dataset['opt'] === this.optimizer));
    const gaBlock = this.el.querySelector<HTMLElement>('[data-r0="ga-controls"]');
    if (gaBlock) gaBlock.hidden = this.optimizer !== 'genetic';
  }

  /** When the data spans a peak/plateau, auto-enable the timing genes (incubation,
   *  infectious) so the fit can match curve shape, not just height. Returns whether
   *  anything was added (so the caller can surface a note). User can uncheck them. */
  private autoExpandShapeParams(observed: ObservedPoint[]): boolean {
    if (!this.dataSpansPeak(observed)) return false;
    let added = false;
    for (const name of ['incubation', 'infectious'] as FitParamName[]) {
      if (!this.selected.has(name)) { this.selected.add(name); added = true; }
    }
    if (added) { this.renderParams(); this.persist(); }
    return added;
  }

  /** Heuristic: does the observed data actually *identify* the timing genes? Only
   *  an active-infections (prevalence) curve with an interior peak does — its rise
   *  and fall pin incubation + infectious. A cumulative-only curve does not: many
   *  (incubation, infectious) pairs reproduce the same cumulative shape, so adding
   *  those genes there is ill-posed and sends the optimizer to a degenerate corner.
   *  So we require an interior peak in active_infections and stay 2-param otherwise. */
  private dataSpansPeak(observed: ObservedPoint[]): boolean {
    const active = observed
      .filter((p) => p.category === 'active_infections')
      .sort((a, b) => a.day - b.day);
    if (active.length < 4) return false;
    let maxIdx = 0;
    for (let i = 1; i < active.length; i++) if (active[i].value > active[maxIdx].value) maxIdx = i;
    // Interior peak (rises then clearly falls) — both phases present.
    return maxIdx > 0
      && maxIdx < active.length - 1
      && active[active.length - 1].value < active[maxIdx].value * 0.7;
  }

  private setRunning(on: boolean): void {
    const run = this.el!.querySelector<HTMLButtonElement>('[data-r0="run"]')!;
    const cancel = this.el!.querySelector<HTMLButtonElement>('[data-r0="cancel"]')!;
    run.disabled = on;
    cancel.disabled = !on;
    this.el!.querySelector('[data-r0="progress"]')!.classList.toggle('active', on);
  }

  // ── Output: stats + uPlot overlay ──

  /** Provisional output shown while a fit runs: a live chart plus best-so-far R₀
   *  and loss readouts that the rAF-throttled onImprove updates as it converges. */
  private renderLive(observed: ObservedPoint[], raw: ObservedPoint[] | null = null): void {
    const host = this.el!.querySelector<HTMLElement>('[data-r0="output"]')!;
    const applyBtn = this.el!.querySelector<HTMLButtonElement>('[data-r0="apply"]')!;
    applyBtn.disabled = true;
    // Chart domain matches the fit's sim horizon exactly: observed span, plus
    // the offset search's upper bound when the index date is being evolved
    // (candidates can slide the data that far right), plus the prediction
    // horizon — so no candidate curve or dot position ever clips.
    const offHi = this.offsetEvolve
      ? Math.max(0, Math.round(Math.max(this.offsetBounds[0], this.offsetBounds[1])))
      : 0;
    const days = Math.max(1, ...observed.map((p) => Math.round(p.day))) + offHi + this.predictionDays;

    host.innerHTML = `
      <div class="r0-result-grid">
        <div class="r0-metric r0-metric-hero">
          <span class="r0-metric-label">Basic reproduction number</span>
          <span class="r0-metric-value" data-r0="live-r0">R₀ = …</span>
          <span class="r0-metric-sub">fitting…</span>
        </div>
        <div class="r0-metric">
          <span class="r0-metric-label">Best fit so far</span>
          <span class="r0-metric-value" data-r0="live-loss">…</span>
          <span class="r0-metric-sub" data-r0="live-sub">loss — lower is better</span>
        </div>
      </div>
      <div class="r0-chart" data-r0="chart"></div>
      <div class="r0-ovl-legend" data-r0="ovl-legend" hidden></div>
    `;
    this.createChart(observed, days, this.population, raw, this.lastAdjust);
  }

  private renderOutput(): void {
    const host = this.el!.querySelector<HTMLElement>('[data-r0="output"]')!;
    const r = this.result;
    const applyBtn = this.el!.querySelector<HTMLButtonElement>('[data-r0="apply"]')!;
    if (!r) {
      host.innerHTML = '<p class="r0-empty">Run a fit to see best-fit parameters, R₀, and the overlaid curves.</p>';
      applyBtn.disabled = true;
      return;
    }
    applyBtn.disabled = false;

    const r0 = r.r0 == null ? '—' : r.r0.toFixed(2);
    // Read the CI honestly: a real interval, an over-determined point estimate, or
    // none. An equal-bounds "95% CI 10.89 – 10.89" is misleading, so we don't show it.
    const ciSub =
      r.r0CIKind === 'exact' ? '≈ exact (data over-determines R₀)'
      : r.r0CI ? `95% CI ${r.r0CI[0].toFixed(2)} – ${r.r0CI[1].toFixed(2)}`
      : '95% CI —';
    const rating = gofRating(r.gof.r2);
    const barPct = Math.max(0, Math.min(1, r.gof.r2)) * 100;
    const paramRows = r.params
      .map((p) => `<tr><td>${p.label}</td><td>${fmtParam(p.name, p.value)}</td></tr>`)
      .join('')
      + (r.indexOffset == null ? '' : `<tr>
          <td title="Evolved during the fit. The interval is a PROFILE-LIKELIHOOD CI — calibrated via 2·ln(Lmax/L) ≤ 3.84 (95%) / 1.0 (68%) over the index-date grid with the other parameters at their best. It is a parameter interval, distinct from the fan chart's ensemble percentile bands (predictive spread).">Index date (head start)</td>
          <td>≈ day ${r.indexOffset}${r.offsetCI
            ? (r.offsetCI.ci95[0] === r.offsetCI.ci95[1]
              ? ' <span class="r0-muted">(≈ exact — the data over-determines the date)</span>'
              : ` <span class="r0-muted">(95% CI ${r.offsetCI.ci95[0]}–${r.offsetCI.ci95[1]} · 68% ${r.offsetCI.ci68[0]}–${r.offsetCI.ci68[1]})</span>`)
            : ''}</td>
        </tr>`)
      + bayesRows(r)
      + ensembleRows(r, this.lastEnsemble);

    host.innerHTML = `
      <div class="r0-result-grid">
        <div class="r0-metric r0-metric-hero">
          <span class="r0-metric-label">Basic reproduction number</span>
          <span class="r0-metric-value">R₀ = ${r0}</span>
          <span class="r0-metric-sub">${ciSub}</span>
        </div>
        <div class="r0-metric r0-gof ${rating.cls}">
          <span class="r0-metric-label">Goodness of fit</span>
          <span class="r0-gof-rating"><span class="r0-gof-badge ${rating.cls}">${rating.label}</span></span>
          <span class="r0-gof-bar"><span style="width:${barPct.toFixed(1)}%"></span></span>
          <span class="r0-metric-sub">R² ${r.gof.r2.toFixed(3)} · RMSE ${fmtNum(r.gof.rmse)}</span>
          ${holdoutLine(r)}
        </div>
        <table class="r0-params-table">
          <thead><tr><th>Fitted parameter</th><th>Value</th></tr></thead>
          <tbody>${paramRows}</tbody>
        </table>
      </div>
      <div class="r0-chart" data-r0="chart"></div>
      <div class="r0-ovl-legend" data-r0="ovl-legend" hidden></div>
    `;
    this.createChart(r.observed, r.days, r.population, this.lastRaw, this.lastAdjust, this.lastFan, this.lastEnsemble);
    this.updateChartData(r.simulated);
  }

  // ── Fit history ──
  // Past fits, grouped by the effective dataset they ran against (hash of the
  // shifted/cleaned points + population) so ranking is only ever like-for-like,
  // best-to-worst by R² (ties → lower loss). Load restores the stored result
  // into the panel; Apply pushes its config straight into the simulation.
  private renderHistory(): void {
    const host = this.el?.querySelector<HTMLElement>('[data-r0="history"]');
    const count = this.el?.querySelector<HTMLElement>('[data-r0="history-count"]');
    if (!host) return;
    if (count) count.textContent = `${this.history.length} fit${this.history.length === 1 ? '' : 's'}`;
    host.innerHTML = '';
    if (this.history.length === 0) {
      host.innerHTML = '<p class="r0-history-empty">No fits yet — completed fits appear here, ranked per dataset.</p>';
      return;
    }

    const groups = new Map<string, FitHistoryEntry[]>();
    for (const e of this.history) {
      const g = groups.get(e.hash);
      if (g) g.push(e); else groups.set(e.hash, [e]);
    }
    const currentHash = this.observed.length
      ? datasetHash(this.effectiveObserved().observed, this.population)
      : '';
    const ordered = [...groups.entries()].sort((a, b) => {
      if (a[0] === currentHash) return -1;
      if (b[0] === currentHash) return 1;
      return Math.max(...b[1].map((e) => e.t)) - Math.max(...a[1].map((e) => e.t));
    });

    const presetLabel = (id: string): string =>
      id === 'synthetic' ? 'Synthetic demo' : HISTORICAL_PRESETS.find((p) => p.id === id)?.label ?? 'Custom data';

    for (const [hash, entries] of ordered) {
      entries.sort((a, b) => (b.result.gof.r2 - a.result.gof.r2) || (a.result.loss - b.result.loss));
      const title = document.createElement('div');
      title.className = 'r0-history-group';
      title.textContent = `${presetLabel(entries[0].presetId)}${hash === currentHash ? ' — current data' : ''}`;
      host.appendChild(title);
      entries.forEach((e, rank) => {
        const row = document.createElement('div');
        row.className = 'r0-history-row';
        const when = new Date(e.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const params = e.result.params.map((p) => `${p.label} ${fmtParam(p.name, p.value)}`).join(' · ');
        row.innerHTML = `
          <span class="r0-history-rank">#${rank + 1}</span>
          <span class="r0-history-when">${when}</span>
          <span>R₀ ${e.result.r0 == null ? '—' : e.result.r0.toFixed(2)}</span>
          <span>R² ${e.result.gof.r2.toFixed(3)}</span>
          <span class="r0-muted">loss ${fmtLoss(e.result.loss)}</span>
          <span class="r0-history-params r0-muted" title="${params}">${params}</span>
          <button class="btn ghost" type="button" data-act="load">Load</button>
          <button class="btn ghost" type="button" data-act="apply">Apply</button>
        `;
        row.querySelector<HTMLButtonElement>('[data-act="load"]')!.addEventListener('click', () => {
          this.result = e.result;
          // Stored results carry only the effective fitted points — the raw
          // overlay, adjustment envelope, and fan bands are transient.
          this.lastRaw = null;
          this.lastAdjust = null;
          this.lastFan = null;
          this.lastEnsemble = null;
          this.liveOffsetBand = null;
          this.renderOutput();
          this.note('Loaded fit from history.');
        });
        row.querySelector<HTMLButtonElement>('[data-act="apply"]')!.addEventListener('click', () => {
          void (async () => {
            const extras = await this.applyExtras(e.result);
            this.events.onApply(e.result.config, extras);
            this.close();
          })();
        });
        host.appendChild(row);
      });
    }
  }

  /** Build the uPlot overlay once (observed dots + an empty sim line per
   *  category present in the data). `updateChartData` then streams sim curves in
   *  via setData — far cheaper than destroy/recreate, and the basis for the live
   *  update during a fit. */
  private createChart(
    observed: ObservedPoint[],
    days: number,
    population: number,
    raw: ObservedPoint[] | null = null,
    adjustBands: { floor: ObservedPoint[]; central: ObservedPoint[]; upper: ObservedPoint[] } | null = null,
    fan: Record<FitCategory, number[][]> | null = null,
    ensemble: Record<FitCategory, number[][]> | null = null,
  ): void {
    const host = this.el!.querySelector<HTMLElement>('[data-r0="chart"]')!;
    this.plot?.destroy();
    this.plot = null;
    this.liveObserved = observed;
    this.liveDays = days;
    this.livePop = population;
    this.liveCats = FIT_CATEGORIES.filter((c) => observed.some((p) => p.category === c));

    // Cache the hook-painted overlays (people-scaled) + the y-range they need.
    // A fresh chart is aligned (dots and model in the same day coordinates);
    // only onImprove sets a nonzero dot shift while an offset-evolving fit runs.
    this.liveDotShift = 0;
    this.liveIndexMarker = null;
    this.liveFanCols = null;
    this.liveEnsembleCols = null;
    this.liveAdjustPts = null;
    this.overlayMax = 0;
    if (fan) {
      this.liveFanCols = {};
      for (const cat of this.liveCats) {
        const rows = fan[cat]?.map((row) => row.map((v) => v * population));
        if (!rows?.length) continue;
        this.liveFanCols[cat] = rows;
        const top = rows[rows.length - 1]; // highest percentile row
        for (const v of top) if (v > this.overlayMax) this.overlayMax = v;
      }
    }
    if (ensemble) {
      this.liveEnsembleCols = {};
      for (const cat of this.liveCats) {
        const rows = ensemble[cat]?.map((row) => row.map((v) => v * population));
        if (!rows?.length) continue;
        this.liveEnsembleCols[cat] = rows;
        const top = rows[rows.length - 1]; // 95th-percentile row
        for (const v of top) if (v > this.overlayMax) this.overlayMax = v;
      }
    }
    if (adjustBands) {
      this.liveAdjustPts = {};
      const verts = (pts: ObservedPoint[], cat: FitCategory): [number, number][] =>
        pts.filter((p) => p.category === cat).sort((a, b) => a.day - b.day).map((p) => [p.day, p.value]);
      for (const cat of this.liveCats) {
        const upper = verts(adjustBands.upper, cat);
        if (upper.length === 0) continue;
        this.liveAdjustPts[cat] = {
          floor: verts(adjustBands.floor, cat),
          central: verts(adjustBands.central, cat),
          upper,
        };
        for (const [, v] of upper) if (v > this.overlayMax) this.overlayMax = v;
      }
    }

    // Greyed overlay of raw points superseded by the revision cleaning: one extra
    // dots-only column per category that has any point differing from the cleaned
    // value at the same day. Columns are cached so updateChartData can rebuild
    // the exact same data shape on every live frame.
    this.liveRawSeriesIdx = [];
    this.liveRawCols = this.liveCats.map(() => null);
    if (raw) {
      const cleaned = new Map<string, number>();
      for (const pt of observed) cleaned.set(`${pt.category}:${Math.round(pt.day)}`, pt.value);
      this.liveCats.forEach((cat, ci) => {
        let col: (number | null)[] | null = null;
        for (const pt of raw) {
          if (pt.category !== cat) continue;
          const d = Math.round(pt.day);
          if (d < 0 || d > days) continue;
          if (cleaned.get(`${cat}:${d}`) === pt.value) continue; // not revised
          if (!col) col = Array.from({ length: days + 1 }, () => null);
          col[d] = pt.value;
        }
        this.liveRawCols[ci] = col;
      });
    }

    // Legend readout: the model curves carry fractional means (fraction × pop), so
    // format them as compact counts instead of dumping a long-decimal float.
    const legendVal = (_u: uPlot, v: number | null): string =>
      v == null || !Number.isFinite(v) ? '–' : fmtNum(v);

    const xs = this.chartXs(days);
    const data: (number | null)[][] = [xs];
    const series: uPlot.Series[] = [{}];
    this.liveCats.forEach((cat, ci) => {
      const sim: (number | null)[] = xs.map(() => null);
      const obs: (number | null)[] = xs.map(() => null);
      for (const pt of observed) {
        if (pt.category !== cat) continue;
        const d = Math.round(pt.day);
        if (d >= 0 && d <= days) obs[d] = pt.value;
      }
      data.push(sim, obs);
      series.push(
        { label: `${CAT_SHORT[cat]} · model`, stroke: CAT_COLOR[cat], width: 2, value: legendVal },
        {
          label: `${CAT_SHORT[cat]} · data`,
          stroke: CAT_COLOR[cat],
          paths: () => null, // dots only
          points: { show: true, size: 7, stroke: CAT_COLOR[cat], fill: '#fff' },
          value: legendVal,
        },
      );
      const rawCol = this.liveRawCols[ci];
      if (rawCol) {
        data.push(rawCol);
        this.liveRawSeriesIdx.push(series.length);
        series.push({
          label: `${CAT_SHORT[cat]} · raw`,
          stroke: RAW_INK,
          show: this.overlayVis.raw,
          paths: () => null, // dots only — superseded values, greyed
          points: { show: true, size: 6, stroke: RAW_INK, fill: 'transparent' },
          value: legendVal,
        });
      }
    });

    // uPlot draws axis ticks, labels and grid on canvas, so they ignore CSS — feed
    // them the theme colors explicitly or they render in uPlot's default near-black,
    // which is invisible against the dark "Lab" theme.
    const css = getComputedStyle(document.documentElement);
    const axisInk = css.getPropertyValue('--text-muted').trim() || '#6b7280';
    const gridInk = css.getPropertyValue('--border').trim() || 'rgba(128,128,128,0.25)';
    const axisOpts = (label: string, extra: uPlot.Axis): uPlot.Axis => ({
      label,
      stroke: axisInk,
      grid: { stroke: gridInk, width: 1 },
      ticks: { stroke: gridInk, width: 1 },
      ...extra,
    });

    const w = host.clientWidth || 520;
    this.plot = new uPlot(
      {
        width: w,
        height: 260,
        // Extra left padding so the widened y-axis gutter + label clear the card edge.
        padding: [12, 12, 0, 6],
        legend: { show: true },
        scales: {
          x: { time: false },
          // Let the hook-painted overlays (fan bands / adjustment upper bound)
          // extend the y-range past the series data so they never clip.
          y: {
            range: (_u, min, max) => [
              Math.min(0, min),
              Math.max(max, this.overlayMax) * 1.03 || 1,
            ] as [number, number],
          },
        },
        // Band + floor/central/upper envelope are painted directly on the
        // canvas (below the series, which redraw after this hook) so the data
        // columns and legend stay exactly as before. The legend pins to the
        // END-STATE values whenever the cursor is not on the chart — live
        // streaming values appear only while hovering the live line.
        hooks: {
          draw: [(u) => this.paintOverlays(u)],
          ready: [(u) => this.pinLegendToEnd(u)],
          setData: [(u) => this.pinLegendToEnd(u)],
          setCursor: [(u) => { if (u.cursor.idx == null) this.pinLegendToEnd(u); }],
          // Keep the 'raw' chip in sync when the user toggles a raw series via
          // the uPlot legend directly (both directions stay coherent).
          setSeries: [(u, si) => { if (si != null && this.liveRawSeriesIdx.includes(si)) this.syncRawChip(u); }],
        },
        axes: [
          axisOpts('Day', { space: 56, values: (_u, splits) => splits.map((v) => String(Math.round(v))) }),
          // fmtNum keeps big counts compact (12k, 1.2M) so ticks stay inside the
          // gutter instead of clipping; the wider size + gaps give the label room.
          axisOpts('Count', { size: 76, gap: 8, labelGap: 8, values: (_u, splits) => splits.map((v) => fmtNum(v)) }),
        ],
        series,
      },
      data as uPlot.AlignedData,
      host,
    );
    this.annotateSeriesLegend();
    this.renderOverlayLegend();
  }

  /** Colored toggle dots on the uPlot legend rows (the modal hides uPlot's
   *  default markers globally, so without this the entries have no color and
   *  no visible affordance). Line series get a filled dot, dot-series a ring,
   *  matching how they draw on the canvas. */
  private annotateSeriesLegend(): void {
    const host = this.el?.querySelector<HTMLElement>('[data-r0="chart"]');
    const plot = this.plot;
    if (!host || !plot) return;
    host.querySelectorAll('.u-legend .u-series').forEach((row, idx) => {
      if (idx === 0) return; // x row
      const th = row.querySelector('th') as HTMLElement | null;
      if (!th || th.querySelector('.u-toggle-dot')) return;
      th.title = 'Click to show/hide this series';
      const dot = document.createElement('span');
      dot.className = 'u-toggle-dot';
      dot.setAttribute('aria-hidden', 'true');
      const s = plot.series[idx] as { stroke?: unknown; paths?: unknown; label?: string };
      const stroke = typeof s.stroke === 'string' ? s.stroke : null;
      if (stroke) dot.style.setProperty('--dot-color', stroke);
      // Dots-only series (data / raw) render as a ring, matching the chart.
      if (typeof s.label === 'string' && !s.label.endsWith('· model')) dot.classList.add('ring');
      th.prepend(dot);
    });
  }

  /** Chip legend for the canvas-painted overlay layers (and the raw-revision
   *  series): one chip per layer actually present, colored to match its paint;
   *  clicking hides/shows the layer. State lives in overlayVis (persisted). */
  private renderOverlayLegend(): void {
    const host = this.el?.querySelector<HTMLElement>('[data-r0="ovl-legend"]');
    if (!host) return;
    const catTint = CAT_COLOR[this.liveCats[0] ?? 'cumulative_infections'];
    const chips: { key: OverlayKey; label: string; color: string; tip: string }[] = [];
    if (this.liveItvWindows.length > 0) {
      chips.push({ key: 'itv', label: 'Interventions', color: 'rgb(139, 92, 246)', tip: 'Violet spans: intervention windows — the time-varying transmission R(t) reductions the fit ran under.' });
    }
    if (this.liveRawCols.some((c) => c)) {
      chips.push({ key: 'raw', label: 'Raw data', color: 'rgb(148, 163, 184)', tip: 'Greyed hollow dots: reported values later revised downward (the fit targets the cleaned series).' });
    }
    if (this.liveAdjustPts && Object.keys(this.liveAdjustPts).length > 0) {
      chips.push({ key: 'adjust', label: 'Adjusted data', color: 'rgb(100, 116, 139)', tip: 'Underreporting-adjustment envelope: reported floor, central estimate, vintaged upper bound (category-colored dashes).' });
    }
    if (this.liveEnsembleCols && Object.keys(this.liveEnsembleCols).length > 0) {
      chips.push({ key: 'ensemble', label: 'Ensemble density', color: catTint, tip: 'Soft density: index-case ensemble — the best-fit disease re-run from many different starting cells. Predictive spread (stochastic path + starting cell); naturally wider than the Bayes band.' });
    }
    if (this.liveFanCols && Object.keys(this.liveFanCols).length > 0) {
      chips.push({ key: 'bayes', label: 'Bayes band', color: catTint, tip: 'Saturated band: Bayesian posterior-predictive 5/50/95 — parameter uncertainty only, so it is narrow by design.' });
    }
    if (this.liveOffsetBand) {
      chips.push({ key: 'offset', label: 'Index-date CI', color: 'rgb(148, 163, 184)', tip: 'Grey band: profile-likelihood CI for where the first observation sits (dashed line = the fitted index date).' });
    }
    host.hidden = chips.length === 0;
    if (chips.length === 0) { host.innerHTML = ''; return; }
    host.innerHTML = `<span class="r0-ovl-caption">Layers</span>` + chips.map((c) => {
      const on = this.overlayVis[c.key];
      return `<button type="button" class="r0-ovl-chip${on ? '' : ' off'}" data-ovl="${c.key}" aria-pressed="${on}" title="${c.tip} Click to ${on ? 'hide' : 'show'}.">
        <span class="r0-ovl-dot" style="--c:${c.color}"></span>${c.label}
      </button>`;
    }).join('');
    host.querySelectorAll<HTMLButtonElement>('[data-ovl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset['ovl'] as OverlayKey;
        this.overlayVis[key] = !this.overlayVis[key];
        if (key === 'raw') {
          // Raw is a real uPlot series set — toggle through setSeries so the
          // uPlot legend rows stay coherent (its hook re-syncs the chip).
          for (const si of this.liveRawSeriesIdx) this.plot?.setSeries(si, { show: this.overlayVis.raw });
        } else {
          this.repaintOverlays();
        }
        this.renderOverlayLegend();
      });
    });
  }

  /** Repaint the canvas overlays after a visibility toggle. uPlot 1.x
   *  redraw() can wipe cached series paths (documented pitfall in Chart.ts),
   *  so re-push the current data instead — setData refires hooks.draw. */
  private repaintOverlays(): void {
    if (this.plot) this.plot.setData(this.plot.data);
  }

  /** setSeries hook target: reflect the raw series' actual visibility back
   *  onto overlayVis + the chip (covers toggles made via the uPlot legend). */
  private syncRawChip(u: uPlot): void {
    const anyShown = this.liveRawSeriesIdx.some((si) => (u.series[si] as { show?: boolean }).show !== false);
    if (this.overlayVis.raw !== anyShown) {
      this.overlayVis.raw = anyShown;
      this.renderOverlayLegend();
    }
  }

  /** Push fresh simulated curves into the existing plot (observed dots unchanged).
   *  Must rebuild the exact column shape createChart declared — including the
   *  greyed raw-overlay columns for categories that have them. */
  private updateChartData(curves: SimCurves): void {
    if (!this.plot) return;
    const xs = this.chartXs(this.liveDays);
    const data: (number | null)[][] = [xs];
    // Offset-evolving fit: the model stays at sim days (unshifted, fully
    // visible from outbreak day 0) and the DATA DOTS slide right by the
    // current candidate's offset. Zero outside an evolving fit.
    const dotShift = this.liveDotShift;
    this.liveCats.forEach((cat, ci) => {
      // When the Bayes fan is cached, the central line is its MEDIAN (p50) so
      // the line always sits inside that band. Deliberate: the index-case
      // ensemble does NOT replace the main line — its median paints as its own
      // dotted line inside the density layer (paintOverlays), keeping the
      // legend's "model" label honest.
      const p50 = this.liveFanCols?.[cat]?.[BAND_CENTRAL];
      const arr = p50 ?? curves[cat] ?? [];
      const scale = p50 ? 1 : this.livePop; // fan rows are already people-scaled
      const sim = xs.map((d) => (arr[Math.min(d, arr.length - 1)] ?? 0) * scale);
      const obs: (number | null)[] = xs.map(() => null);
      for (const pt of this.liveObserved) {
        if (pt.category !== cat) continue;
        const d = Math.round(pt.day) + dotShift;
        if (d >= 0 && d <= this.liveDays) obs[d] = pt.value;
      }
      data.push(sim, obs);
      const rawCol = this.liveRawCols[ci];
      if (rawCol) {
        // Greyed raw dots ride with the data: remap the cached raw-day column
        // by the same shift.
        data.push(dotShift === 0 ? rawCol : xs.map((d) => (d - dotShift >= 0 ? rawCol[d - dotShift] ?? null : null)));
      }
    });
    this.plot.setData(data as uPlot.AlignedData);
  }

  /** Pin the legend readout to the final day when the cursor is off the chart,
   *  so non-hover labels always show the end-state numbers. Guarded against
   *  re-entrancy (setLegend can fire hooks). */
  private pinningLegend = false;
  private pinLegendToEnd(u: uPlot): void {
    if (this.pinningLegend) return;
    const n = u.data?.[0]?.length ?? 0;
    if (!n) return;
    this.pinningLegend = true;
    try {
      u.setLegend({ idx: n - 1 }, false);
    } finally {
      this.pinningLegend = false;
    }
  }

  /** Canvas-paint the posterior-predictive band (LOW..HIGH fill around the
   *  CENTRAL line) and the adjustment envelope (floor / central / upper) for
   *  each category. Runs as a uPlot draw hook; series redraw on top. */
  private paintOverlays(u: uPlot): void {
    const fan = this.liveFanCols;
    const ens = this.liveEnsembleCols;
    const adj = this.liveAdjustPts;
    if (!fan && !ens && !adj && !this.liveOffsetBand && this.liveIndexMarker == null && this.liveItvWindows.length === 0) return;
    const ctx = u.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    ctx.clip();
    const X = (d: number): number => u.valToPos(d, 'x', true);
    const Y = (v: number): number => u.valToPos(v, 'y', true);
    // Overlay labels are collected here and painted LAST, unclipped and
    // clamped fully inside the plot, so their text is always complete and
    // always in the foreground (see the label pass after ctx.restore()).
    const labels: { text: string; x: number; y: number; color: string }[] = [];
    const pr = uPlot.pxRatio || 1;
    // Evolving index-date marker: a vertical amber line where data day 0
    // currently sits in sim days, updated live as the optimizer mutates the
    // offset. (Post-fit charts show the grey profile-CI band instead.)
    if (this.liveIndexMarker != null) {
      const xm = X(this.liveIndexMarker);
      ctx.beginPath();
      ctx.moveTo(xm, u.bbox.top);
      ctx.lineTo(xm, u.bbox.top + u.bbox.height);
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      labels.push({
        text: `index date · day ${this.liveIndexMarker}`,
        x: xm + 4 * pr,
        y: u.bbox.top + u.bbox.height - 14 * pr,
        color: 'rgb(245, 158, 11)',
      });
    }
    // Intervention ramp windows: violet spans (distinct from the grey offset-CI
    // band and the category-colored fills) with a dashed start line and the
    // intervention's name at the top, staggered per row.
    if (this.overlayVis.itv) this.liveItvWindows.forEach((w, wi) => {
      const x1 = X(w.from);
      const x2 = Number.isFinite(w.to) ? X(w.to) : u.bbox.left + u.bbox.width;
      ctx.fillStyle = 'rgba(139, 92, 246, 0.06)';
      ctx.fillRect(x1, u.bbox.top, Math.max(1, x2 - x1), u.bbox.height);
      ctx.beginPath();
      ctx.moveTo(x1, u.bbox.top);
      ctx.lineTo(x1, u.bbox.top + u.bbox.height);
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      labels.push({
        text: w.label,
        x: x1 + 4 * pr,
        y: u.bbox.top + (4 + wi * 19) * pr,
        color: 'rgb(139, 92, 246)',
      });
    });
    // Index-date profile-CI marker: the grey band spans the plausible positions
    // of the FIRST OBSERVATION under the CI (darker = 68%), with a dashed line
    // where the fitted offset actually anchors it.
    const ob = this.overlayVis.offset ? this.liveOffsetBand : null;
    if (ob) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.10)';
      ctx.fillRect(X(ob.lo95), u.bbox.top, Math.max(1, X(ob.hi95) - X(ob.lo95)), u.bbox.height);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.fillRect(X(ob.lo68), u.bbox.top, Math.max(1, X(ob.hi68) - X(ob.lo68)), u.bbox.height);
      ctx.beginPath();
      ctx.moveTo(X(ob.at), u.bbox.top);
      ctx.lineTo(X(ob.at), u.bbox.top + u.bbox.height);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Index-case ensemble density — painted FIRST so the Bayes band and the
    // series draw on top. Layered fills (broad 5–95 wash + darker 25–75 core)
    // read as a density; the ensemble median is dotted so it can't be
    // mistaken for the fitted line.
    if (ens && this.overlayVis.ensemble) {
      for (const cat of this.liveCats) {
        const rows = ens[cat];
        if (!rows || rows.length < ENSEMBLE_PROBS.length) continue;
        const color = CAT_COLOR[cat];
        const band = (lo: number[], hi: number[], alpha: number): void => {
          ctx.beginPath();
          hi.forEach((v, d) => { if (d === 0) ctx.moveTo(X(0), Y(v)); else ctx.lineTo(X(d), Y(v)); });
          for (let d = lo.length - 1; d >= 0; d--) ctx.lineTo(X(d), Y(lo[d]));
          ctx.closePath();
          ctx.fillStyle = withAlpha(color, alpha);
          ctx.fill();
        };
        band(rows[0], rows[4], 0.10); // 5–95
        band(rows[1], rows[3], 0.14); // 25–75 (stacks on the wash)
        ctx.beginPath();
        rows[ENSEMBLE_CENTRAL].forEach((v, d) => { if (d === 0) ctx.moveTo(X(0), Y(v)); else ctx.lineTo(X(d), Y(v)); });
        ctx.strokeStyle = withAlpha(color, 0.5);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    for (const cat of this.liveCats) {
      const color = CAT_COLOR[cat];
      const rows = this.overlayVis.bayes ? fan?.[cat] : undefined;
      if (rows) {
        // BAND_PROBS = [5, 50, 95] → LOW..HIGH posterior-predictive fill with
        // explicit dashed edge lines so even a narrow band reads as a band.
        ctx.beginPath();
        rows[2].forEach((v, d) => { if (d === 0) ctx.moveTo(X(0), Y(v)); else ctx.lineTo(X(d), Y(v)); });
        for (let d = rows[0].length - 1; d >= 0; d--) ctx.lineTo(X(d), Y(rows[0][d]));
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.28);
        ctx.fill();
        for (const edge of [0, 2]) {
          ctx.beginPath();
          rows[edge].forEach((v, d) => { if (d === 0) ctx.moveTo(X(0), Y(v)); else ctx.lineTo(X(d), Y(v)); });
          ctx.strokeStyle = withAlpha(color, 0.55);
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      const a = this.overlayVis.adjust ? adj?.[cat] : undefined;
      if (a && a.upper.length > 1) {
        // The envelope vertices are anchored to the data days, so they ride
        // with the dots during an offset-evolving fit (shift is 0 otherwise).
        const XS = (d: number): number => X(d + this.liveDotShift);
        ctx.beginPath();
        a.upper.forEach(([d, v], i) => { if (i === 0) ctx.moveTo(XS(d), Y(v)); else ctx.lineTo(XS(d), Y(v)); });
        for (let i = a.floor.length - 1; i >= 0; i--) ctx.lineTo(XS(a.floor[i][0]), Y(a.floor[i][1]));
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.08);
        ctx.fill();
        const stroke = (pts: [number, number][], alpha: number, dash: number[]): void => {
          if (pts.length < 2) return;
          ctx.beginPath();
          pts.forEach(([d, v], i) => { if (i === 0) ctx.moveTo(XS(d), Y(v)); else ctx.lineTo(XS(d), Y(v)); });
          ctx.strokeStyle = withAlpha(color, alpha);
          ctx.lineWidth = 1;
          ctx.setLineDash(dash);
          ctx.stroke();
          ctx.setLineDash([]);
        };
        stroke(a.upper, 0.55, [5, 4]);  // vintaged upper bound
        stroke(a.floor, 0.55, [2, 3]);  // reported floor
        // In overlay-only mode the dots are the reported counts, so draw the
        // central estimate as its own dashed line; in fit-target mode the dots
        // ARE the central, so an extra line would just double-ink them.
        if (!this.adjust.asTarget) stroke(a.central, 0.85, [7, 3]);
      }
    }
    ctx.restore();

    // Label pass — after the clip is released so nothing truncates the text.
    // Each label gets a translucent theme-colored chip and is clamped so the
    // FULL text always sits inside the plot area, even for windows starting
    // near (or past) the right edge or off-view to the left.
    if (labels.length > 0) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-elevated').trim() || '#ffffff';
      ctx.save();
      ctx.font = `600 ${11 * pr}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const chipH = 16 * pr;
      const padX = 5 * pr;
      const left = u.bbox.left;
      const right = u.bbox.left + u.bbox.width;
      for (const L of labels) {
        const tw = ctx.measureText(L.text).width;
        const w = tw + padX * 2;
        const x = Math.max(left + 2 * pr, Math.min(L.x, right - w - 2 * pr));
        const y = Math.max(u.bbox.top + 2 * pr, Math.min(L.y, u.bbox.top + u.bbox.height - chipH - 2 * pr));
        ctx.beginPath();
        const r = 3 * pr;
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + chipH, r);
        ctx.arcTo(x + w, y + chipH, x, y + chipH, r);
        ctx.arcTo(x, y + chipH, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.strokeStyle = withAlpha(L.color, 0.55);
        ctx.stroke();
        ctx.fillStyle = L.color;
        ctx.fillText(L.text, x + padX, y + chipH / 2 + 0.5 * pr);
      }
      ctx.restore();
    }
  }

  private chartXs(days: number): number[] {
    const xs: number[] = [];
    for (let d = 0; d <= days; d++) xs.push(d);
    return xs;
  }

  private note(msg: string): void {
    const el = this.el?.querySelector<HTMLElement>('[data-r0="note"]');
    if (el) el.textContent = msg;
  }
}

// ── Formatting helpers ──

/** LOW / CENTRAL / HIGH readout rows for the Bayesian posterior-predictive
 *  band at the projection end, one row per category present. */
function bayesRows(r: FitResult): string {
  if (!r.bayes) return '';
  let out = '';
  for (const cat of FIT_CATEGORIES) {
    const rows = r.bayes[cat];
    if (!rows?.[0]?.length) continue;
    if (!r.observed.some((p) => p.category === cat)) continue;
    const last = rows[0].length - 1;
    const f = (i: number): string => fmtNum(rows[i][last] * r.population);
    out += `<tr>
      <td title="Bayesian posterior-predictive band at the projection end — seeded Metropolis over the fitted parameters (flat priors within the search bounds), 5/50/95 percentiles across draws. Calibrated parameter-uncertainty propagation; distinct from the index-date profile-likelihood CI, which is a parameter interval.">${CAT_SHORT[cat]} @ day ${last} (Bayes)</td>
      <td>low ${f(0)} · <b>central ${f(1)}</b> · high ${f(2)}</td>
    </tr>`;
  }
  return out;
}

/** 5 / median / 95 readout rows for the index-case ensemble at the projection
 *  end — the predictive-spread sibling of bayesRows. */
function ensembleRows(r: FitResult, ens: Record<FitCategory, number[][]> | null): string {
  if (!ens) return '';
  let out = '';
  for (const cat of FIT_CATEGORIES) {
    const rows = ens[cat];
    if (!rows?.[0]?.length) continue;
    if (!r.observed.some((p) => p.category === cat)) continue;
    const last = rows[0].length - 1;
    const f = (i: number): string => fmtNum(rows[i][last] * r.population);
    out += `<tr>
      <td title="Index-case ensemble at the projection end — the best-fit disease re-simulated from many DIFFERENT starting cells (deterministic sample), percentiles across trials. This is PREDICTIVE spread (stochastic path + index-case location) and is naturally wider than the Bayes band, which only propagates parameter uncertainty.">${CAT_SHORT[cat]} @ day ${last} (ensemble)</td>
      <td>5% ${f(0)} · <b>median ${f(ENSEMBLE_CENTRAL)}</b> · 95% ${f(ENSEMBLE_PROBS.length - 1)}</td>
    </tr>`;
  }
  return out;
}

function fmtParam(name: FitParamName, v: number): string {
  if (name === 'attackRate' || name === 'ifr') return `${(v * 100).toFixed(1)}%`;
  if (name === 'range') return String(Math.round(v));
  return `${v.toFixed(1)} d`;
}

function fmtNum(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(0);
}

// Compact display for the live loss readout — Poisson NLL can run large or
// negative, so abbreviate big magnitudes and keep small ones to 2 decimals.
function fmtLoss(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e3) return (v < 0 ? '-' : '') + fmtNum(a);
  return v.toFixed(2);
}

// Held-out seed check line: the winner was re-simulated on a fresh seed family
// (candidates are compared on COMMON random numbers by design — fair, cached,
// deterministic — so this is the guard against exploiting those K draws).
// Flag when the holdout loss is meaningfully worse than the fit loss.
function holdoutLine(r: FitResult): string {
  if (!r.holdout) return '';
  const h = r.holdout.loss;
  const f = r.loss;
  // Poisson NLL can be negative; compare on the difference scaled by |fit|.
  const worse = Number.isFinite(h) && Number.isFinite(f) && (h - f) > 0.5 * Math.max(1, Math.abs(f));
  const tip = 'The best-fit disease re-simulated at K trials on a DIFFERENT seed set (fresh RNG draws; a fresh topology on Voronoi). Candidates are compared on shared seeds (common random numbers) for fair, deterministic ranking — this checks the winner generalizes beyond those specific draws. A much worse holdout loss means the fit was riding its seed set: raise K (trials).';
  return `<span class="r0-metric-sub ${worse ? 'r0-holdout-warn' : ''}" data-tip="${tip}">held-out seeds: loss ${fmtLoss(h)} (fit ${fmtLoss(f)})${worse ? ` ${icon('warning','r0-inline-ico')} raise K` : ` ${icon('check','r0-inline-ico')}`}</span>`;
}

// Turns the R² goodness-of-fit number into a plain-language, color-coded rating
// so a non-statistician can read the fit quality at a glance.
function gofRating(r2: number): { label: string; cls: string } {
  if (r2 >= 0.95) return { label: 'Excellent', cls: 'excellent' };
  if (r2 >= 0.85) return { label: 'Good', cls: 'good' };
  if (r2 >= 0.70) return { label: 'Fair', cls: 'fair' };
  return { label: 'Poor', cls: 'poor' };
}

// Static markup; dynamic regions are filled by render*() via [data-r0] hooks.
const TEMPLATE = `
  <header class="r0-head">
    <div class="r0-titles">
      <h2 id="r0-title">Estimation workspace</h2>
      <p class="r0-tag">Fit an observed outbreak curve back to disease parameters — R₀, with uncertainty.</p>
    </div>
  </header>
  <div class="r0-cols">
  <div class="r0-col r0-col-cfg">
  <div class="r0-banner" data-r0="banner" hidden></div>

  <section class="r0-section">
    <h3>1 · Observed data</h3>
    <p class="r0-blurb">Enter real-world counts by day, or paste a CSV. Values are matched against the
      simulation rescaled to your population.</p>
    <label class="r0-field">
      <span>Population</span>
      <input class="r0-in" type="number" step="any" min="1" data-r0="population" />
    </label>
    <label class="r0-field">
      <span>Index-case offset (days)</span>
      <input class="r0-in" type="number" step="1" min="0" max="365" data-r0="offset" />
    </label>
    <p class="r0-blurb r0-hint">Shifts every data point this many days later in model time, giving the
      outbreak a head start before the first reported case. Early surveillance undercounts a new
      epidemic (low testing, sampling bias), so the true index case usually predates the data — raise
      this if the model can't grow fast enough to reach the earliest points.</p>
    <div class="r0-actions">
      <label class="r0-check" style="gap:6px">Dataset
        <select class="r0-in" data-r0="preset" aria-label="Load a dataset">
          <option value="synthetic">Synthetic (auto-generated)</option>
        </select>
      </label>
      <button class="btn ghost" type="button" data-r0="add-row">+ Add row</button>
      <button class="btn ghost" type="button" data-r0="clear">Clear</button>
      <label class="r0-check" title="Cumulative counts revised DOWN later (duplicates removed) are impossible for true cumulative data. When on, the fit uses the running-min envelope — each value clipped to the minimum of all later values — and the chart greys the superseded raw points. No-op on clean data.">
        <input type="checkbox" data-r0="revfix" /> honor downward revisions
      </label>
    </div>
    <details class="r0-details r0-data-details" data-r0="data-details">
      <summary>Data table · <span class="r0-muted" data-r0="row-count"></span></summary>
      <div class="r0-table">
        <div class="r0-row r0-row-head">
          <span>Day</span><span>Value</span><span>Category</span><span></span>
        </div>
        <div data-r0="rows"></div>
      </div>
    </details>
    <details class="r0-details" data-r0="adjust-details">
      <summary>Case/death adjustment (underreporting multipliers)</summary>
      <p class="r0-blurb">Reported counts are a floor on the true burden. Keyframe multipliers — linearly
        interpolated by report day, clamped past the end keyframes (days before t₀ / after the data are
        fine) — scale each day's NEW counts at their report date ("vintaged" accumulation):
        upper(tᵢ) = Σ Δreported(tⱼ)·m(tⱼ), central = (reported + upper) / 2. The initial stock uses m at
        the midpoint of [t₀, first observation]. Defaults: cases 5.0 → 3.8 and deaths 3.0 → 2.5 over a
        6-week ramp from t₀.</p>
      <div class="r0-actions">
        <label class="r0-check"><input type="checkbox" data-adj="enabled" /> enable</label>
        <label class="r0-check" title="On: the loss fits the adjusted central estimate (floor and upper drawn as an envelope). Off: the adjustment is a chart overlay only — the fit targets the reported counts.">
          <input type="checkbox" data-adj="astarget" /> fit the adjusted central
        </label>
        <label class="r0-field r0-field-inline"><span>t₀ (first-case day)</span>
          <input class="r0-in tiny" type="number" step="1" data-adj="t0" placeholder="auto" />
        </label>
      </div>
      <div class="r0-adjust-frames" data-r0="adjust-frames"></div>
    </details>
    <details class="r0-details">
      <summary>Paste CSV / TSV</summary>
      <textarea class="r0-paste" data-r0="paste" rows="4"
        placeholder="day,value,category&#10;0,12,cumulative_infections&#10;5,140,cumulative_infections&#10;5,2,cumulative_deaths"></textarea>
      <div class="r0-actions">
        <button class="btn" type="button" data-r0="parse">Parse</button>
        <label class="r0-check"><input type="checkbox" data-r0="paste-append" /> append (don't replace)</label>
      </div>
    </details>
  </section>

  <section class="r0-section">
    <h3>2 · Parameters to fit</h3>
    <p class="r0-blurb">Start with attack rate + range. Each fitted parameter is searched within its bounds.</p>
    <div class="r0-params" data-r0="params"></div>
    <div class="r0-actions">
      <label class="r0-check" title="Search the index date during the fit: the offset becomes an evolved, bounded integer parameter (like the other ranges), deterministic and seeded. The fitted value is written back into the Index-case offset field in section 1, and a profile-likelihood CI for it is reported with the result.">
        <input type="checkbox" data-r0="offset-evolve" /> evolve index date within
      </label>
      <span class="r0-bound"><input class="r0-in tiny" type="number" step="1" min="0" data-r0="offset-lo" aria-label="Index-date offset lower bound" /></span>
      <span class="r0-sep">–</span>
      <span class="r0-bound"><input class="r0-in tiny" type="number" step="1" min="0" data-r0="offset-hi" aria-label="Index-date offset upper bound" /></span>
      <span class="r0-muted">days head start</span>
    </div>
    <details class="r0-details" data-r0="itv-details">
      <summary>Interventions — time-varying transmission R(t) · <span class="r0-muted" data-r0="itv-count"></span></summary>
      <p class="r0-blurb">Public-health interventions reduce the <b>MODEL's</b> transmission over time:
        R(t) = R₀ × Π (1 − effectiveReduction(params at day t)), applied per day inside every simulation
        the fit runs. Each intervention carries the SAME parameters as the main sim's controls
        (mask/vaccine: Rate, Protection, Source control, Mortality reduction; lockdown: Mobility,
        Transmission reduction, Compliance; quarantine: Detection rate, Contacts range, Protection,
        Source control, Duration), and any parameter can be KEYFRAMED over time (⏱: day → value points,
        linear between, held at the ends — interventions persist indefinitely unless keyframed down;
        days before day 0 or beyond the data are fine). This is separate from the <i>case/death
        adjustment</i> in section 1, which corrects the reported DATA for under-ascertainment and never
        changes the model. Keyframe windows are shaded on the chart. Deterministic; "Apply to simulation"
        carries the fitted genes but not these schedules.</p>
      <div data-r0="itv-list"></div>
      <div class="r0-actions">
        <button class="btn ghost" type="button" data-r0="itv-add">+ Add intervention</button>
      </div>
    </details>
  </section>

  <section class="r0-section">
    <h3>3 · Run</h3>
    <div class="r0-run-controls">
      <div class="r0-toggle" role="group" aria-label="Search strategy">
        <button class="r0-toggle-btn" type="button" data-opt="genetic" title="Population-based global evolutionary search — robust on rugged, multimodal surfaces">Genetic algorithm</button>
        <button class="r0-toggle-btn" type="button" data-opt="local" title="Grid/Latin-hypercube sample → Nelder–Mead local refine">Local search</button>
      </div>
      <div class="r0-toggle" role="group" aria-label="Loss function">
        <button class="r0-toggle-btn active" type="button" data-loss="poisson" title="Maximum-likelihood for count data">Poisson NLL</button>
        <button class="r0-toggle-btn" type="button" data-loss="mse" title="Plain least-squares">MSE</button>
      </div>
      <label class="r0-field r0-field-inline">
        <span>Max trials per candidate: <b data-r0="k-label">30</b></span>
        <input type="range" min="10" max="100" step="5" data-r0="k" />
      </label>
      <label class="r0-field r0-field-inline" title="After the fit, sample the parameter posterior with a SEEDED Metropolis chain (flat priors within the search bounds), simulate each draw's curve, and shade the 5–95% posterior-predictive band with LOW / CENTRAL / HIGH readouts. This is calibrated parameter-uncertainty propagation — distinct from the index-date profile-likelihood CI (a parameter interval), and it replaces the old uncalibrated index-case ensemble band. Deterministic: same seed → same band. 0 = off.">
        <span>Posterior draws (Bayes band)</span>
        <input class="r0-in tiny" type="number" min="0" max="500" step="10" data-r0="fan" />
      </label>
      <label class="r0-field r0-field-inline" title="After the fit, re-simulate the best-fit disease N times, each trial seeding the outbreak at a DIFFERENT board cell (a deterministic sample of index-case locations — the practical equivalent of trying every other cell), under the same fitted R(t) schedule. The 5–95% and 25–75% spread shades the chart as a soft density with a dotted median. This is PREDICTIVE spread (stochastic path + starting point) — naturally wider than the Bayes band, which only propagates parameter uncertainty. Deterministic: same settings → same band. 0 = off.">
        <span>Index-case ensemble (density)</span>
        <input class="r0-in tiny" type="number" min="0" max="256" step="8" data-r0="ens" />
      </label>
      <label class="r0-field r0-field-inline" title="Project the fitted model this many days beyond the data's last day — the curve (and the Bayesian band) extends into the future. Deterministic.">
        <span>Predict (days ahead)</span>
        <input class="r0-in tiny" type="number" min="0" max="365" step="1" data-r0="pred" />
      </label>
    </div>
    <div class="r0-ga" data-r0="ga-controls">
      <details class="r0-details">
      <summary>Advanced search settings (GA hyperparameters)</summary>
      <p class="r0-blurb">Evolves a population of disease genomes — selection, crossover, and Gaussian mutation — like the simulation's own strain mutation. Larger population / more generations search harder.</p>
      <div class="r0-ga-grid">
        <label class="r0-field r0-field-inline"><span>Population</span><input class="r0-in tiny" type="number" min="8" max="200" step="1" data-ga="population" /></label>
        <label class="r0-field r0-field-inline"><span>Generations</span><input class="r0-in tiny" type="number" min="1" max="100" step="1" data-ga="generations" /></label>
        <label class="r0-field r0-field-inline"><span>Mutation rate</span><input class="r0-in tiny" type="number" min="0" max="1" step="0.05" data-ga="mutationRate" /></label>
        <label class="r0-field r0-field-inline"><span>Crossover rate</span><input class="r0-in tiny" type="number" min="0" max="1" step="0.05" data-ga="crossoverRate" /></label>
        <label class="r0-field r0-field-inline"><span>Elitism</span><input class="r0-in tiny" type="number" min="0" max="20" step="1" data-ga="elitism" /></label>
        <label class="r0-field r0-field-inline"><span>Tournament</span><input class="r0-in tiny" type="number" min="2" max="10" step="1" data-ga="tournament" /></label>
      </div>
      </details>
    </div>
    <div class="r0-actions">
      <button class="btn primary" type="button" data-r0="run">Run fit</button>
      <button class="btn ghost" type="button" data-r0="cancel" disabled>Cancel</button>
      <div class="r0-progress" data-r0="progress"><div class="r0-progress-fill" data-r0="progress-fill"></div></div>
      <span class="r0-progress-pct" data-r0="progress-pct"></span>
    </div>
    <p class="r0-note" data-r0="note" role="status" aria-live="polite"></p>
  </section>
  </div>

  <div class="r0-col r0-col-out">
  <section class="r0-section r0-section-result">
    <h3>Result</h3>
    <div data-r0="output"></div>
    <div class="r0-actions">
      <button class="btn primary" type="button" data-r0="apply" disabled>Apply to simulation</button>
    </div>
    <details class="r0-details">
      <summary>Fit history · <span class="r0-muted" data-r0="history-count"></span></summary>
      <div data-r0="history"></div>
    </details>
  </section>
  </div>
  </div>
`;
