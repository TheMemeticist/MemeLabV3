import { CellState } from '../types';
import type { GeometryType, VoronoiTopology } from '../types';
import { SpriteAtlas, type MaskTier } from './SpriteAtlas';
import { PetriMotion } from './PetriMotion';

interface ColorTriplet { r: number; g: number; b: number }
interface ColorPalette {
  s: ColorTriplet;
  s_mask: ColorTriplet;
  s_vax: ColorTriplet;
  s_both: ColorTriplet;
  e: ColorTriplet;
  i: ColorTriplet;
  r: ColorTriplet;
  d: ColorTriplet;
  bg: ColorTriplet;
  ringMask: ColorTriplet;
  ringVax: ColorTriplet;
  quarantine: ColorTriplet;
}

const SPRITE_THRESHOLD = 60;
// Voronoi sprites sit at irregular centroids and read well only on small grids,
// so they use a tighter threshold; above it Voronoi renders as solid polygons.
const VORONOI_SPRITE_THRESHOLD = 24;
// Live-motion tier (V3+ morph/jelly renderer) ceiling, in cells. Measured on
// the reference box: 32² (1024 blobs + springs + particles) holds 60fps with
// headroom; 40² (1600) dips below 50 during outbreak bursts, so the ceiling
// sits at 32². Voronoi runs it too (≤ VORONOI_SPRITE_THRESHOLD²): blobs sit at
// the centroids and are scaled per cell by nearest-neighbour pitch so tight
// clusters shrink instead of piling up.
const MOTION_CELLS = 1024;
const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Petri {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlay: HTMLDivElement;
  private legend: HTMLElement;
  private size = 0;
  private geometry: GeometryType = 'square';
  private mode: 'pixel' | 'sprite' | 'motion' = 'pixel';
  private imageData: ImageData | null = null;
  // Pixel→cell lookup for hex/tri pixel mode: geoLut[pixelIndex] = cell index.
  // Built once per size/geometry change so per-frame paint is a flat putImageData
  // whose cost is constant in cell count.
  private geoLut: Int32Array | null = null;
  private cellR: Uint8Array | null = null;
  private cellG: Uint8Array | null = null;
  private cellB: Uint8Array | null = null;
  private palette: ColorPalette = makeDefaultPalette();
  private atlas: SpriteAtlas | null = null;
  private maskTier: MaskTier = 1;
  private spriteReady = false;
  private voronoiTopo: VoronoiTopology | null = null;
  // ── live-motion tier ──
  private motion: PetriMotion | null = null;
  private motionEnabled = true;
  private motionSeed = 1;
  private motionLoopOn = false;
  private motionLastTs = 0;
  private lastState: Uint8Array | null = null;
  private lastDefenses: Uint8Array | null = null;
  private lastQuarantined: Uint8Array | null = null;

  constructor(host: HTMLElement) {
    host.classList.add('petri-host');
    host.innerHTML = `
      <div class="petri-frame">
        <div class="petri-ring" aria-hidden="true"></div>
        <canvas class="petri-canvas" aria-label="Petri dish — population grid"></canvas>
        <div class="petri-overlay"></div>
      </div>
      <div class="petri-legend" data-petri-legend></div>
    `;
    this.canvas = host.querySelector('canvas') as HTMLCanvasElement;
    this.overlay = host.querySelector('.petri-overlay') as HTMLDivElement;
    this.legend = host.querySelector('.petri-legend') as HTMLElement;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    this.refreshPalette();
    this.renderLegend();
  }

  /** Visual mask tier for the sprite atlas (cloth/surgical/N95/hazmat),
   *  derived from the mask intervention's protection level. Repaints on the
   *  next frame; if the atlas exists it re-rasterizes immediately. */
  setMaskTier(tier: MaskTier): void {
    if (tier === this.maskTier) return;
    this.maskTier = tier;
    this.atlas?.setMaskTier(tier);
    this.motion?.setMaskTier(tier);
  }

  /** User toggle for the live-motion tier (persisted by App). Forces a
   *  re-derive of the render mode on the next paint. */
  setMotionEnabled(on: boolean): void {
    if (on === this.motionEnabled) return;
    this.motionEnabled = on;
    this.size = 0; // invalidate so the next paint() re-runs resize()
  }

  /** Board seed drives per-cell anatomy (individuality stable across a run). */
  setMotionSeed(seed: number): void {
    const s = seed >>> 0;
    if (s === this.motionSeed) return;
    this.motionSeed = s;
    if (this.mode === 'motion') this.size = 0; // rebuild tables on next paint
  }

  /** True when the current board renders on the live-motion tier. */
  motionActive(): boolean {
    return this.mode === 'motion';
  }

  private motionEligible(size: number, geometry: GeometryType): boolean {
    return (
      this.motionEnabled &&
      !REDUCED_MOTION &&
      size * size <= MOTION_CELLS &&
      geometry !== 'meanfield'
    );
  }

  refreshPalette(): void {
    const css = getComputedStyle(document.documentElement);
    const read = (key: string, fallback: ColorTriplet): ColorTriplet => {
      const raw = css.getPropertyValue(key).trim();
      return parseRgb(raw) ?? fallback;
    };
    const def = makeDefaultPalette();
    this.palette = {
      s: read('--cell-s', def.s),
      s_mask: read('--cell-s-mask', def.s_mask),
      s_vax: read('--cell-s-vax', def.s_vax),
      s_both: read('--cell-s-both', def.s_both),
      e: read('--cell-e', def.e),
      i: read('--cell-i', def.i),
      r: read('--cell-r', def.r),
      d: read('--cell-d', def.d),
      bg: read('--petri-bg', def.bg),
      ringMask: read('--cell-ring-mask', def.ringMask),
      ringVax: read('--cell-ring-vax', def.ringVax),
      quarantine: read('--cell-quarantine', def.quarantine),
    };
    this.renderLegend();
  }

  /** Call whenever the engine rebuilds with geometry=voronoi. Pass null to clear. */
  setVoronoiTopology(topo: VoronoiTopology | null): void {
    this.voronoiTopo = topo;
    // Invalidate LUT so resize() rebuilds it with the new topology. Only
    // rebuild eagerly when the topology matches the current grid — during a
    // size change the new topology arrives BEFORE the first new-size frame,
    // and a LUT built from it would index past a stale old-size frame's
    // buffers (undefined → channels clamp to 0 → a solid-black board). The
    // first matching paint() resizes and builds the LUT instead.
    this.geoLut = null;
    if (topo !== null && this.geometry === 'voronoi' && topo.n === this.size * this.size) {
      this.resize(this.size, 'voronoi');
    }
  }

  resize(size: number, geometry: GeometryType): void {
    if (size === this.size && geometry === this.geometry && !(geometry === 'voronoi' && this.geoLut === null)) return;
    this.size = size;
    this.geometry = geometry;

    // Sprite (emoji) mode for small grids; solid-color pixel/LUT mode above the
    // threshold. Voronoi uses a tighter sprite threshold (its sprites sit at
    // irregular centroids). Mean-field has no per-cell sprites.
    const spriteThreshold = geometry === 'voronoi' ? VORONOI_SPRITE_THRESHOLD : SPRITE_THRESHOLD;
    const smallGrid = geometry !== 'meanfield' && size <= spriteThreshold;
    const wantMode: 'pixel' | 'sprite' | 'motion' =
      smallGrid ? (this.motionEligible(size, geometry) ? 'motion' : 'sprite') : 'pixel';

    if (wantMode === 'motion') {
      const tile = clampInt(Math.round(900 / size), 24, 80);
      this.canvas.width = size * tile;
      this.canvas.height = size * tile;
      this.imageData = null;
      this.geoLut = null;
      this.motion ??= new PetriMotion();
      this.motion.setMaskTier(this.maskTier);
      this.motion.configure(
        size * size,
        this.motionSeed,
        this.motionTile(size, geometry, tile),
        this.motionCenters(size, geometry, tile),
        geometry === 'voronoi' ? this.voronoiScale(size) : null,
      );
      this.attachMotionPointer();
    } else if (wantMode === 'sprite') {
      const tile = clampInt(Math.round(900 / size), 24, 80);
      this.atlas ??= new SpriteAtlas();
      this.atlas.setMaskTier(this.maskTier);
      this.atlas.setTile(tile);
      this.spriteReady = false;
      this.atlas.whenReady().then(() => {
        this.spriteReady = true;
        this.atlas?.setTile(tile);
        // Repaint the stored frame: while paused no new frame will arrive to
        // replace the pre-ready palette-rect fallback.
        if (this.lastState && this.lastDefenses && this.size === size && this.geometry === geometry) {
          this.paint(this.lastState, this.lastDefenses, this.lastQuarantined, size, geometry);
        }
      });
      this.canvas.width = size * tile;
      this.canvas.height = size * tile;
      this.imageData = null;
      this.geoLut = null;
    } else {
      // Cap non-square canvas at 1200px to prevent memory issues at large grid sizes
      // (uncapped: size=512 → 3072px² ≈ 37 MB; size=1024 → 6144px² ≈ 150 MB).
      const canvasPx = geometry === 'square' ? size : Math.max(Math.min(size * 6, 1200), 400);
      this.canvas.width = canvasPx;
      this.canvas.height = canvasPx;
      if (geometry === 'square') {
        this.geoLut = null;
        const img = this.ctx.createImageData(canvasPx, canvasPx);
        const d = img.data;
        for (let i = 3; i < d.length; i += 4) d[i] = 255;
        this.imageData = img;
      } else {
        // Hex/tri/voronoi: render via a precomputed pixel→cell lookup table. Drawing
        // tens of thousands of vector polygons per frame is the bottleneck;
        // a flat putImageData off the LUT is ~50× faster and O(canvas pixels).
        const img = this.ctx.createImageData(canvasPx, canvasPx);
        const d = img.data;
        for (let i = 3; i < d.length; i += 4) d[i] = 255;
        this.imageData = img;
        if (geometry === 'hexagonal') {
          this.geoLut = buildHexLut(size, canvasPx, canvasPx);
        } else if (geometry === 'triangular') {
          this.geoLut = buildTriLut(size, canvasPx, canvasPx);
        } else if (geometry === 'voronoi' && this.voronoiTopo && this.voronoiTopo.n === size * size) {
          this.geoLut = buildVoronoiLut(this.voronoiTopo, canvasPx, canvasPx);
        } else {
          this.geoLut = null;
        }
      }
    }
    this.mode = wantMode;
    this.canvas.style.imageRendering = (wantMode === 'pixel' && geometry === 'square') ? 'pixelated' : 'auto';
    this.renderLegend();
  }

  paint(state: Uint8Array, defenses: Uint8Array, quarantined: Uint8Array | null, size: number, geometry: GeometryType): void {
    // Stale-pair guard: during a size/geometry rebuild, frames and topology
    // messages from the old and new engines can interleave. A voronoi LUT
    // whose topology doesn't match this frame's cell count reads out of
    // bounds (undefined → 0,0,0 = black board). Skip the frame — a
    // consistent one follows within a tick.
    if (geometry === 'voronoi' && (this.voronoiTopo === null || this.voronoiTopo.n !== size * size)) return;
    this.lastState = state;
    this.lastDefenses = defenses;
    this.lastQuarantined = quarantined;
    if (size !== this.size || geometry !== this.geometry) this.resize(size, geometry);

    if (geometry === 'meanfield') {
      this.paintMeanField(state, size);
      return;
    }

    if (this.mode === 'motion') {
      // The motion loop repaints continuously (idle life must not wait for
      // the next worker frame); paint() already stored the frame arrays.
      this.motion?.update(state, defenses);
      this.startMotionLoop();
      return;
    }

    if (this.mode === 'sprite') {
      this.paintSprites(state, defenses, quarantined, size);
      // Dashed amber borders read well at sprite size for the regular lattices.
      // Voronoi polygons wrap toroidally (their vertices split across opposite
      // edges), so stroking them stretches lines across the canvas — Voronoi
      // marks quarantine with a halo inside paintSprites instead.
      if (quarantined && geometry !== 'voronoi') this.drawQuarantineBorders(quarantined, size, geometry);
    } else if (geometry === 'hexagonal' || geometry === 'triangular' || geometry === 'voronoi') {
      this.paintViaLut(state, defenses, quarantined, size);
    } else {
      this.paintPixels(state, defenses, quarantined, size);
    }
  }

  // ── Square pixel renderer ─────────────────────────────────────────────────

  private paintPixels(state: Uint8Array, defenses: Uint8Array, quarantined: Uint8Array | null, size: number): void {
    if (!this.imageData) this.resize(size, 'square');
    const img = this.imageData!;
    const d = img.data;
    const p = this.palette;
    const q = p.quarantine;
    const n = size * size;
    for (let i = 0; i < n; i++) {
      const f = defenses[i];
      let c: ColorTriplet;
      switch (state[i]) {
        case CellState.Susceptible:
          c = (f & 3) === 3 ? p.s_both : (f & 1) ? p.s_mask : (f & 2) ? p.s_vax : p.s;
          break;
        case CellState.Exposed: c = p.e; break;
        case CellState.Infectious: c = p.i; break;
        case CellState.Recovered: c = p.r; break;
        case CellState.Dead: c = p.d; break;
        default: c = p.bg; break;
      }
      const o = i * 4;
      // Quarantined cells are tinted toward the quarantine color — robust at any
      // cell size and free of the toroidal-polygon problems vector borders hit.
      if (quarantined && quarantined[i]) {
        d[o] = (c.r * 0.4 + q.r * 0.6) | 0;
        d[o + 1] = (c.g * 0.4 + q.g * 0.6) | 0;
        d[o + 2] = (c.b * 0.4 + q.b * 0.6) | 0;
      } else {
        d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b;
      }
    }
    this.ctx.putImageData(img, 0, 0);
  }

  // ── Hex / triangular renderer (precomputed pixel→cell lookup) ────────────
  // Per frame: map each cell to its color once (O(cells)), then walk the LUT
  // writing pixel colors and blit once (O(canvas pixels)). No per-cell vector
  // fills — the whole frame is one putImageData regardless of grid size.

  private paintViaLut(state: Uint8Array, defenses: Uint8Array, quarantined: Uint8Array | null, size: number): void {
    const lut = this.geoLut;
    const img = this.imageData;
    if (!lut || !img) return;
    const p = this.palette;
    const q = p.quarantine;
    const n = size * size;

    if (!this.cellR || this.cellR.length !== n) {
      this.cellR = new Uint8Array(n);
      this.cellG = new Uint8Array(n);
      this.cellB = new Uint8Array(n);
    }
    const cr = this.cellR, cg = this.cellG!, cb = this.cellB!;
    for (let i = 0; i < n; i++) {
      const c = this.cellColor(state[i], defenses[i], p);
      // Quarantine tint — wrap-safe replacement for vector borders (hex/tri/voronoi).
      if (quarantined && quarantined[i]) {
        cr[i] = (c.r * 0.4 + q.r * 0.6) | 0;
        cg[i] = (c.g * 0.4 + q.g * 0.6) | 0;
        cb[i] = (c.b * 0.4 + q.b * 0.6) | 0;
      } else {
        cr[i] = c.r; cg[i] = c.g; cb[i] = c.b;
      }
    }

    const d = img.data;
    const px = lut.length;
    for (let i = 0; i < px; i++) {
      const cell = lut[i];
      const o = i * 4;
      d[o] = cr[cell]; d[o + 1] = cg[cell]; d[o + 2] = cb[cell];
    }
    this.ctx.putImageData(img, 0, 0);
  }

  // ── Mean-field renderer (vertical compartment bar, bottom→top) ───────────

  private paintMeanField(state: Uint8Array, size: number): void {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const p = this.palette;
    const n = size * size;

    let s = 0, e = 0, inf = 0, r = 0, d = 0;
    for (let i = 0; i < n; i++) {
      switch (state[i]) {
        case CellState.Susceptible: s++; break;
        case CellState.Exposed: e++; break;
        case CellState.Infectious: inf++; break;
        case CellState.Recovered: r++; break;
        case CellState.Dead: d++; break;
      }
    }

    // Stacked vertical bar: epidemic grows upward from the bottom.
    // Order bottom→top: Dead, Recovered, Infectious, Exposed, Susceptible.
    const segments: { count: number; c: ColorTriplet }[] = [
      { count: d,   c: p.d },
      { count: r,   c: p.r },
      { count: inf, c: p.i },
      { count: e,   c: p.e },
      { count: s,   c: p.s },
    ];

    let bottomY = H;
    for (const { count, c } of segments) {
      const h = (count / n) * H;
      if (h < 0.5) { bottomY -= h; continue; }
      ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      ctx.fillRect(0, bottomY - h, W, h);
      bottomY -= h;
    }

    // Label in the centre.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.font = `bold ${Math.max(11, H * 0.06)}px var(--font-mono, monospace)`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Mean-field', W / 2, H / 2);
  }

  // ── Sprite renderer (small grids) ────────────────────────────────────────

  private paintSprites(state: Uint8Array, defenses: Uint8Array, quarantined: Uint8Array | null, size: number): void {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const p = this.palette;

    ctx.fillStyle = `rgb(${p.bg.r},${p.bg.g},${p.bg.b})`;
    ctx.fillRect(0, 0, W, H);

    // ── Hex sprite mode ──────────────────────────────────────────────────────
    if (this.geometry === 'hexagonal') {
      const sxr = W / (SQRT3 * (size + 0.5));
      const syr = 2 * H / (3 * size + 1);
      const colSpacing = SQRT3 * sxr;
      const rowSpacing = 1.5 * syr;
      const offX = colSpacing / 2;
      const offY = syr;
      const sprW = SQRT3 * sxr, sprH = 2 * syr;

      if (!this.spriteReady || !this.atlas) {
        // Fallback until atlas is ready: colored hex polygons (same as pixel mode).
        for (let y = -1; y <= size; y++) {
          const dataY = ((y % size) + size) % size;
          for (let x = -1; x <= size; x++) {
            const dataX = ((x % size) + size) % size;
            const i = dataY * size + dataX;
            const cx = offX + x * colSpacing + (y & 1) * (colSpacing * 0.5);
            const cy = offY + y * rowSpacing;
            const c = this.cellColor(state[i], defenses[i], p);
            ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
            hexPath(ctx, cx, cy, sxr, syr);
            ctx.fill();
          }
        }
        return;
      }
      // Sprites only — no per-cell colored background, matching square sprite mode.
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const cx = offX + x * colSpacing + (y & 1) * (colSpacing * 0.5);
          const cy = offY + y * rowSpacing;
          this.atlas.draw(ctx, state[i], defenses[i], cx - sprW / 2, cy - sprH / 2, sprW, sprH);
        }
      }
      return;
    }

    // ── Tri sprite mode ───────────────────────────────────────────────────────
    if (this.geometry === 'triangular') {
      const tileW = W / size;
      const tileH = tileW * SQRT3 / 2;
      const gridH = size * tileH;
      const offY = (H - gridH) / 2;
      const extraRows = Math.ceil(offY / tileH) + 1;

      if (!this.spriteReady || !this.atlas) {
        for (let y = -extraRows; y < size + extraRows; y++) {
          const dataY = ((y % size) + size) % size;
          for (let x = -1; x <= size; x++) {
            const dataX = ((x % size) + size) % size;
            const i = dataY * size + dataX;
            const isUp = (x + y) % 2 === 0;
            const c = this.cellColor(state[i], defenses[i], p);
            ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
            triPath(ctx, x * tileW, offY + y * tileH, tileW, tileH, isUp);
            ctx.fill();
          }
        }
        return;
      }
      // Sprites at each triangle's centroid.
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const isUp = (x + y) % 2 === 0;
          const centX = (x + 0.5) * tileW;
          const centY = offY + y * tileH + (isUp ? tileH * 2 / 3 : tileH / 3);
          const sprSize = tileH * 2 / 3;
          this.atlas.draw(ctx, state[i], defenses[i], centX - sprSize / 2, centY - sprSize / 2, sprSize, sprSize);
        }
      }
      return;
    }

    // ── Voronoi sprite mode (small grids) ─────────────────────────────────────
    if (this.geometry === 'voronoi' && this.voronoiTopo) {
      const topo = this.voronoiTopo;
      const sprSize = Math.max(16, Math.round(900 / size));
      const q = p.quarantine;
      // Quarantine halo at the centroid — wrap-safe, unlike stroking the cell's
      // toroidal polygon (which stretches across the canvas at the torus seam).
      const halo = (cx: number, cy: number) => {
        ctx.fillStyle = `rgba(${q.r},${q.g},${q.b},0.5)`;
        ctx.beginPath();
        ctx.arc(cx, cy, sprSize * 0.62, 0, Math.PI * 2);
        ctx.fill();
      };
      if (!this.spriteReady || !this.atlas) {
        // Fallback until the atlas loads: colored circles at each centroid.
        const r = sprSize * 0.4;
        for (let i = 0; i < topo.n; i++) {
          const cx = topo.cx[i] * W, cy = topo.cy[i] * H;
          if (quarantined && quarantined[i]) halo(cx, cy);
          const c = this.cellColor(state[i], defenses[i], p);
          ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }
      for (let i = 0; i < topo.n; i++) {
        const cx = topo.cx[i] * W, cy = topo.cy[i] * H;
        if (quarantined && quarantined[i]) halo(cx, cy);
        this.atlas.draw(ctx, state[i], defenses[i], cx - sprSize / 2, cy - sprSize / 2, sprSize, sprSize);
      }
      return;
    }

    // ── Square sprite mode ────────────────────────────────────────────────────
    const tile = W / size;
    if (!this.spriteReady || !this.atlas) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const c = this.cellColor(state[i], defenses[i], p);
          ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
          ctx.fillRect(x * tile, y * tile, tile, tile);
        }
      }
      return;
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        this.atlas.draw(ctx, state[i], defenses[i], x * tile, y * tile, tile, tile);
      }
    }
  }

  // ── Quarantine border overlay ─────────────────────────────────────────────

  private drawQuarantineBorders(q: Uint8Array, size: number, geometry: GeometryType): void {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const tile = W / size;
    if (tile < 3) return;

    const lineW = Math.max(2, tile * 0.16);
    const dashOn = Math.max(3, tile * 0.32);
    const dashOff = Math.max(2, tile * 0.18);

    ctx.save();
    ctx.setLineDash([dashOn, dashOff]);
    ctx.lineJoin = 'miter';

    const drawBorders = (strokeStyle: string, extraW: number) => {
      ctx.lineWidth = lineW + extraW;
      ctx.strokeStyle = strokeStyle;
      // Pre-compute layouts that mirror paintHex / paintTri exactly.
      const hexSxr = geometry === 'hexagonal' ? W / (SQRT3 * (size + 0.5)) : 0;
      const hexSyr = geometry === 'hexagonal' ? 2 * H / (3 * size + 1) : 0;
      const hexColSpacing = SQRT3 * hexSxr;
      const hexRowSpacing = 1.5 * hexSyr;
      const hexOffX = hexColSpacing / 2;
      const hexOffY = hexSyr;
      const triTileW = geometry === 'triangular' ? W / size : 0;
      const triTileH = triTileW * SQRT3 / 2;
      const triOffY = (H - size * triTileH) / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (!q[y * size + x]) continue;
          if (geometry === 'hexagonal') {
            const hx = hexOffX + x * hexColSpacing + (y & 1) * (hexColSpacing * 0.5);
            const hy = hexOffY + y * hexRowSpacing;
            hexPath(ctx, hx, hy, hexSxr, hexSyr);
          } else if (geometry === 'triangular') {
            const isUp = (x + y) % 2 === 0;
            triPath(ctx, x * triTileW, triOffY + y * triTileH, triTileW, triTileH, isUp);
          } else {
            ctx.rect(x * tile + 0.5, y * tile + 0.5, tile - 1, tile - 1);
          }
          ctx.stroke();
          ctx.beginPath();
        }
      }
    };

    drawBorders('rgba(50, 30, 0, 0.85)', 1);
    drawBorders('rgb(200, 140, 20)', 0);

    ctx.restore();
  }

  // ── Live-motion tier (V3+ morph/jelly renderer) ───────────────────────────

  /** Blob pitch for the motion renderer, per geometry (px). */
  private motionTile(size: number, geometry: GeometryType, tile: number): number {
    const W = size * tile;
    if (geometry === 'hexagonal') {
      const sxr = W / (SQRT3 * (size + 0.5));
      const syr = (2 * W) / (3 * size + 1);
      return Math.min(SQRT3 * sxr, 2 * syr);
    }
    if (geometry === 'triangular') {
      const tileW = W / size;
      return (tileW * SQRT3) / 2 / 1.3; // triangle centroids sit closer — shrink blobs
    }
    return tile;
  }

  /** Cell center positions (px), mirroring paintSprites' layout math. */
  private motionCenters(size: number, geometry: GeometryType, tile: number): Float32Array {
    const W = size * tile;
    const H = W;
    const out = new Float32Array(size * size * 2);
    if (geometry === 'hexagonal') {
      const sxr = W / (SQRT3 * (size + 0.5));
      const syr = (2 * H) / (3 * size + 1);
      const colSpacing = SQRT3 * sxr;
      const rowSpacing = 1.5 * syr;
      const offX = colSpacing / 2;
      const offY = syr;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          out[i * 2] = offX + x * colSpacing + (y & 1) * (colSpacing * 0.5);
          out[i * 2 + 1] = offY + y * rowSpacing;
        }
      }
    } else if (geometry === 'triangular') {
      const tileW = W / size;
      const tileH = (tileW * SQRT3) / 2;
      const offY = (H - size * tileH) / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const isUp = (x + y) % 2 === 0;
          out[i * 2] = (x + 0.5) * tileW;
          out[i * 2 + 1] = offY + y * tileH + (isUp ? (tileH * 2) / 3 : tileH / 3);
        }
      }
    } else if (geometry === 'voronoi' && this.voronoiTopo && this.voronoiTopo.n === size * size) {
      const topo = this.voronoiTopo;
      for (let i = 0; i < topo.n; i++) {
        out[i * 2] = topo.cx[i] * W;
        out[i * 2 + 1] = topo.cy[i] * H;
      }
    } else {
      // square — and voronoi before its topology has arrived (setVoronoiTopology
      // re-runs resize, which re-configures with the real centroids).
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          out[i * 2] = (x + 0.5) * tile;
          out[i * 2 + 1] = (y + 0.5) * tile;
        }
      }
    }
    return out;
  }

  /** Per-cell blob scale for voronoi: nearest adjacent centroid distance over
   *  the mean pitch (toroidal), clamped so no blob vanishes or balloons. */
  private voronoiScale(size: number): Float32Array | null {
    const topo = this.voronoiTopo;
    if (!topo || topo.n !== size * size) return null;
    const n = topo.n;
    const out = new Float32Array(n).fill(1);
    const pitch = 1 / size; // mean centroid spacing, normalized
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let a = topo.adjOffsets[i]; a < topo.adjOffsets[i + 1]; a++) {
        const j = topo.adjList[a];
        let dx = Math.abs(topo.cx[j] - topo.cx[i]);
        let dy = Math.abs(topo.cy[j] - topo.cy[i]);
        if (dx > 0.5) dx = 1 - dx;
        if (dy > 0.5) dy = 1 - dy;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      if (best < Infinity) out[i] = Math.min(1.1, Math.max(0.5, Math.sqrt(best) / pitch));
    }
    return out;
  }

  private motionPointerAttached = false;

  private attachMotionPointer(): void {
    if (this.motionPointerAttached) return;
    this.motionPointerAttached = true;
    let last: { x: number; y: number; t: number } | null = null;
    const toCanvas = (ev: PointerEvent): { x: number; y: number } | null => {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: ((ev.clientX - r.left) * this.canvas.width) / r.width,
        y: ((ev.clientY - r.top) * this.canvas.height) / r.height,
      };
    };
    this.canvas.addEventListener('pointermove', (ev) => {
      if (this.mode !== 'motion' || !this.motion) return;
      const p = toCanvas(ev);
      if (!p) return;
      let speed = 0;
      if (last) {
        const dt = Math.max(1, ev.timeStamp - last.t);
        speed = Math.hypot(p.x - last.x, p.y - last.y) / dt;
      }
      last = { x: p.x, y: p.y, t: ev.timeStamp };
      this.motion.setCursor(p.x, p.y, speed);
    });
    this.canvas.addEventListener('pointerleave', () => {
      last = null;
      this.motion?.clearCursor();
    });
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (this.mode !== 'motion' || !this.motion) return;
      const p = toCanvas(ev);
      if (p) this.motion.pokeAt(p.x, p.y);
    });
  }

  private startMotionLoop(): void {
    if (this.motionLoopOn) return;
    this.motionLoopOn = true;
    this.motionLastTs = 0;
    const step = (ts: number): void => {
      if (this.mode !== 'motion' || !this.motion || !this.lastState) {
        this.motionLoopOn = false;
        return;
      }
      const dt = this.motionLastTs ? ts - this.motionLastTs : 16;
      this.motionLastTs = ts;
      try {
        this.motionFrame(dt);
      } catch (err) {
        // Never let one bad frame silently kill the paint pipeline.
        console.error('motion frame failed (frame skipped):', err);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private motionFrame(dt: number): void {
    const ctx = this.ctx;
    const p = this.palette;
    ctx.fillStyle = `rgb(${p.bg.r},${p.bg.g},${p.bg.b})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.motion!.frame(ctx, dt);
    if (this.lastQuarantined) {
      this.drawQuarantineBorders(this.lastQuarantined, this.size, this.geometry);
    }
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  private cellColor(cellState: number, flags: number, p: ColorPalette): ColorTriplet {
    switch (cellState) {
      case CellState.Susceptible:
        return (flags & 3) === 3 ? p.s_both : (flags & 1) ? p.s_mask : (flags & 2) ? p.s_vax : p.s;
      case CellState.Exposed: return p.e;
      case CellState.Infectious: return p.i;
      case CellState.Recovered: return p.r;
      case CellState.Dead: return p.d;
      default: return p.bg;
    }
  }

  setOverlayMessage(html: string | null): void {
    this.overlay.innerHTML = html ?? '';
    this.overlay.style.display = html ? 'flex' : 'none';
  }

  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  // ── Legend ────────────────────────────────────────────────────────────────

  private renderLegend(): void {
    if (!this.legend) return;
    if (this.mode === 'sprite' || this.mode === 'motion') {
      this.renderSpriteLegend();
    } else {
      this.renderColorLegend();
    }
  }

  private renderColorLegend(): void {
    const swatch = (key: string, label: string): string => `
      <span class="legend-item"><span class="legend-swatch" style="background: rgb(var(${key}));"></span>${label}</span>
    `;
    this.legend.innerHTML = [
      swatch('--cell-s', 'Susceptible'),
      swatch('--cell-s-mask', 'Masked'),
      swatch('--cell-s-vax', 'Vaccinated'),
      swatch('--cell-s-both', 'Both'),
      swatch('--cell-e', 'Exposed'),
      swatch('--cell-i', 'Infectious'),
      swatch('--cell-r', 'Recovered'),
      swatch('--cell-d', 'Dead'),
      swatch('--cell-quarantine', 'Quarantined'),
    ].join('');
  }

  private renderSpriteLegend(): void {
    const item = (sprite: string, overlay: string | null, label: string): string => `
      <span class="legend-item">
        <span class="legend-sprite">
          <img src="./assets/CellSprites/${sprite}" alt="" />
          ${overlay ? `<img class="legend-overlay" src="./assets/CellSprites/defenses/${overlay}" alt="" />` : ''}
        </span>${label}
      </span>
    `;
    this.legend.innerHTML = [
      item('person.svg', null, 'Susceptible'),
      item('person.svg', 'maskSurgical.svg', 'Masked'),
      item('person.svg', 'syringe.svg', 'Vaccinated'),
      item('personExposed.svg', null, 'Exposed'),
      item('personInfectious.svg', null, 'Infectious'),
      item('zombie.svg', null, 'Recovered'),
      item('headstone.svg', null, 'Dead'),
    ].join('');
  }
}

// ── Canvas path helpers ───────────────────────────────────────────────────────

const SQRT3 = Math.sqrt(3);

// Unit hexagon vertex offsets (pointy-top), precomputed once so the per-cell
// paint loop never calls trig.
const HEX_COS: number[] = [];
const HEX_SIN: number[] = [];
for (let a = 0; a < 6; a++) {
  const angle = Math.PI / 2 + (Math.PI / 3) * a;
  HEX_COS.push(Math.cos(angle));
  HEX_SIN.push(Math.sin(angle));
}

// Pointy-top hexagon with independent horizontal (sxr) and vertical (syr) radii.
// Using separate radii lets the hex grid fill both canvas dimensions simultaneously
// rather than being constrained by whichever axis is tighter.
function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, sxr: number, syr: number): void {
  ctx.beginPath();
  for (let a = 0; a < 6; a++) {
    const px = cx + sxr * HEX_COS[a];
    const py = cy - syr * HEX_SIN[a];
    a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// Builds the hexagonal pixel→cell LUT. A hex lattice's Voronoi cells (nearest
// center) are exactly its hexagons, so each pixel is assigned to its nearest hex
// center over a 3×3 candidate window. Distances are scaled by the cell's aspect
// ratio so the metric is isotropic. One-time cost per size/geometry change.
function buildHexLut(size: number, W: number, H: number): Int32Array {
  const sxr = W / (SQRT3 * (size + 0.5));
  const syr = 2 * H / (3 * size + 1);
  const colSpacing = SQRT3 * sxr;
  const rowSpacing = 1.5 * syr;
  const offX = colSpacing / 2;
  const offY = syr;
  const aspect = sxr / syr;
  const lut = new Int32Array(W * H);
  for (let py = 0; py < H; py++) {
    const ry = Math.round((py - offY) / rowSpacing);
    for (let px = 0; px < W; px++) {
      let best = 0, bd = Infinity;
      for (let yy = ry - 1; yy <= ry + 1; yy++) {
        const cy = offY + yy * rowSpacing;
        const cx0 = offX + (yy & 1) * (colSpacing * 0.5);
        const cxIdx = Math.round((px - cx0) / colSpacing);
        for (let xx = cxIdx - 1; xx <= cxIdx + 1; xx++) {
          const cx = cx0 + xx * colSpacing;
          const dx = px - cx;
          const dy = (py - cy) * aspect;
          const dd = dx * dx + dy * dy;
          if (dd < bd) {
            bd = dd;
            const wx = ((xx % size) + size) % size;
            const wy = ((yy % size) + size) % size;
            best = wy * size + wx;
          }
        }
      }
      lut[py * W + px] = best;
    }
  }
  return lut;
}

// Builds the triangular pixel→cell LUT analytically. The renderer draws each
// cell as a 2-tile-wide triangle (apex up for even (x+y), down for odd), left to
// right, so where triangles overlap the larger column wins. For a pixel we find
// the largest column whose triangle covers it. A row spans tileH vertically;
// rows outside the centered grid wrap toroidally (matches the renderer's bleed).
// No canvas readback ⇒ no anti-aliasing corruption, crisp at any resolution.
function buildTriLut(size: number, W: number, H: number): Int32Array {
  const tileW = W / size;
  const tileH = tileW * SQRT3 / 2;
  const offY = (H - size * tileH) / 2;
  const lut = new Int32Array(W * H);
  for (let py = 0; py < H; py++) {
    const yReal = (py - offY) / tileH;
    const y = Math.floor(yReal);
    const v = yReal - y; // 0 at row top, 1 at row bottom
    const dataY = ((y % size) + size) % size;
    const rowBase = dataY * size;
    for (let px = 0; px < W; px++) {
      const u = px / tileW;
      let bestX = Math.round(u - 0.5);
      const x0 = Math.floor(u - 0.5) - 1;
      for (let x = x0; x <= x0 + 3; x++) {
        const isUp = ((((x + y) % 2) + 2) % 2) === 0;
        // Up triangle: apex at top, widens downward → half-width = v.
        // Down triangle: base at top, narrows downward → half-width = 1 - v.
        const half = isUp ? v : 1 - v;
        if (Math.abs(u - (x + 0.5)) <= half) bestX = x;
      }
      const dataX = ((bestX % size) + size) % size;
      lut[py * W + px] = rowBase + dataX;
    }
  }
  return lut;
}

// Triangles are drawn 2× wider than their tile so adjacent same-row cells share
// the diagonal boundary via the painter's model (later cells overwrite earlier
// ones at the correct slant). Canvas auto-clips any overhang at the edges.
// `expand` inflates all edges outward by that many pixels to seal anti-aliasing gaps.
function triPath(ctx: CanvasRenderingContext2D, px: number, py: number, tw: number, th: number, isUp: boolean, expand = 0): void {
  ctx.beginPath();
  if (isUp) {
    ctx.moveTo(px - tw * 0.5 - expand, py + th + expand);
    ctx.lineTo(px + tw * 1.5 + expand, py + th + expand);
    ctx.lineTo(px + tw * 0.5, py - expand);
  } else {
    ctx.moveTo(px - tw * 0.5 - expand, py - expand);
    ctx.lineTo(px + tw * 1.5 + expand, py - expand);
    ctx.lineTo(px + tw * 0.5, py + th + expand);
  }
  ctx.closePath();
}

// Builds a pixel→cell lookup table for Voronoi topology.
// Each pixel is assigned to its nearest centroid using a spatial bucket grid so
// only ~9 buckets (≈9 centroids) are tested. Both the bucket neighbourhood and
// the distance metric wrap toroidally, matching the simulation's torus topology.
// Built with flat CSR buckets and an allocation-free inner loop so the one-time
// cost stays low even at the 1200px canvas cap (~1.4M pixels).
function buildVoronoiLut(topo: VoronoiTopology, W: number, H: number): Int32Array {
  const { n, cx, cy } = topo;
  const lut = new Int32Array(W * H);
  const gridK = Math.max(1, Math.ceil(Math.sqrt(n)));
  const nb = gridK * gridK;

  // Counting-sort centroids into flat CSR buckets: order[start[b]..start[b+1]).
  const cellBucket = new Int32Array(n);
  const start = new Int32Array(nb + 1);
  for (let i = 0; i < n; i++) {
    let bx = (cx[i] * gridK) | 0; if (bx >= gridK) bx = gridK - 1; else if (bx < 0) bx = 0;
    let by = (cy[i] * gridK) | 0; if (by >= gridK) by = gridK - 1; else if (by < 0) by = 0;
    const b = by * gridK + bx;
    cellBucket[i] = b;
    start[b + 1]++;
  }
  for (let b = 0; b < nb; b++) start[b + 1] += start[b];
  const order = new Int32Array(n);
  const cursor = Int32Array.from(start.subarray(0, nb));
  for (let i = 0; i < n; i++) order[cursor[cellBucket[i]]++] = i;

  for (let py = 0; py < H; py++) {
    const ny = (py + 0.5) / H;
    let by = (ny * gridK) | 0; if (by >= gridK) by = gridK - 1;
    for (let px = 0; px < W; px++) {
      const nx = (px + 0.5) / W;
      let bx = (nx * gridK) | 0; if (bx >= gridK) bx = gridK - 1;
      let best = 0, bestDist = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        let by2 = by + dy; if (by2 < 0) by2 += gridK; else if (by2 >= gridK) by2 -= gridK;
        const rowBase = by2 * gridK;
        for (let dx = -1; dx <= 1; dx++) {
          let bx2 = bx + dx; if (bx2 < 0) bx2 += gridK; else if (bx2 >= gridK) bx2 -= gridK;
          const b = rowBase + bx2;
          const e = start[b + 1];
          for (let k = start[b]; k < e; k++) {
            const i = order[k];
            // Toroidal wrap to the nearest image (difference is already in (-1,1)).
            let ddx = nx - cx[i]; if (ddx > 0.5) ddx -= 1; else if (ddx < -0.5) ddx += 1;
            let ddy = ny - cy[i]; if (ddy > 0.5) ddy -= 1; else if (ddy < -0.5) ddy += 1;
            const d = ddx * ddx + ddy * ddy;
            if (d < bestDist) { bestDist = d; best = i; }
          }
        }
      }
      lut[py * W + px] = best;
    }
  }
  return lut;
}

// ── Palette / parse helpers ───────────────────────────────────────────────────

function makeDefaultPalette(): ColorPalette {
  return {
    s: { r: 122, g: 173, b: 35 },
    s_mask: { r: 38, g: 169, b: 198 },
    s_vax: { r: 156, g: 89, b: 209 },
    s_both: { r: 33, g: 191, b: 175 },
    e: { r: 230, g: 167, b: 23 },
    i: { r: 218, g: 60, b: 50 },
    r: { r: 70, g: 110, b: 145 },
    d: { r: 40, g: 35, b: 30 },
    bg: { r: 246, g: 239, b: 225 },
    ringMask: { r: 38, g: 169, b: 198 },
    ringVax: { r: 156, g: 89, b: 209 },
    quarantine: { r: 196, g: 126, b: 18 },
  };
}

function parseRgb(raw: string): ColorTriplet | null {
  if (!raw) return null;
  const m = raw.match(/^(\d+)\s+(\d+)\s+(\d+)/) ||
    raw.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  const h = raw.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (h) return { r: parseInt(h[1], 16), g: parseInt(h[2], 16), b: parseInt(h[3], 16) };
  return null;
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = v | 0;
  return n < lo ? lo : n > hi ? hi : n;
}
