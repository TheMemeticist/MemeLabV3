import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { InterventionEvent, LongStats } from '../types';

const MARKER_COLORS: Record<string, string> = {
  mask: 'rgb(38, 169, 198)',
  vaccine: 'rgb(156, 89, 209)',
  lockdown: 'rgb(245, 158, 11)',
  quarantine: 'rgb(225, 178, 25)',
};

const MARKER_LABELS: Record<string, string> = {
  mask: 'Mask',
  vaccine: 'Vaccine',
  lockdown: 'Lockdown',
  quarantine: 'Quarantine',
};

export type ChartView = 'compartments' | 'reff';

export class Chart {
  private host: HTMLElement;
  private plot: uPlot | null = null;
  private resizeObs: ResizeObserver;
  private lastW = 0;
  private lastH = 0;
  private resizeRaf = 0;
  private markers: InterventionEvent[] = [];
  private markerTip: HTMLElement | null = null;
  private mouseHandler: ((ev: MouseEvent) => void) | null = null;
  private leaveHandler: (() => void) | null = null;
  private view: ChartView = 'compartments';
  private lastLong: LongStats | null = null;

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

  setMarkers(events: InterventionEvent[]): void {
    this.markers = events;
    // Don't call plot.redraw() — uPlot 1.x's redraw() can clear cached series
    // paths in a way that wipes the visible traces. The next setData() (which
    // arrives at every sim tick) re-fires hooks.draw and paints markers fresh.
  }

  setView(view: ChartView): void {
    if (this.view === view) return;
    this.view = view;
    // Tear down the existing plot — series list changes between views, and
    // uPlot doesn't support live series-list mutation. Next update() rebuilds.
    if (this.plot) {
      this.plot.destroy();
      this.plot = null;
      this.lastW = 0;
      this.lastH = 0;
      if (this.mouseHandler) this.host.removeEventListener('mousemove', this.mouseHandler);
      if (this.leaveHandler) this.host.removeEventListener('mouseleave', this.leaveHandler);
      this.mouseHandler = null;
      this.leaveHandler = null;
      this.markerTip?.remove();
      this.markerTip = null;
    }
    if (this.lastLong) this.update(this.lastLong);
  }

  getView(): ChartView {
    return this.view;
  }

  private relayout(): void {
    if (!this.plot) return;
    const w = this.host.clientWidth;
    const h = this.canvasHeight();
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.plot.setSize({ width: w, height: h });
  }

  private canvasHeight(): number {
    // The host grows to fit canvas + legend (legend may wrap on narrow
    // widths), so the canvas gets a fixed target height based on viewport.
    // This keeps the x-axis labels readable and stops the legend from
    // overflowing the host bottom when it wraps to two or three rows.
    return window.matchMedia('(max-width: 700px)').matches ? 170 : 200;
  }

