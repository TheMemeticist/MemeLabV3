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
import { read, write } from '../lib/storage';
import {
  CATEGORY_LABELS,
  FIT_CATEGORIES,
  FIT_PARAMS,
  parseObservedCSV,
  runFit,
} from '../lib/fit';
import type {
  FitCategory,
  FitParamDef,
  FitParamName,
  FitProgress,
  FitResult,
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
  private indexOffset = 0;
  // Genetic algorithm is the default search — global and robust on MemeLab's rugged,
  // multimodal loss surfaces, and it evolves the disease genome the way the sim does.
  private optimizer: OptimizerKind = 'genetic';
  private ga: GASettings = { ...DEFAULT_GA };
  private presetId = 'synthetic';
  private running = false;
  private signal = { aborted: false };
  private result: FitResult | null = null;

  // Live-chart state (set by createChart, read by updateChartData) + an rAF
  // throttle so a burst of optimizer improvements coalesces into one redraw.
  private liveObserved: ObservedPoint[] = [];
  private liveCats: FitCategory[] = [];
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
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) this.close(); });
    document.addEventListener('keydown', this.onKey);

    // Restore the previous session if one was saved; otherwise fall back to the
    // self-consistent, engine-generated demo on first open.
    const saved = read<R0Snapshot | null>(STORAGE_KEY, null);
    if (saved) this.hydrate(saved);

    this.bindControls();
    this.renderTable();
    this.renderParams();
    this.renderOutput();
    if (!saved) void this.loadDemo();
  }

  close(): void {
    if (!this.el) return;
    this.persist();
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

  // ── Run the fit ──
  private async run(): Promise<void> {
    if (this.running || !this.pool) return;
    if (this.observed.length < 2) { this.note('Add at least two observed points.'); return; }

    // Shift every observed day later in model time by the index-case offset, so the
    // simulated outbreak (which starts at model day 0) gets a head start before the
    // first reported case — correcting for early under-detection.
    const off = this.indexOffset || 0;
    const observed = this.observed
      .filter((p) => Number.isFinite(p.day) && Number.isFinite(p.value))
      .map((p) => (off ? { ...p, day: p.day + off } : p));
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

    this.renderLive(observed); // persistent chart + provisional metrics, updated live
    if (expanded) this.note('Timing params added (your data spans the peak) — fitting…');

    const base = this.fitBaseConfig();
    try {
      const result = await runFit({
        observed,
        baseConfig: base,
        params,
        population: this.population,
        K: this.K,
        loss: this.loss,
        optimizer: this.optimizer,
        gaPopulation: this.ga.population,
        gaGenerations: this.ga.generations,
        gaMutationRate: this.ga.mutationRate,
        gaCrossoverRate: this.ga.crossoverRate,
        gaElitism: this.ga.elitism,
        gaTournament: this.ga.tournament,
        simulate: (cfg, days, K, seed) => this.pool!.simulate(cfg, days, K, seed),
        signal: this.signal,
        onProgress: (frac) => { bar.style.width = `${Math.round(frac * 100)}%`; },
        onImprove: (p) => this.onImprove(p),
      });
      if (this.signal.aborted) { this.note('Fit cancelled.'); }
      else {
        // The fit runs on a smaller grid for speed. For voronoi, R₀ scales with
        // the grid's node degree, so the reported R₀ would not match the value
        // the live sim shows after Apply. Recompute it on the user's real grid.
        this.note('Refining R₀ for your grid…');
        this.result = await this.reconcileR0(result);
        this.renderOutput();
        this.note('Fit complete.');
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
      this.updateChartData(s.curves);
      const r0El = this.el?.querySelector<HTMLElement>('[data-r0="live-r0"]');
      if (r0El) r0El.textContent = `R₀ = ${s.r0 == null ? '—' : s.r0.toFixed(2)}`;
      const lossEl = this.el?.querySelector<HTMLElement>('[data-r0="live-loss"]');
      if (lossEl) lossEl.textContent = fmtLoss(s.loss);
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
    cfg.size = Math.min(Math.max(cfg.size, 48), 80);
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
  private renderLive(observed: ObservedPoint[]): void {
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
          <span class="r0-metric-sub">loss — lower is better</span>
        </div>
      </div>
      <div class="r0-chart" data-r0="chart"></div>
    `;
    this.createChart(observed, days, this.population);
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
      .join('');

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
    this.createChart(r.observed, r.days, r.population);
    this.updateChartData(r.simulated);
  }

  /** Build the uPlot overlay once (observed dots + an empty sim line per
   *  category present in the data). `updateChartData` then streams sim curves in
   *  via setData — far cheaper than destroy/recreate, and the basis for the live
   *  update during a fit. */
  private createChart(observed: ObservedPoint[], days: number, population: number): void {
    const host = this.el!.querySelector<HTMLElement>('[data-r0="chart"]')!;
    this.plot?.destroy();
    this.plot = null;
    this.liveObserved = observed;
    this.liveDays = days;
    this.livePop = population;
    this.liveCats = FIT_CATEGORIES.filter((c) => observed.some((p) => p.category === c));

    // Legend readout: the model curves carry fractional means (fraction × pop), so
    // format them as compact counts instead of dumping a long-decimal float.
    const legendVal = (_u: uPlot, v: number | null): string =>
      v == null || !Number.isFinite(v) ? '–' : fmtNum(v);

    const xs = this.chartXs(days);
    const data: (number | null)[][] = [xs];
    const series: uPlot.Series[] = [{}];
    for (const cat of this.liveCats) {
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
    }

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
        scales: { x: { time: false } },
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

  /** Push fresh simulated curves into the existing plot (observed dots unchanged). */
  private updateChartData(curves: SimCurves): void {
    if (!this.plot) return;
    const xs = this.chartXs(this.liveDays);
    const data: (number | null)[][] = [xs];
    for (const cat of this.liveCats) {
      const arr = curves[cat] ?? [];
      const sim = xs.map((d) => (arr[Math.min(d, arr.length - 1)] ?? 0) * this.livePop);
      const obs: (number | null)[] = xs.map(() => null);
      for (const pt of this.liveObserved) {
        if (pt.category !== cat) continue;
        const d = Math.round(pt.day);
        if (d >= 0 && d <= this.liveDays) obs[d] = pt.value;
      }
      data.push(sim, obs);
    }
    this.plot.setData(data as uPlot.AlignedData);
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
    </div>
    <p class="r0-note" data-r0="note" role="status" aria-live="polite"></p>
  </section>

  <section class="r0-section">
    <h3>4 · Result</h3>
    <div data-r0="output"></div>
    <div class="r0-actions">
      <button class="btn primary" type="button" data-r0="apply" disabled>Apply to simulation</button>
    </div>
  </section>
`;
