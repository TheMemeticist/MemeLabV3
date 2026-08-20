// WASM port of the event-driven SEIR-D engine core (docs/perf-plan.md Phase 2).
//
// This is a LINE-FAITHFUL port of `src/sim/engine.ts` (the Phase-1 event-driven
// engine) for the single-strain configuration space: square / triangular /
// hexagonal / mean-field geometries, defenses, lockdown, quarantine, births,
// waning, txSchedule, and extinction reseed. Voronoi and strain mutation stay
// on the TypeScript engine (the wrapper's compatibility gate routes them there).
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

use std::collections::HashMap;

const ST_S: u8 = 0;
const ST_E: u8 = 1;
const ST_I: u8 = 2;
const ST_R: u8 = 3;
const ST_D: u8 = 4;

struct Rng {
    s: [u32; 4],
}

impl Rng {
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

#[derive(Default)]
struct Params {
    // strain (single strain — the wrapper gates mutate=false)
    attack: f64,
    incub: i32,
    infectious: i32,
    ifr: f64,
    immunity_days: f64,
    range: i32,
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
    geometry: i32, // 0 square, 1 triangular, 2 hexagonal, 3 meanfield
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
    sched: Vec<f64>,
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
                let p = atk_src * prot_mul;
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
        let mut new_infections = 0i32;
        for j in 0..n {
            if self.state[j] != ST_S {
                continue;
            }
            let q = if quarantine_on && self.quarantined[j] != 0 { 1usize } else { 0usize };
            let pe = p_table[(((self.defenses[j] & 3) as usize) << 1) | q];
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
        sched: Vec::new(),
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
pub extern "C" fn set_strain(attack: f64, incub: i32, infectious: i32, ifr: f64, immunity_days: f64, range: i32) {
    let p = &mut sim().p;
    p.attack = attack;
    p.incub = incub;
    p.infectious = infectious;
    p.ifr = ifr;
    p.immunity_days = immunity_days;
    p.range = range;
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

#[no_mangle]
pub extern "C" fn sched_alloc(len: u32) -> *mut f64 {
    let s = &mut sim().sched;
    s.clear();
    s.resize(len as usize, 1.0);
    if len == 0 {
        std::ptr::null_mut()
    } else {
        s.as_mut_ptr()
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
