import { CellState } from '../types';
import type { LongStats, RetiredCostTotals, SimConfig, SimStats, StrainGenes, VoronoiTopology } from '../types';
import { LongHistory } from './long-history';
import { Rng } from './rng';
import { StrainPool } from './strain';
import { allocate, seed, type PopulationBuffers } from './population';
import { makeGeometry, torus, VoronoiLattice, type LatticeGeometry } from './neighbors';
import { buildVoronoi } from './voronoi';
import {
  resolveDefenses,
  protectionMultiplier,
  MASK_ALL,
  type ResolvedDefenses,
} from './defense';

const REFF_WINDOW = 14;

// Module-level copies of hot CellState members — cross-module const enum
// members aren't inlined by esbuild, so keep hot reads local.
const DEAD = CellState.Dead;

/** Cumulative per-pass wall-clock time (ms), populated only while
 *  `Engine.profile` is set. Used by the bench harness (`tests/bench.ts`);
 *  costs two `performance.now()` calls per pass per tick when enabled and
 *  nothing when null. */
export interface PassProfile {
  transmission: number;
  quarantine: number;
  lifecycle: number;
  stats: number;
}

/** Construction options. */
export interface EngineOptions {
  /**
   * Reuse an already-computed analytic R₀ instead of recomputing it in
   * `reset()`. `estimateR0` depends only on the strain genes, the geometry and
   * the Voronoi topology — never on the seed, the population buffers or the
   * RNG — so a caller running many engines that differ *only* by seed (the
   * fit/GA trial loop in `lib/fit-sim.ts`) can compute it once and hand it to
   * the rest. It draws no randomness, so skipping it cannot perturb the PRNG
   * trajectory: engines built with and without this option step identically.
   *
   * Omit the field to compute normally. Passing `null` reuses a null estimate
   * (the degenerate `size < 8` case) rather than meaning "unset".
   */
  rNaught?: number | null;
  /**
   * Cell index for patient zero (defaults to the grid center). Used by the fit
   * ensemble to start each trial from a different index case. Placement draws
   * no randomness, so engines with and without the override step identically
   * apart from the seeding location itself.
   */
  indexCell?: number;
  /**
   * Per-tick multiplier on transmission (index = tick, clamped to the last
   * entry; 1 = no effect) — the R₀ Estimator's time-varying interventions
   * R(t) hook. Multiplies the per-contact attack probability in both the
   * spatial and mean-field transmission passes. Omitted/empty ⇒ bit-identical
   * to the unscheduled engine (x·1 === x in IEEE). Deliberately NOT part of
   * SimConfig (no permalink impact) and ignored by estimateR0 — R₀ stays the
   * intervention-free basic number by convention.
   */
  txSchedule?: number[];
}

/**
 * Event-driven engine core (perf-plan.md Phase 1).
 *
 * The previous engine swept all N cells three times per tick; at endemic
 * steady state only ~3% of cells change state per tick, so the sweeps were
 * ~97% idle. This engine instead:
 *
 *  - keeps a compact list of Infectious cells (transmission + quarantine
 *    detection iterate O(I), not O(N));
 *  - schedules every timed transition (E→I, I→R/D, R→S waning, quarantine
 *    release) in per-tick bucket queues. E→I and I→R are deterministic
 *    counters, stored at exposure/onset. R→S waning samples its geometric
 *    waiting time ONCE at recovery — distribution-identical to the old
 *    per-tick Bernoulli (both are Geometric(p)), with one draw instead of one
 *    per tick per Recovered cell;
 *  - maintains the S/E/I/R/D census (and masked/vaccinated/quarantined
 *    counts) incrementally at each transition instead of a full-grid fold;
 *  - iterates a compact dead-cell list for the birth roll.
 *
 * Determinism contract: the engine remains a pure function of SimConfig —
 * two engines with the same config produce identical SimStats forever. The
 * RNG *trajectory* differs from the pre-P1 engine by design (fewer, different
 * draws); the golden digests in tests/engine-golden.test.ts were re-pinned
 * once for this redefinition, per the re-pin protocol documented there.
 *
 * The two-buffer swap invariant is unchanged: passes read `pop.state` and
 * write `pop.next`; the swap happens at the end of step().
 */
export class Engine {
  private rng!: Rng;
  private txSchedule: number[] | null = null;
  private pop!: PopulationBuffers;
  private strains!: StrainPool;
  private defenses!: ResolvedDefenses;
  private config!: SimConfig;
  private geometry!: LatticeGeometry;
  voronoiTopo: VoronoiTopology | null = null;

  tick = 0;
  private newInfectionsHistory: number[] = [];
  private newInfectiousHistory: number[] = [];
  // Monotonic cumulative-arrival counters (total infected / infectious /
  // recovered / dead since reset). Pushed per-tick into longStats so the chart
  // can show "Total" alongside "Active" (current) compartment counts.
  private cumExposed = 0;
  private cumInfectious = 0;
  private cumRecovered = 0;
  private cumDead = 0;
  history: LongHistory = new LongHistory();

