import { CellState } from '../types';
import type { LongStats, SimConfig, SimStats } from '../types';
import { Rng } from './rng';
import { StrainPool } from './strain';
import { allocate, seed, type PopulationBuffers } from './population';
import { getOffsets, torus } from './neighbors';
import {
  resolveDefenses,
  protectionMultiplier,
  sourceControlMultiplier,
  mortalityMultiplier,
  type ResolvedDefenses,
} from './defense';

const REFF_WINDOW = 14;
const LONG_CAP = 4096; // ticks of history retained

export class Engine {
  private rng!: Rng;
  private pop!: PopulationBuffers;
  private strains!: StrainPool;
  private defenses!: ResolvedDefenses;
  private config!: SimConfig;

  tick = 0;
  private newInfectionsHistory: number[] = [];
  private newInfectiousHistory: number[] = [];
  longStats: LongStats = emptyLong();
  rNaught: number | null = null;

  constructor(config: SimConfig) {
    this.reset(config);
  }

  reset(config: SimConfig): void {
    this.config = config;
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
   * structural shape — grid size, seed, and strain genes still require a full
   * rebuild (because they alter R₀, the neighbor cache shape, or the RNG
   * trajectory). Use `reset()` for those.
   */
  patchConfig(newCfg: SimConfig): void {
    const old = this.config;
    // 1. Defense uptake stochastic resampling.
    for (let k = 0; k < newCfg.defenses.length && k < old.defenses.length; k++) {
      const oldP = old.defenses[k].uptake;
      const newP = newCfg.defenses[k].uptake;
      // If either defense was/is disabled, treat its effective uptake as 0
      // for resampling purposes — the buffer flag is preserved either way.
      const oldEff = old.defenses[k].enabled === false ? 0 : oldP;
      const newEff = newCfg.defenses[k].enabled === false ? 0 : newP;
      if (oldEff !== newEff) this.resampleDefenseFlag(k, oldEff, newEff);
    }
    // 2. Lockdown compliance.
    const oldComp = old.lockdown.enabled ? old.lockdown.compliance : 0;
    const newComp = newCfg.lockdown.enabled ? newCfg.lockdown.compliance : 0;
    if (oldComp !== newComp) {
      this.resampleByteFlag(this.pop.lockdownCompliant, oldComp, newComp);
    }
    // 3. Quarantine toggle-off → instantly clear all active quarantines.
    if (old.quarantine.enabled && !newCfg.quarantine.enabled) {
      this.pop.quarantined.fill(0);
      this.pop.quarantineExpiry.fill(0);
    }
    // 4. Re-resolve the defense table (picks up enabled flags + multipliers).
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

    // 1) Snapshot current state into next-buffer; we'll mutate `next` then swap.
    next.set(state);

    let newInfections = 0;
    let newInfectious = 0;

    // 2) Transmission pass: every infectious cell attacks neighbors.
    //    We use the parent strain's range/attack from the *current* strainId.
    for (let i = 0; i < n; i++) {
      if (state[i] !== CellState.Infectious) continue;
      const attackerStrain = strains.get(strainId[i]);
      const range = attackerStrain.range;
      const baseAttack = attackerStrain.attackRate;
      let srcMul = sourceControlMultiplier(D, defenses[i]);
      // Quarantine attenuates outgoing transmission.
      if (quarantineOn && quarantined[i]) srcMul *= qSrcMul;
      // Lockdown reduces transmission globally.
      srcMul *= lockdownTransMul;
      if (baseAttack * srcMul <= 0) continue;

      const x = i % size;
      const y = (i / size) | 0;
      const table = getOffsets(range);
      const offsets = table.offsets;
      const m2 = offsets.length;
      const srcUnderLockdown = lockdownOn && lockdownCompliant[i] === 1;

      for (let k = 0; k < m2; k += 2) {
        // Probabilistic neighbor culling for compliant cells under lockdown.
        if (srcUnderLockdown && lockdownSkipP > 0 && rng.bernoulli(lockdownSkipP)) continue;
        const nx = torus(x + offsets[k], size);
        const ny = torus(y + offsets[k + 1], size);
        const j = ny * size + nx;
        if (state[j] !== CellState.Susceptible) continue;
        let protMul = protectionMultiplier(D, defenses[j]);
        if (quarantineOn && quarantined[j]) protMul *= qProtMul;
        const p = baseAttack * srcMul * protMul;
        if (p <= 0) continue;
        if (rng.bernoulli(p)) {
          // Use `next` to record exposures; `state` stays clean for ordering.
          if (next[j] === CellState.Susceptible) {
            next[j] = CellState.Exposed;
            infectedAge[j] = 0;
            const childStrain = mutate ? strains.spawnChild(strainId[i], this.tick, rng) : strainId[i];
            strainId[j] = childStrain;
            newInfections++;
          }
        }
      }
    }

    // 2b) Quarantine detection pass: each pre-existing infectious cell may be
    //     detected and quarantined along with its close contacts. Runs against
    //     the snapshot `state` so detection probability is independent of
    //     ordering. Uses `next[j]` only to test whether a detected cell hasn't
    //     itself been transitioned this tick.
    if (quarantineOn && quarantine.detectionRate > 0 && quarantine.duration > 0) {
      const detRate = quarantine.detectionRate;
      const contactsTable = getOffsets(Math.max(1, quarantine.contactsRange | 0));
      const offsets = contactsTable.offsets;
      const m2 = offsets.length;
      const expiry = this.tick + quarantine.duration;
      for (let i = 0; i < n; i++) {
        if (state[i] !== CellState.Infectious || quarantined[i]) continue;
        if (!rng.bernoulli(detRate)) continue;
        quarantined[i] = 1;
        quarantineExpiry[i] = expiry;
        const x = i % size;
        const y = (i / size) | 0;
        for (let k = 0; k < m2; k += 2) {
          const nx = torus(x + offsets[k], size);
          const ny = torus(y + offsets[k + 1], size);
          const j = ny * size + nx;
          if (j === i) continue;
          quarantined[j] = 1;
          // Extend existing expiry if shorter.
          if (quarantineExpiry[j] < expiry) quarantineExpiry[j] = expiry;
        }
      }
    }

    // 3) Per-cell life-cycle pass: SEIR transitions + births. Uses prev `state`.
    for (let i = 0; i < n; i++) {
      // Quarantine expiry — O(1) per cell.
      if (quarantined[i] && this.tick >= quarantineExpiry[i]) {
        quarantined[i] = 0;
        quarantineExpiry[i] = 0;
      }
      const s = state[i];
      if (s === CellState.Dead) {
        if (birthRate > 0 && rng.bernoulli(birthRate * neighborAliveFraction(state, i, size))) {
          next[i] = CellState.Susceptible;
          age[i] = 0;
          infectedAge[i] = 0;
          strainId[i] = 0;
          // Inherit a defense roll for the new arrival.
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
          // Recovery / death roll.
          const ifr = strain.ifr * mortalityMultiplier(D, defenses[i]);
          if (rng.bernoulli(ifr)) {
            next[i] = CellState.Dead;
          } else {
            next[i] = CellState.Recovered;
            infectedAge[i] = 0;
            // Strain reference retained for lineage stats; cell is no longer a host.
          }
        }
      } else if (s === CellState.Recovered) {
        // Per-day wane probability = 1 / immunityDays — yields exponentially
        // distributed immune durations with mean equal to immunityDays.
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

    // Anti-extinction: in a finite-immunity world the disease should be
    //    endemic. With small populations, stochastic dynamics will sometimes
    //    drive E+I to zero before a wane resupplies S. When that happens AND
    //    immunity is not lifelong AND the user enabled the reseed flag (true
    //    by default), we re-introduce one infectious cell to keep the dynamic
    //    going. This mirrors the "external import" mechanism that real-world
    //    SEIRS sims need to model migration / out-of-network exposure.
    if (this.config.reseedOnExtinction !== false) {
      const seedStrain = this.strains.get(0);
      if (seedStrain.immunityDays < 36500 && this.tick > 30) {
        const cur = pop.state;
        let extant = 0;
        for (let k = 0; k < cur.length; k++) {
          if (cur[k] === CellState.Exposed || cur[k] === CellState.Infectious) {
            extant++;
            if (extant > 0) break;
          }
        }
        if (extant === 0) {
          // Pick a random S, or fall back to any non-D cell.
          let attempts = 0;
          while (attempts < 16) {
            const idx = rng.intRange(cur.length);
            if (cur[idx] === CellState.Susceptible) {
              cur[idx] = CellState.Infectious;
              this.pop.infectedAge[idx] = seedStrain.incubation;
              this.pop.strainId[idx] = 0;
              break;
            }
            attempts++;
          }
        }
      }
    }

    // 5) Stats.
    let s = 0;
    let e = 0;
    let inf = 0;
    let r = 0;
    let d = 0;
    const cur = pop.state;
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
    // Approximation: ratio of new infections to new infectious individuals over a
    // sliding window. When few people become infectious in the window, fall back to 0.
    let inf = 0;
    let became = 0;
    for (let i = 0; i < this.newInfectiousHistory.length; i++) {
      inf += this.newInfectionsHistory[i] ?? 0;
      became += this.newInfectiousHistory[i] ?? 0;
    }
    if (became <= 0) return 0;
    return inf / became;
  }

  /**
   * Analytical R₀ expectation for an all-susceptible neighborhood.
   * Per-day infection is Bernoulli(attackRate); a neighbor exposed for `days`
   * independent days is infected with P = 1 − (1 − attackRate)^days.
   * E[R₀] = (distinct reachable neighbors) × P. Closed-form, deterministic, no
   * seed dependency — R₀ is a property of the disease, not the run.
   */
  private estimateR0(config: SimConfig): number | null {
    if (config.size < 8) return null;
    const strain = config.strain;
    const days = strain.infectious;
    if (days <= 0) return 0;
    const p = Math.max(0, Math.min(1, strain.attackRate));
    const size = Math.min(config.size, 80);
    const cx = size >> 1;
    const cy = size >> 1;
    const center = cy * size + cx;
    const offsets = getOffsets(strain.range).offsets;
    const reachable = new Set<number>();
    for (let k = 0; k < offsets.length; k += 2) {
      const nx = torus(cx + offsets[k], size);
      const ny = torus(cy + offsets[k + 1], size);
      const j = ny * size + nx;
      if (j !== center) reachable.add(j);
    }
    const pInfected = 1 - Math.pow(1 - p, days);
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

function neighborAliveFraction(state: Uint8Array, i: number, size: number): number {
  const x = i % size;
  const y = (i / size) | 0;
  let alive = 0;
  let total = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = torus(x + dx, size);
      const ny = torus(y + dy, size);
      const j = ny * size + nx;
      if (state[j] !== CellState.Dead) alive++;
      total++;
    }
  }
  return alive / total;
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
    long.tick.shift();
    long.s.shift();
    long.e.shift();
    long.i.shift();
    long.r.shift();
    long.d.shift();
    long.reff.shift();
  }
}
