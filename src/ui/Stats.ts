import type { SimStats } from '../types';

export class Stats {
  private el: HTMLElement;
  private items: Record<string, HTMLElement> = {};
  private rNaughtVal: HTMLElement;
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
    `;
    this.el = host;
    host.querySelectorAll<HTMLElement>('.stat').forEach((s) => {
      const k = s.dataset['key']!;
      this.items[k] = s.querySelector('.stat-value') as HTMLElement;
    });
    this.rNaughtVal = this.items['r0'];
  }

  setRNaught(value: number | null): void {
    this.rNaughtVal.textContent = value === null ? '—' : value.toFixed(1);
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

function pct(v: number, n: number): string {
  if (n <= 0) return '0%';
  const p = (v / n) * 100;
  if (p < 0.1 && p > 0) return '<0.1%';
  return p.toFixed(p < 10 ? 1 : 0) + '%';
}