  // ── Event-driven core state ────────────────────────────────────────────────
  /** Incremental S/E/I/R/D census, indexed by CellState. Updated at every
   *  transition; conservation (ΣΣ = N) holds because every update is a paired
   *  decrement/increment. */
  private census = new Int32Array(5);
  /** Living cells carrying the mask / vaccine flag (ungated by `enabled`;
   *  gating applies at stats time, matching the old census behavior). */
  private maskedLiving = 0;
  private vaccinatedLiving = 0;
  /** Living cells currently quarantined. */
  private quarLiving = 0;
  /** Compact list of Infectious cells + per-cell position (or -1). */
  private iList!: Int32Array;
  private iCount = 0;
  private iPos!: Int32Array;
  /** Compact list of Dead cells (for the birth roll). */
  private dList!: Int32Array;
  private dCount = 0;
  private dPos!: Int32Array;
  /** Tick the cell's current infection began (-1 for cells seeded at reset,
   *  so that seed-time exposures fire on the same schedule as the old
   *  infectedAge counter did). */
  private exposedAt!: Int32Array;
  /** The cell's currently scheduled life-cycle transition tick, or -1. Guards
   *  against stale bucket entries after a patchConfig reschedule. */
  private eventTick!: Int32Array;
  /** tick → cells whose life-cycle transition fires that tick. */
  private lifeBuckets = new Map<number, number[]>();
  /** tick → cells whose quarantine may expire that tick. Entries can be stale
   *  (expiry raised by a later detection); the firing guard re-checks. */
  private qBuckets = new Map<number, number[]>();

  /** Full ordered snapshot of the ring-buffered history. Allocates on every
   *  access — for tests/exports, not for per-frame use (the worker sends
   *  deltas via `history.lastRows()`). */
  get longStats(): LongStats {
    return this.history.toLongStats();
  }

  retiredCost: RetiredCostTotals = emptyRetired();
  rNaught: number | null = null;
  /** Set to a PassProfile to accumulate per-pass timings; null = no overhead. */
  profile: PassProfile | null = null;

  constructor(config: SimConfig, prebuiltTopo?: VoronoiTopology | null, opts?: EngineOptions) {
    this.reset(config, prebuiltTopo, opts);
  }

  reset(config: SimConfig, prebuiltTopo?: VoronoiTopology | null, opts?: EngineOptions): void {
    this.config = config;
    if ((config.geometry ?? 'square') === 'voronoi') {
      if (prebuiltTopo) {
        this.voronoiTopo = prebuiltTopo;
      } else {
        const topoRng = new Rng(config.seed ^ 0x564f524f);
        this.voronoiTopo = buildVoronoi(
          config.size * config.size,
          config.voronoiConfig,
          topoRng,
          false,
        );
      }
      this.geometry = new VoronoiLattice(this.voronoiTopo!);
    } else {
      this.voronoiTopo = null;
      this.geometry = makeGeometry(config.geometry);
    }
    this.rng = new Rng(config.seed);
    this.pop = allocate(config.size);
    this.strains = new StrainPool(config.strain);
    this.defenses = resolveDefenses(config.defenses);
    seed(this.pop, this.rng, {
      seedInfections: config.seedInfections,
      maskUptake: this.defenses.uptake[0],
      vaccineUptake: this.defenses.uptake[1],
      lockdownCompliance: config.lockdown.enabled ? config.lockdown.compliance : 0,
      patientZero: true,
      indexCell: opts?.indexCell,
    });
    this.tick = 0;
    this.newInfectionsHistory = [];
    this.newInfectiousHistory = [];

    // Build the event-driven structures from the freshly seeded buffers.
    // Scheduling draws no randomness, so the reset-time RNG trajectory is
    // identical to the pre-P1 engine (seed() draws are unchanged).
    const n = this.pop.n;
    this.iList = new Int32Array(n);
    this.iPos = new Int32Array(n).fill(-1);
    this.iCount = 0;
    this.dList = new Int32Array(n);
    this.dPos = new Int32Array(n).fill(-1);
    this.dCount = 0;
    this.exposedAt = new Int32Array(n);
    this.eventTick = new Int32Array(n).fill(-1);
    this.lifeBuckets.clear();
    this.qBuckets.clear();
    this.census.fill(0);
    this.maskedLiving = 0;
    this.vaccinatedLiving = 0;
    this.quarLiving = 0;

    const st0 = this.pop.state;
    const def0 = this.pop.defenses;
    const incub0 = config.strain.incubation;
    let e0 = 0;
    for (let i = 0; i < n; i++) {
      const s = st0[i];
      this.census[s]++;
      const d = def0[i];
      if (d & 1) this.maskedLiving++;
      if (d & 2) this.vaccinatedLiving++;
      if (s === CellState.Exposed) {
        e0++;
        // Seeded cells behave as if exposed one tick before tick 0: the old
        // engine's infectedAge counter made them turn Infectious during the
        // step with tickNow = incubation − 1.
        this.exposedAt[i] = -1;
        this.scheduleLife(i, Math.max(0, -1 + incub0));
      }
    }

    // Seed the cumulative-arrival counters from the initial population: the
    // patient-zero / seedInfections cells are already infected, so they count
    // toward "total infected" (otherwise the Total view would start below the
    // current count). (No Infectious cells exist at seed time.)
    this.cumExposed = e0;
    this.cumInfectious = 0;
    this.cumRecovered = 0;
    this.cumDead = 0;
    this.history = new LongHistory();
    this.retiredCost = emptyRetired();
    // Time-varying transmission multiplier (interventions R(t) hook).
    this.txSchedule = opts?.txSchedule && opts.txSchedule.length > 0 ? opts.txSchedule : null;
    // `undefined` (field omitted) means compute; an explicit number|null is a
    // caller-supplied estimate for an identical config — see EngineOptions.
    this.rNaught = opts !== undefined && opts.rNaught !== undefined
      ? opts.rNaught
      : this.estimateR0(config);
  }

  /** Current tick's transmission multiplier (1 when no schedule is set). */
  private txMulNow(): number {
    const s = this.txSchedule;
    if (s === null) return 1;
    return s[this.tick < s.length ? this.tick : s.length - 1];
  }

  // ── List + queue plumbing ─────────────────────────────────────────────────

