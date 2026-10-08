// WASM port of the event-driven SEIR-D engine core (docs/perf-plan.md Phase 2).
//
// This is a LINE-FAITHFUL port of `src/sim/engine.ts` (the Phase-1 event-driven
// engine) for the single-strain configuration space: square / triangular /
// hexagonal / mean-field / voronoi geometries, defenses, lockdown, quarantine,
// births, waning, txSchedule, and extinction reseed. Strain mutation stays on
// the TypeScript engine (the wrapper's compatibility gate routes it there).
//
// Voronoi neighborhoods are per-cell CSR lists (absolute indices) precomputed
// by the TS geometry layer (VoronoiLattice.getNeighborIndices — direct CSR for
// range 1, BFS order beyond) and copied in verbatim, so iteration order is the
// TS order by construction, exactly like the lattice parity tables.
//
// Determinism contract: the TS wrapper seeds the population buffers directly in
// this module's memory using the TS `seed()` (identical draws), then hands over
// the post-seed xoshiro128** state via `set_rng`. From that point every draw is
// made here, in exactly the order the TS engine makes them, with the identical
// RNG algorithm and f64 arithmetic — the golden-digest parity tests in
// `tests/wasm-engine.test.ts` enforce bit-equality with the TS engine.
//
// Geometry neighbor tables (per row/cell parity) are computed by the TS
// geometry layer and copied in verbatim, so neighbor iteration order is the
// TS order by construction.
//
// Susceptibility heterogeneity (SimConfig.susceptibilityCV) is drawn HERE, not
// copied in: `susceptibility_init` runs the identical Marsaglia–Tsang Gamma
// sampler (`Rng::gamma`, a port of `Rng.gamma` in src/sim/rng.ts) on the main
// stream right after `set_rng` — the same stream position at which the TS
// engine draws them (immediately after seed()). The wrapper calls it only when
// the option is on; off, `sus` stays empty and no path changes.

use std::collections::HashMap;

const MAX_SCHEDULE_LEN: u32 = 10_000;
const ST_S: u8 = 0;
const ST_E: u8 = 1;
const ST_I: u8 = 2;
const ST_R: u8 = 3;
const ST_D: u8 = 4;

struct Rng {
    s: [u32; 4],
}

impl Rng {
    /// Standard normal, Marsaglia polar method — exact port of
    /// `Rng.normalPolar` (second variate discarded). Uses the portable
    /// `det_log`, never the platform `ln`, so it matches TS bit-for-bit.
    fn normal_polar(&mut self) -> f64 {
        loop {
            let u = 2.0 * self.random() - 1.0;
            let v = 2.0 * self.random() - 1.0;
            let s = u * u + v * v;
            if s > 0.0 && s < 1.0 {
                return u * ((-2.0 * det_log(s)) / s).sqrt();
            }
        }
    }

    /// Gamma(shape, 1), Marsaglia–Tsang with the shape < 1 boost — exact port
    /// of `Rng.gamma` (same draws, same floating-point order, same portable
    /// det_log/det_exp).
    fn gamma(&mut self, shape: f64) -> f64 {
        if shape < 1.0 {
            let g = self.gamma(shape + 1.0);
            let u = self.random();
            return g * det_exp(det_log(u) / shape);
        }
        let d = shape - 1.0 / 3.0;
        let c = 1.0 / (9.0 * d).sqrt();
        loop {
            let mut x;
            let mut v;
            loop {
                x = self.normal_polar();
                v = 1.0 + c * x;
                if v > 0.0 {
                    break;
                }
            }
            v = v * v * v;
            let u = self.random();
            let x2 = x * x;
            if u < 1.0 - 0.0331 * (x2 * x2) {
                return d * v;
            }
            if det_log(u) < 0.5 * x2 + d * (1.0 - v + det_log(v)) {
                return d * v;
            }
        }
    }

    #[inline(always)]
    fn next(&mut self) -> u32 {
        let s = &mut self.s;
        let result = s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s[1] << 9;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(11);
        result
    }

    /// Uniform [0,1), 53-bit via two draws — the exact TS construction.
    #[inline(always)]
    fn random(&mut self) -> f64 {
        let a = (self.next() >> 5) as f64;
        let b = (self.next() >> 6) as f64;
        (a * 67108864.0 + b) / 9007199254740992.0
    }

    /// TS semantics: p<=0 and p>=1 consume no randomness.
    #[inline(always)]
    fn bernoulli(&mut self, p: f64) -> bool {
        if p <= 0.0 {
            return false;
        }
        if p >= 1.0 {
            return true;
        }
        self.random() < p
    }

    #[inline(always)]
    fn int_range(&mut self, n: usize) -> usize {
        (self.random() * n as f64).floor() as usize
    }
}

// ── Portable log / exp ───────────────────────────────────────────────────────
// Exact ports of `detLog` / `detExp` in src/sim/rng.ts (fdlibm 5.3 e_log.c and
// e_exp.c): only IEEE-754 +, −, ×, / and bit manipulation, so the results are
// bit-identical to the TS versions. f64::ln / powf come from Rust's libm, which
// differs from V8's Math.log / Math.pow by 1 ulp on some inputs — not good
// enough for the Gamma draws, whose bits the parity tests compare.

const LN2_HI: f64 = 6.93147180369123816490e-01;
const LN2_LO: f64 = 1.90821492927058770002e-10;
const TWO54: f64 = 1.80143985094819840000e+16;
const LG1: f64 = 6.666666666666735130e-01;
const LG2: f64 = 3.999999999940941908e-01;
const LG3: f64 = 2.857142874366239149e-01;
const LG4: f64 = 2.222219843214978396e-01;
const LG5: f64 = 1.818357216161805012e-01;
const LG6: f64 = 1.531383769920937332e-01;
const LG7: f64 = 1.479819860511658591e-01;

