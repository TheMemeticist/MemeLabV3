import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { LongStats } from '../types';

export class Chart {
  private host: HTMLElement;
  private plot: uPlot | null = null;
  private resizeObs: ResizeObserver;
  private lastW = 0;
  private lastH = 0;
  private resizeRaf = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('chart-host');
    // Coalesce resize callbacks via rAF and bail when dims didn't change to
    // avoid feedback loops with the parent grid.
    this.resizeObs = new ResizeObserver(() => {
      if (this.resizeRaf) return;
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = 0;
        this.relayout();
      });
    });
    this.resizeObs.observe(host);
  }

  private relayout(): void {
    if (!this.plot) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.plot.setSize({ width: w, height: h });
  }

  update(long: LongStats): void {
    if (long.tick.length === 0) {
      // Tear down any existing plot before wiping the DOM, otherwise the next
      // non-empty update would call setData() on a detached uPlot instance.
      if (this.plot) {
        this.plot.destroy();
        this.plot = null;
        this.lastW = 0;
        this.lastH = 0;
      }
      this.host.innerHTML = '<div class="chart-empty">Waiting for first tick…</div>';
      return;
    }

    const data: uPlot.AlignedData = [
      Float64Array.from(long.tick),
      Float64Array.from(long.s),
      Float64Array.from(long.e),
      Float64Array.from(long.i),
      Float64Array.from(long.r),
      Float64Array.from(long.d),
    ];

    if (!this.plot) {
      this.host.innerHTML = '';
      const css = getComputedStyle(document.documentElement);
      const accent = (k: string) => css.getPropertyValue(k).trim() || '#888';
      const opts: uPlot.Options = {
        width: this.host.clientWidth,
        height: this.host.clientHeight,
        scales: { x: { time: false } },
        axes: [
          { stroke: accent('--text-muted'), grid: { stroke: accent('--grid-color') } },
          { stroke: accent('--text-muted'), grid: { stroke: accent('--grid-color') } },
        ],
        legend: { show: true, live: true },
        series: [
          { label: 'Day' },
          { label: 'Susceptible', stroke: rgbCss('--cell-s'), width: 1.4 },
          { label: 'Exposed', stroke: rgbCss('--cell-e'), width: 1.4 },
          { label: 'Infectious', stroke: rgbCss('--cell-i'), width: 1.8 },
          { label: 'Recovered', stroke: rgbCss('--cell-r'), width: 1.4 },
          { label: 'Dead', stroke: rgbCss('--cell-d'), width: 1.4 },
        ],
      };
      this.plot = new uPlot(opts, data, this.host);
    } else {
      this.plot.setData(data);
    }
  }

  exportCsv(long: LongStats): string {
    const header = 'tick,S,E,I,R,D,Reff\n';
    const rows: string[] = [];
    for (let k = 0; k < long.tick.length; k++) {
      rows.push(
        `${long.tick[k]},${long.s[k]},${long.e[k]},${long.i[k]},${long.r[k]},${long.d[k]},${long.reff[k]?.toFixed(3) ?? ''}`,
      );
    }
    return header + rows.join('\n');
  }

  destroy(): void {
    this.resizeObs.disconnect();
    this.plot?.destroy();
    this.plot = null;
  }
}

function rgbCss(varName: string): string {
  const css = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!css) return '#888';
  if (css.startsWith('#') || css.startsWith('rgb')) return css;
  return `rgb(${css})`;
}