  private iAdd(i: number): void {
    this.iPos[i] = this.iCount;
    this.iList[this.iCount++] = i;
  }

  private iRemove(i: number): void {
    const p = this.iPos[i];
    const last = this.iList[--this.iCount];
    this.iList[p] = last;
    this.iPos[last] = p;
    this.iPos[i] = -1;
  }

  private dAdd(i: number): void {
    this.dPos[i] = this.dCount;
    this.dList[this.dCount++] = i;
  }

  private dRemove(i: number): void {
    const p = this.dPos[i];
    const last = this.dList[--this.dCount];
    this.dList[p] = last;
    this.dPos[last] = p;
    this.dPos[i] = -1;
  }

  private scheduleLife(i: number, t: number): void {
    this.eventTick[i] = t;
    let b = this.lifeBuckets.get(t);
    if (b === undefined) {
      b = [];
      this.lifeBuckets.set(t, b);
    }
    b.push(i);
  }

  private scheduleQuar(i: number, t: number): void {
    let b = this.qBuckets.get(t);
    if (b === undefined) {
      b = [];
      this.qBuckets.set(t, b);
    }
    b.push(i);
  }

  /** Geometric waiting time (support 1, 2, …) for per-tick hazard p — the
   *  number of per-tick Bernoulli(p) trials up to and including the first
   *  success. One draw replaces the old draw-per-tick loop, with the identical
   *  distribution. */
  private geometricDelay(p: number): number {
    if (p >= 1) return 1;
    // p is always > 0 here (immunityDays > 0 ⇒ p = 1/immunityDays; else 1).
    const u = this.rng.random();
    return 1 + Math.floor(Math.log(1 - u) / Math.log(1 - p));
  }

  /** Genes for a cell's strain, with the single-strain fast path. */
  private genesOf(cell: number, solo: StrainGenes | null): StrainGenes {
    const sid = this.pop.strainId[cell];
    return solo !== null && sid === 0 ? solo : this.strains.get(sid);
  }

  /**
   * Live-patch the running simulation with a new config WITHOUT resetting the
   * RNG, the tick counter, or any cell state. Stochastic adjustments are made
   * only on per-cell buffers whose target distribution has changed (defense
   * uptake, lockdown compliance). Multiplicative params (protection, source
   * control, transmission reduction, etc.) re-resolve and take effect on the
   * next tick without any buffer mutation.
   *
   * Timing genes are the one addition over the pre-P1 contract: because
   * transitions are now scheduled rather than re-derived per tick, a change to
   * incubation/infectious deterministically reschedules in-flight E/I cells of
   * the base strain, and a change to immunityDays resamples Recovered cells'
   * waning times from the new hazard (memoryless, so this is exactly the
   * distribution the old per-tick engine would have produced going forward).
   *
   * Callers MUST send this only for changes that don't affect the engine's
   * structural shape — grid size, seed, strain genes, and geometry still require
   * a full rebuild. Use `reset()` for those.
   */
  patchConfig(newCfg: SimConfig): void {
    const old = this.config;
    let flagsChanged = false;
    for (let k = 0; k < newCfg.defenses.length && k < old.defenses.length; k++) {
      const oldEff = old.defenses[k].enabled === false ? 0 : old.defenses[k].uptake;
      const newEff = newCfg.defenses[k].enabled === false ? 0 : newCfg.defenses[k].uptake;
      if (oldEff !== newEff) {
        this.resampleDefenseFlag(k, oldEff, newEff);
        flagsChanged = true;
      }
    }
    if (flagsChanged) this.recountDefenseFlags();
    const oldComp = old.lockdown.enabled ? old.lockdown.compliance : 0;
    const newComp = newCfg.lockdown.enabled ? newCfg.lockdown.compliance : 0;
    if (oldComp !== newComp) {
      this.resampleByteFlag(this.pop.lockdownCompliant, oldComp, newComp);
    }
    if (old.quarantine.enabled && !newCfg.quarantine.enabled) {
      this.pop.quarantined.fill(0);
      this.pop.quarantineExpiry.fill(0);
      this.quarLiving = 0;
      this.qBuckets.clear();
    }
    this.defenses = resolveDefenses(newCfg.defenses);
    // Live-patch strain 0 so disease-slider edits take effect mid-run without
    // a reset. Rate genes (attackRate, ifr, range) are read at use time, so
    // updating the base entry is enough; timing genes need a reschedule of
    // in-flight base-strain cells (see rebuildSchedules).
    const timingChanged =
      old.strain.incubation !== newCfg.strain.incubation ||
      old.strain.infectious !== newCfg.strain.infectious;
    const waneChanged = old.strain.immunityDays !== newCfg.strain.immunityDays;
    this.strains.updateBaseStrain(newCfg.strain);
    if (timingChanged || waneChanged) {
      this.rebuildSchedules(newCfg.strain, timingChanged, waneChanged);
    }
    this.config = newCfg;
    // attackRate / range / infectious all factor into R0; recompute so the
    // UI's R0 readout reflects the patched values on the next frame.
    this.rNaught = this.estimateR0(newCfg);
  }