#[inline(always)]
fn hi_word(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

#[inline(always)]
fn with_hi_word(x: f64, hi: i32) -> f64 {
    f64::from_bits(((hi as u32 as u64) << 32) | (x.to_bits() & 0xffff_ffff))
}

/// Natural log — exact port of `detLog` (fdlibm e_log.c).
#[allow(clippy::excessive_precision)]
fn det_log(mut x: f64) -> f64 {
    let mut hx = hi_word(x);
    let lx = x.to_bits() as u32;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = hi_word(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    x = with_hi_word(x, hx | (i ^ 0x3ff0_0000));
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk0 = k as f64;
            return dk0 * LN2_HI + dk0 * LN2_LO;
        }
        let r0 = f * f * (0.5 - 0.33333333333333333 * f);
        if k == 0 {
            return f - r0;
        }
        let dk1 = k as f64;
        return dk1 * LN2_HI - ((r0 - dk1 * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = k as f64;
    let z = s * s;
    let mut ii = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    ii |= j;
    let r = t2 + t1;
    if ii > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            return f - (hfsq - s * (hfsq + r));
        }
        return dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f);
    }
    if k == 0 {
        return f - s * (f - r);
    }
    dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
}

const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
const INVLN2: f64 = 1.44269504088896338700e+00;
const TWOM1000: f64 = 9.33263618503218878990e-302;
const P1: f64 = 1.66666666666666019037e-01;
const P2: f64 = -2.77777777770155933842e-03;
const P3: f64 = 6.61375632143793436117e-05;
const P4: f64 = -1.65339022054652515390e-06;
const P5: f64 = 4.13813679705723846039e-08;

/// e^x — exact port of `detExp` (fdlibm e_exp.c).
#[allow(clippy::excessive_precision)]
fn det_exp(mut x: f64) -> f64 {
    let mut hx = (x.to_bits() >> 32) as u32;
    let xsb = ((hx >> 31) & 1) as i32;
    hx &= 0x7fff_ffff;
    let mut hi = 0.0;
    let mut lo = 0.0;
    let k: i32;
    if hx >= 0x4086_2e42 {
        if hx >= 0x7ff0_0000 {
            if ((hx & 0xfffff) | (x.to_bits() as u32)) != 0 {
                return x + x;
            }
            return if xsb == 0 { x } else { 0.0 };
        }
        if x > O_THRESHOLD {
            return f64::INFINITY;
        }
        if x < U_THRESHOLD {
            return 0.0;
        }
    }
    if hx > 0x3fd6_2e42 {
        if hx < 0x3ff0_a2b2 {
            hi = x - (if xsb == 0 { LN2_HI } else { -LN2_HI });
            lo = if xsb == 0 { LN2_LO } else { -LN2_LO };
            k = 1 - xsb - xsb;
        } else {
            k = (INVLN2 * x + (if xsb == 0 { 0.5 } else { -0.5 })) as i32;
            let t = k as f64;
            hi = x - t * LN2_HI;
            lo = t * LN2_LO;
        }
        x = hi - lo;
    } else if hx < 0x3e30_0000 {
        return 1.0 + x;
    } else {
        k = 0;
    }
    let t = x * x;
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        return with_hi_word(y, hi_word(y).wrapping_add(k << 20));
    }
    with_hi_word(y, hi_word(y).wrapping_add((k + 1000) << 20)) * TWOM1000
}

#[derive(Default)]
struct Params {
    // strain (single strain — the wrapper gates mutate=false)
    attack: f64,
    incub: i32,
    infectious: i32,
    ifr: f64,
    immunity_days: f64,
    range: i32,
    mixing: f64,
    // defenses
    prot_by_mask: [f64; 4],
    src_by_mask: [f64; 4],
    mort_by_mask: [f64; 4],
    uptake: [f64; 2],
    // lockdown
    lockdown_on: bool,
    mobility: f64,
    trans_mul: f64, // 1 - transmissionReduction when on, else 1
    // quarantine
    quarantine_on: bool,
    det_rate: f64,
    q_prot_mul: f64, // 1 - protection when on, else 1
    q_src_mul: f64,  // 1 - sourceControl when on, else 1
    q_duration: i32,
    // misc
    geometry: i32, // 0 square, 1 triangular, 2 hexagonal, 3 meanfield, 4 voronoi
    birth_rate: f64,
    reseed_on: bool,
}

struct Sim {
    rng: Rng,
    p: Params,
    size: usize,
    n: usize,
    tick: i32,
    state: Vec<u8>,
    next: Vec<u8>,
    defenses: Vec<u8>,
    lockdown_compliant: Vec<u8>,
    quarantined: Vec<u8>,
    q_expiry: Vec<i32>,
    exposed_at: Vec<i32>,
    event_tick: Vec<i32>,
    i_list: Vec<u32>,
    i_pos: Vec<i32>,
    d_list: Vec<u32>,
    d_pos: Vec<i32>,
    life_buckets: HashMap<i32, Vec<u32>>,
    q_buckets: HashMap<i32, Vec<u32>>,
    census: [i32; 5],
    masked_living: i32,
    vaccinated_living: i32,
    quar_living: i32,
    // neighbor tables [role][parity] as flat [dx,dy,...]; square/meanfield use
    // parity 0 for both. role 0 = transmission range, 1 = quarantine contacts,
    // 2 = birth range-1.
    tables: [[Vec<i32>; 2]; 3],
    // Voronoi per-cell CSR neighbor lists per role (geometry 4): offsets is
    // n+1 long, list holds absolute cell indices in TS iteration order.
    csr_offsets: [Vec<i32>; 3],
    csr_list: [Vec<i32>; 3],
    sched: Vec<f64>,
    // Per-cell susceptibility multipliers (susceptibilityCV); empty = off.
    sus: Vec<f64>,
    // per-step stats out: [s,e,i,r,d,newInf,newInfectious,newDeaths,newRecovered,masked,vax,quar]
    stats: [i32; 12],
}

