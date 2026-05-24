import { CellState } from '../types';
import type { GeometryType } from '../types';
import { SpriteAtlas } from './SpriteAtlas';

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
}

const SPRITE_THRESHOLD = 60;

export class Petri {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlay: HTMLDivElement;
  private legend: HTMLElement;
  private size = 0;
  private geometry: GeometryType = 'square';
  private mode: 'pixel' | 'sprite' = 'pixel';
  private imageData: ImageData | null = null;
  private fallbackImg: ImageData | null = null;
  private palette: ColorPalette = makeDefaultPalette();
  private atlas: SpriteAtlas | null = null;
  private spriteReady = false;

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
    };
    this.renderLegend();
  }

  resize(size: number, geometry: GeometryType): void {
    if (size === this.size && geometry === this.geometry) return;
    this.size = size;
    this.geometry = geometry;

    // Same size threshold applies to all geometries; meanfield has no cells to render as sprites.
    const wantMode: 'pixel' | 'sprite' = (geometry !== 'meanfield' && size <= SPRITE_THRESHOLD) ? 'sprite' : 'pixel';

    if (wantMode === 'sprite') {
      const tile = clampInt(Math.round(900 / size), 24, 80);
      this.atlas ??= new SpriteAtlas();
      this.atlas.setTile(tile);
      this.spriteReady = false;
      this.atlas.whenReady().then(() => {
        this.spriteReady = true;
        this.atlas?.setTile(tile);
      });
      this.canvas.width = size * tile;
      this.canvas.height = size * tile;
      this.imageData = null;
    } else {
      // Cap hex/tri canvas at 1200px to prevent memory issues at large grid sizes
      // (uncapped: size=512 → 3072px² ≈ 37 MB; size=1024 → 6144px² ≈ 150 MB).
      const canvasPx = geometry === 'square' ? size : Math.max(Math.min(size * 6, 1200), 400);
      this.canvas.width = canvasPx;
      this.canvas.height = canvasPx;
      this.imageData = geometry === 'square'
        ? (() => {
            const img = this.ctx.createImageData(canvasPx, canvasPx);
            const d = img.data;
            for (let i = 3; i < d.length; i += 4) d[i] = 255;
            return img;
          })()
        : null;
    }
    this.mode = wantMode;
    this.canvas.style.imageRendering = (wantMode === 'pixel' && geometry === 'square') ? 'pixelated' : 'auto';
    this.renderLegend();
  }

  paint(state: Uint8Array, defenses: Uint8Array, quarantined: Uint8Array | null, size: number, geometry: GeometryType): void {
    if (size !== this.size || geometry !== this.geometry) this.resize(size, geometry);

    if (geometry === 'meanfield') {
      this.paintMeanField(state, size);
      return;
    }

    if (this.mode === 'sprite') {
      this.paintSprites(state, defenses, size);
    } else if (geometry === 'hexagonal') {
      this.paintHex(state, defenses, size);
    } else if (geometry === 'triangular') {
      this.paintTri(state, defenses, size);
    } else {
      this.paintPixels(state, defenses, size);
    }

    if (quarantined) this.drawQuarantineBorders(quarantined, size, geometry);
  }

  // ── Square pixel renderer ─────────────────────────────────────────────────

  private paintPixels(state: Uint8Array, defenses: Uint8Array, size: number): void {
    if (!this.imageData) this.resize(size, 'square');
    const img = this.imageData!;
    const d = img.data;
    const p = this.palette;
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
      d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b;
    }
    this.ctx.putImageData(img, 0, 0);
  }

  // ── Hexagonal renderer (pointy-top hexagons, offset-r rows) ─────────────

  private paintHex(state: Uint8Array, defenses: Uint8Array, size: number): void {
    const W = this.canvas.width, H = this.canvas.height;
    // When cells are < 3px wide the hex shape is invisible; use fast pixel fallback.
    if (W / size < 3) { this.paintPixelsFallback(state, defenses, size); return; }

    const ctx = this.ctx;
    const p = this.palette;
    const sxr = W / (SQRT3 * (size + 0.5));
    const syr = 2 * H / (3 * size + 1);
    const colSpacing = SQRT3 * sxr;
    const rowSpacing = 1.5 * syr;
    const offX = colSpacing / 2;
    const offY = syr;
    // Inflate hex radii by 0.5 px at large sizes to seal sub-pixel anti-aliasing
    // gaps — no extra canvas calls needed vs the previous stroke approach.
    const inf = size > 70 ? 0.5 : 0;

    ctx.fillStyle = `rgb(${p.bg.r},${p.bg.g},${p.bg.b})`;
    ctx.fillRect(0, 0, W, H);

    for (let y = -1; y <= size; y++) {
      const dataY = ((y % size) + size) % size;
      for (let x = -1; x <= size; x++) {
        const dataX = ((x % size) + size) % size;
        const i = dataY * size + dataX;
        const cx = offX + x * colSpacing + (y & 1) * (colSpacing * 0.5);
        const cy = offY + y * rowSpacing;
        const c = this.cellColor(state[i], defenses[i], p);
        ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
        hexPath(ctx, cx, cy, sxr + inf, syr + inf);
        ctx.fill();
      }
    }
  }

  // ── Triangular renderer (alternating up/down triangles) ───────────────────

  private paintTri(state: Uint8Array, defenses: Uint8Array, size: number): void {
    const W = this.canvas.width, H = this.canvas.height;
    if (W / size < 3) { this.paintPixelsFallback(state, defenses, size); return; }

    const ctx = this.ctx;
    const p = this.palette;
    const tileW = W / size;
    const tileH = tileW * SQRT3 / 2;
    const gridH = size * tileH;
    const offY = (H - gridH) / 2;
    const extraRows = Math.ceil(offY / tileH) + 1;
    const inf = size > 70 ? 0.5 : 0;

    ctx.fillStyle = `rgb(${p.bg.r},${p.bg.g},${p.bg.b})`;
    ctx.fillRect(0, 0, W, H);

    for (let y = -extraRows; y < size + extraRows; y++) {
      const dataY = ((y % size) + size) % size;
      for (let x = -1; x <= size; x++) {
        const dataX = ((x % size) + size) % size;
        const i = dataY * size + dataX;
        const isUp = (x + y) % 2 === 0;
        const c = this.cellColor(state[i], defenses[i], p);
        ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
        triPath(ctx, x * tileW, offY + y * tileH, tileW, tileH, isUp, inf);
        ctx.fill();
      }
    }
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

  // ── Pixel fallback (very large hex/tri grids where cells < 3 px) ─────────

  private paintPixelsFallback(state: Uint8Array, defenses: Uint8Array, size: number): void {
    const W = this.canvas.width, H = this.canvas.height;
    const p = this.palette;
    if (!this.fallbackImg || this.fallbackImg.width !== W || this.fallbackImg.height !== H) {
      this.fallbackImg = this.ctx.createImageData(W, H);
      const d = this.fallbackImg.data;
      for (let i = 3; i < d.length; i += 4) d[i] = 255;
    }
    const d = this.fallbackImg.data;
    const scaleX = W / size, scaleY = H / size;
    for (let cy = 0; cy < size; cy++) {
      const py0 = Math.floor(cy * scaleY);
      const py1 = Math.min(H, Math.floor((cy + 1) * scaleY));
      for (let cx = 0; cx < size; cx++) {
        const i = cy * size + cx;
        const c = this.cellColor(state[i], defenses[i], p);
        const px0 = Math.floor(cx * scaleX);
        const px1 = Math.min(W, Math.floor((cx + 1) * scaleX));
        for (let py = py0; py < py1; py++) {
          let o = (py * W + px0) * 4;
          for (let px = px0; px < px1; px++, o += 4) {
            d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b;
          }
        }
      }
    }
    this.ctx.putImageData(this.fallbackImg, 0, 0);
  }

  // ── Sprite renderer (small grids) ────────────────────────────────────────

  private paintSprites(state: Uint8Array, defenses: Uint8Array, size: number): void {
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
    if (this.mode === 'sprite') {
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

// Pointy-top hexagon with independent horizontal (sxr) and vertical (syr) radii.
// Using separate radii lets the hex grid fill both canvas dimensions simultaneously
// rather than being constrained by whichever axis is tighter.
function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, sxr: number, syr: number): void {
  ctx.beginPath();
  for (let a = 0; a < 6; a++) {
    const angle = Math.PI / 2 + (Math.PI / 3) * a;
    const px = cx + sxr * Math.cos(angle);
    const py = cy - syr * Math.sin(angle);
    a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
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