  /** Reschedule in-flight base-strain cells after a timing-gene patch.
   *  E/I reschedules are deterministic (no RNG); R waning resamples only when
   *  immunityDays changed — geometric hazards are memoryless, so sampling the
   *  remaining wait from the new hazard is exactly correct. Old bucket entries
   *  become stale and are ignored via the eventTick guard. */
  private rebuildSchedules(genes: StrainGenes, timingChanged: boolean, waneChanged: boolean): void {
    const { state, strainId, n } = this.pop;
    const ST_E = CellState.Exposed;
    const ST_I = CellState.Infectious;
    const ST_R = CellState.Recovered;
    const now = this.tick;
    const wp = genes.immunityDays > 0 ? 1 / genes.immunityDays : 1;
    for (let i = 0; i < n; i++) {
      if (strainId[i] !== 0) continue;
      const s = state[i];
      if (timingChanged && s === ST_E) {
        this.scheduleLife(i, Math.max(now, this.exposedAt[i] + genes.incubation));
      } else if (timingChanged && s === ST_I) {
        this.scheduleLife(i, Math.max(now, this.exposedAt[i] + genes.incubation + genes.infectious));
      } else if (waneChanged && s === ST_R) {
        // The next per-tick roll the old engine would have made is at `now`;
        // firing at now + (G − 1) reproduces that alignment.
        this.scheduleLife(i, now + this.geometricDelay(wp) - 1);
      }
    }
  }

  private resampleDefenseFlag(flagIdx: number, oldP: number, newP: number): void {
    const mask = 1 << flagIdx;
    const def = this.pop.defenses;
    const rng = this.rng;
    if (newP > oldP) {
      const q = (newP - oldP) / Math.max(1e-9, 1 - oldP);
      for (let i = 0; i < def.length; i++) {
        if (!(def[i] & mask) && rng.bernoulli(q)) def[i] |= mask;
      }
    } else if (newP < oldP) {
      const q = (oldP - newP) / Math.max(1e-9, oldP);
      for (let i = 0; i < def.length; i++) {
        if ((def[i] & mask) && rng.bernoulli(q)) def[i] &= ~mask;
      }
    }
  }