static mut SIM: Option<Sim> = None;

fn sim() -> &'static mut Sim {
    unsafe {
        #[allow(static_mut_refs)]
        SIM.as_mut().unwrap()
    }
}

#[inline(always)]
fn torus(v: i32, size: i32) -> i32 {
    let m = v % size;
    if m < 0 {
        m + size
    } else {
        m
    }
}

impl Sim {
    #[inline(always)]
    fn parity_of(&self, x: i32, y: i32) -> usize {
        match self.p.geometry {
            1 => ((x + y) & 1) as usize, // triangular: cell parity
            2 => (y & 1) as usize,       // hexagonal: row parity
            _ => 0,
        }
    }

    #[inline(always)]
    fn schedule_life(&mut self, i: u32, t: i32) {
        self.event_tick[i as usize] = t;
        self.life_buckets.entry(t).or_default().push(i);
    }

    #[inline(always)]
    fn schedule_quar(&mut self, i: u32, t: i32) {
        self.q_buckets.entry(t).or_default().push(i);
    }

    /// Geometric waiting time, support {1, 2, …} — exact TS formula.
    #[inline(always)]
    fn geometric_delay(&mut self, p: f64) -> i32 {
        if p >= 1.0 {
            return 1;
        }
        let u = self.rng.random();
        1 + ((1.0 - u).ln() / (1.0 - p).ln()).floor() as i32
    }

    #[inline(always)]
    fn wane_p(&self) -> f64 {
        if self.p.immunity_days > 0.0 {
            1.0 / self.p.immunity_days
        } else {
            1.0
        }
    }

    #[inline(always)]
    fn i_add(&mut self, i: u32) {
        self.i_pos[i as usize] = self.i_list.len() as i32;
        self.i_list.push(i);
    }

    #[inline(always)]
    fn i_remove(&mut self, i: usize) {
        let p = self.i_pos[i] as usize;
        let last = *self.i_list.last().unwrap();
        self.i_list[p] = last;
        self.i_pos[last as usize] = p as i32;
        self.i_list.pop();
        self.i_pos[i] = -1;
    }

    #[inline(always)]
    fn tx_mul_now(&self) -> f64 {
        if self.sched.is_empty() {
            return 1.0;
        }
        let idx = if (self.tick as usize) < self.sched.len() {
            self.tick as usize
        } else {
            self.sched.len() - 1
        };
        self.sched[idx]
    }

    fn finalize_init(&mut self) {
        self.tick = 0;
        self.next.copy_from_slice(&self.state);
        self.i_list.clear();
        self.d_list.clear();
        self.i_pos.iter_mut().for_each(|v| *v = -1);
        self.d_pos.iter_mut().for_each(|v| *v = -1);
        self.exposed_at.iter_mut().for_each(|v| *v = 0);
        self.event_tick.iter_mut().for_each(|v| *v = -1);
        self.life_buckets.clear();
        self.q_buckets.clear();
        self.census = [0; 5];
        self.masked_living = 0;
        self.vaccinated_living = 0;
        self.quar_living = 0;
        let incub = self.p.incub;
        for i in 0..self.n {
            let s = self.state[i];
            self.census[s as usize] += 1;
            let d = self.defenses[i];
            if d & 1 != 0 {
                self.masked_living += 1;
            }
            if d & 2 != 0 {
                self.vaccinated_living += 1;
            }
            if s == ST_E {
                // Seeded cells behave as if exposed one tick before tick 0.
                self.exposed_at[i] = -1;
                self.schedule_life(i as u32, (-1 + incub).max(0));
            }
        }
    }

