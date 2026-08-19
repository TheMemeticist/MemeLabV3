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
import type { SimConfig } from '../types';
import { FitPool } from '../lib/fit-pool';
import { read, remove, write } from '../lib/storage';
import {
  CATEGORY_LABELS,
  FIT_CATEGORIES,
  FIT_PARAMS,
  hasDownwardRevisions,
  parseObservedCSV,
  percentileBands,
  resolutionFitSize,
  revisionEnvelope,
  runFit,
  vintagedAdjust,
} from '../lib/fit';
import type {
  FitCategory,
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
  /** Push the fitted config back into the simulation. */
  onApply: (config: SimConfig) => void;
}

// Per-category overlay colors (line = simulated, dots = observed).
const CAT_COLOR: Record<FitCategory, string> = {
  cumulative_infections: 'rgb(59, 130, 246)',
  cumulative_deaths: 'rgb(239, 68, 68)',
  active_infections: 'rgb(34, 197, 94)',
};

// Greyed ink for raw points superseded by the revision cleaning.
const RAW_INK = 'rgba(148, 163, 184, 0.55)';

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

// Fan-chart percentiles: median + 25% band (37.5–62.5), 50% band (25–75), 90% band (5–95).
const FAN_PROBS = [5, 25, 37.5, 50, 62.5, 75, 95];

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
  fanTrials?: number;
  adjust?: AdjustSettings;
  offsetEvolve?: boolean;
  offsetBounds?: [number, number];
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
  // Fan-chart ensemble size: trials of the best-fit config, each from a
  // different index case, aggregated into percentile bands. 1 = single line.
  private fanTrials = 30;
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

  // Live-chart state (set by createChart, read by updateChartData) + an rAF
  // throttle so a burst of optimizer improvements coalesces into one redraw.
  private liveObserved: ObservedPoint[] = [];
  private liveCats: FitCategory[] = [];
  // Per-category greyed raw-overlay columns (null = category has no revisions);
  // parallel to liveCats, cached so live frames rebuild the same data shape.
  private liveRawCols: ((number | null)[] | null)[] = [];
  // Fan-chart percentile rows (people-scaled, FAN_PROBS order) per category, and
  // sparse floor/central/upper vertices for the adjustment envelope — painted by
  // a custom uPlot draw hook so the chart's data columns / legend stay untouched.
  private liveFanCols: Partial<Record<FitCategory, number[][]>> | null = null;
  private liveAdjustPts: Partial<Record<FitCategory, { floor: [number, number][]; central: [number, number][]; upper: [number, number][] }>> | null = null;
  // Highest overlay value (people) so y-autoscale includes bands above the data.
  private overlayMax = 0;
  // During an offset-evolving fit the dots sit at raw days; slide the model line
  // right by the current best candidate's offset so the two stay aligned.
  private liveModelShift = 0;
  // Index-date profile-CI marker for the final chart (x = plausible positions of
  // the first observation given the CI; line = where it actually sits).
  private liveOffsetBand: { lo95: number; hi95: number; lo68: number; hi68: number; at: number } | null = null;
  private liveDays = 0;
  private livePop = 0;
  private pendingSnapshot: FitProgress | null = null;
  private rafId = 0;

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
        <button class="r0-close" type="button" aria-label="Close">×</button>
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
    if (saved) this.showRestoreBanner();
    if (!saved) void this.loadDemo();
  }

  close(): void {
    if (!this.el) return;
    if (!this.skipPersist) this.persist();
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
      fanTrials: this.fanTrials,
      adjust: { ...this.adjust },
      offsetEvolve: this.offsetEvolve,
      offsetBounds: [...this.offsetBounds] as [number, number],
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
    if (Number.isFinite(s.fanTrials)) this.fanTrials = Math.min(100, Math.max(1, Math.round(s.fanTrials!)));
    if (s.adjust && typeof s.adjust === 'object') this.adjust = { ...DEFAULT_ADJUST, ...s.adjust };
    if (typeof s.offsetEvolve === 'boolean') this.offsetEvolve = s.offsetEvolve;
    if (Array.isArray(s.offsetBounds) && s.offsetBounds.length === 2) {
      const lo = Math.max(0, Math.round(s.offsetBounds[0]));
      this.offsetBounds = [lo, Math.max(lo, Math.round(s.offsetBounds[1]))];
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
      <button class="r0-banner-x" type="button" aria-label="Dismiss">×</button>
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
    this.fanTrials = 30;
    this.adjust = { ...DEFAULT_ADJUST };
    this.offsetEvolve = true;
    this.offsetBounds = [0, 28];
    this.lastRaw = null;
    this.lastAdjust = null;
    this.lastFan = null;
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
      if (p) this.loadDataset(p.points, p.population);
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

    // Fan-chart trials (percentile bands around the best fit).
    const fanInput = q<HTMLInputElement>('[data-r0="fan"]');
    fanInput.value = String(this.fanTrials);
    fanInput.addEventListener('change', () => {
      const v = Number(fanInput.value);
      this.fanTrials = Number.isFinite(v) ? Math.min(100, Math.max(1, Math.round(v))) : 30;
      fanInput.value = String(this.fanTrials);
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
    q<HTMLButtonElement>('[data-r0="cancel"]').addEventListener('click', () => { this.signal.aborted = true; });
    q<HTMLButtonElement>('[data-r0="apply"]').addEventListener('click', () => {
      if (!this.result) return;
      this.events.onApply(this.result.config);
      this.close(); // dismiss so the user lands back on the running simulation
    });
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
        <button class="r0-del" type="button" aria-label="Delete row" title="Delete">×</button>
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
          <button class="r0-del" type="button" aria-label="Delete keyframe" ${frames.length <= 1 ? 'disabled' : ''}>×</button>
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
    this.liveOffsetBand = null;
    this.liveModelShift = 0;
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
      warnings.push(`fit ran at ${base.size}×${base.size} for resolution — enlarge the live grid before Apply to reproduce`);
    }
    if (liveSize > FIT_GRID_CAP) {
      warnings.push(`fitting on a ${FIT_GRID_CAP}×${FIT_GRID_CAP} grid for speed — on a larger grid the outbreak spreads farther per capita, so deaths may not reproduce exactly`);
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
        optimizer: this.optimizer,
        gaPopulation: this.ga.population,
        gaGenerations: this.ga.generations,
        gaMutationRate: this.ga.mutationRate,
        gaCrossoverRate: this.ga.crossoverRate,
        gaElitism: this.ga.elitism,
        gaTournament: this.ga.tournament,
        simulate: (cfg, days, K, seed) => this.pool!.simulate(cfg, days, K, seed),
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
        // Fan chart: re-run the best config as an ensemble (each trial from a
        // different index case) and aggregate into percentile bands. Display
        // only — the fit result above is already final. Deterministic in
        // (config, days, N, seed).
        if (this.fanTrials > 1 && this.pool) {
          this.note(`Computing confidence bands (${this.fanTrials} trials)…`);
          try {
            const ens = await this.pool.simulateEnsemble(
              this.result.config, this.result.days, this.fanTrials, base.seed,
            );
            if (ens.perTrial?.length) this.lastFan = percentileBands(ens.perTrial, FAN_PROBS);
          } catch { /* bands are optional — the fit result stands without them */ }
        }
        // Record the fit in the history, keyed by the effective dataset it ran
        // against, so the table only ranks like-for-like.
        this.history.unshift({
          t: Date.now(),
          hash: datasetHash(observed, this.population),
          presetId: this.presetId,
          result: this.result,
        });
        if (this.history.length > HISTORY_CAP) this.history.length = HISTORY_CAP;
        this.persist();
        this.renderOutput();
        this.renderHistory();
        this.note(warnings.length ? `Fit complete. ⚠ ${warnings.join(' · ')}` : 'Fit complete.');
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
      // Slide the model line to the candidate's index-date offset so it aligns
      // with the raw-day data dots while the offset is being evolved.
      this.liveModelShift = s.indexOffset ?? 0;
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

  /** Load a fixed observed dataset (a historical preset) into the table. */
  private loadDataset(points: ObservedPoint[], population: number): void {
    this.observed = points.map((p) => ({ ...p }));
    this.population = population;
    const popInput = this.el?.querySelector<HTMLInputElement>('[data-r0="population"]');
    if (popInput) popInput.value = String(population);
    this.result = null;
    this.renderTable();
    this.renderOutput();
    this.persist();
    this.note('Dataset loaded — press Run fit.');
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
    const days = Math.max(1, ...observed.map((p) => Math.round(p.day)));

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
        </tr>`);

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
        </div>
        <table class="r0-params-table">
          <thead><tr><th>Fitted parameter</th><th>Value</th></tr></thead>
          <tbody>${paramRows}</tbody>
        </table>
      </div>
      <div class="r0-chart" data-r0="chart"></div>
    `;
    this.createChart(r.observed, r.days, r.population, this.lastRaw, this.lastAdjust, this.lastFan);
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
          this.liveOffsetBand = null;
          this.renderOutput();
          this.note('Loaded fit from history.');
        });
        row.querySelector<HTMLButtonElement>('[data-act="apply"]')!.addEventListener('click', () => {
          this.events.onApply(e.result.config);
          this.close();
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
    // only onImprove sets a nonzero shift while an offset-evolving fit runs.
    this.liveModelShift = 0;
    this.liveFanCols = null;
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
        series.push({
          label: `${CAT_SHORT[cat]} · raw`,
          stroke: RAW_INK,
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
        // Percentile fan + floor/central/upper envelope are painted directly on
        // the canvas (below the series, which redraw after this hook) so the
        // data columns and legend stay exactly as before.
        hooks: { draw: [(u) => this.paintOverlays(u)] },
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
  }

  /** Push fresh simulated curves into the existing plot (observed dots unchanged).
   *  Must rebuild the exact column shape createChart declared — including the
   *  greyed raw-overlay columns for categories that have them. */
  private updateChartData(curves: SimCurves): void {
    if (!this.plot) return;
    const xs = this.chartXs(this.liveDays);
    const data: (number | null)[][] = [xs];
    this.liveCats.forEach((cat, ci) => {
      // When a percentile fan is cached, the central line is the MEDIAN (p50)
      // of the ensemble — for N=1 that is exactly the single trial — instead
      // of the fit's mean curve, so the line always sits inside its bands.
      const p50 = this.liveFanCols?.[cat]?.[FAN_PROBS.indexOf(50)];
      const arr = p50 ?? curves[cat] ?? [];
      const scale = p50 ? 1 : this.livePop; // fan rows are already people-scaled
      const shift = p50 ? 0 : this.liveModelShift; // fan renders post-fit, already aligned
      const sim = xs.map((d) => (arr[Math.min(d + shift, arr.length - 1)] ?? 0) * scale);
      const obs: (number | null)[] = xs.map(() => null);
      for (const pt of this.liveObserved) {
        if (pt.category !== cat) continue;
        const d = Math.round(pt.day);
        if (d >= 0 && d <= this.liveDays) obs[d] = pt.value;
      }
      data.push(sim, obs);
      const rawCol = this.liveRawCols[ci];
      if (rawCol) data.push(rawCol);
    });
    this.plot.setData(data as uPlot.AlignedData);
  }

  /** Canvas-paint the percentile fan (25% / 50% / 90% bands around the median)
   *  and the adjustment envelope (floor / central / upper) for each category.
   *  Runs as a uPlot draw hook; series redraw on top. */
  private paintOverlays(u: uPlot): void {
    const fan = this.liveFanCols;
    const adj = this.liveAdjustPts;
    if (!fan && !adj && !this.liveOffsetBand) return;
    const ctx = u.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    ctx.clip();
    const X = (d: number): number => u.valToPos(d, 'x', true);
    const Y = (v: number): number => u.valToPos(v, 'y', true);
    // Index-date profile-CI marker: the grey band spans the plausible positions
    // of the FIRST OBSERVATION under the CI (darker = 68%), with a dashed line
    // where the fitted offset actually anchors it.
    const ob = this.liveOffsetBand;
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
    for (const cat of this.liveCats) {
      const color = CAT_COLOR[cat];
      const rows = fan?.[cat];
      if (rows) {
        // FAN_PROBS = [5, 25, 37.5, 50, 62.5, 75, 95] → (lo, hi, alpha) pairs.
        const pairs: [number, number, number][] = [[0, 6, 0.07], [1, 5, 0.13], [2, 4, 0.2]];
        for (const [lo, hi, alpha] of pairs) {
          ctx.beginPath();
          rows[hi].forEach((v, d) => { if (d === 0) ctx.moveTo(X(0), Y(v)); else ctx.lineTo(X(d), Y(v)); });
          for (let d = rows[lo].length - 1; d >= 0; d--) ctx.lineTo(X(d), Y(rows[lo][d]));
          ctx.closePath();
          ctx.fillStyle = withAlpha(color, alpha);
          ctx.fill();
        }
      }
      const a = adj?.[cat];
      if (a && a.upper.length > 1) {
        ctx.beginPath();
        a.upper.forEach(([d, v], i) => { if (i === 0) ctx.moveTo(X(d), Y(v)); else ctx.lineTo(X(d), Y(v)); });
        for (let i = a.floor.length - 1; i >= 0; i--) ctx.lineTo(X(a.floor[i][0]), Y(a.floor[i][1]));
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.08);
        ctx.fill();
        const stroke = (pts: [number, number][], alpha: number, dash: number[]): void => {
          if (pts.length < 2) return;
          ctx.beginPath();
          pts.forEach(([d, v], i) => { if (i === 0) ctx.moveTo(X(d), Y(v)); else ctx.lineTo(X(d), Y(v)); });
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
  <div class="r0-banner" data-r0="banner" hidden></div>
  <header class="r0-head">
    <div class="r0-titles">
      <h2 id="r0-title">R₀ Estimator</h2>
      <p class="r0-tag">Fit an observed outbreak curve back to disease parameters.</p>
    </div>
  </header>

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
    <div class="r0-actions">
      <label class="r0-check" title="Search the index date during the fit: the offset becomes an evolved, bounded integer parameter (like the other ranges), deterministic and seeded. The fitted value is written back into the offset field above, and a profile-likelihood CI for it is reported with the result.">
        <input type="checkbox" data-r0="offset-evolve" /> evolve index date within
      </label>
      <span class="r0-bound"><input class="r0-in tiny" type="number" step="1" min="0" data-r0="offset-lo" aria-label="Index-date offset lower bound" /></span>
      <span class="r0-sep">–</span>
      <span class="r0-bound"><input class="r0-in tiny" type="number" step="1" min="0" data-r0="offset-hi" aria-label="Index-date offset upper bound" /></span>
      <span class="r0-muted">days head start</span>
    </div>
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
      <label class="r0-field r0-field-inline" title="After the fit, re-run the best-fit disease this many times — each run starting from a DIFFERENT index case on the board — and shade the spread as percentile bands (25% / 50% / 90%) around the median. Caveat: trials are deterministic seeded realizations, so the bands quantify stochastic-path + index-case-location spread, not a Bayesian posterior over parameters. 1 = single line.">
        <span>Fan-chart trials</span>
        <input class="r0-in tiny" type="number" min="1" max="100" step="1" data-r0="fan" />
      </label>
    </div>
    <div class="r0-ga" data-r0="ga-controls">
      <p class="r0-blurb">Evolves a population of disease genomes — selection, crossover, and Gaussian mutation — like the simulation's own strain mutation. Larger population / more generations search harder.</p>
      <div class="r0-ga-grid">
        <label class="r0-field r0-field-inline"><span>Population</span><input class="r0-in tiny" type="number" min="8" max="200" step="1" data-ga="population" /></label>
        <label class="r0-field r0-field-inline"><span>Generations</span><input class="r0-in tiny" type="number" min="1" max="100" step="1" data-ga="generations" /></label>
        <label class="r0-field r0-field-inline"><span>Mutation rate</span><input class="r0-in tiny" type="number" min="0" max="1" step="0.05" data-ga="mutationRate" /></label>
        <label class="r0-field r0-field-inline"><span>Crossover rate</span><input class="r0-in tiny" type="number" min="0" max="1" step="0.05" data-ga="crossoverRate" /></label>
        <label class="r0-field r0-field-inline"><span>Elitism</span><input class="r0-in tiny" type="number" min="0" max="20" step="1" data-ga="elitism" /></label>
        <label class="r0-field r0-field-inline"><span>Tournament</span><input class="r0-in tiny" type="number" min="2" max="10" step="1" data-ga="tournament" /></label>
      </div>
    </div>
    <div class="r0-actions">
      <button class="btn primary" type="button" data-r0="run">Run fit</button>
      <button class="btn ghost" type="button" data-r0="cancel" disabled>Cancel</button>
      <div class="r0-progress" data-r0="progress"><div class="r0-progress-fill" data-r0="progress-fill"></div></div>
      <span class="r0-progress-pct" data-r0="progress-pct"></span>
    </div>
    <p class="r0-note" data-r0="note" role="status" aria-live="polite"></p>
  </section>

  <section class="r0-section">
    <h3>4 · Result</h3>
    <div data-r0="output"></div>
    <div class="r0-actions">
      <button class="btn primary" type="button" data-r0="apply" disabled>Apply to simulation</button>
    </div>
    <details class="r0-details">
      <summary>Fit history · <span class="r0-muted" data-r0="history-count"></span></summary>
      <div data-r0="history"></div>
    </details>
  </section>
`;
