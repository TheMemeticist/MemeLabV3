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

export type ChartView = 'compartments' | 'reff' | 'costs';
// Compartments view can plot current counts ("active") or cumulative arrivals
// ("total") — e.g. total infected ever vs currently infected.
export type CompartmentMode = 'active' | 'total';

// Cumulative cost categories (USD, currency-converted by the caller). Order
// matches the data columns built in setCostSeries.
const COST_LABELS = ['Medical', 'Deaths', 'Quarantine', 'Mask', 'Vaccine', 'Lockdown', 'Surge', 'Total'];
const COST_COLORS = [
  'rgb(249, 115, 22)', // medical — orange
  'rgb(239, 68, 68)', // deaths — red
  'rgb(225, 178, 25)', // quarantine — amber
  'rgb(34, 197, 94)', // mask — green
  'rgb(59, 130, 246)', // vaccine — blue
  'rgb(148, 163, 184)', // lockdown — slate
  'rgb(168, 85, 247)', // surge — purple
];

export interface CostChartData {
  tick: number[];
  // Column-aligned with COST_LABELS (Total last).
  columns: number[][];
  // Currency symbol for the legend value formatter (already-converted columns).
  symbol?: string;
}

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
  private mode: CompartmentMode = 'active';
  private lastLong: LongStats | null = null;
  private costData: CostChartData | null = null;
  private costSymbol = '$';
  private expanded = false;

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
    this.destroyPlot();
    if (this.lastLong) this.update(this.lastLong);
  }

  getView(): ChartView {
    return this.view;
  }

  // Switch the compartments view between current ("active") and cumulative
  // ("total") counts. Labels/series are identical between modes — only the
  // underlying columns differ — so just re-push data (no rebuild flash, and it
  // preserves any series the user has toggled off via the legend).
  setMode(mode: CompartmentMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.view !== 'compartments' || !this.plot || !this.lastLong) return;
    this.plot.setData(this.buildData(this.lastLong));
    // Only the Infectious series is renamed between modes; update it in place
    // (uPlot doesn't re-render legend labels on setData).
    this.setSeriesLabel(3, this.infectiousLabel());
  }

  // "Infectious" (current count) vs "Infections" (cumulative, Total mode).
  private infectiousLabel(): string {
    return this.mode === 'total' ? 'Infections' : 'Infectious';
  }

  // Rename a series in place and update its legend chip text without a rebuild
  // (keeps the injected toggle dot and the user's show/hide state intact).
  private setSeriesLabel(seriesIdx: number, text: string): void {
    if (!this.plot) return;
    (this.plot.series[seriesIdx] as { label?: string }).label = text;
    const row = this.host.querySelectorAll('.u-legend .u-series')[seriesIdx];
    const th = row?.querySelector('th');
    if (!th) return;
    const textNodes = Array.from(th.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
    const last = textNodes[textNodes.length - 1];
    if (last) last.nodeValue = text;
    else th.appendChild(document.createTextNode(text));
  }

  getMode(): CompartmentMode {
    return this.mode;
  }

  // App moves the whole chart-wrap into/out of a fullscreen modal; we only need
  // to know so canvasHeight() can size the canvas large, then relayout.
  setExpanded(on: boolean): void {
    if (this.expanded === on) return;
    this.expanded = on;
    // Force a resize even if the cached dims happen to match.
    this.lastW = 0;
    this.lastH = 0;
    this.relayout();
  }

  // Tear down the uPlot instance + its event listeners and reset size cache.
  // Shared by view/mode switches and the empty-state path.
  private destroyPlot(): void {
    if (!this.plot) return;
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

  // App computes the (currency-converted) cumulative cost series and hands it in.
  // When the cost view is active, the next update() repaints from this data.
  setCostData(data: CostChartData): void {
    this.costData = data;
    if (data.symbol) this.costSymbol = data.symbol;
    // Repaint live only if the cost view is already mounted; otherwise the next
    // update()/setView() builds it. buildData ignores `long` in the cost view.
    if (this.view === 'costs' && this.plot && this.lastLong && data.tick.length > 0) {
      this.plot.setData(this.buildData(this.lastLong));
    }
  }

  // Compact currency formatter for the cost legend (values are pre-converted to
  // the display currency): $9,999 → "$9,999", "$12.3k", "$1.2M", "$3.4B", "$1.2T".
  // Falls back to the latest point when idle so the legend isn't blank at rest.
  private fmtMoneyVal(u: uPlot, raw: number | null, seriesIdx: number): string {
    const v = idleValue(u, raw, seriesIdx);
    if (v == null) return '--';
    const s = this.costSymbol;
    const a = Math.abs(v);
    if (a >= 1e12) return s + (v / 1e12).toFixed(a >= 1e13 ? 0 : 1) + 'T';
    if (a >= 1e9) return s + (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return s + (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return s + (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    return s + Math.round(v).toLocaleString();
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
    // Expanded modal: fill most of the viewport height minus the modal title
    // bar and the legend below the canvas.
    if (this.expanded) {
      const legend = this.host.querySelector<HTMLElement>('.u-legend');
      const legendH = legend ? legend.offsetHeight + 12 : 48;
      const avail = Math.round(window.innerHeight * 0.84) - 64 - legendH;
      return Math.max(240, Math.min(920, avail));
    }
    // Mobile / single-column layout: host has no row constraint, so use a
    // fixed pixel height. The host grows naturally to fit canvas + legend.
    if (window.matchMedia('(max-width: 1080px)').matches) {
      return window.matchMedia('(max-width: 700px)').matches ? 160 : 180;
    }
    // Desktop overlay card: the card height is auto (it grows to fit the
    // canvas + however many rows the legend wraps to), so a fixed canvas
    // height is used rather than deriving from the container — deriving would
    // be circular. The Expand button gives a larger view on demand.
    return 188;
  }

  update(long: LongStats): void {
    this.lastLong = long;
    const empty = this.view === 'costs'
      ? !this.costData || this.costData.tick.length === 0
      : long.tick.length === 0;
    if (empty) {
      // Tear down any existing plot before wiping the DOM, otherwise the next
      // non-empty update would call setData() on a detached uPlot instance.
      this.destroyPlot();
      this.host.innerHTML = '<div class="chart-empty">Waiting for first tick…</div>';
      return;
    }

    const data = this.buildData(long);

    if (!this.plot) {
      this.host.innerHTML = '';
      const css = getComputedStyle(document.documentElement);
      const accent = (k: string) => css.getPropertyValue(k).trim() || '#888';
      const series: uPlot.Series[] = this.view === 'reff'
        ? [
            { label: 'Day' },
            { label: 'R_eff', stroke: rgbCss('--accent') || '#3b82f6', width: 1.8, value: fmtReffVal },
          ]
        : this.view === 'costs'
        ? [
            { label: 'Day' },
            // Total is emphasized; the big drivers (Medical, Deaths) show by
            // default, the rest are toggleable via the legend to avoid clutter.
            ...COST_LABELS.map((label, k) => {
              const isTotal = k === COST_LABELS.length - 1;
              return {
                label,
                stroke: isTotal ? (rgbCss('--accent') || '#888') : COST_COLORS[k],
                width: isTotal ? 2.2 : 1.4,
                show: isTotal || label === 'Medical' || label === 'Deaths',
                value: (u: uPlot, v: number | null, si: number) => this.fmtMoneyVal(u, v, si),
              } as uPlot.Series;
            }),
          ]
        : [
            { label: 'Day' },
            // Same labels/colors in both Active and Total mode — the toolbar
            // toggle communicates which; only the underlying data differs
            // (current counts vs cumulative arrivals; see buildData).
            // Default-hide Susceptible / Exposed / Recovered — S typically
            // dwarfs everything else and crushes the y-axis. The user can
            // toggle them back on via the legend.
            { label: 'Susceptible', stroke: rgbCss('--cell-s'), width: 1.4, show: false, value: fmtCountVal },
            { label: 'Exposed', stroke: rgbCss('--cell-e'), width: 1.4, show: false, value: fmtCountVal },
            { label: this.infectiousLabel(), stroke: rgbCss('--cell-i'), width: 1.8, value: fmtCountVal },
            { label: 'Recovered', stroke: rgbCss('--cell-r'), width: 1.4, show: false, value: fmtCountVal },
            { label: 'Dead', stroke: cssVar('--chart-dead'), width: 1.6, value: fmtCountVal },
          ];
      const isReff = this.view === 'reff';
      // Named y axis + compact ticks: raw comma-separated large values
      // ("1,500,000,000" on the costs chart) overflow the default 50px
      // gutter and clip; compact "$1.5B" ticks plus a measured gutter width
      // (autoAxisSize) keep every label fully visible.
      const yAxis: uPlot.Axis = {
        stroke: accent('--text-muted'),
        grid: { stroke: accent('--grid-color') },
        label: isReff ? 'Reproduction number (R)' : this.view === 'costs' ? 'Cumulative cost' : 'People',
        labelSize: 18,
        labelFont: AXIS_LABEL_FONT,
        size: autoAxisSize,
      };
      if (!isReff) {
        yAxis.values = (_u, splits) =>
          splits.map((v) => (this.view === 'costs' ? this.costSymbol : '') + fmtCompact(v));
      }
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
          {
            stroke: accent('--text-muted'),
            grid: { stroke: accent('--grid-color') },
            label: 'Day',
            labelSize: 18,
            labelFont: AXIS_LABEL_FONT,
          },
          yAxis,
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
    if (this.view === 'costs') {
      const c = this.costData ?? { tick: [], columns: [] };
      return [
        Float64Array.from(c.tick),
        ...c.columns.map((col) => Float64Array.from(col)),
      ] as uPlot.AlignedData;
    }
    if (this.view === 'reff') {
      return [
        Float64Array.from(long.tick),
        Float64Array.from(long.reff),
      ];
    }
    if (this.mode === 'total') {
      // Susceptible stays current (no meaningful cumulative); E/I/R/D become
      // cumulative arrivals so the lines read as totals.
      return [
        Float64Array.from(long.tick),
        Float64Array.from(long.s),
        Float64Array.from(long.ecum),
        Float64Array.from(long.icum),
        Float64Array.from(long.rcum),
        Float64Array.from(long.dcum),
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

// When the cursor isn't over the chart uPlot hands the legend a null value, so
// fall back to the series' latest data point — the legend then shows the
// *current* value at rest and the hovered value while tracking.
function idleValue(u: uPlot, raw: number | null, seriesIdx: number): number | null {
  if (raw != null && Number.isFinite(raw)) return raw;
  const col = u.data[seriesIdx] as ReadonlyArray<number | null> | undefined;
  if (!col) return null;
  for (let k = col.length - 1; k >= 0; k--) {
    const c = col[k];
    if (c != null && Number.isFinite(c)) return c;
  }
  return null;
}

// Compact legend value formatter so large counts (esp. cumulative Total-mode
// numbers) don't overflow the fixed-width legend value column: 9,999 →
// "9,999", 12.3k, 123k, 1.2M.
function fmtCountVal(u: uPlot, raw: number | null, seriesIdx: number): string {
  const v = idleValue(u, raw, seriesIdx);
  if (v == null) return '--';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
  return Math.round(v).toLocaleString();
}

// R_eff legend value: latest at rest, hovered while tracking.
function fmtReffVal(u: uPlot, raw: number | null, seriesIdx: number): string {
  const v = idleValue(u, raw, seriesIdx);
  return v == null ? '--' : v.toFixed(2);
}

// Axis-title font — small and muted so the titles stay recessive next to data.
const AXIS_LABEL_FONT = '600 11px ui-sans-serif, system-ui, sans-serif';

// Compact tick formatter for the y axis: 2500 → "2.5k", 1.5e9 → "1.5B".
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return trimZeros(v / 1e12) + 'T';
  if (a >= 1e9) return trimZeros(v / 1e9) + 'B';
  if (a >= 1e6) return trimZeros(v / 1e6) + 'M';
  if (a >= 1e3) return trimZeros(v / 1e3) + 'k';
  return trimZeros(v);
}

function trimZeros(v: number): string {
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

// uPlot's axis-autosize recipe: size the y gutter to the widest rendered tick
// (plus tick mark + gap) so labels never clip regardless of magnitude.
function autoAxisSize(u: uPlot, values: string[] | null, axisIdx: number, cycleNum: number): number {
  const axis = u.axes[axisIdx] as uPlot.Axis & { _size?: number; font?: string[] };
  // Converge: after the first measuring cycle, keep the settled size.
  if (cycleNum > 1) return axis._size ?? 50;
  let size = (typeof axis.ticks?.size === 'number' ? axis.ticks.size : 10) + (typeof axis.gap === 'number' ? axis.gap : 5);
  const longest = (values ?? []).reduce((acc, s) => (s.length > acc.length ? s : acc), '');
  if (longest !== '') {
    if (axis.font?.[0]) u.ctx.font = axis.font[0];
    size += u.ctx.measureText(longest).width / (window.devicePixelRatio || 1);
  }
  return Math.ceil(Math.max(40, size));
}

function rgbCss(varName: string): string {
  const css = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!css) return '#888';
  if (css.startsWith('#') || css.startsWith('rgb')) return css;
  return `rgb(${css})`;
}

function cssVar(varName: string): string {
  const css = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return css || '#888';
}