    fn step(&mut self) {
        let tick = self.tick;
        let n = self.n;
        self.next.copy_from_slice(&self.state);

        let mut new_infections = 0i32;
        let mut new_infectious = 0i32;
        let mut new_deaths = 0i32;
        let mut new_recovered = 0i32;

        // 1) Transmission.
        if self.p.geometry == 3 {
            new_infections = self.transmit_mean_field(tick);
        } else if self.p.geometry == 4 {
            new_infections = self.transmit_spatial_csr(tick);
        } else {
            new_infections = self.transmit_spatial(tick);
        }

        // 2) Quarantine detection over the I-list.
        if self.p.quarantine_on && self.p.det_rate > 0.0 && self.p.q_duration > 0 {
            let det_rate = self.p.det_rate;
            let expiry = tick + self.p.q_duration;
            let size = self.size as i32;
            let mean_field = self.p.geometry == 3;
            let i_count = self.i_list.len();
            for c in 0..i_count {
                let i = self.i_list[c] as usize;
                if self.quarantined[i] != 0 {
                    continue;
                }
                if !self.rng.bernoulli(det_rate) {
                    continue;
                }
                self.quarantined[i] = 1;
                if self.state[i] != ST_D {
                    self.quar_living += 1;
                }
                self.q_expiry[i] = expiry;
                self.schedule_quar(i as u32, expiry);
                if mean_field {
                    continue;
                }
                if self.p.geometry == 4 {
                    let lo = self.csr_offsets[1][i] as usize;
                    let hi = self.csr_offsets[1][i + 1] as usize;
                    for k in lo..hi {
                        let j = self.csr_list[1][k] as usize;
                        if j == i {
                            continue;
                        }
                        if self.quarantined[j] == 0 {
                            self.quarantined[j] = 1;
                            if self.state[j] != ST_D {
                                self.quar_living += 1;
                            }
                        }
                        if self.q_expiry[j] < expiry {
                            self.q_expiry[j] = expiry;
                            self.schedule_quar(j as u32, expiry);
                        }
                    }
                    continue;
                }
                let x = (i % self.size) as i32;
                let y = (i / self.size) as i32;
                let parity = self.parity_of(x, y);
                let m2 = self.tables[1][parity].len();
                for k in (0..m2).step_by(2) {
                    let dx = self.tables[1][parity][k];
                    let dy = self.tables[1][parity][k + 1];
                    let nx = torus(x + dx, size);
                    let ny = torus(y + dy, size);
                    let j = (ny * size + nx) as usize;
                    if j == i {
                        continue;
                    }
                    if self.quarantined[j] == 0 {
                        self.quarantined[j] = 1;
                        if self.state[j] != ST_D {
                            self.quar_living += 1;
                        }
                    }
                    if self.q_expiry[j] < expiry {
                        self.q_expiry[j] = expiry;
                        self.schedule_quar(j as u32, expiry);
                    }
                }
            }
        }

        // 3a) Quarantine release.
        if self.p.quarantine_on {
            if let Some(qb) = self.q_buckets.remove(&tick) {
                for &iu in &qb {
                    let i = iu as usize;
                    if self.quarantined[i] != 0 && self.q_expiry[i] <= tick {
                        self.quarantined[i] = 0;
                        self.q_expiry[i] = 0;
                        if self.state[i] != ST_D {
                            self.quar_living -= 1;
                        }
                    }
                }
            }
        }

        // 3b) Scheduled life-cycle transitions.
        if let Some(lb) = self.life_buckets.remove(&tick) {
            for &iu in &lb {
                let i = iu as usize;
                if self.event_tick[i] != tick {
                    continue; // stale after a reschedule
                }
                let s = self.state[i];
                if s == ST_E {
                    self.next[i] = ST_I;
                    self.census[ST_E as usize] -= 1;
                    self.census[ST_I as usize] += 1;
                    new_infectious += 1;
                    self.i_add(iu);
                    let t2 = (tick + 1).max(self.exposed_at[i] + self.p.incub + self.p.infectious);
                    self.schedule_life(iu, t2);
                } else if s == ST_I {
                    self.i_remove(i);
                    let ifr = self.p.ifr * self.p.mort_by_mask[(self.defenses[i] & 3) as usize];
                    if self.rng.bernoulli(ifr) {
                        self.next[i] = ST_D;
                        self.census[ST_I as usize] -= 1;
                        self.census[ST_D as usize] += 1;
                        new_deaths += 1;
                        self.d_pos[i] = self.d_list.len() as i32;
                        self.d_list.push(iu);
                        let d = self.defenses[i];
                        if d & 1 != 0 {
                            self.masked_living -= 1;
                        }
                        if d & 2 != 0 {
                            self.vaccinated_living -= 1;
                        }
                        if self.quarantined[i] != 0 {
                            self.quar_living -= 1;
                        }
                        self.event_tick[i] = -1;
                    } else {
                        self.next[i] = ST_R;
                        self.census[ST_I as usize] -= 1;
                        self.census[ST_R as usize] += 1;
                        new_recovered += 1;
                        let wp = self.wane_p();
                        let g = self.geometric_delay(wp);
                        self.schedule_life(iu, tick + g);
                    }
                } else if s == ST_R {
                    self.next[i] = ST_S;
                    self.census[ST_R as usize] -= 1;
                    self.census[ST_S as usize] += 1;
                    self.event_tick[i] = -1;
                }
            }
        }

        // 3c) Birth roll over the dead list (backward; swap-remove safe).
        if self.p.birth_rate > 0.0 && !self.d_list.is_empty() {
            let mean_field = self.p.geometry == 3;
            let size = self.size as i32;
            let mut k = self.d_list.len();
            while k > 0 {
                k -= 1;
                let i = self.d_list[k] as usize;
                let p = if mean_field {
                    self.p.birth_rate
                } else if self.p.geometry == 4 {
                    // TS neighborAliveFraction voronoi branch: alive/len over
                    // the direct CSR neighbors, empty degree → 0.5.
                    let lo = self.csr_offsets[2][i] as usize;
                    let hi = self.csr_offsets[2][i + 1] as usize;
                    let frac = if hi == lo {
                        0.5
                    } else {
                        let mut alive = 0i32;
                        for k in lo..hi {
                            if self.state[self.csr_list[2][k] as usize] != ST_D {
                                alive += 1;
                            }
                        }
                        alive as f64 / (hi - lo) as f64
                    };
                    self.p.birth_rate * frac
                } else {
                    let x = (i % self.size) as i32;
                    let y = (i / self.size) as i32;
                    let parity = self.parity_of(x, y);
                    let m2 = self.tables[2][parity].len();
                    let mut alive = 0i32;
                    if x >= 1 && x < size - 1 && y >= 1 && y < size - 1 {
                        for kk in (0..m2).step_by(2) {
                            let dx = self.tables[2][parity][kk];
                            let dy = self.tables[2][parity][kk + 1];
                            let j = (i as i32 + dy * size + dx) as usize;
                            if self.state[j] != ST_D {
                                alive += 1;
                            }
                        }
                    } else {
                        for kk in (0..m2).step_by(2) {
                            let dx = self.tables[2][parity][kk];
                            let dy = self.tables[2][parity][kk + 1];
                            let nx = torus(x + dx, size);
                            let ny = torus(y + dy, size);
                            let j = (ny * size + nx) as usize;
                            if self.state[j] != ST_D {
                                alive += 1;
                            }
                        }
                    }
                    let frac = if m2 == 0 { 0.5 } else { alive as f64 / (m2 as f64 / 2.0) };
                    self.p.birth_rate * frac
                };
                if !self.rng.bernoulli(p) {
                    continue;
                }
                self.next[i] = ST_S;
                self.census[ST_D as usize] -= 1;
                self.census[ST_S as usize] += 1;
                let last = *self.d_list.last().unwrap();
                self.d_list[k] = last;
                self.d_pos[last as usize] = k as i32;
                self.d_list.pop();
                self.d_pos[i] = -1;
                let mut flags = 0u8;
                if self.rng.bernoulli(self.p.uptake[0]) {
                    flags |= 1;
                }
                if self.rng.bernoulli(self.p.uptake[1]) {
                    flags |= 2;
                }
                self.defenses[i] = flags;
                if flags & 1 != 0 {
                    self.masked_living += 1;
                }
                if flags & 2 != 0 {
                    self.vaccinated_living += 1;
                }
                if self.quarantined[i] != 0 {
                    self.quar_living += 1;
                }
            }
        }

        // 4) Swap.
        std::mem::swap(&mut self.state, &mut self.next);
        self.tick += 1;

        // Optional extinction reseed (off by default).
        if self.p.reseed_on
            && self.p.immunity_days < 36500.0
            && self.tick > 30
            && self.census[ST_E as usize] + self.census[ST_I as usize] == 0
        {
            let mut attempts = 0;
            while attempts < 16 {
                let idx = self.rng.int_range(n);
                if self.state[idx] == ST_S {
                    let mut prot_mul = self.p.prot_by_mask[(self.defenses[idx] & 3) as usize];
                    if self.p.quarantine_on && self.quarantined[idx] != 0 {
                        prot_mul *= self.p.q_prot_mul;
                    }
                    let mut import_p = prot_mul * self.p.trans_mul;
                    if self.p.quarantine_on {
                        import_p *= self.p.q_src_mul;
                    }
                    if !self.sus.is_empty() {
                        import_p *= self.sus[idx];
                        if import_p > 1.0 {
                            import_p = 1.0;
                        }
                    }
                    if import_p > 0.0 && self.rng.bernoulli(import_p) {
                        self.state[idx] = ST_I;
                        self.census[ST_S as usize] -= 1;
                        self.census[ST_I as usize] += 1;
                        self.i_add(idx as u32);
                        self.exposed_at[idx] = self.tick - 1 - self.p.incub;
                        let t2 = self.tick.max(self.tick - 1 + self.p.infectious);
                        self.schedule_life(idx as u32, t2);
                    }
                    break;
                }
                attempts += 1;
            }
        }

        self.stats = [
            self.census[0],
            self.census[1],
            self.census[2],
            self.census[3],
            self.census[4],
            new_infections,
            new_infectious,
            new_deaths,
            new_recovered,
            self.masked_living,
            self.vaccinated_living,
            self.quar_living,
        ];
    }

