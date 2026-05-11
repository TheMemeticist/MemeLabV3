import { CellState } from '../types';
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
  private mode: 'pixel' | 'sprite' = 'pixel';
  private imageData: ImageData | null = null;
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

  resize(size: number): void {
    if (size === this.size && this.imageData) return;
    this.size = size;
    const wantMode: 'pixel' | 'sprite' = size <= SPRITE_THRESHOLD ? 'sprite' : 'pixel';
    if (wantMode === 'sprite') {
      // Display canvas at higher resolution so sprites look crisp.
      // Target: at least 24 px per tile so mask/vax overlays are recognizable.
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
      this.canvas.width = size;
      this.canvas.height = size;
      this.imageData = this.ctx.createImageData(size, size);
      const d = this.imageData.data;
      for (let i = 3; i < d.length; i += 4) d[i] = 255;
    }
    this.mode = wantMode;
    this.canvas.style.imageRendering = wantMode === 'pixel' ? 'pixelated' : 'auto';
    this.renderLegend();
  }

  paint(state: Uint8Array, defenses: Uint8Array, quarantined: Uint8Array | null, size: number): void {
    if (size !== this.size) this.resize(size);
    if (this.mode === 'sprite') this.paintSprites(state, defenses, size);
    else this.paintPixels(state, defenses, size);
    if (quarantined) this.drawQuarantineBorders(quarantined, size);
  }

  private drawQuarantineBorders(q: Uint8Array, size: number): void {
    const tile = this.canvas.width / size;
    if (tile < 3) return;
    const ctx = this.ctx;
    const lineW = Math.max(2, tile * 0.16);
    const dashOn = Math.max(3, tile * 0.32);
    const dashOff = Math.max(2, tile * 0.18);
    ctx.save();
    ctx.setLineDash([dashOn, dashOff]);
    ctx.lineJoin = 'miter';
    // Two-pass stroke: dark backing for legibility on light cells, warm amber on top.
    // First pass: thick dark outline.
    ctx.lineWidth = lineW + 1;
    ctx.strokeStyle = 'rgba(50, 30, 0, 0.85)';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!q[y * size + x]) continue;
        ctx.strokeRect(x * tile + 0.5, y * tile + 0.5, tile - 1, tile - 1);
      }
    }
    // Second pass: bolder amber inside the dark outline.
    ctx.lineWidth = lineW;
    ctx.strokeStyle = 'rgb(200, 140, 20)';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!q[y * size + x]) continue;
        ctx.strokeRect(x * tile + 0.5, y * tile + 0.5, tile - 1, tile - 1);
      }
    }
    ctx.restore();
  }

  private paintPixels(state: Uint8Array, defenses: Uint8Array, size: number): void {
    if (!this.imageData) this.resize(size);
    const img = this.imageData!;
    const d = img.data;
    const p = this.palette;
    const n = size * size;
    for (let i = 0; i < n; i++) {
      const f = defenses[i];
      let c: ColorTriplet;
      switch (state[i]) {
        case CellState.Susceptible:
          // Defense state encoded by hue, not just tint — visible at a glance.
          c = (f & 3) === 3 ? p.s_both : (f & 1) ? p.s_mask : (f & 2) ? p.s_vax : p.s;
          break;
        case CellState.Exposed: c = p.e; break;
        case CellState.Infectious: c = p.i; break;
        case CellState.Recovered: c = p.r; break;
        case CellState.Dead: c = p.d; break;
        default: c = p.bg; break;
      }
      const o = i * 4;
      d[o] = c.r;
      d[o + 1] = c.g;
      d[o + 2] = c.b;
    }
    this.ctx.putImageData(img, 0, 0);
  }

  private paintSprites(state: Uint8Array, defenses: Uint8Array, size: number): void {
    const ctx = this.ctx;
    const tile = this.canvas.width / size;
    const p = this.palette;
    // Wash background.
    ctx.fillStyle = `rgb(${p.bg.r},${p.bg.g},${p.bg.b})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.spriteReady || !this.atlas) {
      // Fall back to pixel-style fill until atlas resolves.
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
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

  setOverlayMessage(html: string | null): void {
    this.overlay.innerHTML = html ?? '';
    this.overlay.style.display = html ? 'flex' : 'none';
  }

  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

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
