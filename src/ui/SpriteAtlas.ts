// Rasterizes the v2 SVG sprites into an OffscreenCanvas atlas at a chosen
// per-cell pixel size. The renderer blits one tile per cell.
//
// Layout (one row per state, columns = defense bitmask 0..3):
//   row 0: Susceptible
//   row 1: Exposed
//   row 2: Infectious
//   row 3: Recovered
//   row 4: Dead
// Per row, columns:
//   col 0: bare       (no defense)
//   col 1: with mask  (mask bit)
//   col 2: with vax   (vaccine bit)
//   col 3: mask + vax

import { CellState } from '../types';

const SPRITE_BASE = './assets/CellSprites';
const SPRITE_BY_STATE: Record<number, string> = {
  [CellState.Susceptible]: `${SPRITE_BASE}/person.svg`,
  [CellState.Exposed]: `${SPRITE_BASE}/personExposed.svg`,
  [CellState.Infectious]: `${SPRITE_BASE}/personInfectious.svg`,
  [CellState.Recovered]: `${SPRITE_BASE}/zombie.svg`,
  [CellState.Dead]: `${SPRITE_BASE}/headstone.svg`,
};
// Mask overlays escalate with the mask intervention's protection parameter
// (tier chosen by the caller via setMaskTier): cloth < surgical < N95 < hazmat.
const MASK_OVERLAYS = [
  `${SPRITE_BASE}/defenses/mask_cloth.svg`,
  `${SPRITE_BASE}/defenses/maskSurgical.svg`,
  `${SPRITE_BASE}/defenses/mask_n95.svg`,
  `${SPRITE_BASE}/defenses/mask_hazmat.svg`,
] as const;
const VAX_OVERLAY = `${SPRITE_BASE}/defenses/syringe.svg`;

export type MaskTier = 0 | 1 | 2 | 3;

/** Map DefenseSpec.protection (0..1) to a visual mask tier. */
export function maskTierFor(protection: number): MaskTier {
  return protection < 0.35 ? 0 : protection < 0.65 ? 1 : protection < 0.85 ? 2 : 3;
}

const ROWS = 5;
const COLS = 4;

export class SpriteAtlas {
  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private tile = 0;
  private maskTier: MaskTier = 1;
  private ready: Promise<void>;
  private images: { state: HTMLImageElement[]; masks: HTMLImageElement[]; vax: HTMLImageElement } | null = null;

  constructor() {
    this.canvas = supportsOffscreen()
      ? new OffscreenCanvas(1, 1)
      : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
    this.ctx = this.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    this.ready = this.preload();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Set per-tile pixel size and re-rasterize. */
  setTile(size: number): void {
    if (size === this.tile) return;
    this.tile = size;
    this.canvas.width = size * COLS;
    this.canvas.height = size * ROWS;
    this.rasterize();
  }

  /** Swap the mask overlay tier (cloth/surgical/N95/hazmat) and re-rasterize.
   *  Same pattern as setTile; rendering only — the defense bitmask is untouched. */
  setMaskTier(tier: MaskTier): void {
    if (tier === this.maskTier) return;
    this.maskTier = tier;
    this.rasterize();
  }

  /** Draw the atlas tile for (state, defenseBits) into the target ctx at (x,y) sized w×h.
   *  Sprites are drawn well over their cell box (overscale=1.7) and biased
   *  upward so each row's heads overlap the row above — a "theater audience"
   *  stacking effect. The renderer iterates top→bottom so lower rows paint
   *  on top, naturally producing the audience layering. */
  draw(
    target: CanvasRenderingContext2D,
    state: number,
    defenseBits: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    if (!this.tile) return;
    const row = Math.min(state, ROWS - 1);
    const col = Math.min(defenseBits & 0b11, COLS - 1);
    const overscale = 1.7;
    const dw = w * overscale;
    const dh = h * overscale;
    // Center horizontally; pull upward so the figure's body covers the cell
    // above (heads of front-row figures overlap the row behind them).
    const dx = x - (dw - w) * 0.5;
    const dy = y - (dh - h) * 0.65;
    target.drawImage(
      this.canvas as unknown as CanvasImageSource,
      col * this.tile,
      row * this.tile,
      this.tile,
      this.tile,
      dx,
      dy,
      dw,
      dh,
    );
  }

  private async preload(): Promise<void> {
    const stateImgs = await Promise.all(
      [CellState.Susceptible, CellState.Exposed, CellState.Infectious, CellState.Recovered, CellState.Dead].map(
        (s) => loadImage(SPRITE_BY_STATE[s]),
      ),
    );
    const masks = await Promise.all(MASK_OVERLAYS.map((m) => loadImage(m)));
    const vax = await loadImage(VAX_OVERLAY);
    this.images = { state: stateImgs, masks, vax };
    if (this.tile > 0) this.rasterize();
  }

  private rasterize(): void {
    if (!this.images || !this.tile) return;
    const ctx = this.ctx;
    const t = this.tile;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const x = col * t;
        const y = row * t;
        // Base sprite
        ctx.drawImage(this.images.state[row], x, y, t, t);
        // Defense overlays — only meaningful for Susceptible, Exposed, Infectious.
        // Recovered (zombie) and Dead (headstone) skip overlays for clarity.
        if (row <= 2) {
          if (col & 1) ctx.drawImage(this.images.masks[this.maskTier], x, y, t, t);
          if (col & 2) ctx.drawImage(this.images.vax, x + t * 0.55, y + t * 0.5, t * 0.45, t * 0.45);
        }
      }
    }
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

function supportsOffscreen(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}
