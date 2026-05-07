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