    fn transmit_spatial(&mut self, tick: i32) -> i32 {
        let size = self.size as i32;
        let range = self.p.range;
        let tx_mul = self.tx_mul_now();
        let base_attack = self.p.attack * tx_mul;
        let lockdown_on = self.p.lockdown_on;
        let lockdown_skip_p = if lockdown_on { self.p.mobility } else { 0.0 };
        let quarantine_on = self.p.quarantine_on;
        let sus_on = !self.sus.is_empty();
        let mut new_infections = 0i32;

        let i_count = self.i_list.len();
        for c in 0..i_count {
            let i = self.i_list[c] as usize;
            let mut src_mul = self.p.src_by_mask[(self.defenses[i] & 3) as usize];
            if quarantine_on && self.quarantined[i] != 0 {
                src_mul *= self.p.q_src_mul;
            }
            src_mul *= self.p.trans_mul;
            let atk_src = base_attack * src_mul;
            if atk_src <= 0.0 {
                continue;
            }
            let src_under_lockdown = lockdown_on && self.lockdown_compliant[i] == 1;
            let x = (i % self.size) as i32;
            let y = (i / self.size) as i32;
            let parity = self.parity_of(x, y);
            let m2 = self.tables[0][parity].len();
            let interior = x >= range && x < size - range && y >= range && y < size - range;

            for k in (0..m2).step_by(2) {
                if src_under_lockdown && lockdown_skip_p > 0.0 && self.rng.bernoulli(lockdown_skip_p) {
                    continue;
                }
                let dx = self.tables[0][parity][k];
                let dy = self.tables[0][parity][k + 1];
                let j = if interior {
                    (i as i32 + dy * size + dx) as usize
                } else {
                    let nx = torus(x + dx, size);
                    let ny = torus(y + dy, size);
                    (ny * size + nx) as usize
                };
                if self.state[j] != ST_S {
                    continue;
                }
                let mut prot_mul = self.p.prot_by_mask[(self.defenses[j] & 3) as usize];
                if quarantine_on && self.quarantined[j] != 0 {
                    prot_mul *= self.p.q_prot_mul;
                }
                let mut p = atk_src * prot_mul;
                if sus_on {
                    p *= self.sus[j];
                    if p > 1.0 {
                        p = 1.0;
                    }
                }
                if p <= 0.0 {
                    continue;
                }
                if self.rng.bernoulli(p) && self.next[j] == ST_S {
                    self.next[j] = ST_E;
                    self.exposed_at[j] = tick;
                    let t2 = tick + self.p.incub.max(1);
                    self.schedule_life(j as u32, t2);
                    self.census[ST_S as usize] -= 1;
                    self.census[ST_E as usize] += 1;
                    new_infections += 1;
                }
            }

            // Long-range mixing — the exact TS jump block: draws only when the
            // gene is nonzero, schedule multiplier on the contact frequency,
            // lockdown skip for compliant sources, one uniform target.
            let mix = self.p.mixing;
            if mix > 0.0 {
                let p_jump = mix * tx_mul;
                if src_under_lockdown && lockdown_skip_p > 0.0 && self.rng.bernoulli(lockdown_skip_p) {
                    continue;
                }
                if !self.rng.bernoulli(p_jump) {
                    continue;
                }
                let j = self.rng.int_range(self.n);
                if j == i || self.state[j] != ST_S {
                    continue;
                }
                let mut prot_mul = self.p.prot_by_mask[(self.defenses[j] & 3) as usize];
                if quarantine_on && self.quarantined[j] != 0 {
                    prot_mul *= self.p.q_prot_mul;
                }
                let mut p = atk_src * prot_mul;
                if sus_on {
                    p *= self.sus[j];
                    if p > 1.0 {
                        p = 1.0;
                    }
                }
                if p <= 0.0 {
                    continue;
                }
                if self.rng.bernoulli(p) && self.next[j] == ST_S {
                    self.next[j] = ST_E;
                    self.exposed_at[j] = tick;
                    let t2 = tick + self.p.incub.max(1);
                    self.schedule_life(j as u32, t2);
                    self.census[ST_S as usize] -= 1;
                    self.census[ST_E as usize] += 1;
                    new_infections += 1;
                }
            }
        }
        new_infections
    }

