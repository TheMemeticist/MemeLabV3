import { CellState } from '../types';
import type { LongStats, RetiredCostTotals, SimConfig, SimStats, VoronoiTopology } from '../types';
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

// Module-level copy of CellState.Dead for neighborAliveFraction — cross-module
// const enum members aren't inlined by esbuild, so keep the hot read local.
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

export class Engine {
  private rng!: Rng;
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

  constructor(config: SimConfig, prebuiltTopo?: VoronoiTopology | null) {
    this.reset(config, prebuiltTopo);
  }

  reset(config: SimConfig, prebuiltTopo?: VoronoiTopology | null): void {
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
    });
    this.tick = 0;
    this.newInfectionsHistory = [];
    this.newInfectiousHistory = [];
    // Seed the cumulative-arrival counters from the initial population: the
    // patient-zero / seedInfections cells are already infected, so they count
    // toward "total infected" (otherwise the Total view would start below the
    // current count).
    let e0 = 0, i0 = 0;
    const st0 = this.pop.state;
    for (let k = 0; k < st0.length; k++) {
      if (st0[k] === CellState.Exposed) e0++;
      else if (st0[k] === CellState.Infectious) i0++;
    }
    this.cumExposed = e0 + i0;
    this.cumInfectious = i0;
    this.cumRecovered = 0;
    this.cumDead = 0;
    this.history = new LongHistory();
    this.retiredCost = emptyRetired();
    this.rNaught = this.estimateR0(config);
  }

  /**
   * Live-patch the running simulation with a new config WITHOUT resetting the
   * RNG, the tick counter, or any cell state. Stochastic adjustments are made
   * only on per-cell buffers whose target distribution has changed (defense
   * uptake, lockdown compliance). Multiplicative params (protection, source
   * control, transmission reduction, etc.) re-resolve and take effect on the
   * next tick without any buffer mutation.
   *
   * Callers MUST send this only for changes that don't affect the engine's
   * structural shape — grid size, seed, strain genes, and geometry still require
   * a full rebuild. Use `reset()` for those.
   */
  patchConfig(newCfg: SimConfig): void {
    const old = this.config;
    for (let k = 0; k < newCfg.defenses.length && k < old.defenses.length; k++) {
      const oldEff = old.defenses[k].enabled === false ? 0 : old.defenses[k].uptake;
      const newEff = newCfg.defenses[k].enabled === false ? 0 : newCfg.defenses[k].uptake;
      if (oldEff !== newEff) this.resampleDefenseFlag(k, oldEff, newEff);
    }
    const oldComp = old.lockdown.enabled ? old.lockdown.compliance : 0;
    const newComp = newCfg.lockdown.enabled ? newCfg.lockdown.compliance : 0;
    if (oldComp !== newComp) {
      this.resampleByteFlag(this.pop.lockdownCompliant, oldComp, newComp);
    }
    if (old.quarantine.enabled && !newCfg.quarantine.enabled) {
      this.pop.quarantined.fill(0);
      this.pop.quarantineExpiry.fill(0);
    }
    this.defenses = resolveDefenses(newCfg.defenses);
    // Live-patch strain 0 so disease-slider edits take effect mid-run without
    // a reset. Engine reads strain genes per-cell each tick, so updating the
    // base entry is enough — no buffer mutation needed.
    this.strains.updateBaseStrain(newCfg.strain);
    this.config = newCfg;
    // attackRate / range / infectious all factor into R0; recompute so the
    // UI's R0 readout reflects the patched values on the next frame.
    this.rNaught = this.estimateR0(newCfg);
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

  step(): SimStats {
    if (this.geometry.isMeanField()) return this.stepMeanField();
    return this.stepSpatial();
  }

  private stepMeanField(): SimStats {
    const pop = this.pop;
    const { state, next, age, infectedAge, defenses, strainId, quarantined, quarantineExpiry, n } = pop;
    const D = this.defenses;
    const protByMask = D.protByMask;
    const mortByMask = D.mortByMask;
    const rng = this.rng;
    const strains = this.strains;
    const mutate = this.config.mutate;
    const birthRate = this.config.birthRate;
    const lockdown = this.config.lockdown;
    const lockdownOn = lockdown.enabled === true;
    const lockdownTransMul = lockdownOn ? 1 - lockdown.transmissionReduction : 1;
    const quarantine = this.config.quarantine;
    const quarantineOn = quarantine.enabled === true;
    const qSrcMul = quarantineOn ? 1 - quarantine.sourceControl : 1;
    const qProtMul = quarantineOn ? 1 - quarantine.protection : 1;

    // Hot-loop hoists — see stepSpatial for the const-enum / LoadIC rationale.
    const ST_S = CellState.Susceptible;
    const ST_E = CellState.Exposed;
    const ST_I = CellState.Infectious;
    const ST_R = CellState.Recovered;
    const ST_D = CellState.Dead;
    const tickNow = this.tick;
    const solo = strains.count() === 1 ? strains.get(0) : null;
    const soloIncub = solo !== null ? solo.incubation : 0;
    const soloIncubEnd = solo !== null ? solo.incubation + solo.infectious : 0;
    const soloIfr = solo !== null ? solo.ifr : 0;
    const soloWane = solo !== null ? (solo.immunityDays > 0 ? 1 / solo.immunityDays : 1) : 0;

    const prof = this.profile;
    let tMark = prof ? performance.now() : 0;

    next.set(state);

    // Count infectious for global mixing force-of-infection.
    let iCount = 0;
    for (let i = 0; i < n; i++) {
      if (state[i] === ST_I) iCount++;
    }

    let newInfections = 0;
    let newInfectious = 0;
    let newDeaths = 0;
    let newRecovered = 0;

    // Mean-field transmission: each susceptible is attacked by the aggregate
    // infectious pool. Effective contact count k mirrors the square range-1
    // neighbourhood so R0 is comparable across geometry modes.
    if (iCount > 0) {
      // Use the dominant strain (strain 0) for the rate parameters.
      const dominantStrain = strains.get(0);
      // k=2: mean-field sits below triangular (3) in the R0 hierarchy.
      const k = 2;
      const baseAttack = dominantStrain.attackRate;

      for (let j = 0; j < n; j++) {
        if (state[j] !== ST_S) continue;
        let protMul = protByMask[defenses[j] & MASK_ALL];
        if (quarantineOn && quarantined[j]) protMul *= qProtMul;
        // Effective per-tick exposure: 1 − (1−p)^(I × k / N)
        // where p = baseAttack × srcMul_avg × protMul
        // srcMul_avg ≈ 1 (global average; quarantine/lockdown applied globally below)
        let srcMul = 1 * lockdownTransMul * qSrcMul;
        if (lockdownOn && rng.bernoulli(lockdown.mobilityReduction)) srcMul = 0;
        const p = baseAttack * srcMul * protMul;
        if (p <= 0) continue;
        // Exposure probability: 1 − (1−p)^(iCount * k / n)  — exact for small p
        const pExposed = 1 - Math.pow(1 - p, (iCount * k) / n);
        if (pExposed <= 0) continue;
        if (rng.bernoulli(pExposed)) {
          if (next[j] === ST_S) {
            next[j] = ST_E;
            infectedAge[j] = 0;
            strainId[j] = mutate ? strains.spawnChild(0, tickNow, rng) : 0;
            newInfections++;
          }
        }
      }
    }

    if (prof) { const t = performance.now(); prof.transmission += t - tMark; tMark = t; }

    // Quarantine detection — same as spatial.
    if (quarantineOn && quarantine.detectionRate > 0 && quarantine.duration > 0) {
      const detRate = quarantine.detectionRate;
      const expiry = tickNow + quarantine.duration;
      for (let i = 0; i < n; i++) {
        if (state[i] !== ST_I || quarantined[i]) continue;
        if (!rng.bernoulli(detRate)) continue;
        quarantined[i] = 1;
        quarantineExpiry[i] = expiry;
      }
    }

    if (prof) { const t = performance.now(); prof.quarantine += t - tMark; tMark = t; }

    // Life-cycle pass — identical to spatial (see stepSpatial for the census
    // fold and single-strain fast-path rationale); the only difference is the
    // birth roll, which has no neighbor term under global mixing.
    const maskEnabled = this.config.defenses[0]?.enabled === true;
    const vaxEnabled = this.config.defenses[1]?.enabled === true;
    const census = new Int32Array(5); // indexed by CellState
    let masked = 0, vaccinated = 0, quarCount = 0;
    for (let i = 0; i < n; i++) {
      if (quarantineOn && quarantined[i] && tickNow >= quarantineExpiry[i]) {
        quarantined[i] = 0;
        quarantineExpiry[i] = 0;
      }
      const s = state[i];
      if (s === ST_D) {
        if (birthRate > 0 && rng.bernoulli(birthRate)) {
          next[i] = ST_S;
          age[i] = 0;
          infectedAge[i] = 0;
          strainId[i] = 0;
          let flags = 0;
          if (rng.bernoulli(D.uptake[0])) flags |= 1;
          if (rng.bernoulli(D.uptake[1])) flags |= 2;
          defenses[i] = flags;
        }
      } else if (s === ST_E) {
        infectedAge[i]++;
        const incub = solo !== null ? soloIncub : strains.get(strainId[i]).incubation;
        if (infectedAge[i] >= incub) {
          next[i] = ST_I;
          newInfectious++;
        }
      } else if (s === ST_I) {
        infectedAge[i]++;
        let incubEnd: number, baseIfr: number;
        if (solo !== null) {
          incubEnd = soloIncubEnd;
          baseIfr = soloIfr;
        } else {
          const strain = strains.get(strainId[i]);
          incubEnd = strain.incubation + strain.infectious;
          baseIfr = strain.ifr;
        }
        if (infectedAge[i] >= incubEnd) {
          const ifr = baseIfr * mortByMask[defenses[i] & MASK_ALL];
          if (rng.bernoulli(ifr)) {
            next[i] = ST_D;
            newDeaths++;
          } else {
            next[i] = ST_R;
            infectedAge[i] = 0;
            newRecovered++;
          }
        }
      } else if (s === ST_R) {
        let dailyWane: number;
        if (solo !== null) {
          dailyWane = soloWane;
        } else {
          const strain = strains.get(strainId[i]);
          dailyWane = strain.immunityDays > 0 ? 1 / strain.immunityDays : 1;
        }
        if (rng.bernoulli(dailyWane)) {
          next[i] = ST_S;
          strainId[i] = 0;
        }
      }
      const ns = next[i];
      census[ns]++;
      if (ns !== ST_D) {
        const def = defenses[i];
        if (maskEnabled && (def & 1)) masked++;
        if (vaxEnabled && (def & 2)) vaccinated++;
        if (quarantineOn && quarantined[i]) quarCount++;
      }
    }
    let cS = census[ST_S], cE = census[ST_E],
      cI = census[ST_I], cR = census[ST_R],
      cD = census[ST_D];

    pop.state = next;
    pop.next = state;
    this.tick++;

    if (prof) { const t = performance.now(); prof.lifecycle += t - tMark; tMark = t; }
    const stats = this.computeStats(newInfections, newInfectious, newDeaths, newRecovered, {
      s: cS, e: cE, i: cI, r: cR, d: cD, masked, vaccinated, quar: quarCount,
    });
    if (prof) prof.stats += performance.now() - tMark;
    return stats;
  }

  private stepSpatial(): SimStats {
    const pop = this.pop;
    const { state, next, age, infectedAge, defenses, strainId, lockdownCompliant, quarantined, quarantineExpiry, size, n } = pop;
    const D = this.defenses;
    const protByMask = D.protByMask;
    const srcByMask = D.srcByMask;
    const mortByMask = D.mortByMask;
    const rng = this.rng;
    const strains = this.strains;
    const mutate = this.config.mutate;
    const birthRate = this.config.birthRate;
    const lockdown = this.config.lockdown;
    const lockdownOn = lockdown.enabled === true;
    const lockdownTransMul = lockdownOn ? 1 - lockdown.transmissionReduction : 1;
    const lockdownSkipP = lockdownOn ? lockdown.mobilityReduction : 0;
    const quarantine = this.config.quarantine;
    const quarantineOn = quarantine.enabled === true;
    const qSrcMul = quarantineOn ? 1 - quarantine.sourceControl : 1;
    const qProtMul = quarantineOn ? 1 - quarantine.protection : 1;
    const geo = this.geometry;
    const isVoronoi = geo.isVoronoi?.() ?? false;
    const voronoiGeo = isVoronoi ? (geo as VoronoiLattice) : null;

    // esbuild can't inline cross-module `const enum` members (isolatedModules
    // semantics), so `CellState.*` inside the hot loops compiles to a property
    // load per use per cell — V8 profiling showed LoadIC handling eating ~35%
    // of tick time. Hoist the states, and the per-cell `this.tick` read, into
    // locals once per step.
    const ST_S = CellState.Susceptible;
    const ST_E = CellState.Exposed;
    const ST_I = CellState.Infectious;
    const ST_R = CellState.Recovered;
    const ST_D = CellState.Dead;
    const tickNow = this.tick;

    // Single-strain fast path (used by both transmission and life-cycle):
    // while the pool holds only strain 0 every cell carries strain 0, so its
    // genes are loop constants instead of a per-cell object walk.
    const solo = strains.count() === 1 ? strains.get(0) : null;
    const soloIncub = solo !== null ? solo.incubation : 0;
    const soloIncubEnd = solo !== null ? solo.incubation + solo.infectious : 0;
    const soloIfr = solo !== null ? solo.ifr : 0;
    const soloWane = solo !== null ? (solo.immunityDays > 0 ? 1 / solo.immunityDays : 1) : 0;

    const prof = this.profile;
    let tMark = prof ? performance.now() : 0;

    next.set(state);

    let newInfections = 0;
    let newInfectious = 0;
    let newDeaths = 0;
    let newRecovered = 0;

    // 2) Transmission pass.
    for (let i = 0; i < n; i++) {
      if (state[i] !== ST_I) continue;
      const attackerStrain = solo !== null ? solo : strains.get(strainId[i]);
      const range = attackerStrain.range;
      const baseAttack = attackerStrain.attackRate;
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
            infectedAge[j] = 0;
            strainId[j] = mutate ? strains.spawnChild(strainId[i], tickNow, rng) : strainId[i];
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
            infectedAge[j] = 0;
            const childStrain = mutate ? strains.spawnChild(strainId[i], tickNow, rng) : strainId[i];
            strainId[j] = childStrain;
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
            infectedAge[j] = 0;
            const childStrain = mutate ? strains.spawnChild(strainId[i], tickNow, rng) : strainId[i];
            strainId[j] = childStrain;
            newInfections++;
          }
        }
      }
    }

    if (prof) { const t = performance.now(); prof.transmission += t - tMark; tMark = t; }

    // 2b) Quarantine detection pass.
    if (quarantineOn && quarantine.detectionRate > 0 && quarantine.duration > 0) {
      const detRate = quarantine.detectionRate;
      const contactsRange = Math.max(1, quarantine.contactsRange | 0);
      const expiry = tickNow + quarantine.duration;
      for (let i = 0; i < n; i++) {
        if (state[i] !== ST_I || quarantined[i]) continue;
        if (!rng.bernoulli(detRate)) continue;
        quarantined[i] = 1;
        quarantineExpiry[i] = expiry;
        if (voronoiGeo) {
          const nbrs = voronoiGeo.getNeighborIndices!(i, contactsRange);
          for (let k = 0; k < nbrs.length; k++) {
            const j = nbrs[k];
            if (j === i) continue;
            quarantined[j] = 1;
            if (quarantineExpiry[j] < expiry) quarantineExpiry[j] = expiry;
          }
        } else {
          const x = i % size;
          const y = (i / size) | 0;
          const offsets = geo.getOffsets(contactsRange, x, y);
          const m2 = offsets.length;
          for (let k = 0; k < m2; k += 2) {
            const nx = torus(x + offsets[k], size);
            const ny = torus(y + offsets[k + 1], size);
            const j = ny * size + nx;
            if (j === i) continue;
            quarantined[j] = 1;
            if (quarantineExpiry[j] < expiry) quarantineExpiry[j] = expiry;
          }
        }
      }
    }

    if (prof) { const t = performance.now(); prof.quarantine += t - tMark; tMark = t; }

    // 3) Life-cycle pass. Compartment + cost counts are folded in: after
    // iteration i no later write touches next[i], defenses[i], or
    // quarantined[i], so the post-tick census comes for free here instead of
    // in a second full O(N) pass.
    const maskEnabled = this.config.defenses[0]?.enabled === true;
    const vaxEnabled = this.config.defenses[1]?.enabled === true;
    const census = new Int32Array(5); // indexed by CellState
    let masked = 0, vaccinated = 0, quarCount = 0;
    for (let i = 0; i < n; i++) {
      // quarantined[] is all-zero whenever quarantine is disabled (reset seeds
      // it zero; patchConfig clears it on disable), so gate both the expiry
      // check and the census read to skip the buffer reads entirely.
      if (quarantineOn && quarantined[i] && tickNow >= quarantineExpiry[i]) {
        quarantined[i] = 0;
        quarantineExpiry[i] = 0;
      }
      const s = state[i];
      if (s === ST_D) {
        if (birthRate > 0 && rng.bernoulli(birthRate * neighborAliveFraction(state, i, size, geo))) {
          next[i] = ST_S;
          age[i] = 0;
          infectedAge[i] = 0;
          strainId[i] = 0;
          let flags = 0;
          if (rng.bernoulli(D.uptake[0])) flags |= 1;
          if (rng.bernoulli(D.uptake[1])) flags |= 2;
          defenses[i] = flags;
        }
      } else if (s === ST_E) {
        infectedAge[i]++;
        const incub = solo !== null ? soloIncub : strains.get(strainId[i]).incubation;
        if (infectedAge[i] >= incub) {
          next[i] = ST_I;
          newInfectious++;
        }
      } else if (s === ST_I) {
        infectedAge[i]++;
        let incubEnd: number, baseIfr: number;
        if (solo !== null) {
          incubEnd = soloIncubEnd;
          baseIfr = soloIfr;
        } else {
          const strain = strains.get(strainId[i]);
          incubEnd = strain.incubation + strain.infectious;
          baseIfr = strain.ifr;
        }
        if (infectedAge[i] >= incubEnd) {
          const ifr = baseIfr * mortByMask[defenses[i] & MASK_ALL];
          if (rng.bernoulli(ifr)) {
            next[i] = ST_D;
            newDeaths++;
          } else {
            next[i] = ST_R;
            infectedAge[i] = 0;
            newRecovered++;
          }
        }
      } else if (s === ST_R) {
        let dailyWane: number;
        if (solo !== null) {
          dailyWane = soloWane;
        } else {
          const strain = strains.get(strainId[i]);
          dailyWane = strain.immunityDays > 0 ? 1 / strain.immunityDays : 1;
        }
        if (rng.bernoulli(dailyWane)) {
          next[i] = ST_S;
          strainId[i] = 0;
        }
      }
      const ns = next[i];
      census[ns]++;
      if (ns !== ST_D) {
        const def = defenses[i];
        if (maskEnabled && (def & 1)) masked++;
        if (vaxEnabled && (def & 2)) vaccinated++;
        if (quarantineOn && quarantined[i]) quarCount++;
      }
    }
    let cS = census[ST_S], cE = census[ST_E],
      cI = census[ST_I], cR = census[ST_R],
      cD = census[ST_D];

    // 4) Swap.
    pop.state = next;
    pop.next = state;
    this.tick++;

    // Optional extinction reseed (off by default).
    if (this.config.reseedOnExtinction === true) {
      const seedStrain = this.strains.get(0);
      if (seedStrain.immunityDays < 36500 && this.tick > 30) {
        const cur = pop.state;
        if (cE + cI === 0) {
          let attempts = 0;
          while (attempts < 16) {
            const idx = this.rng.intRange(cur.length);
            if (cur[idx] === CellState.Susceptible) {
              let protMul = protectionMultiplier(D, this.pop.defenses[idx]);
              if (quarantineOn && quarantined[idx]) protMul *= qProtMul;
              let importP = protMul * lockdownTransMul;
              if (quarantineOn) importP *= qSrcMul;
              if (importP > 0 && this.rng.bernoulli(importP)) {
                cur[idx] = CellState.Infectious;
                this.pop.infectedAge[idx] = seedStrain.incubation;
                this.pop.strainId[idx] = 0;
                cS--;
                cI++;
              }
              break;
            }
            attempts++;
          }
        }
      }
    }

    if (prof) { const t = performance.now(); prof.lifecycle += t - tMark; tMark = t; }
    const stats = this.computeStats(newInfections, newInfectious, newDeaths, newRecovered, {
      s: cS, e: cE, i: cI, r: cR, d: cD, masked, vaccinated, quar: quarCount,
    });
    if (prof) prof.stats += performance.now() - tMark;
    return stats;
  }

  // Counts arrive pre-folded from the life-cycle pass (see stepSpatial /
  // stepMeanField); this only assembles stats and maintains the histories.
  // Cost-layer counts cover living cells only (the dead don't wear masks or
  // occupy isolation beds), gated by each defense's enabled flag — a disabled
  // defense incurs no cost even though the per-cell flag remains in the buffer.
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
      return 2 * pInfected; // k=2 matches stepMeanField
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