  private resampleByteFlag(buf: Uint8Array, oldP: number, newP: number): void {
    const rng = this.rng;
    if (newP > oldP) {
      const q = (newP - oldP) / Math.max(1e-9, 1 - oldP);
      for (let i = 0; i < buf.length; i++) {
        if (!buf[i] && rng.bernoulli(q)) buf[i] = 1;
      }
    } else if (newP < oldP) {
      const q = (oldP - newP) / Math.max(1e-9, oldP);
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] && rng.bernoulli(q)) buf[i] = 0;
      }
    }
  }

  private recountDefenseFlags(): void {
    const { state, defenses, n } = this.pop;
    let m = 0, v = 0;
    for (let i = 0; i < n; i++) {
      if (state[i] === DEAD) continue;
      const d = defenses[i];
      if (d & 1) m++;
      if (d & 2) v++;
    }
    this.maskedLiving = m;
    this.vaccinatedLiving = v;
  }

  // ── The tick ──────────────────────────────────────────────────────────────

  step(): SimStats {
    const pop = this.pop;
    const { state, next, defenses, strainId, quarantined, quarantineExpiry, size } = pop;
    const D = this.defenses;
    const mortByMask = D.mortByMask;
    const rng = this.rng;
    const strains = this.strains;
    const birthRate = this.config.birthRate;
    const quarantine = this.config.quarantine;
    const quarantineOn = quarantine.enabled === true;
    const qSrcMul = quarantineOn ? 1 - quarantine.sourceControl : 1;
    const qProtMul = quarantineOn ? 1 - quarantine.protection : 1;
    const lockdown = this.config.lockdown;
    const lockdownOn = lockdown.enabled === true;
    const lockdownTransMul = lockdownOn ? 1 - lockdown.transmissionReduction : 1;
    const geo = this.geometry;
    const meanField = geo.isMeanField();

    // Hot-loop hoists — esbuild can't inline cross-module const enum members
    // (isolatedModules semantics), so hoist CellState reads into locals.
    const ST_S = CellState.Susceptible;
    const ST_E = CellState.Exposed;
    const ST_I = CellState.Infectious;
    const ST_R = CellState.Recovered;
    const ST_D = CellState.Dead;
    const tickNow = this.tick;
    const census = this.census;

    // Single-strain fast path: while the pool holds only strain 0, every cell
    // carries strain 0 and its genes are loop constants.
    const solo = strains.count() === 1 ? strains.get(0) : null;

    const prof = this.profile;
    let tMark = prof ? performance.now() : 0;

    next.set(state);

    // 1) Transmission pass — O(active infectious), writes exposures into next.
    const newInfections = meanField
      ? this.transmitMeanField(tickNow, solo, census, lockdownTransMul, qSrcMul, qProtMul, quarantineOn, lockdownOn)
      : this.transmitSpatial(tickNow, solo, lockdownTransMul, qSrcMul, qProtMul, quarantineOn, lockdownOn);

    if (prof) { const t = performance.now(); prof.transmission += t - tMark; tMark = t; }

    // 2) Quarantine detection pass — O(active infectious), against snapshot state.
    if (quarantineOn && quarantine.detectionRate > 0 && quarantine.duration > 0) {
      const detRate = quarantine.detectionRate;
      const contactsRange = Math.max(1, quarantine.contactsRange | 0);
      const expiry = tickNow + quarantine.duration;
      const iList = this.iList;
      const iCount = this.iCount;
      const isVoronoi = geo.isVoronoi?.() ?? false;
      for (let k = 0; k < iCount; k++) {
        const i = iList[k];
        if (quarantined[i]) continue;
        if (!rng.bernoulli(detRate)) continue;
        quarantined[i] = 1;
        if (state[i] !== ST_D) this.quarLiving++;
        quarantineExpiry[i] = expiry;
        this.scheduleQuar(i, expiry);
        if (meanField) continue; // mean-field has no contact structure
        if (isVoronoi) {
          const nbrs = (geo as VoronoiLattice).getNeighborIndices!(i, contactsRange);
          for (let m = 0; m < nbrs.length; m++) {
            const j = nbrs[m];
            if (j === i) continue;
            this.quarantineContact(j, expiry, ST_D);
          }
        } else {
          const x = i % size;
          const y = (i / size) | 0;
          const offsets = geo.getOffsets(contactsRange, x, y);
          const m2 = offsets.length;
          for (let m = 0; m < m2; m += 2) {
            const nx = torus(x + offsets[m], size);
            const ny = torus(y + offsets[m + 1], size);
            const j = ny * size + nx;
            if (j === i) continue;
            this.quarantineContact(j, expiry, ST_D);
          }
        }
      }
    }

    if (prof) { const t = performance.now(); prof.quarantine += t - tMark; tMark = t; }

    // 3a) Quarantine release — scheduled, with a stale-entry guard (expiry may
    // have been raised by a later detection, which pushed its own entry).
    let newInfectious = 0;
    let newDeaths = 0;
    let newRecovered = 0;
    if (quarantineOn) {
      const qb = this.qBuckets.get(tickNow);
      if (qb !== undefined) {
        this.qBuckets.delete(tickNow);
        for (let k = 0; k < qb.length; k++) {
          const i = qb[k];
          if (quarantined[i] && quarantineExpiry[i] <= tickNow) {
            quarantined[i] = 0;
            quarantineExpiry[i] = 0;
            if (state[i] !== ST_D) this.quarLiving--;
          }
        }
      }
    }

    // 3b) Scheduled life-cycle transitions. Events derive from the snapshot
    // state (a cell exposed this tick is scheduled for a future tick), write
    // into next, and update the census incrementally.
    {
      const lb = this.lifeBuckets.get(tickNow);
      if (lb !== undefined) {
        this.lifeBuckets.delete(tickNow);
        const eventTick = this.eventTick;
        for (let k = 0; k < lb.length; k++) {
          const i = lb[k];
          if (eventTick[i] !== tickNow) continue; // stale after a reschedule
          const s = state[i];
          if (s === ST_E) {
            next[i] = ST_I;
            census[ST_E]--;
            census[ST_I]++;
            newInfectious++;
            this.iAdd(i);
            const g = this.genesOf(i, solo);
            this.scheduleLife(i, Math.max(tickNow + 1, this.exposedAt[i] + g.incubation + g.infectious));
          } else if (s === ST_I) {
            this.iRemove(i);
            const g = this.genesOf(i, solo);
            const ifr = g.ifr * mortByMask[defenses[i] & MASK_ALL];
            if (rng.bernoulli(ifr)) {
              next[i] = ST_D;
              census[ST_I]--;
              census[ST_D]++;
              newDeaths++;
              this.dAdd(i);
              const d = defenses[i];
              if (d & 1) this.maskedLiving--;
              if (d & 2) this.vaccinatedLiving--;
              if (quarantined[i]) this.quarLiving--;
              eventTick[i] = -1;
            } else {
              next[i] = ST_R;
              census[ST_I]--;
              census[ST_R]++;
              newRecovered++;
              const wp = g.immunityDays > 0 ? 1 / g.immunityDays : 1;
              this.scheduleLife(i, tickNow + this.geometricDelay(wp));
            }
          } else if (s === ST_R) {
            next[i] = ST_S;
            census[ST_R]--;
            census[ST_S]++;
            strainId[i] = 0;
            eventTick[i] = -1;
          }
          // ST_S / ST_D: unreachable while eventTick matches; skip defensively.
        }
      }
    }

    // 3c) Birth roll over the compact dead list. Backward iteration so the
    // swap-removal on rebirth never skips an unprocessed element.
    if (birthRate > 0 && this.dCount > 0) {
      const D0 = this.defenses;
      for (let k = this.dCount - 1; k >= 0; k--) {
        const i = this.dList[k];
        const p = meanField ? birthRate : birthRate * neighborAliveFraction(state, i, size, geo);
        if (!rng.bernoulli(p)) continue;
        next[i] = ST_S;
        census[ST_D]--;
        census[ST_S]++;
        strainId[i] = 0;
        this.dRemove(i);
        let flags = 0;
        if (rng.bernoulli(D0.uptake[0])) flags |= 1;
        if (rng.bernoulli(D0.uptake[1])) flags |= 2;
        defenses[i] = flags;
        if (flags & 1) this.maskedLiving++;
        if (flags & 2) this.vaccinatedLiving++;
        if (quarantined[i]) this.quarLiving++;
      }
    }

    // 4) Swap.
    pop.state = next;
    pop.next = state;
    this.tick++;

    // Optional extinction reseed (off by default).
    if (this.config.reseedOnExtinction === true) {
      const seedStrain = this.strains.get(0);
      if (seedStrain.immunityDays < 36500 && this.tick > 30) {
        const cur = pop.state;
        if (census[ST_E] + census[ST_I] === 0) {
          let attempts = 0;
          while (attempts < 16) {
            const idx = this.rng.intRange(cur.length);
            if (cur[idx] === ST_S) {
              let protMul = protectionMultiplier(D, defenses[idx]);
              if (quarantineOn && quarantined[idx]) protMul *= qProtMul;
              let importP = protMul * lockdownTransMul;
              if (quarantineOn) importP *= qSrcMul;
              if (importP > 0 && this.rng.bernoulli(importP)) {
                cur[idx] = ST_I;
                strainId[idx] = 0;
                census[ST_S]--;
                census[ST_I]++;
                this.iAdd(idx);
                // Mirror the old "infectedAge = incubation" import: the cell
                // is freshly infectious, with the full infectious period ahead.
                this.exposedAt[idx] = this.tick - 1 - seedStrain.incubation;
                this.scheduleLife(idx, Math.max(this.tick, this.tick - 1 + seedStrain.infectious));
              }
              break;
            }
            attempts++;
          }
        }
      }
    }

    if (prof) { const t = performance.now(); prof.lifecycle += t - tMark; tMark = t; }

    const maskEnabled = this.config.defenses[0]?.enabled === true;
    const vaxEnabled = this.config.defenses[1]?.enabled === true;
    const stats = this.computeStats(newInfections, newInfectious, newDeaths, newRecovered, {
      s: census[ST_S], e: census[ST_E], i: census[ST_I], r: census[ST_R], d: census[ST_D],
      masked: maskEnabled ? this.maskedLiving : 0,
      vaccinated: vaxEnabled ? this.vaccinatedLiving : 0,
      quar: quarantineOn ? this.quarLiving : 0,
    });
    if (prof) prof.stats += performance.now() - tMark;
    return stats;
  }

  /** Contact-tracing helper: flag a close contact, raise (never lower) its
   *  release tick, and schedule the release. */
  private quarantineContact(j: number, expiry: number, ST_D: number): void {
    const pop = this.pop;
    if (!pop.quarantined[j]) {
      pop.quarantined[j] = 1;
      if (pop.state[j] !== ST_D) this.quarLiving++;
    }
    if (pop.quarantineExpiry[j] < expiry) {
      pop.quarantineExpiry[j] = expiry;
      this.scheduleQuar(j, expiry);
    }
  }

  /** Spatial transmission: every Infectious cell attacks its neighbors via
   *  per-contact Bernoulli trials; exposures are written into next while
   *  reading from state. Iterates the compact I-list instead of scanning the
   *  grid; the inner neighbor loops are unchanged from the sweep engine. */
  private transmitSpatial(
    tickNow: number,
    solo: StrainGenes | null,
    lockdownTransMul: number,
    qSrcMul: number,
    qProtMul: number,
    quarantineOn: boolean,
    lockdownOn: boolean,
  ): number {
    const pop = this.pop;
    const { state, next, defenses, strainId, lockdownCompliant, quarantined, size } = pop;
    const protByMask = this.defenses.protByMask;
    const srcByMask = this.defenses.srcByMask;
    const rng = this.rng;
    const strains = this.strains;
    const mutate = this.config.mutate;
    const lockdown = this.config.lockdown;
    const lockdownSkipP = lockdownOn ? lockdown.mobilityReduction : 0;
    const geo = this.geometry;
    const isVoronoi = geo.isVoronoi?.() ?? false;
    const voronoiGeo = isVoronoi ? (geo as VoronoiLattice) : null;
    const ST_S = CellState.Susceptible;
    const ST_E = CellState.Exposed;
    const exposedAt = this.exposedAt;
    const iList = this.iList;
    const iCount = this.iCount;

    let newInfections = 0;
    // Hoisted per-step transmission multiplier (interventions R(t) schedule);
    // 1 when unscheduled, so the multiply below is bit-identical (x·1 === x).
    const txMul = this.txMulNow();

    for (let c = 0; c < iCount; c++) {
      const i = iList[c];
      const attackerStrain = solo !== null ? solo : strains.get(strainId[i]);
      const range = attackerStrain.range;
      const baseAttack = attackerStrain.attackRate * txMul;
      let srcMul = srcByMask[defenses[i] & MASK_ALL];
      if (quarantineOn && quarantined[i]) srcMul *= qSrcMul;
      srcMul *= lockdownTransMul;
      const atkSrc = baseAttack * srcMul;
      if (atkSrc <= 0) continue;
      const srcUnderLockdown = lockdownOn && lockdownCompliant[i] === 1;

      if (voronoiGeo) {
        const nbrs = voronoiGeo.getNeighborIndices!(i, range);
        for (let k = 0; k < nbrs.length; k++) {
          if (srcUnderLockdown && lockdownSkipP > 0 && rng.bernoulli(lockdownSkipP)) continue;
          const j = nbrs[k];
          if (state[j] !== ST_S) continue;
          let protMul = protByMask[defenses[j] & MASK_ALL];
          if (quarantineOn && quarantined[j]) protMul *= qProtMul;
          const p = atkSrc * protMul;
          if (p <= 0) continue;
          if (rng.bernoulli(p) && next[j] === ST_S) {
            next[j] = ST_E;
            exposedAt[j] = tickNow;
            const sid = mutate ? strains.spawnChild(strainId[i], tickNow, rng) : strainId[i];
            strainId[j] = sid;
            const g = solo !== null && sid === 0 ? solo : strains.get(sid);
            this.scheduleLife(j, tickNow + Math.max(1, g.incubation));
            this.census[ST_S]--;
            this.census[ST_E]++;
            newInfections++;
          }
        }
      } else if (
        // Interior fast path: every offset is bounded by ±range per axis, so a
        // cell at least `range` from every edge can never wrap — index directly
        // and skip the two torus() calls per neighbor. At 320×320 range 1 this
        // covers ~99% of cells and computes the exact same j as the torus path.
        i % size >= range && i % size < size - range &&
        ((i / size) | 0) >= range && ((i / size) | 0) < size - range
      ) {
        const x = i % size;
        const y = (i / size) | 0;
        const offsets = geo.getOffsets(range, x, y);
        const m2 = offsets.length;
        for (let k = 0; k < m2; k += 2) {
          if (srcUnderLockdown && lockdownSkipP > 0 && rng.bernoulli(lockdownSkipP)) continue;
          const j = i + offsets[k + 1] * size + offsets[k];
          if (state[j] !== ST_S) continue;
          let protMul = protByMask[defenses[j] & MASK_ALL];
          if (quarantineOn && quarantined[j]) protMul *= qProtMul;
          const p = atkSrc * protMul;
          if (p <= 0) continue;
          if (rng.bernoulli(p) && next[j] === ST_S) {
            next[j] = ST_E;
            exposedAt[j] = tickNow;
            const sid = mutate ? strains.spawnChild(strainId[i], tickNow, rng) : strainId[i];
            strainId[j] = sid;
            const g = solo !== null && sid === 0 ? solo : strains.get(sid);
            this.scheduleLife(j, tickNow + Math.max(1, g.incubation));
            this.census[ST_S]--;
            this.census[ST_E]++;
            newInfections++;
          }
        }
      } else {
        const x = i % size;
        const y = (i / size) | 0;
        const offsets = geo.getOffsets(range, x, y);
        const m2 = offsets.length;
        for (let k = 0; k < m2; k += 2) {
          if (srcUnderLockdown && lockdownSkipP > 0 && rng.bernoulli(lockdownSkipP)) continue;
          const nx = torus(x + offsets[k], size);
          const ny = torus(y + offsets[k + 1], size);
          const j = ny * size + nx;
          if (state[j] !== ST_S) continue;
          let protMul = protByMask[defenses[j] & MASK_ALL];
          if (quarantineOn && quarantined[j]) protMul *= qProtMul;
          const p = atkSrc * protMul;
          if (p <= 0) continue;
          if (rng.bernoulli(p) && next[j] === ST_S) {
            next[j] = ST_E;
            exposedAt[j] = tickNow;
            const sid = mutate ? strains.spawnChild(strainId[i], tickNow, rng) : strainId[i];
            strainId[j] = sid;
            const g = solo !== null && sid === 0 ? solo : strains.get(sid);
            this.scheduleLife(j, tickNow + Math.max(1, g.incubation));
            this.census[ST_S]--;
            this.census[ST_E]++;
            newInfections++;
          }
        }
      }
    }
    return newInfections;
  }

  /** Mean-field transmission: each susceptible is attacked by the aggregate
   *  infectious pool. The per-cell exposure probability depends only on the
   *  cell's cohort — defense bitmask × quarantined flag — so the 1−(1−p)^x
   *  pow is computed once per cohort (8 values) instead of per cell, and the
   *  lockdown mobility roll is folded in multiplicatively (the compound
   *  probability of "not skipped AND exposed"), one draw per cell. */
  private transmitMeanField(
    tickNow: number,
    solo: StrainGenes | null,
    census: Int32Array,
    lockdownTransMul: number,
    qSrcMul: number,
    qProtMul: number,
    quarantineOn: boolean,
    lockdownOn: boolean,
  ): number {
    const pop = this.pop;
    const { state, next, defenses, strainId, quarantined, n } = pop;
    const D = this.defenses;
    const protByMask = D.protByMask;
    const rng = this.rng;
    const strains = this.strains;
    const mutate = this.config.mutate;
    const ST_S = CellState.Susceptible;
    const ST_E = CellState.Exposed;
    const ST_I = CellState.Infectious;
    const exposedAt = this.exposedAt;

    const iCount = census[ST_I];
    if (iCount <= 0) return 0;

    // Use the dominant strain (strain 0) for the rate parameters.
    const dominantStrain = strains.get(0);
    // k=2: mean-field sits below triangular (3) in the R0 hierarchy.
    const k = 2;
    // ×1 when unscheduled — bit-identical (IEEE x·1 === x).
    const baseAttack = dominantStrain.attackRate * this.txMulNow();
    const exponent = (iCount * k) / n;
    const mobKeep = lockdownOn ? 1 - this.config.lockdown.mobilityReduction : 1;
    const srcMul = lockdownTransMul * qSrcMul;

    // Per-cohort exposure probabilities: index = (defense mask << 1) | quarantined.
    const pTable = new Float64Array((MASK_ALL + 1) * 2);
    for (let mask = 0; mask <= MASK_ALL; mask++) {
      for (let q = 0; q < 2; q++) {
        let protMul = protByMask[mask];
        if (quarantineOn && q === 1) protMul *= qProtMul;
        const p = baseAttack * srcMul * protMul;
        // Exposure probability: 1 − (1−p)^(iCount·k/n) — exact for small p.
        const pExposed = p > 0 ? 1 - Math.pow(1 - p, exponent) : 0;
        pTable[(mask << 1) | q] = mobKeep * pExposed;
      }
    }

    let newInfections = 0;
    const incub0 = Math.max(1, dominantStrain.incubation);
    for (let j = 0; j < n; j++) {
      if (state[j] !== ST_S) continue;
      const idx = ((defenses[j] & MASK_ALL) << 1) | (quarantineOn && quarantined[j] ? 1 : 0);
      const pe = pTable[idx];
      if (pe <= 0) continue;
      if (rng.bernoulli(pe) && next[j] === ST_S) {
        next[j] = ST_E;
        exposedAt[j] = tickNow;
        if (mutate) {
          const sid = strains.spawnChild(0, tickNow, rng);
          strainId[j] = sid;
          const g = solo !== null && sid === 0 ? solo : strains.get(sid);
          this.scheduleLife(j, tickNow + Math.max(1, g.incubation));
        } else {
          strainId[j] = 0;
          this.scheduleLife(j, tickNow + incub0);
        }
        this.census[ST_S]--;
        this.census[ST_E]++;
        newInfections++;
      }
    }
    return newInfections;
  }

  // Counts arrive pre-folded from the incremental census; this only assembles
  // stats and maintains the histories. Cost-layer counts cover living cells
  // only (the dead don't wear masks or occupy isolation beds), gated by each
  // defense's enabled flag — a disabled defense incurs no cost even though the
  // per-cell flag remains in the buffer.
  private computeStats(
    newInfections: number,
    newInfectious: number,
    newDeaths: number,
    newRecovered: number,
    counts: { s: number; e: number; i: number; r: number; d: number; masked: number; vaccinated: number; quar: number },
  ): SimStats {
    const { s, e, i: inf, r, d, masked, vaccinated, quar } = counts;
    const ld = this.config.lockdown;
    const lockdownStringency = ld.enabled === true ? ld.mobilityReduction * ld.compliance : 0;

    this.newInfectionsHistory.push(newInfections);
    this.newInfectiousHistory.push(newInfectious);
    if (this.newInfectionsHistory.length > REFF_WINDOW) this.newInfectionsHistory.shift();
    if (this.newInfectiousHistory.length > REFF_WINDOW) this.newInfectiousHistory.shift();

    const reff = this.computeReff();
    const stats: SimStats = {
      tick: this.tick,
      s, e, i: inf, r, d,
      newInfections,
      newDeaths,
      reff,
      strains: this.strains.count(),
    };

    this.cumExposed += newInfections;
    this.cumInfectious += newInfectious;
    this.cumRecovered += newRecovered;
    this.cumDead += newDeaths;

    this.history.push({
      tick: stats.tick,
      s, e, i: inf, r, d,
      reff,
      dnew: newDeaths,
      masked, vaccinated, quarantined: quar, lockdownStringency,
      ecum: this.cumExposed,
      icum: this.cumInfectious,
      rcum: this.cumRecovered,
      dcum: this.cumDead,
    }, this.retiredCost);
    return stats;
  }

  private computeReff(): number {
    let inf = 0, became = 0;
    for (let i = 0; i < this.newInfectiousHistory.length; i++) {
      inf += this.newInfectionsHistory[i] ?? 0;
      became += this.newInfectiousHistory[i] ?? 0;
    }
    if (became <= 0) return 0;
    return inf / became;
  }

  private estimateR0(config: SimConfig): number | null {
    if (config.size < 8) return null;
    const strain = config.strain;
    const days = strain.infectious;
    if (days <= 0) return 0;
    const p = Math.max(0, Math.min(1, strain.attackRate));
    const pInfected = 1 - Math.pow(1 - p, days);

    if (config.geometry === 'meanfield') {
      return 2 * pInfected; // k=2 matches transmitMeanField
    }

    if (config.geometry === 'voronoi' && this.voronoiTopo) {
      // Average reachable-neighbour count, not a single cell's degree: Voronoi
      // degrees vary cell-to-cell, so one sample is noisy. For range 1 the mean
      // degree is exact from the CSR (total directed edges / cells); for larger
      // ranges we sample cells and BFS-expand so R0 scales with strain.range,
      // mirroring how the lattice geometries grow their neighbourhood.
      const n = config.size * config.size;
      let avgDegree: number;
      if (strain.range <= 1) {
        avgDegree = this.voronoiTopo.adjList.length / n;
      } else {
        const geo = this.geometry;
        const stride = Math.max(1, Math.floor(n / 512));
        let total = 0, samples = 0;
        for (let i = 0; i < n; i += stride) {
          total += geo.getNeighborIndices!(i, strain.range).length;
          samples++;
        }
        avgDegree = samples > 0 ? total / samples : 6;
      }
      return avgDegree * pInfected;
    }

    const size = Math.min(config.size, 80);
    const cx = size >> 1;
    const cy = size >> 1;
    const geo = makeGeometry(config.geometry);
    const offsets = geo.getOffsets(strain.range, cx, cy);
    const reachable = new Set<number>();
    for (let k = 0; k < offsets.length; k += 2) {
      const nx = torus(cx + offsets[k], size);
      const ny = torus(cy + offsets[k + 1], size);
      const j = ny * size + nx;
      if (j !== cy * size + cx) reachable.add(j);
    }
    return reachable.size * pInfected;
  }

  buffers(): { state: Uint8Array; defenses: Uint8Array; quarantined: Uint8Array; size: number } {
    return {
      state: this.pop.state,
      defenses: this.pop.defenses,
      quarantined: this.pop.quarantined,
      size: this.pop.size,
    };
  }
}