    /// Voronoi transmission — the exact TS `transmitSpatial` voronoi branch:
    /// same per-attacker multipliers and same per-neighbor draw order, with the
    /// neighbor source swapped from parity offsets to the per-cell CSR list.
    fn transmit_spatial_csr(&mut self, tick: i32) -> i32 {
        let tx_mul = self.tx_mul_now();
        let base_attack = self.p.attack * tx_mul;
        let lockdown_on = self.p.lockdown_on;
        let lockdown_skip_p = if lockdown_on { self.p.mobility } else { 0.0 };
        let quarantine_on = self.p.quarantine_on;
        let sus_on = !self.sus.is_empty();
        let mut new_infections = 0i32;

        let i_count = self.i_list.len();
        for c in 0..i_count {
            let i = self.i_list[c] as usize;
            let mut src_mul = self.p.src_by_mask[(self.defenses[i] & 3) as usize];
            if quarantine_on && self.quarantined[i] != 0 {
                src_mul *= self.p.q_src_mul;
            }
            src_mul *= self.p.trans_mul;
            let atk_src = base_attack * src_mul;
            if atk_src <= 0.0 {
                continue;
            }
            let src_under_lockdown = lockdown_on && self.lockdown_compliant[i] == 1;
            let lo = self.csr_offsets[0][i] as usize;
            let hi = self.csr_offsets[0][i + 1] as usize;
            for k in lo..hi {
                if src_under_lockdown && lockdown_skip_p > 0.0 && self.rng.bernoulli(lockdown_skip_p) {
                    continue;
                }
                let j = self.csr_list[0][k] as usize;
                if self.state[j] != ST_S {
                    continue;
                }
                let mut prot_mul = self.p.prot_by_mask[(self.defenses[j] & 3) as usize];
                if quarantine_on && self.quarantined[j] != 0 {
                    prot_mul *= self.p.q_prot_mul;
                }
                let mut p = atk_src * prot_mul;
                if sus_on {
                    p *= self.sus[j];
                    if p > 1.0 {
                        p = 1.0;
                    }
                }
                if p <= 0.0 {
                    continue;
                }
                if self.rng.bernoulli(p) && self.next[j] == ST_S {
                    self.next[j] = ST_E;
                    self.exposed_at[j] = tick;
                    let t2 = tick + self.p.incub.max(1);
                    self.schedule_life(j as u32, t2);
                    self.census[ST_S as usize] -= 1;
                    self.census[ST_E as usize] += 1;
                    new_infections += 1;
                }
            }

            // Long-range mixing — the exact TS jump block: draws only when the
            // gene is nonzero, schedule multiplier on the contact frequency,
            // lockdown skip for compliant sources, one uniform target.
            let mix = self.p.mixing;
            if mix > 0.0 {
                let p_jump = mix * tx_mul;
                if src_under_lockdown && lockdown_skip_p > 0.0 && self.rng.bernoulli(lockdown_skip_p) {
                    continue;
                }
                if !self.rng.bernoulli(p_jump) {
                    continue;
                }
                let j = self.rng.int_range(self.n);
                if j == i || self.state[j] != ST_S {
                    continue;
                }
                let mut prot_mul = self.p.prot_by_mask[(self.defenses[j] & 3) as usize];
                if quarantine_on && self.quarantined[j] != 0 {
                    prot_mul *= self.p.q_prot_mul;
                }
                let mut p = atk_src * prot_mul;
                if sus_on {
                    p *= self.sus[j];
                    if p > 1.0 {
                        p = 1.0;
                    }
                }
                if p <= 0.0 {
                    continue;
                }
                if self.rng.bernoulli(p) && self.next[j] == ST_S {
                    self.next[j] = ST_E;
                    self.exposed_at[j] = tick;
                    let t2 = tick + self.p.incub.max(1);
                    self.schedule_life(j as u32, t2);
                    self.census[ST_S as usize] -= 1;
                    self.census[ST_E as usize] += 1;
                    new_infections += 1;
                }
            }
        }
        new_infections
    }

    fn transmit_mean_field(&mut self, tick: i32) -> i32 {
        let n = self.n;
        let i_count = self.census[ST_I as usize];
        if i_count <= 0 {
            return 0;
        }
        // k=2: mean-field sits below triangular (3) in the R0 hierarchy.
        let k = 2.0;
        let base_attack = self.p.attack * self.tx_mul_now();
        let exponent = (i_count as f64 * k) / n as f64;
        let mob_keep = if self.p.lockdown_on { 1.0 - self.p.mobility } else { 1.0 };
        let src_mul = self.p.trans_mul * self.p.q_src_mul;
        let quarantine_on = self.p.quarantine_on;
        let sus_on = !self.sus.is_empty();

        // Per-cohort exposure probabilities: index = (defense mask << 1) | quarantined.
        let mut p_table = [0.0f64; 8];
        for mask in 0..4usize {
            for q in 0..2usize {
                let mut prot_mul = self.p.prot_by_mask[mask];
                if quarantine_on && q == 1 {
                    prot_mul *= self.p.q_prot_mul;
                }
                let p = base_attack * src_mul * prot_mul;
                let p_exposed = if p > 0.0 { 1.0 - (1.0 - p).powf(exponent) } else { 0.0 };
                p_table[(mask << 1) | q] = mob_keep * p_exposed;
            }
        }

        let incub0 = self.p.incub.max(1);
        // Monomorphised sweep: the option-off instance compiles to the exact
        // pre-feature loop (no per-cell branch or bounds check on `sus`).
        if sus_on {
            self.mean_field_sweep::<true>(tick, &p_table, incub0, quarantine_on)
        } else {
            self.mean_field_sweep::<false>(tick, &p_table, incub0, quarantine_on)
        }
    }

