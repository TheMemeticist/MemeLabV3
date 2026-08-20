import type { SimStats } from '../types';

export class Stats {
  private el: HTMLElement;
  private items: Record<string, HTMLElement> = {};
  private rNaughtVal: HTMLElement;
  private costTile: HTMLElement | null = null;
  private lastCostUsd = 0;
  private costCalmTimer = 0;
  private lastReff: number | null = null;
  private lastTick = 0;

  constructor(host: HTMLElement) {
    host.classList.add('stats-host');
    host.innerHTML = `
      <div class="stat" data-key="day"><span class="stat-label">Day</span><span class="stat-value">0</span></div>
      <div class="stat" data-key="i"><span class="stat-label">Infected</span><span class="stat-value">0%</span></div>
      <div class="stat" data-key="r"><span class="stat-label">Recovered</span><span class="stat-value">0%</span></div>
      <div class="stat" data-key="d"><span class="stat-label">Dead</span><span class="stat-value">0%</span></div>
      <div class="stat" data-key="reff"><span class="stat-label">R<sub>eff</sub></span><span class="stat-value">—</span></div>
      <div class="stat" data-key="r0"><span class="stat-label">R<sub>0</sub></span><span class="stat-value">—</span></div>
      <div class="stat" data-key="cost"><span class="stat-label">Cost</span><span class="stat-value">—</span></div>
    `;
    this.el = host;
    host.querySelectorAll<HTMLElement>('.stat').forEach((s) => {
      const k = s.dataset['key']!;
      this.items[k] = s.querySelector('.stat-value') as HTMLElement;
    });
    this.rNaughtVal = this.items['r0'];
    this.costTile = this.items['cost'].closest('.stat');
  }

  setRNaught(value: number | null): void {
    this.rNaughtVal.textContent = value === null ? '—' : value.toFixed(1);
  }

  /**
   * Update the cost readout. `usdValue` (currency-independent) drives the
   * escalating danger styling: the box reddens, glows, and trembles harder as
   * the cumulative burden grows, and only animates while it's actively rising.
   */
  setCost(text: string, usdValue: number): void {
    // Frame it as a loss with a leading minus (but not "−$0" at the start).
    this.items['cost'].textContent = usdValue > 0 ? `−${text}` : text;
    const tile = this.costTile;
    if (!tile) return;

    // Intensity from magnitude on a log scale: ~$100k → 0, ~$1T → 1.
    tile.style.setProperty('--cost-intensity', costIntensity(usdValue).toFixed(3));

    const rising = usdValue > this.lastCostUsd + 1e-6;
    this.lastCostUsd = usdValue;
    if (rising) {
      tile.classList.add('is-rising');
      // Drop the active animation shortly after the burden stops climbing
      // (e.g. when the epidemic ends) — the static red glow remains.
      clearTimeout(this.costCalmTimer);
      this.costCalmTimer = window.setTimeout(() => tile.classList.remove('is-rising'), 700);
    }
  }

  update(stats: SimStats, n: number): void {
    // Detect a reset / new run: tick rewound to 0 (or below previous).
    if (stats.tick < this.lastTick) this.lastReff = null;
    this.lastTick = stats.tick;
    this.items['day'].textContent = stats.tick.toString();
    // "Infected" = Exposed + Infectious. With long-incubation pathogens (Hanta:
    // 18d incubation, 3d infectious), most sick cells are E not I — showing only
    // I would read as 0% while the petri visibly has orange-sprite cells.
    this.items['i'].textContent = pct(stats.e + stats.i, n);
    this.items['r'].textContent = pct(stats.r, n);
    this.items['d'].textContent = pct(stats.d, n);
    // R_eff is window-based (rolling new-infections / new-infectious). With
    // long-incubation pathogens, the denominator is often zero for stretches
    // even though the epidemic is clearly active. Treat zero as "no new data"
    // and hold the last measured value so the readout stays useful.
    const cell = this.items['reff'];
    if (stats.reff > 0) {
      this.lastReff = stats.reff;
      cell.textContent = stats.reff.toFixed(2);
      cell.classList.remove('stale');
    } else if (this.lastReff != null && (stats.e + stats.i) > 0) {
      cell.textContent = this.lastReff.toFixed(2);
      cell.classList.add('stale');
    } else {
      cell.textContent = '—';
      cell.classList.remove('stale');
    }
  }

  // For tests / debugging.
  hostElement(): HTMLElement {
    return this.el;
  }
}

// Maps cumulative burden (USD) to a 0..1 alarm level on a log scale, so the
// readout escalates across the whole range from a small outbreak to a global one.
function costIntensity(usd: number): number {
  if (usd <= 0) return 0;
  const lo = 5; // log10($100k)
  const hi = 12; // log10($1T)
  const t = (Math.log10(usd) - lo) / (hi - lo);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function pct(v: number, n: number): string {
  if (n <= 0) return '0%';
  const p = (v / n) * 100;
  if (p < 0.1 && p > 0) return '<0.1%';
  return p.toFixed(p < 10 ? 1 : 0) + '%';
}
