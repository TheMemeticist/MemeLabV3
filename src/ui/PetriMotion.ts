// Live-motion petri renderer — a canvas port of the V3+ "True morph" engine
// (docs/brand/animation/engine.js) for small boards. Render layer only: the
// worker's state arrays are the single source of truth; this module just
// animates the presentation of state CHANGES (morph transitions), adds idle
// life, particles, and cursor jelly springs on top.
//
// Tiering: Petri routes small boards here (MOTION_CELLS in Petri.ts) and keeps
// the static atlas path for everything larger; prefers-reduced-motion and the
// user's Motion toggle force the static path.
//
// Simplifications vs the reference engine (documented for future porters):
// - State blob radii are evaluated directly from the bump gaussians (rho) at
//   N fixed angles instead of raycasting a Catmull-Rom polyline — visually
//   identical at cell scale and ~100× cheaper to build.
// - The headstone uses one canonical dome radius table for all individuals
//   (its per-individual nubs/tufts/soul engraving are sub-pixel at cell size).
// - Particle vocabulary reduced to: fleck bursts (S→E, E→I) and one rising
//   soul per death. Shed rain / glints / fly-ins stay hero-scale only.
// - Faces are canvas primitives (dots + arcs), parameterized by the same
//   individual face metrics; drawn only when a cell is ≥ FACE_MIN_PX.
import { CellState } from '../types';

const CCX = 36;
const CCY = 40; // reference body center in 72-space