    #[inline(always)]
    fn mean_field_sweep<const HET: bool>(&mut self, tick: i32, p_table: &[f64; 8], incub0: i32, quarantine_on: bool) -> i32 {
        let n = self.n;
        let mut new_infections = 0i32;
        for j in 0..n {
            if self.state[j] != ST_S {
                continue;
            }
            let q = if quarantine_on && self.quarantined[j] != 0 { 1usize } else { 0usize };
            let mut pe = p_table[(((self.defenses[j] & 3) as usize) << 1) | q];
            // Heterogeneous susceptibility: exact cohort lookup, then × s_j.
            if HET {
                pe *= self.sus[j];
                if pe > 1.0 {
                    pe = 1.0;
                }
            }
            if pe <= 0.0 {
                continue;
            }
            if self.rng.bernoulli(pe) && self.next[j] == ST_S {
                self.next[j] = ST_E;
                self.exposed_at[j] = tick;
                self.schedule_life(j as u32, tick + incub0);
                self.census[ST_S as usize] -= 1;
                self.census[ST_E as usize] += 1;
                new_infections += 1;
            }
        }
        new_infections
    }

    // ── patchConfig ops (exact ports; draws stay on this RNG stream) ─────────

    fn resample_defense(&mut self, flag_idx: i32, old_p: f64, new_p: f64) {
        let mask = 1u8 << flag_idx;
        if new_p > old_p {
            let q = (new_p - old_p) / (1.0 - old_p).max(1e-9);
            for i in 0..self.n {
                if self.defenses[i] & mask == 0 && self.rng.bernoulli(q) {
                    self.defenses[i] |= mask;
                }
            }
        } else if new_p < old_p {
            let q = (old_p - new_p) / old_p.max(1e-9);
            for i in 0..self.n {
                if self.defenses[i] & mask != 0 && self.rng.bernoulli(q) {
                    self.defenses[i] &= !mask;
                }
            }
        }
    }

    fn resample_lockdown(&mut self, old_p: f64, new_p: f64) {
        if new_p > old_p {
            let q = (new_p - old_p) / (1.0 - old_p).max(1e-9);
            for i in 0..self.n {
                if self.lockdown_compliant[i] == 0 && self.rng.bernoulli(q) {
                    self.lockdown_compliant[i] = 1;
                }
            }
        } else if new_p < old_p {
            let q = (old_p - new_p) / old_p.max(1e-9);
            for i in 0..self.n {
                if self.lockdown_compliant[i] != 0 && self.rng.bernoulli(q) {
                    self.lockdown_compliant[i] = 0;
                }
            }
        }
    }

    fn quarantine_clear(&mut self) {
        self.quarantined.iter_mut().for_each(|v| *v = 0);
        self.q_expiry.iter_mut().for_each(|v| *v = 0);
        self.quar_living = 0;
        self.q_buckets.clear();
    }

    fn recount_flags(&mut self) {
        let mut m = 0;
        let mut v = 0;
        for i in 0..self.n {
            if self.state[i] == ST_D {
                continue;
            }
            let d = self.defenses[i];
            if d & 1 != 0 {
                m += 1;
            }
            if d & 2 != 0 {
                v += 1;
            }
        }
        self.masked_living = m;
        self.vaccinated_living = v;
    }

    fn rebuild_schedules(&mut self, timing_changed: bool, wane_changed: bool) {
        let now = self.tick;
        let wp = self.wane_p();
        for i in 0..self.n {
            let s = self.state[i];
            if timing_changed && s == ST_E {
                let t2 = now.max(self.exposed_at[i] + self.p.incub);
                self.schedule_life(i as u32, t2);
            } else if timing_changed && s == ST_I {
                let t2 = now.max(self.exposed_at[i] + self.p.incub + self.p.infectious);
                self.schedule_life(i as u32, t2);
            } else if wane_changed && s == ST_R {
                let g = self.geometric_delay(wp);
                self.schedule_life(i as u32, now + g - 1);
            }
        }
    }
}

// ── C ABI exports ────────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn init(size: u32) {
    let size = size as usize;
    let n = size * size;
    let sim = Sim {
        rng: Rng { s: [1, 2, 3, 4] },
        p: Params::default(),
        size,
        n,
        tick: 0,
        state: vec![0; n],
        next: vec![0; n],
        defenses: vec![0; n],
        lockdown_compliant: vec![0; n],
        quarantined: vec![0; n],
        q_expiry: vec![0; n],
        exposed_at: vec![0; n],
        event_tick: vec![-1; n],
        i_list: Vec::with_capacity(n),
        i_pos: vec![-1; n],
        d_list: Vec::with_capacity(n),
        d_pos: vec![-1; n],
        life_buckets: HashMap::new(),
        q_buckets: HashMap::new(),
        census: [0; 5],
        masked_living: 0,
        vaccinated_living: 0,
        quar_living: 0,
        tables: Default::default(),
        csr_offsets: Default::default(),
        csr_list: Default::default(),
        sched: Vec::new(),
        sus: Vec::new(),
        stats: [0; 12],
    };
    unsafe {
        SIM = Some(sim);
    }
}

#[no_mangle]
pub extern "C" fn set_rng(s0: u32, s1: u32, s2: u32, s3: u32) {
    sim().rng.s = [s0, s1, s2, s3];
}

