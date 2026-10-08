// xoshiro128** — small, fast, high-quality PRNG with 32-bit state words.
// Reference: https://prng.di.unimi.it/xoshiro128starstar.c
// Output: 32-bit unsigned int -> [0,1) double.

export class Rng {
  private s: Uint32Array; // 4 x uint32 state

  constructor(seed: number) {
    this.s = new Uint32Array(4);
    this.reseed(seed);
  }

  reseed(seed: number): void {
    // splitmix32 to expand the seed into 4 state words.
    let z = (seed | 0) >>> 0;
    if (z === 0) z = 0x9e3779b9;
    for (let i = 0; i < 4; i++) {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x85ebca6b) >>> 0;
      t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0;
      t = (t ^ (t >>> 16)) >>> 0;
      this.s[i] = t;
    }
    if ((this.s[0] | this.s[1] | this.s[2] | this.s[3]) === 0) {
      this.s[0] = 1;
    }
  }

  /** Raw 32-bit unsigned. */
  next(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** Uniform [0,1). 53-bit precision via two 32-bit draws. */
  random(): number {
    const a = this.next() >>> 5; // 27 bits
    const b = this.next() >>> 6; // 26 bits
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** Bernoulli trial. */
  bernoulli(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.random() < p;
  }

  /** Standard normal via Box–Muller. */
  gaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.random();
    while (v === 0) v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Standard normal via the Marsaglia polar method. Uses only +, −, ×, /,
   *  sqrt (all correctly rounded) and the portable `detLog` — no trig and no
   *  platform libm — so the Rust port (`rust/engine-core`) reproduces it
   *  bit-for-bit. The second variate of each accepted pair is discarded, so
   *  the generator carries no hidden state. Used by `gamma()` only. */
  normalPolar(): number {
    for (;;) {
      const u = 2 * this.random() - 1;
      const v = 2 * this.random() - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) return u * Math.sqrt((-2 * detLog(s)) / s);
    }
  }

  /** Gamma(shape, scale 1) via Marsaglia & Tsang (2000), with the
   *  G(a) = G(a+1)·U^(1/a) boost for shape < 1 (U^(1/a) = exp(log U / a)).
   *  Mirrored exactly (same draws, same floating-point order, same portable
   *  detLog/detExp) by `Rng::gamma` in rust/engine-core. */
  gamma(shape: number): number {
    if (shape < 1) {
      const g = this.gamma(shape + 1);
      const u = this.random();
      return g * detExp(detLog(u) / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normalPolar();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.random();
      const x2 = x * x;
      if (u < 1 - 0.0331 * (x2 * x2)) return d * v;
      if (detLog(u) < 0.5 * x2 + d * (1 - v + detLog(v))) return d * v;
    }
  }

  /** Integer in [0, n). */
  intRange(n: number): number {
    return Math.floor(this.random() * n);
  }

  /** Snapshot the state for branching (e.g., R0 sandbox runs). */
  snapshot(): Uint32Array {
    return new Uint32Array(this.s);
  }

  restore(state: Uint32Array): void {
    this.s.set(state);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

// ── Portable (platform-independent) log / exp ────────────────────────────────
//
// Faithful ports of fdlibm 5.3 __ieee754_log (e_log.c) and __ieee754_exp
// (e_exp.c). They use only IEEE-754 +, −, ×, / and bit manipulation, all of
// which are exactly specified, so they return the same bits on every JS engine
// and in the Rust port (`det_log` / `det_exp` in rust/engine-core/src/lib.rs).
// `Math.log` / `Math.exp` are implementation-defined (and Rust's libm differs
// from V8 by 1 ulp on some inputs), so the Gamma sampler — whose output must be
// bit-identical between the TS and WASM engines — uses these instead. Error
// < 1 ulp, as fdlibm.

const DV = new DataView(new ArrayBuffer(8));
const LN2_HI = 6.93147180369123816490e-01; // 0x3fe62e42 fee00000
const LN2_LO = 1.90821492927058770002e-10; // 0x3dea39ef 35793c76
const TWO54 = 1.80143985094819840000e+16; // 0x43500000 00000000
const LG1 = 6.666666666666735130e-01; // 0x3FE55555 55555593
const LG2 = 3.999999999940941908e-01; // 0x3FD99999 9997FA04
const LG3 = 2.857142874366239149e-01; // 0x3FD24924 94229359
const LG4 = 2.222219843214978396e-01; // 0x3FCC71C5 1D8E78AF
const LG5 = 1.818357216161805012e-01; // 0x3FC74664 96CB03DE
const LG6 = 1.531383769920937332e-01; // 0x3FC39A09 D078C69F
const LG7 = 1.479819860511658591e-01; // 0x3FC2F112 DF3E5244

/** Natural log, fdlibm e_log.c — bit-identical to `det_log` in Rust. */
export function detLog(x: number): number {
  DV.setFloat64(0, x, true);
  let hx = DV.getInt32(4, true);
  const lx = DV.getUint32(0, true);
  let k = 0;
  if (hx < 0x00100000) { // x < 2**-1022
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity; // log(±0)
    if (hx < 0) return NaN; // log(−x)
    k -= 54;
    x *= TWO54; // subnormal: scale up
    DV.setFloat64(0, x, true);
    hx = DV.getInt32(4, true);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  DV.setInt32(4, hx | (i ^ 0x3ff00000), true); // normalize x or x/2 (DV holds x)
  x = DV.getFloat64(0, true);
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) { // |f| < 2**-20
    if (f === 0) {
      if (k === 0) return 0;
      const dk0 = k;
      return dk0 * LN2_HI + dk0 * LN2_LO;
    }
    const R0 = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R0;
    const dk1 = k;
    return dk1 * LN2_HI - ((R0 - dk1 * LN2_LO) - f);
  }
  const s = f / (2.0 + f);
  const dk = k;
  const z = s * s;
  let ii = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  ii |= j;
  const R = t2 + t1;
  if (ii > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

const O_THRESHOLD = 7.09782712893383973096e+02; // 0x40862E42 FEFA39EF
const U_THRESHOLD = -7.45133219101941108420e+02; // 0xc0874910 D52D3051
const INVLN2 = 1.44269504088896338700e+00; // 0x3ff71547 652b82fe
const TWOM1000 = 9.33263618503218878990e-302; // 2**-1000
const P1 = 1.66666666666666019037e-01; // 0x3FC55555 5555553E
const P2 = -2.77777777770155933842e-03; // 0xBF66C16C 16BEBD93
const P3 = 6.61375632143793436117e-05; // 0x3F11566A AF25DE2C
const P4 = -1.65339022054652515390e-06; // 0xBEBBBD41 C5D26BF1
const P5 = 4.13813679705723846039e-08; // 0x3E663769 72BEA4D0

/** e^x, fdlibm e_exp.c — bit-identical to `det_exp` in Rust. */
export function detExp(x: number): number {
  DV.setFloat64(0, x, true);
  let hx = DV.getUint32(4, true);
  const xsb = (hx >>> 31) & 1; // sign bit
  hx &= 0x7fffffff; // high word of |x|
  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx >= 0x40862e42) { // |x| >= 709.78…
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | DV.getUint32(0, true)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0.0; // exp(±inf) = {inf, 0}
    }
    if (x > O_THRESHOLD) return Infinity; // overflow
    if (x < U_THRESHOLD) return 0; // underflow
  }
  if (hx > 0x3fd62e42) { // |x| > 0.5 ln2
    if (hx < 0x3ff0a2b2) { // and |x| < 1.5 ln2
      hi = x - (xsb === 0 ? LN2_HI : -LN2_HI);
      lo = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INVLN2 * x + (xsb === 0 ? 0.5 : -0.5));
      const t = k;
      hi = x - t * LN2_HI; // exact
      lo = t * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) { // |x| < 2**-28
    return 1 + x;
  } else {
    k = 0;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2.0) - x);
  const y = 1 - ((lo - (x * c) / (2.0 - c)) - hi);
  DV.setFloat64(0, y, true);
  if (k >= -1021) {
    DV.setInt32(4, (DV.getInt32(4, true) + (k << 20)) | 0, true); // y · 2^k
    return DV.getFloat64(0, true);
  }
  DV.setInt32(4, (DV.getInt32(4, true) + ((k + 1000) << 20)) | 0, true);
  return DV.getFloat64(0, true) * TWOM1000;
}