  update(long: LongStats): void {
    this.lastLong = long;
    if (long.tick.length === 0) {
      // Tear down any existing plot before wiping the DOM, otherwise the next
      // non-empty update would call setData() on a detached uPlot instance.
      if (this.plot) {
        this.plot.destroy();
        this.plot = null;
        this.lastW = 0;
        this.lastH = 0;
        if (this.mouseHandler) this.host.removeEventListener('mousemove', this.mouseHandler);
        if (this.leaveHandler) this.host.removeEventListener('mouseleave', this.leaveHandler);
        this.mouseHandler = null;
        this.leaveHandler = null;
        this.markerTip?.remove();
        this.markerTip = null;
      }
      this.host.innerHTML = '<div class="chart-empty">Waiting for first tick…</div>';
      return;
    }

    const data = this.buildData(long);

    if (!this.plot) {
      this.host.innerHTML = '';
      const css = getComputedStyle(document.documentElement);
      const accent = (k: string) => css.getPropertyValue(k).trim() || '#888';
      const series = this.view === 'reff'
        ? [
            { label: 'Day' },
            { label: 'R_eff', stroke: rgbCss('--accent') || '#3b82f6', width: 1.8 },
          ]
        : [
            { label: 'Day' },
            // Default-hide Susceptible / Exposed / Recovered — S typically
            // dwarfs everything else and crushes the y-axis. The user can
            // toggle them back on via the legend.
            { label: 'Susceptible', stroke: rgbCss('--cell-s'), width: 1.4, show: false },
            { label: 'Exposed', stroke: rgbCss('--cell-e'), width: 1.4, show: false },
            { label: 'Infectious', stroke: rgbCss('--cell-i'), width: 1.8 },
            { label: 'Recovered', stroke: rgbCss('--cell-r'), width: 1.4, show: false },
            { label: 'Dead', stroke: rgbCss('--cell-d'), width: 1.4 },
          ];
      const isReff = this.view === 'reff';
      const opts: uPlot.Options = {
        width: this.host.clientWidth,
        height: this.canvasHeight(),
        scales: {
          x: { time: false },
          y: {
            auto: true,
            // Tight-fit to visible series. uPlot already excludes hidden
            // series from dataMin/dataMax computation when `series.show=false`;
            // we just add a small headroom so traces don't kiss the axes.
            range: (_u, dataMin, dataMax) => {
              if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
                return isReff ? [0, 2] : [0, 1];
              }
              if (dataMin === dataMax) return [dataMin - 1, dataMax + 1];
              const pad = (dataMax - dataMin) * 0.08;
              const lo = Math.max(0, dataMin - pad);
              const hi = dataMax + pad;
              // R_eff: always include 1 in the range so the herd-immunity
              // threshold line is visible at the top or bottom of the chart.
              if (isReff) return [Math.min(lo, 0), Math.max(hi, 1.2)];
              return [lo, hi];
            },
          },
        },
        axes: [
          { stroke: accent('--text-muted'), grid: { stroke: accent('--grid-color') } },
          { stroke: accent('--text-muted'), grid: { stroke: accent('--grid-color') } },
        ],
        legend: { show: true, live: true },
        cursor: { focus: { prox: 16 } },
        series,
        hooks: {
          draw: [
            (u) => { if (isReff) this.paintReffThreshold(u); },
            (u) => this.paintMarkers(u),
          ],
        },
      };
      this.plot = new uPlot(opts, data, this.host);
      this.installMarkerTooltip();
      this.annotateLegend();
    } else {
      this.plot.setData(data);
    }
  }

  private buildData(long: LongStats): uPlot.AlignedData {
    if (this.view === 'reff') {
      return [
        Float64Array.from(long.tick),
        Float64Array.from(long.reff),
      ];
    }
    return [
      Float64Array.from(long.tick),
      Float64Array.from(long.s),
      Float64Array.from(long.e),
      Float64Array.from(long.i),
      Float64Array.from(long.r),
      Float64Array.from(long.d),
    ];
  }

  private paintReffThreshold(u: uPlot): void {
    // Draw a dashed horizontal at R=1 — the herd-immunity threshold.
    const y = u.valToPos(1, 'y', true);
    if (!Number.isFinite(y)) return;
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)'; // muted red
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(u.bbox.left, y);
    ctx.lineTo(u.bbox.left + u.bbox.width, y);
    ctx.stroke();
    // Label
    ctx.setLineDash([]);
    ctx.font = `600 ${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(239, 68, 68, 0.95)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('R = 1', u.bbox.left + u.bbox.width - 4 * dpr, y - 2 * dpr);
    ctx.restore();
  }

  private annotateLegend(): void {
    // Make it obvious the legend entries are clickable for show/hide.
    // uPlot binds the toggle handler to the <th> child, so style that.
    const legend = this.host.querySelector('.u-legend') as HTMLElement | null;
    if (legend && !legend.querySelector('.u-legend-hint')) {
      const hint = document.createElement('div');
      hint.className = 'u-legend-hint';
      hint.textContent = 'click a series to hide/show';
      legend.prepend(hint);
    }
    const rows = this.host.querySelectorAll('.u-legend .u-series');
    const plot = this.plot;
    rows.forEach((row, idx) => {
      if (idx === 0) return; // skip x-axis row
      const th = row.querySelector('th') as HTMLElement | null;
      if (!th) return;
      th.title = 'Click to show/hide this series';
      // Inject a small toggle indicator before the label so the affordance is
      // obvious without inspecting cursor state.
      let dot = th.querySelector('.u-toggle-dot') as HTMLElement | null;
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'u-toggle-dot';
        dot.setAttribute('aria-hidden', 'true');
        th.prepend(dot);
      }
      // Tint the dot with the actual series stroke colour.
      const stroke = plot?.series?.[idx]?.stroke;
      const color = typeof stroke === 'function' ? null : (stroke as string | null | undefined);
      if (color) dot.style.setProperty('--dot-color', color);
    });
  }

  private paintMarkers(u: uPlot): void {
    if (this.markers.length === 0) return;
    const ctx = u.ctx;
    const top = u.bbox.top;
    const h = u.bbox.height;
    const left = u.bbox.left;
    const right = left + u.bbox.width;
    const dpr = (window.devicePixelRatio || 1);
    // Layout chips at the top — track occupied x-ranges so two close-by toggles
    // stack vertically instead of overlapping.
    const occupied: Array<{ row: number; minX: number; maxX: number }> = [];
    const rowH = 16 * dpr;
    const padX = 6 * dpr;
    const padY = 3 * dpr;
    const fontPx = 10 * dpr;
    const lineW = 2 * dpr;
    ctx.save();
    ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const ev of this.markers) {
      const x = u.valToPos(ev.tick, 'x', true);
      if (x < left || x > right) continue;
      const color = MARKER_COLORS[ev.intervention] ?? '#888';
      const label = `${MARKER_LABELS[ev.intervention] ?? ev.intervention} ${ev.on ? 'ON' : 'OFF'}`;
      const textW = ctx.measureText(label).width;
      const chipW = textW + padX * 2;
      const chipH = rowH;
      // Vertical line — thick, solid for ON, dashed for OFF.
      ctx.setLineDash(ev.on ? [] : [4 * dpr, 3 * dpr]);
      ctx.lineWidth = lineW;
      ctx.strokeStyle = color;
      ctx.globalAlpha = ev.on ? 0.95 : 0.7;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + h);
      ctx.stroke();
      // Pick a row that doesn't overlap any prior chip.
      let row = 0;
      const halfW = chipW / 2;
      let chipX = x - halfW;
      // Keep chip inside the chart bbox horizontally.
      if (chipX < left) chipX = left;
      if (chipX + chipW > right) chipX = right - chipW;
      while (occupied.some((o) => o.row === row && !(chipX + chipW < o.minX - 2 || chipX > o.maxX + 2))) row++;
      occupied.push({ row, minX: chipX, maxX: chipX + chipW });
      const chipY = top + 2 + row * (chipH + 2);
      // Chip background (filled, opaque) + outline.
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      this.roundRect(ctx, chipX, chipY, chipW, chipH, 3 * dpr);
      ctx.fill();
      // Chip label — white text for max contrast on saturated bg.
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(label, chipX + padX, chipY + chipH / 2 + padY * 0.1);
    }
    ctx.restore();
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  private installMarkerTooltip(): void {
    if (!this.plot) return;
    const tip = document.createElement('div');
    tip.className = 'chart-marker-tip';
    tip.style.display = 'none';
    this.host.appendChild(tip);
    this.markerTip = tip;

    const handler = (ev: MouseEvent): void => {
      if (!this.plot || this.markers.length === 0) { tip.style.display = 'none'; return; }
      const rect = this.host.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      // Need device-pixel x for valToPos with true (canvas-space) flag.
      const dpr = window.devicePixelRatio || 1;
      const canvasX = (ev.clientX - rect.left) * dpr;
      const tick = this.plot.posToVal(canvasX, 'x', true);
      // Find nearest within 2 ticks.
      let best: InterventionEvent | null = null;
      let bestD = Infinity;
      for (const m of this.markers) {
        const d = Math.abs(m.tick - tick);
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best && bestD <= 2) {
        const label = MARKER_LABELS[best.intervention] ?? best.intervention;
        tip.textContent = `${label} ${best.on ? 'enabled' : 'disabled'} · day ${best.tick}`;
        tip.style.display = 'block';
        tip.style.left = `${px + 8}px`;
        tip.style.top = `${ev.clientY - rect.top - 22}px`;
        tip.style.borderColor = MARKER_COLORS[best.intervention] ?? '#888';
      } else {
        tip.style.display = 'none';
      }
    };
    const leave = (): void => { tip.style.display = 'none'; };
    this.host.addEventListener('mousemove', handler);
    this.host.addEventListener('mouseleave', leave);
    this.mouseHandler = handler;
    this.leaveHandler = leave;
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
    if (this.mouseHandler) this.host.removeEventListener('mousemove', this.mouseHandler);
    if (this.leaveHandler) this.host.removeEventListener('mouseleave', this.leaveHandler);
    this.markerTip?.remove();
    this.markerTip = null;
  }
}

function rgbCss(varName: string): string {
  const css = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!css) return '#888';
  if (css.startsWith('#') || css.startsWith('rgb')) return css;
  return `rgb(${css})`;
}