#[no_mangle]
pub extern "C" fn set_strain(attack: f64, incub: i32, infectious: i32, ifr: f64, immunity_days: f64, range: i32, mixing: f64) {
    let p = &mut sim().p;
    p.attack = attack;
    p.incub = incub;
    p.infectious = infectious;
    p.ifr = ifr;
    p.immunity_days = immunity_days;
    p.range = range;
    p.mixing = mixing;
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_defenses(
    p0: f64, p1: f64, p2: f64, p3: f64,
    s0: f64, s1: f64, s2: f64, s3: f64,
    m0: f64, m1: f64, m2: f64, m3: f64,
    u0: f64, u1: f64,
) {
    let p = &mut sim().p;
    p.prot_by_mask = [p0, p1, p2, p3];
    p.src_by_mask = [s0, s1, s2, s3];
    p.mort_by_mask = [m0, m1, m2, m3];
    p.uptake = [u0, u1];
}

#[no_mangle]
pub extern "C" fn set_lockdown(on: i32, mobility: f64, trans_mul: f64) {
    let p = &mut sim().p;
    p.lockdown_on = on != 0;
    p.mobility = mobility;
    p.trans_mul = trans_mul;
}

#[no_mangle]
pub extern "C" fn set_quarantine(on: i32, det_rate: f64, q_prot_mul: f64, q_src_mul: f64, duration: i32) {
    let p = &mut sim().p;
    p.quarantine_on = on != 0;
    p.det_rate = det_rate;
    p.q_prot_mul = q_prot_mul;
    p.q_src_mul = q_src_mul;
    p.q_duration = duration;
}

#[no_mangle]
pub extern "C" fn set_misc(geometry: i32, birth_rate: f64, reseed_on: i32) {
    let p = &mut sim().p;
    p.geometry = geometry;
    p.birth_rate = birth_rate;
    p.reseed_on = reseed_on != 0;
}

/// Allocate the neighbor table for (role, parity) and return its pointer; the
/// JS side writes `len` i32s into it.
#[no_mangle]
pub extern "C" fn table_alloc(role: u32, parity: u32, len: u32) -> *mut i32 {
    let t = &mut sim().tables[role as usize][parity as usize];
    t.clear();
    t.resize(len as usize, 0);
    t.as_mut_ptr()
}

/// Allocate the voronoi CSR offsets array for `role` (n+1 i32s) and return its
/// pointer; the JS side writes into it.
#[no_mangle]
pub extern "C" fn csr_offsets_alloc(role: u32, len: u32) -> *mut i32 {
    let t = &mut sim().csr_offsets[role as usize];
    t.clear();
    t.resize(len as usize, 0);
    t.as_mut_ptr()
}

/// Allocate the voronoi CSR neighbor list for `role` (absolute cell indices).
#[no_mangle]
pub extern "C" fn csr_list_alloc(role: u32, len: u32) -> *mut i32 {
    let t = &mut sim().csr_list[role as usize];
    t.clear();
    t.resize(len as usize, 0);
    t.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn sched_alloc(len: u32) -> *mut f64 {
    // Mirror of MAX_SCHEDULE_LEN in src/sim/config.ts.
    let len = len.min(MAX_SCHEDULE_LEN);
    let s = &mut sim().sched;
    s.clear();
    s.resize(len as usize, 1.0);
    if len == 0 {
        std::ptr::null_mut()
    } else {
        s.as_mut_ptr()
    }
}

/// Draw the per-cell susceptibility multipliers s_i ~ Gamma(1/cv², cv²), in
/// cell order, from the main stream (exact port of `drawSusceptibility` in
/// population.ts). Call after `set_rng` and before `finalize_init`/`step`.
/// cv <= 0 (or non-finite) = off: clears `sus` and draws nothing.
#[no_mangle]
pub extern "C" fn susceptibility_init(cv: f64) {
    let sim = sim();
    sim.sus.clear();
    if !(cv.is_finite() && cv > 0.0) {
        return;
    }
    let theta = cv * cv;
    let shape = 1.0 / theta;
    let n = sim.n;
    sim.sus.reserve_exact(n);
    for _ in 0..n {
        let g = sim.rng.gamma(shape);
        sim.sus.push(g * theta);
    }
}

/// Pointer to the susceptibility multipliers (n f64s), or null when off.
#[no_mangle]
pub extern "C" fn susceptibility_ptr() -> *const f64 {
    let s = &sim().sus;
    if s.is_empty() {
        std::ptr::null()
    } else {
        s.as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn finalize_init() {
    sim().finalize_init();
}

#[no_mangle]
pub extern "C" fn step() {
    sim().step();
}

#[no_mangle]
pub extern "C" fn tick() -> i32 {
    sim().tick
}

#[no_mangle]
pub extern "C" fn state_ptr() -> *mut u8 {
    sim().state.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn defenses_ptr() -> *mut u8 {
    sim().defenses.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn lockdown_ptr() -> *mut u8 {
    sim().lockdown_compliant.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn quarantined_ptr() -> *mut u8 {
    sim().quarantined.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn qexpiry_ptr() -> *mut i32 {
    sim().q_expiry.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn stats_ptr() -> *const i32 {
    sim().stats.as_ptr()
}

#[no_mangle]
pub extern "C" fn resample_defense(flag_idx: i32, old_p: f64, new_p: f64) {
    sim().resample_defense(flag_idx, old_p, new_p);
}

#[no_mangle]
pub extern "C" fn resample_lockdown(old_p: f64, new_p: f64) {
    sim().resample_lockdown(old_p, new_p);
}

#[no_mangle]
pub extern "C" fn quarantine_clear() {
    sim().quarantine_clear();
}

#[no_mangle]
pub extern "C" fn recount_flags() {
    sim().recount_flags();
}

#[no_mangle]
pub extern "C" fn rebuild_schedules(timing_changed: i32, wane_changed: i32) {
    sim().rebuild_schedules(timing_changed != 0, wane_changed != 0);
}
