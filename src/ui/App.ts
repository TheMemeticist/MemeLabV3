import type { FrameMessage, InterventionEvent, InterventionKey, SimConfig, WorkerCommand } from '../types';
import { findPreset, DEFAULT_PRESET_ID } from '../sim/presets';
import { Petri } from './Petri';
import { Chart, type ChartView } from './Chart';
import { Stats } from './Stats';
import { ControlPanel } from './ControlPanel';
import { Onboarding } from './Onboarding';
import { AboutModal } from './AboutModal';
import { installTooltip } from './Tooltip';
import { read, write } from '../lib/storage';
import { encode as encodeUrl, decode as decodeUrl, applyEncoded } from '../lib/url-state';
import { downloadText, downloadDataUrl, timestamp } from '../lib/export';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const BASE_TPS = 8;

export class App {
  private root: HTMLElement;
  private worker!: Worker;
  private petri!: Petri;
  private chart!: Chart;
  private stats!: Stats;
  private controls!: ControlPanel;

  private speedIdx = 2;
  private playing = false;
  private theme: 'petri' | 'lab' = 'petri';
  private toolbarBtns: Record<string, HTMLButtonElement> = {};
  private speedBtn!: HTMLButtonElement;
  private mutateBtn!: HTMLButtonElement;
  private themeBtn!: HTMLButtonElement;
  private permalinkBtn!: HTMLButtonElement;
  private exportBtn!: HTMLButtonElement;
  private aboutBtn!: HTMLButtonElement;
  private about = new AboutModal();
  private toastEl!: HTMLElement;
  private lastFrame: FrameMessage | null = null;
  private interventionEvents: InterventionEvent[] = [];
  private prevConfig: SimConfig | null = null;
  private epidemicStarted = false;
  private epidemicEnded = false;
  private endedBanner: HTMLElement | null = null;
  private chartView: ChartView = 'compartments';


  constructor(root: HTMLElement) {
    this.root = root;
  }

  start(): void {
    this.layout();
    installTooltip();

    // Hydrate config: URL > localStorage > default
    const defaults = this.defaultConfig();
    const fromUrl = location.hash ? decodeUrl(location.hash) : null;
    const fromLs = read<{ config: SimConfig; presetId: string; speed: number; theme: 'petri' | 'lab'; customName?: string | null } | null>('lastConfig', null);

    let initialConfig = defaults.config;
    let initialPresetId = defaults.presetId;
    let initialCustomName: string | null = null;
    if (fromUrl) {
      const applied = applyEncoded(fromUrl, defaults.config);
      initialConfig = applied.config;
      if (applied.presetId) initialPresetId = applied.presetId;
      if (applied.speed != null) this.speedIdx = clampInt(applied.speed, 0, SPEEDS.length - 1);
      if (applied.theme === 'lab' || applied.theme === 'petri') this.theme = applied.theme;
      const nameRaw = fromUrl.get('name');
      if (nameRaw) initialCustomName = decodeURIComponent(nameRaw);
    } else if (fromLs) {
      initialConfig = fromLs.config;
      initialPresetId = fromLs.presetId;
      this.speedIdx = clampInt(fromLs.speed ?? 2, 0, SPEEDS.length - 1);
      if (fromLs.theme === 'lab' || fromLs.theme === 'petri') this.theme = fromLs.theme;
      initialCustomName = fromLs.customName ?? null;
    }

    this.applyTheme();
    this.controls.hydrate(initialConfig, initialPresetId);
    this.controls.setCustomName(initialCustomName);
    this.refreshSpeedLabel();
    this.refreshMutateLabel();
    this.refreshThemeLabel();

    // Worker
    this.worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FrameMessage>) => this.onFrame(ev.data);
    this.send({ cmd: 'init', config: initialConfig });
    this.prevConfig = structuredClone(initialConfig);

    // Onboarding (first visit only)
    const onboarded = read<boolean>('onboarded', false);

