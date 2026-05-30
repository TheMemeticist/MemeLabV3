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
  FitResult,
  LossType,
  ObservedPoint,
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
  private running = false;
  private signal = { aborted: false };
  private result: FitResult | null = null;

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

    this.bindControls();
    this.renderTable();
    this.renderParams();
    this.renderOutput();
    // Populate with a self-consistent, engine-generated demo on first open.
    void this.loadDemo();
  }

  close(): void {
    if (!this.el) return;
    document.removeEventListener('keydown', this.onKey);
    this.signal.aborted = true;
    this.plot?.destroy();
    this.plot = null;
    this.pool?.dispose();
    this.pool = null;
    const e = this.el;
    this.el = null;
    e.classList.add('r0-out');
    setTimeout(() => e.remove(), 200);
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
      if (Number.isFinite(v) && v > 0) this.population = v;
    });

    q<HTMLButtonElement>('[data-r0="add-row"]').addEventListener('click', () => {
      const lastDay = this.observed.length ? Math.max(...this.observed.map((p) => p.day)) : 0;
      this.observed.push({ day: lastDay + 1, value: 0, category: 'cumulative_infections' });
      this.renderTable();
    });

    // Populate the dataset picker with the historical presets and wire loading.
    const preset = q<HTMLSelectElement>('[data-r0="preset"]');
    for (const p of HISTORICAL_PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      preset.appendChild(opt);
    }
    preset.addEventListener('change', () => {
      if (preset.value === 'synthetic') { void this.loadDemo(); return; }
      const p = HISTORICAL_PRESETS.find((x) => x.id === preset.value);
      if (p) this.loadDataset(p.points, p.population);
    });

    q<HTMLButtonElement>('[data-r0="clear"]').addEventListener('click', () => {
      this.observed = [];
      this.result = null;
      this.renderTable();
      this.renderOutput();
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

    this.el!.querySelectorAll<HTMLButtonElement>('[data-loss]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.loss = btn.dataset['loss'] as LossType;
        this.el!.querySelectorAll<HTMLButtonElement>('[data-loss]').forEach((b) =>
          b.classList.toggle('active', b === btn));
      });
    });

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
      });
      row.querySelector<HTMLInputElement>('[data-col="value"]')!.addEventListener('change', (e) => {
        pt.value = Number((e.target as HTMLInputElement).value);
      });
      row.querySelector<HTMLSelectElement>('[data-col="category"]')!.addEventListener('change', (e) => {
        pt.category = (e.target as HTMLSelectElement).value as FitCategory;
      });
      row.querySelector<HTMLButtonElement>('.r0-del')!.addEventListener('click', () => {
        this.observed.splice(idx, 1);
        this.renderTable();
      });
      tbody.appendChild(row);
    });
    const count = this.el!.querySelector<HTMLElement>('[data-r0="row-count"]');
    if (count) count.textContent = `${this.observed.length} point${this.observed.length === 1 ? '' : 's'}`;
  }

  // ── Parameter checkboxes + bounds ──
  private renderParams(): void {
    const host = this.el!.querySelector<HTMLElement>('[data-r0="params"]')!;
    host.innerHTML = '';
    for (const p of FIT_PARAMS) {
      const b = this.bounds.get(p.name)!;
      const wrap = document.createElement('label');
      wrap.className = 'r0-param';
      wrap.innerHTML = `
        <input type="checkbox" ${this.selected.has(p.name) ? 'checked' : ''} />
        <span class="r0-param-name">${p.label}</span>
        <span class="r0-param-bounds">
          <input class="r0-in tiny" type="number" step="any" value="${b[0]}" aria-label="${p.label} lower bound" />
          <span>–</span>
          <input class="r0-in tiny" type="number" step="any" value="${b[1]}" aria-label="${p.label} upper bound" />
        </span>
      `;
      const cb = wrap.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      const bounds = wrap.querySelectorAll<HTMLInputElement>('.r0-param-bounds input');
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(p.name);
        else this.selected.delete(p.name);
      });
      bounds[0].addEventListener('change', () => { b[0] = Number(bounds[0].value); });
      bounds[1].addEventListener('change', () => { b[1] = Number(bounds[1].value); });
      host.appendChild(wrap);
    }
  }

  // ── Run the fit ──
  private async run(): Promise<void> {
    if (this.running || !this.pool) return;
    if (this.observed.length < 2) { this.note('Add at least two observed points.'); return; }
    const params = this.activeParams();
    if (params.length === 0) { this.note('Select at least one parameter to fit.'); return; }

    this.running = true;
    this.signal = { aborted: false };
    this.setRunning(true);
    const bar = this.el!.querySelector<HTMLElement>('[data-r0="progress-fill"]')!;
    bar.style.width = '0%';

    const base = this.fitBaseConfig();
    try {
      const result = await runFit({
        observed: this.observed.filter((p) => Number.isFinite(p.day) && Number.isFinite(p.value)),
        baseConfig: base,
        params,
        population: this.population,
        K: this.K,
        loss: this.loss,
        simulate: (cfg, days, K, seed) => this.pool!.simulate(cfg, days, K, seed),
        signal: this.signal,
        onProgress: (frac) => { bar.style.width = `${Math.round(frac * 100)}%`; },
      });
      if (this.signal.aborted) { this.note('Fit cancelled.'); }
      else { this.result = result; this.renderOutput(); this.note('Fit complete.'); }
    } catch (err) {
      this.note(`Fit failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
      this.setRunning(false);
    }
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
      const popInput = this.el?.querySelector<HTMLInputElement>('[data-r0="population"]');
      if (popInput) popInput.value = String(DEMO_POP);
      this.renderTable();
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
    this.note('Dataset loaded — press Run fit.');
  }

  private activeParams(): FitParamDef[] {
    return FIT_PARAMS.filter((p) => this.selected.has(p.name)).map((p) => ({
      ...p,
      bounds: this.bounds.get(p.name)!,
    }));
  }

  private setRunning(on: boolean): void {
    const run = this.el!.querySelector<HTMLButtonElement>('[data-r0="run"]')!;
    const cancel = this.el!.querySelector<HTMLButtonElement>('[data-r0="cancel"]')!;
    run.disabled = on;
    cancel.disabled = !on;
    this.el!.querySelector('[data-r0="progress"]')!.classList.toggle('active', on);
  }

  // ── Output: stats + uPlot overlay ──
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
    const ci = r.r0CI ? `${r.r0CI[0].toFixed(2)} – ${r.r0CI[1].toFixed(2)}` : '—';
    const paramRows = r.params
      .map((p) => `<tr><td>${p.label}</td><td>${fmtParam(p.name, p.value)}</td></tr>`)
      .join('');

    host.innerHTML = `
      <div class="r0-result-grid">
        <div class="r0-metric r0-metric-hero">
          <span class="r0-metric-label">Basic reproduction number</span>
          <span class="r0-metric-value">R₀ = ${r0}</span>
          <span class="r0-metric-sub">95% CI ${ci}</span>
        </div>
        <div class="r0-metric">
          <span class="r0-metric-label">Goodness of fit</span>
          <span class="r0-metric-value">R² = ${r.gof.r2.toFixed(3)}</span>
          <span class="r0-metric-sub">RMSE ${fmtNum(r.gof.rmse)}</span>
        </div>
        <table class="r0-params-table">
          <thead><tr><th>Fitted parameter</th><th>Value</th></tr></thead>
          <tbody>${paramRows}</tbody>
        </table>
      </div>
      <div class="r0-chart" data-r0="chart"></div>
    `;
    this.drawChart(r);
  }

  private drawChart(r: FitResult): void {
    const host = this.el!.querySelector<HTMLElement>('[data-r0="chart"]')!;
    this.plot?.destroy();
    this.plot = null;

    const cats = FIT_CATEGORIES.filter((c) => r.observed.some((p) => p.category === c));
    const xs: number[] = [];
    for (let d = 0; d <= r.days; d++) xs.push(d);

    const data: (number | null)[][] = [xs];
    const series: uPlot.Series[] = [{}];
    for (const cat of cats) {
      const sim = xs.map((d) => (r.simulated[cat][Math.min(d, r.simulated[cat].length - 1)] ?? 0) * r.population);
      const obs: (number | null)[] = xs.map(() => null);
      for (const pt of r.observed) {
        if (pt.category !== cat) continue;
        const d = Math.round(pt.day);
        if (d >= 0 && d <= r.days) obs[d] = pt.value;
      }
      data.push(sim, obs);
      series.push(
        { label: `${CATEGORY_LABELS[cat]} (sim)`, stroke: CAT_COLOR[cat], width: 2 },
        {
          label: `${CATEGORY_LABELS[cat]} (obs)`,
          stroke: CAT_COLOR[cat],
          paths: () => null, // dots only
          points: { show: true, size: 7, stroke: CAT_COLOR[cat], fill: '#fff' },
        },
      );
    }

    const w = host.clientWidth || 520;
    this.plot = new uPlot(
      {
        width: w,
        height: 260,
        legend: { show: true },
        scales: { x: { time: false } },
        axes: [
          { label: 'Day' },
          { label: 'Count', size: 64 },
        ],
        series,
      },
      data as uPlot.AlignedData,
      host,
    );
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
    <div class="r0-table">
      <div class="r0-row r0-row-head">
        <span>Day</span><span>Value</span><span>Category</span><span></span>
      </div>
      <div data-r0="rows"></div>
    </div>
    <div class="r0-actions">
      <label class="r0-check" style="gap:6px">Dataset
        <select class="r0-in" data-r0="preset" aria-label="Load a dataset">
          <option value="synthetic">Synthetic (auto-generated)</option>
        </select>
      </label>
      <button class="btn ghost" type="button" data-r0="add-row">+ Add row</button>
      <button class="btn ghost" type="button" data-r0="clear">Clear</button>
      <span class="r0-muted" data-r0="row-count"></span>
    </div>
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
      <div class="r0-toggle" role="group" aria-label="Loss function">
        <button class="r0-toggle-btn active" type="button" data-loss="poisson" title="Maximum-likelihood for count data">Poisson NLL</button>
        <button class="r0-toggle-btn" type="button" data-loss="mse" title="Plain least-squares">MSE</button>
      </div>
      <label class="r0-field r0-field-inline">
        <span>Trials per candidate: <b data-r0="k-label">30</b></span>
        <input type="range" min="10" max="100" step="5" data-r0="k" />
      </label>
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
