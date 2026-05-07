import type { SimStats } from '../types';

export class Stats {
  private el: HTMLElement;
  private items: Record<string, HTMLElement> = {};
  private rNaughtVal: HTMLElement;

  constructor(host: HTMLElement) {
    host.classList.add('stats-host');
    host.innerHTML = `
      <div class="stat" data-key="day"><span class="stat-label">Day</span><span class="stat-value">0</span></div>
      <div class="stat" data-key="i"><span class="stat-label">Infectious</span><span class="stat-value">0%</span></div>
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
    this.items['day'].textContent = stats.tick.toString();
    this.items['i'].textContent = pct(stats.i, n);
    this.items['r'].textContent = pct(stats.r, n);
    this.items['d'].textContent = pct(stats.d, n);
    this.items['reff'].textContent = stats.reff > 0 ? stats.reff.toFixed(2) : '—';
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
