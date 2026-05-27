import { CellState } from '../types';
import type { LongStats, SimConfig, SimStats, VoronoiTopology } from '../types';
import { Rng } from './rng';
import { StrainPool } from './strain';
import { allocate, seed, type PopulationBuffers } from './population';
import { makeGeometry, torus, VoronoiLattice, type LatticeGeometry } from './neighbors';
import { buildVoronoi } from './voronoi';
import {
  resolveDefenses,
  protectionMultiplier,
  sourceControlMultiplier,
  mortalityMultiplier,
  type ResolvedDefenses,
} from './defense';

const REFF_WINDOW = 14;
const LONG_CAP = 4096;

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
  longStats: LongStats = emptyLong();
  rNaught: number | null = null;

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
    this.longStats = emptyLong();
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
    this.config = newCfg;
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

    next.set(state);

    // Count infectious for global mixing force-of-infection.
    let iCount = 0;
    for (let i = 0; i < n; i++) {
      if (state[i] === CellState.Infectious) iCount++;
    }

    let newInfections = 0;
    let newInfectious = 0;

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
        if (state[j] !== CellState.Susceptible) continue;
        let protMul = protectionMultiplier(D, defenses[j]);
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
          if (next[j] === CellState.Susceptible) {
            next[j] = CellState.Exposed;
            infectedAge[j] = 0;
            strainId[j] = mutate ? strains.spawnChild(0, this.tick, rng) : 0;
            newInfections++;
          }
        }
      }
    }

    // Quarantine detection — same as spatial.
    if (quarantineOn && quarantine.detectionRate > 0 && quarantine.duration > 0) {
      const detRate = quarantine.detectionRate;
      const expiry = this.tick + quarantine.duration;
      for (let i = 0; i < n; i++) {
        if (state[i] !== CellState.Infectious || quarantined[i]) continue;
        if (!rng.bernoulli(detRate)) continue;
        quarantined[i] = 1;
        quarantineExpiry[i] = expiry;
      }
    }

    // Life-cycle pass — identical to spatial.
    for (let i = 0; i < n; i++) {
      if (quarantined[i] && this.tick >= quarantineExpiry[i]) {
        quarantined[i] = 0;
        quarantineExpiry[i] = 0;
      }
      const s = state[i];
      if (s === CellState.Dead) {
        if (birthRate > 0 && rng.bernoulli(birthRate)) {
          next[i] = CellState.Susceptible;
          age[i] = 0;
          infectedAge[i] = 0;
          strainId[i] = 0;
          let flags = 0;
          if (rng.bernoulli(D.uptake[0])) flags |= 1;
          if (rng.bernoulli(D.uptake[1])) flags |= 2;
          defenses[i] = flags;
        }
        continue;
      }
      age[i]++;
      if (s === CellState.Exposed) {
        infectedAge[i]++;
        const strain = strains.get(strainId[i]);
        if (infectedAge[i] >= strain.incubation) {
          next[i] = CellState.Infectious;
          newInfectious++;
        }
      } else if (s === CellState.Infectious) {
        infectedAge[i]++;
        const strain = strains.get(strainId[i]);
        if (infectedAge[i] >= strain.incubation + strain.infectious) {
          const ifr = strain.ifr * mortalityMultiplier(D, defenses[i]);
          if (rng.bernoulli(ifr)) {
            next[i] = CellState.Dead;
          } else {
            next[i] = CellState.Recovered;
            infectedAge[i] = 0;
          }
        }
      } else if (s === CellState.Recovered) {
        const strain = strains.get(strainId[i]);
        const dailyWane = strain.immunityDays > 0 ? 1 / strain.immunityDays : 1;
        if (rng.bernoulli(dailyWane)) {
          next[i] = CellState.Susceptible;
          strainId[i] = 0;
        }
      }
    }

    pop.state = next;
    pop.next = state;
    this.tick++;

    return this.computeStats(newInfections, newInfectious);
  }

  private stepSpatial(): SimStats {
    const pop = this.pop;
    const { state, next, age, infectedAge, defenses, strainId, lockdownCompliant, quarantined, quarantineExpiry, size, n } = pop;
    const D = this.defenses;
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

    next.set(state);

    let newInfections = 0;
    let newInfectious = 0;

    // 2) Transmission pass.
    for (let i = 0; i < n; i++) {
      if (state[i] !== CellState.Infectious) continue;
      const attackerStrain = strains.get(strainId[i]);
      const range = attackerStrain.range;
      const baseAttack = attackerStrain.attackRate;
      let srcMul = sourceControlMultiplier(D, defenses[i]);
      if (quarantineOn && quarantined[i]) srcMul *= qSrcMul;
      srcMul *= lockdownTransMul;
      if (baseAttack * srcMul <= 0) continue;
      const srcUnderLockdown = lockdownOn && lockdownCompliant[i] === 1;

      if (voronoiGeo) {
        const nbrs = voronoiGeo.getNeighborIndices!(i, range);
        for (let k = 0; k < nbrs.length; k++) {
          if (srcUnderLockdown && lockdownSkipP > 0 && rng.bernoulli(lockdownSkipP)) continue;
          const j = nbrs[k];
          if (state[j] !== CellState.Susceptible) continue;
          let protMul = protectionMultiplier(D, defenses[j]);
          if (quarantineOn && quarantined[j]) protMul *= qProtMul;
          const p = baseAttack * srcMul * protMul;
          if (p <= 0) continue;
          if (rng.bernoulli(p) && next[j] === CellState.Susceptible) {
            next[j] = CellState.Exposed;
            infectedAge[j] = 0;
            strainId[j] = mutate ? strains.spawnChild(strainId[i], this.tick, rng) : strainId[i];
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
          if (state[j] !== CellState.Susceptible) continue;
          let protMul = protectionMultiplier(D, defenses[j]);
          if (quarantineOn && quarantined[j]) protMul *= qProtMul;
          const p = baseAttack * srcMul * protMul;
          if (p <= 0) continue;
          if (rng.bernoulli(p) && next[j] === CellState.Susceptible) {
            next[j] = CellState.Exposed;
            infectedAge[j] = 0;
            const childStrain = mutate ? strains.spawnChild(strainId[i], this.tick, rng) : strainId[i];
            strainId[j] = childStrain;
            newInfections++;
          }
        }
      }
    }

    // 2b) Quarantine detection pass.
    if (quarantineOn && quarantine.detectionRate > 0 && quarantine.duration > 0) {
      const detRate = quarantine.detectionRate;
      const contactsRange = Math.max(1, quarantine.contactsRange | 0);
      const expiry = this.tick + quarantine.duration;
      for (let i = 0; i < n; i++) {
        if (state[i] !== CellState.Infectious || quarantined[i]) continue;
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

    // 3) Life-cycle pass.
    for (let i = 0; i < n; i++) {
      if (quarantined[i] && this.tick >= quarantineExpiry[i]) {
        quarantined[i] = 0;
        quarantineExpiry[i] = 0;
      }
      const s = state[i];
      if (s === CellState.Dead) {
        if (birthRate > 0 && rng.bernoulli(birthRate * neighborAliveFraction(state, i, size, geo))) {
          next[i] = CellState.Susceptible;
          age[i] = 0;
          infectedAge[i] = 0;
          strainId[i] = 0;
          let flags = 0;
          if (rng.bernoulli(D.uptake[0])) flags |= 1;
          if (rng.bernoulli(D.uptake[1])) flags |= 2;
          defenses[i] = flags;
        }
        continue;
      }

      age[i]++;

      if (s === CellState.Exposed) {
        infectedAge[i]++;
        const strain = strains.get(strainId[i]);
        if (infectedAge[i] >= strain.incubation) {
          next[i] = CellState.Infectious;
          newInfectious++;
        }
      } else if (s === CellState.Infectious) {
        infectedAge[i]++;
        const strain = strains.get(strainId[i]);
        if (infectedAge[i] >= strain.incubation + strain.infectious) {
          const ifr = strain.ifr * mortalityMultiplier(D, defenses[i]);
          if (rng.bernoulli(ifr)) {
            next[i] = CellState.Dead;
          } else {
            next[i] = CellState.Recovered;
            infectedAge[i] = 0;
          }
        }
      } else if (s === CellState.Recovered) {
        const strain = strains.get(strainId[i]);
        const dailyWane = strain.immunityDays > 0 ? 1 / strain.immunityDays : 1;
        if (rng.bernoulli(dailyWane)) {
          next[i] = CellState.Susceptible;
          strainId[i] = 0;
        }
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
        let extant = 0;
        for (let k = 0; k < cur.length; k++) {
          if (cur[k] === CellState.Exposed || cur[k] === CellState.Infectious) { extant++; break; }
        }
        if (extant === 0) {
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
              }
              break;
            }
            attempts++;
          }
        }
      }
    }

    return this.computeStats(newInfections, newInfectious);
  }

  private computeStats(newInfections: number, newInfectious: number): SimStats {
    const pop = this.pop;
    const { n } = pop;
    const cur = pop.state;
    let s = 0, e = 0, inf = 0, r = 0, d = 0;
    for (let i = 0; i < n; i++) {
      switch (cur[i]) {
        case CellState.Susceptible: s++; break;
        case CellState.Exposed: e++; break;
        case CellState.Infectious: inf++; break;
        case CellState.Recovered: r++; break;
        case CellState.Dead: d++; break;
      }
    }

    this.newInfectionsHistory.push(newInfections);
    this.newInfectiousHistory.push(newInfectious);
    if (this.newInfectionsHistory.length > REFF_WINDOW) this.newInfectionsHistory.shift();
    if (this.newInfectiousHistory.length > REFF_WINDOW) this.newInfectiousHistory.shift();

    const reff = this.computeReff();
    const stats: SimStats = {
      tick: this.tick,
      s, e, i: inf, r, d,
      newInfections,
      reff,
      strains: this.strains.count(),
    };

    pushLong(this.longStats, stats);
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
      if (state[nbrs[k]] !== CellState.Dead) alive++;
    }
    return alive / nbrs.length;
  }
  const x = i % size;
  const y = (i / size) | 0;
  const offsets = geo.getOffsets(1, x, y);
  const m2 = offsets.length;
  if (m2 === 0) return 0.5; // mean-field: use flat rate, caller multiplies by birthRate
  let alive = 0;
  for (let k = 0; k < m2; k += 2) {
    const nx = torus(x + offsets[k], size);
    const ny = torus(y + offsets[k + 1], size);
    const j = ny * size + nx;
    if (state[j] !== CellState.Dead) alive++;
  }
  return alive / (m2 / 2);
}

function emptyLong(): LongStats {
  return { tick: [], s: [], e: [], i: [], r: [], d: [], reff: [] };
}

function pushLong(long: LongStats, stats: SimStats): void {
  long.tick.push(stats.tick);
  long.s.push(stats.s);
  long.e.push(stats.e);
  long.i.push(stats.i);
  long.r.push(stats.r);
  long.d.push(stats.d);
  long.reff.push(stats.reff);
  if (long.tick.length > LONG_CAP) {
    long.tick.shift(); long.s.shift(); long.e.shift();
    long.i.shift(); long.r.shift(); long.d.shift(); long.reff.shift();
  }
}