// B5 semantic fills (match the static sprite set, deliberately theme-stable).
const STATE_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [245, 200, 76], // S #f5c84c
  [240, 147, 56], // E #f09338
  [229, 72, 77], // I #e5484d
  [138, 148, 166], // R #8a94a6
  [36, 39, 45], // D #24272d
];
const STATE_FILL = STATE_RGB.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`);
const CHAR_FILL = 'rgb(36,39,45)';
const SOUL_FILL = 'rgb(255,255,255)';

// Graded transition midpoints, per (from,to) — reference transSpec colors.
function midColor(from: number, to: number): readonly [number, number, number] | null {
  if (from === CellState.Exposed && to === CellState.Infectious) return [217, 48, 44];
  if (from === CellState.Infectious && to === CellState.Recovered) return [176, 106, 112];
  if (to === CellState.Dead) return [90, 47, 52];
  if (from === CellState.Dead) return [125, 114, 71];
  if (from === CellState.Susceptible && to === CellState.Exposed) return [247, 119, 46];
  if (from === CellState.Recovered && to === CellState.Susceptible) return [201, 189, 143];
  return null;
}

interface TransSpec {
  dur: number;
  wave: number; // traveling spike wave share (E→I)
  sag: number; // liquid melt bias (→D)
  rise: number; // reverse melt (D→…)
  tremor: boolean;
  melt: boolean;
  overshoot: boolean; // I→R momentum slump
  soul: boolean;
  burst: number; // fleck count to emit at start
}

function transSpec(from: number, to: number): TransSpec {
  const s: TransSpec = {
    dur: 700, wave: 0, sag: 0, rise: 0,
    tremor: false, melt: false, overshoot: false, soul: false, burst: 0,
  };
  if (from === CellState.Exposed && to === CellState.Infectious) {
    s.dur = 700; s.wave = 0.65; s.tremor = true; s.burst = 3;
  } else if (from === CellState.Infectious && to === CellState.Recovered) {
    s.dur = 1200; s.overshoot = true;
  } else if (to === CellState.Dead) {
    s.dur = 1100; s.sag = 0.55; s.melt = true; s.soul = true;
  } else if (from === CellState.Dead) {
    s.dur = 800; s.rise = 0.45; s.melt = true;
  } else if (from === CellState.Susceptible && to === CellState.Exposed) {
    s.dur = 800; s.burst = 2;
  }
  return s;
}

// Idle oscillation params per state (reference IDLE).
const IDLE_FREQ = [1.1, 3.4, 6.6, 0.65, 0];
const IDLE_AMP = [0.035, 0.028, 0.05, 0.03, 0];
const IDLE_SPREAD = [0.9, 1.7, 2.1, 0.7, 0];
const IDLE_BREATH = [0.012, 0.01, 0.016, 0.008, 0];

// Spring params (user-approved tuning carried from the reference).
const SPRING_K = [140, 140, 266, 63, 200];
const SPRING_C = [11, 11, 9, 20, 26];
const SPRING_KN = [60, 60, 90, 34, 50];
const MAX_DENT = 0.28;
const CURSOR_RANGE = 22; // 72-space units (widened at cell scale so dents read in a crowd)
const CURSOR_GAIN_BASE = 2600;
const CURSOR_GAIN_SPEED = 8500;
const POKE_STRENGTH = 75;

const NSAMP = 24;
const FACE_MIN_PX = 14;
const OVERLAY_MIN_PX = 12;
const MAX_PARTICLES = 150;
const BURST_BUDGET_PER_FRAME = 12;

// Reference state blob definitions (gen_expressive bump tables).
interface BlobDef { base: number; cy: number; squash: number; bumps: number[][] }
const BLOBS: BlobDef[] = [
  { base: 23.0, cy: 38, squash: 1.0, bumps: [[-90, 5.4, 15], [-38, 4.8, 14], [15, 7.4, 20], [52, 3.4, 11], [105, 5.2, 15], [152, 5.0, 14], [-145, 5.4, 15]] },
  { base: 22.5, cy: 38, squash: 1.0, bumps: [[-90, 5.0, 17], [-45, 4.4, 15], [0, 5.2, 16], [42, 4.2, 15], [88, 4.6, 16], [130, 4.4, 15], [172, 5.0, 16], [-135, 4.6, 15]] },
  { base: 21.0, cy: 38, squash: 1.0, bumps: [[-90, 8.2, 10], [-50, 5.4, 9], [-12, 7.6, 10], [28, 4.8, 9], [66, 8.0, 11], [104, 5.2, 9], [142, 7.2, 10], [178, 4.6, 9], [-130, 6.9, 10]] },
  { base: 23.5, cy: 39, squash: 0.96, bumps: [[-90, 2.4, 20], [-30, 3.4, 18], [25, 4.6, 19], [90, 5.2, 21], [155, 4.6, 19], [-150, 3.4, 18]] },
];

function rho(theta: number, base: number, bumps: number[][]): number {
  let r = base;
  for (let k = 0; k < bumps.length; k++) {
    const phi = (bumps[k][0] * Math.PI) / 180;
    const amp = bumps[k][1];
    const sig = (bumps[k][2] * Math.PI) / 180;
    const d = Math.atan2(Math.sin(theta - phi), Math.cos(theta - phi));
    r += amp * Math.exp(-0.5 * (d / sig) * (d / sig));
  }
  return r;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Canonical dome radius table (one for all individuals) — raycast of the
// reference domePolyline from (CCX, CCY), computed once at module load.
const DOME_R = buildDomeTable();
function buildDomeTable(): Float32Array {
  const pts: number[][] = [[12, 62], [13, 34]];
  const cubic = (p0: number[], c1: number[], c2: number[], p3: number[]) => {
    for (let i = 1; i <= 24; i++) {
      const t = i / 24; const mt = 1 - t;
      pts.push([
        mt * mt * mt * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p3[0],
        mt * mt * mt * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p3[1],
      ]);
    }
  };
  cubic([13, 34], [13, 20], [22, 12], [36, 12]);
  cubic([36, 12], [50, 12], [59, 20], [59, 34]);
  pts.push([60, 62]);
  for (let x = 56; x >= 16; x -= 4) pts.push([x, 62]);
  const out = new Float32Array(NSAMP);
  for (let a = 0; a < NSAMP; a++) {
    const th = (2 * Math.PI * a) / NSAMP;
    const dx = Math.cos(th), dy = Math.sin(th);
    let best = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const sx = q[0] - p[0], sy = q[1] - p[1];
      const denom = dx * sy - dy * sx;
      if (Math.abs(denom) < 1e-9) continue;
      const px = p[0] - CCX, py = p[1] - CCY;
      const t = (px * sy - py * sx) / denom;
      const u = (px * dy - py * dx) / denom;
      if (t > 0 && u >= -0.001 && u <= 1.001 && t > best) best = t;
    }
    out[a] = best;
  }
  return out;
}

interface Particle {
  active: boolean;
  soul: boolean;
  x: number; y: number; vx: number; vy: number;
  r: number; life: number; maxLife: number;
  fill: string;
}

function easeInOutCubic(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function easeOutBack(t: number): number { const s = 1.25; const u = t - 1; return 1 + (s + 1) * u * u * u + s * u * u; }
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smooth(t: number): number { return t * t * (3 - 2 * t); }

export class PetriMotion {
  private n = 0;
  private seed = 0;
  private tile = 0;
  private k = 0; // px per 72-space unit
  private centers: Float32Array = new Float32Array(0); // 2n (px)
  // Optional per-cell size multiplier (voronoi: nearest-neighbour pitch /
  // mean pitch, so blobs at tight centroids shrink instead of overlapping).
  private scale: Float32Array | null = null;
  // Per-cell per-state radius tables: [cell * 5 * NSAMP]
  private tables: Float32Array = new Float32Array(0);
  // Face metrics per cell: eyeDx, eyeR, eyeY, mouthW, mouthTilt, mouthDx, phase
  private face: Float32Array = new Float32Array(0);
  // Morph state per cell
  private curState: Uint8Array = new Uint8Array(0); // authoritative (worker)
  private defenses: Uint8Array = new Uint8Array(0);
  private fromS: Uint8Array = new Uint8Array(0);
  private toS: Uint8Array = new Uint8Array(0);
  private tau: Float32Array = new Float32Array(0);
  // Springs (72-space units)
  private disp: Float32Array = new Float32Array(0); // n * NSAMP
  private vel: Float32Array = new Float32Array(0);
  private springActive: Uint8Array = new Uint8Array(0);
  private lastR: Float32Array = new Float32Array(0); // n * NSAMP, blended pre-spring radii
  private particles: Particle[] = [];
  private time = 0;
  private cursorX = -1e9;
  private cursorY = -1e9;
  private cursorSpeed = 0;
  private cursorDown: { x: number; y: number } | null = null;
  private overlayImgs: (HTMLImageElement | null)[] = [null, null]; // [mask, vax]
  private maskTier = 1;
  private cos = new Float32Array(NSAMP);
  private sin = new Float32Array(NSAMP);
  private ready = false;

  constructor() {
    for (let i = 0; i < NSAMP; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / NSAMP);
      this.sin[i] = Math.sin((2 * Math.PI * i) / NSAMP);
    }
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ active: false, soul: false, x: 0, y: 0, vx: 0, vy: 0, r: 0, life: 0, maxLife: 1, fill: '' });
    }
    this.loadOverlay(0, this.maskUrl(this.maskTier));
    this.loadOverlay(1, './assets/CellSprites/defenses/syringe.svg');
  }

  private maskUrl(tier: number): string {
    const files = ['mask_cloth.svg', 'maskSurgical.svg', 'mask_n95.svg', 'mask_hazmat.svg'];
    return `./assets/CellSprites/defenses/${files[Math.min(3, Math.max(0, tier))]}`;
  }

  private loadOverlay(slot: number, url: string): void {
    const img = new Image();
    img.onload = () => { this.overlayImgs[slot] = img; };
    img.src = url;
  }

  setMaskTier(tier: number): void {
    if (tier === this.maskTier) return;
    this.maskTier = tier;
    this.overlayImgs[0] = null;
    this.loadOverlay(0, this.maskUrl(tier));
  }

  /** (Re)build anatomy tables for a board. Cheap enough to run synchronously
   *  (~1M exp at the 40² ceiling); called only on size/seed/geometry change. */
  configure(n: number, seed: number, tile: number, centers: Float32Array, scale: Float32Array | null = null): void {
    const sameBoard = n === this.n && seed === this.seed;
    this.n = n;
    this.seed = seed >>> 0;
    this.tile = tile;
    this.k = tile / 53; // 72-space→px; blob max radius ≈31 → ~0.59 tile (slight gaps so deformation reads)
    this.centers = centers;
    this.scale = scale;
    if (sameBoard && this.tables.length === n * 5 * NSAMP) { this.ready = true; return; }

    this.tables = new Float32Array(n * 5 * NSAMP);
    this.face = new Float32Array(n * 7);
    this.curState = new Uint8Array(n);
    this.defenses = new Uint8Array(n);
    this.fromS = new Uint8Array(n);
    this.toS = new Uint8Array(n);
    this.tau = new Float32Array(n).fill(1);
    this.disp = new Float32Array(n * NSAMP);
    this.vel = new Float32Array(n * NSAMP);
    this.springActive = new Uint8Array(n);
    this.lastR = new Float32Array(n * NSAMP);
    for (const p of this.particles) p.active = false;

    const jitA = new Float32Array(12);
    const jitS = new Float32Array(12);
    for (let c = 0; c < n; c++) {
      const rnd = mulberry32((this.seed ^ Math.imul(c + 1, 2654435761)) >>> 0);
      const R = (lo: number, hi: number) => lo + (hi - lo) * rnd();
      // identity core (reference makeIndividual, trimmed to what cell scale shows)
      const phase = R(0, 360);
      const aspect = R(0.94, 1.06);
      const size = R(0.96, 1.05);
      for (let j = 0; j < 12; j++) { jitA[j] = R(0.8, 1.2); jitS[j] = R(0.85, 1.18); }
      const addBump = rnd() < 0.4;
      const addAt = R(0, 360), addAmp = R(3.0, 5.5), addSig = R(11, 18);
      const dropBump = !addBump && rnd() < 0.35;
      const fo = c * 7;
      this.face[fo] = R(0.88, 1.12); // eyeDx
      this.face[fo + 1] = R(0.88, 1.12); // eyeR
      this.face[fo + 2] = R(-1, 1); // eyeY
      this.face[fo + 3] = R(0.85, 1.15); // mouthW
      this.face[fo + 4] = R(-8, 8); // mouthTilt (deg)
      this.face[fo + 5] = R(-1.5, 1.5); // mouthDx
      this.face[fo + 6] = R(0, Math.PI * 2); // idle phase

      for (let st = 0; st < 4; st++) {
        const def = BLOBS[st];
        const bumps: number[][] = [];
        for (let b = 0; b < def.bumps.length; b++) {
          if (dropBump && b === def.bumps.length - 1 && def.bumps.length > 6) continue;
          let a = jitA[b % 12];
          if (st === CellState.Infectious) a = 0.92 + (a - 0.8) * 0.75;
          bumps.push([def.bumps[b][0] + phase, def.bumps[b][1] * a, def.bumps[b][2] * jitS[b % 12]]);
        }
        if (addBump) {
          const amp = addAmp * (st === CellState.Infectious ? 1.45 : st === CellState.Recovered ? 0.6 : 1);
          bumps.push([addAt + phase, amp, addSig]);
        }
        const base = def.base * size;
        const cyOff = def.cy - CCY;
        const to = (c * 5 + st) * NSAMP;
        for (let i = 0; i < NSAMP; i++) {
          const th = (2 * Math.PI * i) / NSAMP;
          // fold squash/cy offset into an effective radial table around (CCX,CCY)
          const r = rho(th, base, bumps);
          const x = r * this.cos[i];
          const y = cyOff + r * this.sin[i] * def.squash * aspect;
          this.tables[to + i] = Math.hypot(x, y);
        }
      }
      const doff = (c * 5 + CellState.Dead) * NSAMP;
      for (let i = 0; i < NSAMP; i++) this.tables[doff + i] = DOME_R[i];
    }
    this.ready = true;
  }

  isReady(): boolean { return this.ready; }

  /** Ingest a worker frame: diff states → start transitions; store defenses. */
  update(state: Uint8Array, defenses: Uint8Array): void {
    const n = Math.min(this.n, state.length);
    let burstBudget = BURST_BUDGET_PER_FRAME;
    for (let c = 0; c < n; c++) {
      const s = state[c];
      if (s !== this.curState[c]) {
        const from = this.tau[c] < 1 ? this.toS[c] : this.curState[c];
        this.fromS[c] = from;
        this.toS[c] = s;
        this.tau[c] = 0;
        const spec = transSpec(from, s);
        if (burstBudget > 0) {
          if (spec.burst > 0) { this.emitBurst(c, spec.burst, s); burstBudget--; }
          if (spec.soul) { this.emitSoul(c); burstBudget--; }
        }
        this.curState[c] = s;
      }
      this.defenses[c] = defenses[c];
    }
  }

  private kOf(c: number): number {
    return this.scale ? this.k * this.scale[c] : this.k;
  }

  private emitBurst(c: number, count: number, toState: number): void {
    const cx = this.centers[c * 2], cy = this.centers[c * 2 + 1];
    const k = this.kOf(c);
    const fill = STATE_FILL[Math.min(toState, CellState.Infectious)];
    for (let i = 0; i < count; i++) {
      const p = this.allocParticle();
      if (!p) return;
      const th = Math.random() * Math.PI * 2;
      const sp = (14 + Math.random() * 18) * k;
      p.soul = false;
      p.x = cx + Math.cos(th) * 8 * k;
      p.y = cy + Math.sin(th) * 8 * k;
      p.vx = Math.cos(th) * sp;
      p.vy = Math.sin(th) * sp;
      p.r = Math.max(1, 1.6 * k);
      p.life = 0; p.maxLife = 550;
      p.fill = fill;
      p.active = true;
    }
  }

  private emitSoul(c: number): void {
    const p = this.allocParticle();
    if (!p) return;
    p.soul = true;
    p.x = this.centers[c * 2];
    p.y = this.centers[c * 2 + 1];
    p.vx = 0;
    p.vy = -10 * this.kOf(c);
    p.r = Math.max(1.4, 3.1 * this.kOf(c));
    p.life = 0; p.maxLife = 1600;
    p.fill = SOUL_FILL;
    p.active = true;
  }

  private allocParticle(): Particle | null {
    for (const p of this.particles) if (!p.active) return p;
    return null;
  }

  // ── pointer → jelly ───────────────────────────────────────────────────────
  setCursor(xPx: number, yPx: number, speedPxMs: number): void {
    this.cursorX = xPx;
    this.cursorY = yPx;
    // convert px/ms to 72-space units/ms for gain parity with the reference
    this.cursorSpeed = this.k > 0 ? speedPxMs / this.k : 0;
  }
  clearCursor(): void { this.cursorX = -1e9; this.cursorY = -1e9; this.cursorSpeed = 0; }
  pokeAt(xPx: number, yPx: number): void { this.cursorDown = { x: xPx, y: yPx }; }

  private applyPointer(dtS: number): void {
    const n = this.n, k = this.k;
    const rangePx = CURSOR_RANGE * k + this.tile * 0.75;
    // hover dent
    if (this.cursorX > -1e8) {
      const sp = Math.min(this.cursorSpeed, 0.5);
      const gain = CURSOR_GAIN_BASE + sp * CURSOR_GAIN_SPEED;
      for (let c = 0; c < n; c++) {
        const cx = this.centers[c * 2], cy = this.centers[c * 2 + 1];
        const dx = cx - this.cursorX, dy = cy - this.cursorY;
        if (Math.abs(dx) > rangePx || Math.abs(dy) > rangePx) continue;
        const base = c * NSAMP;
        const kc = this.kOf(c);
        let touched = false;
        for (let s = 0; s < NSAMP; s++) {
          const rr = this.lastR[base + s] || 24;
          const px = cx + rr * kc * this.cos[s];
          const py = cy + rr * kc * this.sin[s];
          const ddx = (px - this.cursorX) / kc, ddy = (py - this.cursorY) / kc;
          const dd = Math.hypot(ddx, ddy);
          if (dd > CURSOR_RANGE || dd < 0.01) continue;
          let strength = 1 - dd / CURSOR_RANGE;
          strength *= strength;
          const radialPush = (ddx * this.cos[s] + ddy * this.sin[s]) / dd;
          this.vel[base + s] += radialPush * strength * gain * dtS;
          touched = true;
        }
        if (touched) this.springActive[c] = 1;
      }
      this.cursorSpeed *= 0.9;
    }
    // tap poke
    if (this.cursorDown) {
      const { x, y } = this.cursorDown;
      this.cursorDown = null;
      // nearest cell
      let best = -1, bd = Infinity;
      for (let c = 0; c < n; c++) {
        const dx = this.centers[c * 2] - x, dy = this.centers[c * 2 + 1] - y;
        const dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = c; }
      }
      if (best >= 0 && bd < this.tile * this.tile * 2.5) {
        const th = Math.atan2(y - this.centers[best * 2 + 1], x - this.centers[best * 2]);
        const j = Math.round((((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * NSAMP) % NSAMP;
        const base = best * NSAMP;
        for (let o = -5; o <= 5; o++) {
          const w = Math.exp(-0.5 * (o / 2.2) * (o / 2.2));
          this.vel[base + ((j + o + NSAMP) % NSAMP)] -= POKE_STRENGTH * w;
        }
        this.springActive[best] = 1;
      }
    }
  }

  private integrateSprings(dtS: number): void {
    const n = this.n;
    for (let c = 0; c < n; c++) {
      if (!this.springActive[c]) continue;
      const st = this.toS[c];
      const k = SPRING_K[st], cc = SPRING_C[st], kN = SPRING_KN[st];
      const base = c * NSAMP;
      let energy = 0;
      for (let i = 0; i < NSAMP; i++) {
        const im = base + ((i - 1 + NSAMP) % NSAMP);
        const ip = base + ((i + 1) % NSAMP);
        const lap = this.disp[im] + this.disp[ip] - 2 * this.disp[base + i];
        const acc = -k * this.disp[base + i] - cc * this.vel[base + i] + kN * lap;
        this.vel[base + i] += acc * dtS;
      }
      for (let i = 0; i < NSAMP; i++) {
        const o = base + i;
        this.disp[o] += this.vel[o] * dtS;
        const cap = (this.lastR[o] || 24) * MAX_DENT;
        if (this.disp[o] > cap) { this.disp[o] = cap; if (this.vel[o] > 0) this.vel[o] = 0; }
        if (this.disp[o] < -cap) { this.disp[o] = -cap; if (this.vel[o] < 0) this.vel[o] = 0; }
        energy += this.disp[o] * this.disp[o] + this.vel[o] * this.vel[o] * 0.001;
      }
      if (energy < 0.0004) {
        this.springActive[c] = 0;
        this.disp.fill(0, base, base + NSAMP);
        this.vel.fill(0, base, base + NSAMP);
      }
    }
  }

  /** Advance time and draw every cell. Caller has already painted the bg. */
  frame(ctx: CanvasRenderingContext2D, dtMs: number): void {
    if (!this.ready || this.n === 0) return;
    const dt = Math.min(dtMs, 50);
    this.time += dt / 1000;
    const dtS = Math.min(dt, 33) / 1000;
    this.applyPointer(dtS);
    this.integrateSprings(dtS);

    const n = this.n, t = this.time;
    const drawFaces = this.tile >= FACE_MIN_PX;
    for (let c = 0; c < n; c++) {
      // advance morph
      if (this.tau[c] < 1) {
        const spec = transSpec(this.fromS[c], this.toS[c]);
        this.tau[c] = clamp01(this.tau[c] + dt / spec.dur);
      }
      this.drawCell(ctx, c, t, drawFaces);
    }
    this.drawOverlays(ctx);
    this.stepParticles(ctx, dt);
  }

  private drawCell(ctx: CanvasRenderingContext2D, c: number, t: number, drawFaces: boolean): void {
    const k = this.kOf(c);
    const cx = this.centers[c * 2], cy = this.centers[c * 2 + 1];
    const from = this.fromS[c], to = this.toS[c];
    const tau = this.tau[c];
    const spec = tau < 1 ? transSpec(from, to) : null;
    const E0 = spec ? (spec.overshoot ? easeOutBack(tau) : easeInOutCubic(tau)) : 1;
    const E0c = clamp01(E0);
    const A = (c * 5 + from) * NSAMP;
    const B = (c * 5 + to) * NSAMP;
    const phase = this.face[c * 7 + 6];
    const melt = spec && spec.melt ? Math.sin(Math.PI * E0c) : 0;

    // idle scales
    const fIF = IDLE_FREQ[from], fIA = IDLE_AMP[from], fISp = IDLE_SPREAD[from], fIB = IDLE_BREATH[from];
    const tIF = IDLE_FREQ[to], tIA = IDLE_AMP[to], tISp = IDLE_SPREAD[to], tIB = IDLE_BREATH[to];
    const breathF = fIB * Math.sin(0.9 * t + phase);
    const breathT = tIB * Math.sin(0.9 * t + phase);

    ctx.beginPath();
    const base = c * NSAMP;
    // compute rim points (catmull-rom through NSAMP samples)
    const xs = SCRATCH_X, ys = SCRATCH_Y;
    for (let i = 0; i < NSAMP; i++) {
      let ei = E0;
      if (spec) {
        const frac = i / NSAMP; // angle fraction from -x axis; wave origin arbitrary per cell
        if (spec.wave) {
          ei = smooth(clamp01(E0c * (1 + spec.wave) - spec.wave * ((frac + phase / 7) % 1)));
        } else if (spec.sag) {
          const down = (this.sin[i] + 1) / 2;
          ei = clamp01(E0c * (1 + spec.sag) - spec.sag * (1 - down));
        } else if (spec.rise) {
          const dn = (this.sin[i] + 1) / 2;
          ei = clamp01(E0c * (1 + spec.rise) - spec.rise * dn);
        }
      }
      const iaF = fIA === 0 ? 1 : 1 + fIA * Math.sin(fIF * t + i * fISp + phase) + breathF;
      const iaT = tIA === 0 ? 1 : 1 + tIA * Math.sin(tIF * t + i * tISp + phase) + breathT;
      const ra = this.tables[A + i] * iaF;
      const rb = this.tables[B + i] * iaT;
      let r = ra + (rb - ra) * ei;
      if (spec && spec.tremor) r += Math.sin(Math.PI * E0c) * Math.sin(t * 40 + i * 1.7) * 1.4;
      this.lastR[base + i] = r;
      r += this.disp[base + i];
      const px = cx + r * k * this.cos[i];
      let py = cy + r * k * this.sin[i];
      if (melt) py = cy + (py - cy) * (1 - 0.07 * melt) + 1.6 * melt * k;
      xs[i] = px; ys[i] = py;
    }
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 0; i < NSAMP; i++) {
      const i0 = (i - 1 + NSAMP) % NSAMP, i1 = i, i2 = (i + 1) % NSAMP, i3 = (i + 2) % NSAMP;
      ctx.bezierCurveTo(
        xs[i1] + (xs[i2] - xs[i0]) / 6, ys[i1] + (ys[i2] - ys[i0]) / 6,
        xs[i2] - (xs[i3] - xs[i1]) / 6, ys[i2] - (ys[i3] - ys[i1]) / 6,
        xs[i2], ys[i2],
      );
    }
    ctx.closePath();
    if (spec) {
      const a = STATE_RGB[from], b = STATE_RGB[to];
      const m = midColor(from, to);
      let rr: number, gg: number, bb: number;
      if (m && E0c < 0.5) {
        const u = E0c * 2;
        rr = a[0] + (m[0] - a[0]) * u; gg = a[1] + (m[1] - a[1]) * u; bb = a[2] + (m[2] - a[2]) * u;
      } else if (m) {
        const u = (E0c - 0.5) * 2;
        rr = m[0] + (b[0] - m[0]) * u; gg = m[1] + (b[1] - m[1]) * u; bb = m[2] + (b[2] - m[2]) * u;
      } else {
        rr = a[0] + (b[0] - a[0]) * E0c; gg = a[1] + (b[1] - a[1]) * E0c; bb = a[2] + (b[2] - a[2]) * E0c;
      }
      ctx.fillStyle = `rgb(${rr | 0},${gg | 0},${bb | 0})`;
    } else {
      ctx.fillStyle = STATE_FILL[to];
    }
    ctx.fill();

    if (drawFaces) {
      // face crossfade: draw the dominant end's face only (cheap + readable)
      const showTo = !spec || E0c > 0.55;
      const st = showTo ? to : from;
      const alpha = spec ? Math.abs(E0c - 0.5) * 2 : 1;
      if (st !== CellState.Dead && alpha > 0.15) {
        ctx.globalAlpha = alpha;
        this.drawFace(ctx, c, st, cx, cy);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawFace(ctx: CanvasRenderingContext2D, c: number, st: number, cx: number, cy: number): void {
    const k = this.kOf(c);
    const fo = c * 7;
    const eyeDx = this.face[fo], eyeR = this.face[fo + 1], eyeY = this.face[fo + 2];
    const mouthW = this.face[fo + 3], mouthTilt = (this.face[fo + 4] * Math.PI) / 180, mouthDx = this.face[fo + 5];
    ctx.fillStyle = CHAR_FILL;
    ctx.strokeStyle = CHAR_FILL;
    const ey = cy + (-7.6 + eyeY) * k;
    if (st === CellState.Susceptible) {
      // serene: two dots + smile arc
      dot(ctx, cx - 6.5 * eyeDx * k, ey, 1.7 * eyeR * k);
      dot(ctx, cx + 6.5 * eyeDx * k, ey, 1.7 * eyeR * k);
      smileArc(ctx, cx + mouthDx * k, cy + 0.4 * k, 3.9 * mouthW * k, mouthTilt, 1.1 * k);
    } else if (st === CellState.Exposed) {
      dot(ctx, cx - 4.9 * eyeDx * k, ey, 1.6 * eyeR * k);
      dot(ctx, cx + 4.9 * eyeDx * k, ey, 1.6 * eyeR * k);
      dot(ctx, cx + mouthDx * k, cy + 1.8 * k, 1.6 * mouthW * k); // "o"
    } else if (st === CellState.Infectious) {
      dot(ctx, cx - 7.65 * eyeDx * k, cy + (-8.5 + eyeY) * k, 2.0 * eyeR * k);
      dot(ctx, cx + 7.65 * eyeDx * k, cy + (-7.8 + eyeY) * k, 1.2 * eyeR * k);
      smileArc(ctx, cx + mouthDx * k, cy + 2.6 * k, 4.4 * mouthW * k, mouthTilt * 0.6, 1.3 * k, true);
    } else if (st === CellState.Recovered) {
      // half-lid: short line + small dot, crooked smile
      ctx.lineWidth = Math.max(1, 1.1 * k);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - (6.75 * eyeDx + 2.4) * k, cy + (-6 + eyeY) * k);
      ctx.lineTo(cx - (6.75 * eyeDx - 2.4) * k, cy + (-6 + eyeY) * k);
      ctx.stroke();
      dot(ctx, cx + 6.75 * eyeDx * k, cy + (-5.4 + eyeY) * k, 1.3 * eyeR * k);
      smileArc(ctx, cx + (1.6 + mouthDx) * k, cy + 1.4 * k, 4.0 * mouthW * k, -0.16 + mouthTilt, 1.1 * k);
    }
  }

  private drawOverlays(ctx: CanvasRenderingContext2D): void {
    if (this.tile < OVERLAY_MIN_PX) return;
    const mask = this.overlayImgs[0], vax = this.overlayImgs[1];
    if (!mask && !vax) return;
    const n = this.n;
    for (let c = 0; c < n; c++) {
      const st = this.curState[c];
      if (st > CellState.Infectious) continue; // atlas parity: no overlays on R/D
      const f = this.defenses[c] & 3;
      if (!f) continue;
      const k = this.kOf(c);
      const box = 72 * k;
      const x0 = this.centers[c * 2] - CCX * k;
      const y0 = this.centers[c * 2 + 1] - CCY * k;
      if ((f & 1) && mask) ctx.drawImage(mask, x0, y0, box, box);
      if ((f & 2) && vax) ctx.drawImage(vax, x0 + 0.55 * box, y0 + 0.5 * box, 0.45 * box, 0.45 * box);
    }
  }

  private stepParticles(ctx: CanvasRenderingContext2D, dtMs: number): void {
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life += dtMs;
      if (p.life >= p.maxLife) { p.active = false; continue; }
      const u = p.life / p.maxLife;
      if (p.soul) {
        p.x += Math.sin(p.life / 180) * 0.25 * this.k * (dtMs / 16);
        p.y += p.vy * (dtMs / 1000);
        ctx.globalAlpha = 0.28 * Math.sin(Math.PI * u);
        ctx.fillStyle = p.fill;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.7, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = Math.sin(Math.PI * u);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        p.x += p.vx * (dtMs / 1000);
        p.y += p.vy * (dtMs / 1000);
        ctx.globalAlpha = 1 - u;
        ctx.fillStyle = p.fill;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
}

const SCRATCH_X = new Float64Array(NSAMP);
const SCRATCH_Y = new Float64Array(NSAMP);

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.6, r), 0, Math.PI * 2);
  ctx.fill();
}

function smileArc(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  tilt: number, lw: number, open = false,
): void {
  ctx.lineWidth = Math.max(1, lw);
  ctx.lineCap = 'round';
  ctx.beginPath();
  const a0 = 0.15 * Math.PI + tilt, a1 = 0.85 * Math.PI + tilt;
  ctx.arc(x, y, Math.max(1, r * 0.62), a0, a1);
  ctx.stroke();
  if (open) {
    ctx.beginPath();
    ctx.arc(x, y + r * 0.18, Math.max(0.8, r * 0.3), 0, Math.PI * 2);
    ctx.fill();
  }
}