    // Autoplay: returning visitors and people opening a permalink expect the
    // simulation to be running already. First-time visitors see onboarding
    // first; the onboarding "Run a SARS-2 outbreak" CTA presses play for them.
    if (onboarded || fromUrl) {
      // queueMicrotask so the worker `init` is processed before `play` arrives.
      queueMicrotask(() => {
        if (!this.playing) this.handlePlay();
      });
    }
    if (!onboarded) {
      const overlay = document.createElement('div');
      overlay.className = 'onboard-overlay';
      this.root.appendChild(overlay);
      new Onboarding(overlay, () => {
        write('onboarded', true);
        // Default disease (Andes Hantavirus) is already loaded; just press play.
        this.handlePlay();
        setTimeout(() => overlay.remove(), 260);
      });
      // Also dismiss overlay when card removes itself, and auto-play once
      // the user has acknowledged onboarding (CTA or "Explore on my own").
      const obs = new MutationObserver(() => {
        if (!overlay.querySelector('.onboard-card')) {
          overlay.remove();
          obs.disconnect();
          write('onboarded', true);
          if (!this.playing) this.handlePlay();
        }
      });
      obs.observe(overlay, { childList: true });
    }

    // Keyboard
    document.addEventListener('keydown', (e) => this.onKey(e));