function neighborAliveFraction(state: Uint8Array, i: number, size: number, geo: LatticeGeometry): number {
  if (geo.isVoronoi?.()) {
    const nbrs = geo.getNeighborIndices!(i, 1);
    if (nbrs.length === 0) return 0.5;
    let alive = 0;
    for (let k = 0; k < nbrs.length; k++) {
      if (state[nbrs[k]] !== DEAD) alive++;
    }
    return alive / nbrs.length;
  }
  const x = i % size;
  const y = (i / size) | 0;
  const offsets = geo.getOffsets(1, x, y);
  const m2 = offsets.length;
  if (m2 === 0) return 0.5; // mean-field: use flat rate, caller multiplies by birthRate
  let alive = 0;
  if (x >= 1 && x < size - 1 && y >= 1 && y < size - 1) {
    // Interior fast path — range-1 offsets are bounded by ±1 per axis, so no
    // wrapping is possible; same j as the torus path below.
    for (let k = 0; k < m2; k += 2) {
      if (state[i + offsets[k + 1] * size + offsets[k]] !== DEAD) alive++;
    }
  } else {
    for (let k = 0; k < m2; k += 2) {
      const nx = torus(x + offsets[k], size);
      const ny = torus(y + offsets[k + 1], size);
      const j = ny * size + nx;
      if (state[j] !== DEAD) alive++;
    }
  }
  return alive / (m2 / 2);
}

function emptyRetired(): RetiredCostTotals {
  return { ticks: 0, i: 0, dnew: 0, masked: 0, vaccinated: 0, quarantined: 0, lockdownStringency: 0 };
}