    // Hash change
    window.addEventListener('hashchange', () => this.onHashChange());
  }

  private layout(): void {
    this.root.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <a class="brand-link" href="./" aria-label="MemeLab home">
            <svg class="brand-mark" viewBox="0 0 64 64" width="40" height="40" aria-hidden="true">
              <defs>
                <linearGradient id="bg-gloss" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="currentColor" stop-opacity="0.25"/>
                  <stop offset="1" stop-color="currentColor" stop-opacity="0.05"/>
                </linearGradient>
              </defs>
              <circle cx="32" cy="32" r="28" fill="url(#bg-gloss)" stroke="currentColor" stroke-width="2"/>
              <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.45"/>
              <path d="M32 14 C 28 18, 28 22, 32 26 C 36 30, 36 34, 32 38 C 28 42, 28 46, 32 50"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M28 17 L36 17 M28 23 L36 23 M28 35 L36 35 M28 41 L36 41 M28 47 L36 47"
                    stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              <circle cx="46" cy="22" r="4.5" fill="currentColor"/>
              <circle cx="46" cy="22" r="2" fill="var(--bg-elevated, #fff)"/>
              <g stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
                <line x1="46" y1="14.5" x2="46" y2="11"/>
                <line x1="46" y1="29.5" x2="46" y2="33"/>
                <line x1="40" y1="22" x2="36.5" y2="22"/>
                <line x1="55.5" y1="22" x2="52" y2="22"/>
              </g>
            </svg>
            <span class="brand-text">
              <span class="brand-name">MemeLab</span>
              <span class="brand-sub">CDA <span class="brand-version">v3</span></span>
            </span>
          </a>
          <span class="brand-tagline">Simulate outbreaks. Evolve strains. Master defenses.</span>
        </div>
        <div class="topbar-actions">
          <a class="btn ghost" href="https://github.com/TheMemeticist/MemeLabV3" target="_blank" rel="noopener noreferrer" aria-label="View source on GitHub">
            <svg class="btn-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.03-2.682-.103-.253-.447-1.27.097-2.646 0 0 .84-.269 2.75 1.025A9.563 9.563 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.376.202 2.394.1 2.646.64.698 1.026 1.591 1.026 2.682 0 3.841-2.337 4.687-4.565 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z"/></svg>
            GitHub
          </a>
          <button class="btn ghost" data-act="about" data-tip="What is this? Model overview, history, backing research.">
            <span class="btn-icon">?</span>What is this?
          </button>
          <button class="btn" data-act="permalink" data-tip="Copy permalink — encodes the full state in the URL so anyone can replay this exact run.">
            <span class="btn-icon">🔗</span>Permalink
          </button>
          <button class="btn" data-act="export" data-tip="Download PNG snapshot, CSV stats, and JSON config.">
            <span class="btn-icon">⤓</span>Export
          </button>
          <button class="btn ghost" data-act="reset-defaults" data-tip="Clear saved state and reload with factory defaults. Useful after updates.">
            <span class="btn-icon">↺</span>Reset
          </button>
          <button class="btn icon-only" data-act="theme" aria-label="Toggle theme" data-tip="Switch theme"></button>
        </div>
      </header>

      <div class="toolbar" role="toolbar" aria-label="Simulation controls">
        <button class="tb-btn" data-act="play" aria-label="Play (Space)" title="Play / Pause (Space)">▶</button>
        <button class="tb-btn" data-act="step" aria-label="Step one day (→)" title="Step (→)">▎▶</button>
        <button class="tb-btn" data-act="reset" aria-label="Reset (R)" title="Reset (R)">↺</button>
        <span class="tb-divider"></span>
        <button class="tb-btn" data-act="speed" aria-label="Cycle speed" title="Speed">1×</button>
        <button class="tb-btn" data-act="mutate" aria-label="Toggle natural selection" title="Natural selection">🧬 off</button>
        <span class="tb-spacer"></span>
        <span class="tb-meta" data-meta="rN">R<sub>0</sub> = —</span>
        <span class="tb-meta" data-meta="strains">Strains: 1</span>
      </div>

      <main class="app-main">
        <aside class="left-panel" aria-label="Population and defenses"></aside>
        <section class="center-panel">
          <div class="ended-banner" data-section="ended-banner" hidden></div>
          <div class="stats-row" data-section="stats"></div>
          <div class="petri-area" data-section="petri"></div>
          <div class="chart-wrap">
            <div class="chart-tabs" role="tablist" aria-label="Chart view">
              <button class="chart-tab" role="tab" data-view="compartments" aria-selected="true">Compartments</button>
              <button class="chart-tab" role="tab" data-view="reff" aria-selected="false">R<sub>eff</sub></button>
            </div>
            <div class="chart-area" data-section="chart"></div>
          </div>
        </section>
        <aside class="right-panel" aria-label="Disease"></aside>
      </main>

      <footer class="footer">
        <span class="footer-left">Institute of Armchair Epidemiology · clean-room V3 rebuild</span>
        <span class="footer-right">v3 · 10× faster · fully deterministic</span>
      </footer>

      <div class="toast" role="status" aria-live="polite" hidden></div>
    `;

    const left = this.root.querySelector('.left-panel') as HTMLElement;
    const right = this.root.querySelector('.right-panel') as HTMLElement;
    const statsHost = this.root.querySelector('[data-section="stats"]') as HTMLElement;
    const petriHost = this.root.querySelector('[data-section="petri"]') as HTMLElement;
    const chartHost = this.root.querySelector('[data-section="chart"]') as HTMLElement;
    this.toastEl = this.root.querySelector('.toast') as HTMLElement;

    this.stats = new Stats(statsHost);
    this.petri = new Petri(petriHost);
    this.chart = new Chart(chartHost);
    this.endedBanner = this.root.querySelector('[data-section="ended-banner"]') as HTMLElement;

    // Chart tabs
    this.root.querySelectorAll<HTMLButtonElement>('.chart-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = (btn.dataset['view'] as ChartView) ?? 'compartments';
        this.setChartView(view);
      });
    });

    this.controls = new ControlPanel(this.defaultConfig().config, DEFAULT_PRESET_ID, {
      onConfigChange: () => this.onConfigChange(),
      onPresetChange: () => this.onConfigChange(),
      onCustomNameChange: () => this.persist(),
      onInterventionToggle: (key, on) => this.recordInterventionToggle(key, on),
    });
    this.controls.buildLeft(left);
    this.controls.buildRight(right);

    // Toolbar buttons
    this.toolbarBtns = {};
    this.root.querySelectorAll<HTMLButtonElement>('.tb-btn').forEach((b) => {
      const act = b.dataset['act']!;
      this.toolbarBtns[act] = b;
      b.addEventListener('click', () => this.toolbarAction(act));
    });
    this.speedBtn = this.toolbarBtns['speed'];
    this.mutateBtn = this.toolbarBtns['mutate'];

    // Topbar buttons
    this.permalinkBtn = this.root.querySelector('[data-act="permalink"]') as HTMLButtonElement;
    this.exportBtn = this.root.querySelector('[data-act="export"]') as HTMLButtonElement;
    this.themeBtn = this.root.querySelector('[data-act="theme"]') as HTMLButtonElement;
    this.aboutBtn = this.root.querySelector('[data-act="about"]') as HTMLButtonElement;
    this.permalinkBtn.addEventListener('click', () => this.copyPermalink());
    this.exportBtn.addEventListener('click', () => this.exportRun());
    this.themeBtn.addEventListener('click', () => this.toggleTheme());
    this.aboutBtn.addEventListener('click', () => this.about.open());
    (this.root.querySelector('[data-act="reset-defaults"]') as HTMLButtonElement)
      .addEventListener('click', () => { localStorage.clear(); location.reload(); });

    this.refreshPlayLabel();
  }

  private defaultConfig(): { config: SimConfig; presetId: string } {
    const preset = findPreset(DEFAULT_PRESET_ID);
    return {
      config: {
        seed: 0xC0FFEE,
        // Smallest grid by default (8×8 = 64 cells). User can scale up.
        size: 8,
        seedInfections: 0,
        birthRate: 0,
        mutate: false,
        reseedOnExtinction: false,
        strain: { ...preset.genes },
        defenses: [
          { id: 'mask', label: 'Mask', enabled: false, protection: 0.20, sourceControl: 0.81, mortalityReduction: 0.0, uptake: 0.5 },
          { id: 'vaccine', label: 'Vaccine', enabled: false, protection: 0.80, sourceControl: 0.0, mortalityReduction: 0.80, uptake: 0.12 },
        ],
        lockdown: {
          enabled: false,
          mobilityReduction: 0.5,
          transmissionReduction: 0.3,
          compliance: 0.7,
        },
        quarantine: {
          enabled: false,
          detectionRate: 0.7,
          contactsRange: 1,
          protection: 0.4,
          sourceControl: 0.4,
          duration: 14,
        },
      },
      presetId: preset.id,
    };
  }

  // ---- worker comms ----

  private send(cmd: WorkerCommand): void {
    this.worker.postMessage(cmd);
  }

  private onFrame(msg: FrameMessage): void {
    this.lastFrame = msg;
    this.petri.paint(msg.state, msg.defenses, msg.quarantined, msg.size);
    this.chart.update(msg.longStats);
    this.stats.update(msg.stats, msg.size * msg.size);
    this.stats.setRNaught(msg.rNaught);
    const rNStr = msg.rNaught == null ? '—' : msg.rNaught.toFixed(1);
    this.metaSet('rN', `R₀ = ${rNStr}`);
    this.metaSet('strains', `Strains: ${msg.stats.strains}`);

    this.checkEpidemicEnded(msg);

    // Persist last config snapshot.
    this.persist();
  }

  private checkEpidemicEnded(msg: FrameMessage): void {
    if (this.epidemicEnded) return;
    const { e, i } = msg.stats;
    if (!this.epidemicStarted) {
      if (e + i > 0) this.epidemicStarted = true;
      return;
    }
    if (e + i === 0) {
      this.epidemicEnded = true;
      // Auto-pause the clock — the outbreak is over.
      if (this.playing) {
        this.playing = false;
        this.send({ cmd: 'pause' });
        this.refreshPlayLabel();
      }
      this.showEndedBanner(msg);
    }
  }

  private showEndedBanner(msg: FrameMessage): void {
    if (!this.endedBanner) return;
    const n = msg.size * msg.size;
    const { r, d, s } = msg.stats;
    const pct = (v: number) => `${((v / n) * 100).toFixed(1)}%`;
    const verdict = d === 0
      ? 'Contained — no fatalities.'
      : r === 0
        ? 'All cases were fatal.'
        : `${pct(r)} recovered, ${pct(d)} dead.`;
    this.endedBanner.innerHTML = `
      <div class="ended-icon" aria-hidden="true">✓</div>
      <div class="ended-text">
        <div class="ended-title">Epidemic ended · Day ${msg.tick}</div>
        <div class="ended-sub">${verdict} ${s} susceptible remain.</div>
      </div>
      <button class="btn ended-reset" type="button">Reset</button>
    `;
    this.endedBanner.hidden = false;
    this.endedBanner.querySelector('.ended-reset')?.addEventListener(
      'click',
      () => this.handleReset(),
      { once: true },
    );
  }

  private hideEndedBanner(): void {
    if (this.endedBanner) {
      this.endedBanner.hidden = true;
      this.endedBanner.innerHTML = '';
    }
    this.epidemicStarted = false;
    this.epidemicEnded = false;
  }

  private setChartView(view: ChartView): void {
    if (this.chartView === view) return;
    this.chartView = view;
    this.chart.setView(view);
    this.root.querySelectorAll<HTMLButtonElement>('.chart-tab').forEach((b) => {
      const on = b.dataset['view'] === view;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('active', on);
    });
  }

  // ---- handlers ----

  private onConfigChange(): void {
    const cfg = this.controls.config();
    const rebuild = this.needsRebuild(this.prevConfig, cfg);
    const cmd: 'updateConfig' | 'patchConfig' = rebuild ? 'updateConfig' : 'patchConfig';
    this.send({ cmd, config: cfg });
    this.prevConfig = structuredClone(cfg);
    if (rebuild) {
      // Engine just reset — patient zero is fresh, so the ended state no longer applies.
      this.hideEndedBanner();
      // Auto-play the fresh run regardless of prior state — same UX as Reset.
      this.playing = true;
      this.refreshPlayLabel();
    }
    if (this.playing) {
      this.send({ cmd: 'play', tps: this.tps() });
    }
    this.persist();
  }

  private needsRebuild(prev: SimConfig | null, next: SimConfig): boolean {
    if (!prev) return true;
    if (prev.size !== next.size) return true;
    if (prev.seed !== next.seed) return true;
    // Strain genes alter R₀ + neighbor cache + seeding behaviour — full rebuild.
    const a = prev.strain, b = next.strain;
    return a.attackRate !== b.attackRate
      || a.incubation !== b.incubation
      || a.infectious !== b.infectious
      || a.ifr !== b.ifr
      || a.range !== b.range
      || a.immunityDays !== b.immunityDays
      || a.mutationRate !== b.mutationRate;
  }

  private recordInterventionToggle(key: InterventionKey, on: boolean): void {
    const tick = this.lastFrame?.tick ?? 0;
    this.interventionEvents.push({ tick, intervention: key, on });
    this.chart.setMarkers(this.interventionEvents);
    this.persist();
  }

  private toolbarAction(act: string): void {
    switch (act) {
      case 'play': this.handlePlay(); break;
      case 'step': this.handleStep(); break;
      case 'reset': this.handleReset(); break;
      case 'speed': this.cycleSpeed(); break;
      case 'mutate': this.toggleMutate(); break;
    }
  }

  private handlePlay(): void {
    this.playing = !this.playing;
    if (this.playing) {
      this.send({ cmd: 'play', tps: this.tps() });
    } else {
      this.send({ cmd: 'pause' });
    }
    this.refreshPlayLabel();
  }

  private handleStep(): void {
    if (this.playing) {
      this.playing = false;
      this.send({ cmd: 'pause' });
      this.refreshPlayLabel();
    }
    this.send({ cmd: 'step', n: 1 });
  }

  private handleReset(): void {
    const cfg = this.controls.config();
    // Reset clears the chart history, so the intervention markers — which are
    // pinned to specific ticks — would no longer correspond to any data. Wipe
    // them too.
    this.interventionEvents = [];
    this.chart.setMarkers(this.interventionEvents);
    this.hideEndedBanner();
    this.prevConfig = structuredClone(cfg);
    this.send({ cmd: 'reset', config: cfg });
    // Reset auto-starts the simulation — the user almost always wants to see
    // the new run play out immediately.
    this.playing = true;
    this.send({ cmd: 'play', tps: this.tps() });
    this.refreshPlayLabel();
  }

  private cycleSpeed(): void {
    this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
    this.refreshSpeedLabel();
    if (this.playing) this.send({ cmd: 'play', tps: this.tps() });
    this.persist();
  }

  private toggleMutate(): void {
    const cfg = this.controls.config();
    cfg.mutate = !cfg.mutate;
    this.refreshMutateLabel();
    this.onConfigChange();
  }

  private toggleTheme(): void {
    this.theme = this.theme === 'petri' ? 'lab' : 'petri';
    this.applyTheme();
    this.refreshThemeLabel();
    this.petri.refreshPalette();
    if (this.lastFrame) {
      this.petri.paint(this.lastFrame.state, this.lastFrame.defenses, this.lastFrame.quarantined, this.lastFrame.size);
    }
    this.persist();
  }

  private applyTheme(): void {
    document.documentElement.dataset['theme'] = this.theme;
  }

  private refreshThemeLabel(): void {
    this.themeBtn.innerHTML = this.theme === 'petri' ? '🌙' : '☀️';
    this.themeBtn.title = `Switch to ${this.theme === 'petri' ? 'Lab (dark)' : 'Petri (light)'} theme`;
  }

  private refreshPlayLabel(): void {
    const b = this.toolbarBtns['play'];
    b.textContent = this.playing ? '⏸' : '▶';
    b.setAttribute('aria-pressed', this.playing ? 'true' : 'false');
  }

  private refreshSpeedLabel(): void {
    this.speedBtn.textContent = `${SPEEDS[this.speedIdx]}×`;
  }

  private refreshMutateLabel(): void {
    const on = this.controls.config().mutate;
    this.mutateBtn.innerHTML = `🧬 ${on ? 'on' : 'off'}`;
    this.mutateBtn.classList.toggle('active', on);
    this.mutateBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  private metaSet(key: string, text: string): void {
    const el = this.root.querySelector(`[data-meta="${key}"]`);
    if (el) el.textContent = text;
  }

  private tps(): number {
    return BASE_TPS * SPEEDS[this.speedIdx];
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.handlePlay();
    } else if (e.key === 'ArrowRight') {
      this.handleStep();
    } else if (e.key === 'r' || e.key === 'R') {
      this.handleReset();
    } else if (e.key === 'm' || e.key === 'M') {
      this.toggleMutate();
    } else if (e.key === 't' || e.key === 'T') {
      this.toggleTheme();
    } else if (e.key === '?') {
      this.about.open();
    }
  }

  private onHashChange(): void {
    if (!location.hash) return;
    const decoded = decodeUrl(location.hash);
    if (!decoded) return;
    const applied = applyEncoded(decoded, this.controls.config());
    this.controls.hydrate(applied.config, applied.presetId ?? this.controls.currentPresetId());
    const nameParam = decoded.get('name');
    this.controls.setCustomName(nameParam ? decodeURIComponent(nameParam) : null);
    if (applied.theme === 'lab' || applied.theme === 'petri') {
      this.theme = applied.theme;
      this.applyTheme();
    }
    if (applied.speed != null) this.speedIdx = clampInt(applied.speed, 0, SPEEDS.length - 1);
    this.refreshSpeedLabel();
    this.refreshMutateLabel();
    this.refreshThemeLabel();
    this.interventionEvents = [];
    this.chart.setMarkers(this.interventionEvents);
    this.hideEndedBanner();
    this.prevConfig = structuredClone(applied.config);
    this.send({ cmd: 'reset', config: applied.config });
  }

  private copyPermalink(): void {
    const url = location.origin + location.pathname + encodeUrl({
      config: this.controls.config(),
      theme: this.theme,
      speed: this.speedIdx,
      presetId: this.controls.currentPresetId(),
      customName: this.controls.getCustomName(),
    });
    navigator.clipboard.writeText(url).then(
      () => this.toast('Permalink copied. State encoded in URL.'),
      () => {
        // Fallback: show in URL bar.
        history.replaceState(null, '', url);
        this.toast('Permalink set in address bar.');
      },
    );
    history.replaceState(null, '', url);
  }

  private exportRun(): void {
    if (!this.lastFrame) return;
    const t = timestamp();
    const csv = this.chart.exportCsv(this.lastFrame.longStats);
    downloadText(`memelab-${t}.csv`, csv, 'text/csv');
    const json = JSON.stringify({
      config: this.controls.config(),
      presetId: this.controls.currentPresetId(),
      tick: this.lastFrame.tick,
      rNaught: this.lastFrame.rNaught,
      stats: this.lastFrame.stats,
      longStats: this.lastFrame.longStats,
    }, null, 2);
    downloadText(`memelab-${t}.json`, json, 'application/json');
    downloadDataUrl(`memelab-${t}.png`, this.petri.toDataURL());
    this.toast('Exported PNG, CSV, and JSON.');
  }

  private toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this.toastEl.classList.add('toast-in');
    clearTimeout((this.toastEl as HTMLElement & { _t?: number })._t);
    (this.toastEl as HTMLElement & { _t?: number })._t = window.setTimeout(() => {
      this.toastEl.classList.remove('toast-in');
      this.toastEl.hidden = true;
    }, 2400);
  }

  private persist(): void {
    write('lastConfig', {
      config: this.controls.config(),
      presetId: this.controls.currentPresetId(),
      speed: this.speedIdx,
      theme: this.theme,
      customName: this.controls.getCustomName(),
    });
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = v | 0;
  return n < lo ? lo : n > hi ? hi : n;
}
