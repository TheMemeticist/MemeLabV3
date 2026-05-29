import type { Rng } from './rng';
import type { Strain, StrainGenes } from '../types';

const MAX_STRAINS = 4096;

export class StrainPool {
  private list: Strain[] = [];

  constructor(genesis: StrainGenes) {
    this.list.push({
      id: 0,
      parentId: null,
      birthTick: 0,
      ...sanitize(genesis),
    });
  }

  get(id: number): Strain {
    return this.list[id] ?? this.list[0];
  }

  /** Replace strain 0's genome in place. Used by Engine.patchConfig so a slider
   *  drag updates the running base strain without resetting the population.
   *  Mutant children keep their drifted genes — editing the base shouldn't
   *  retroactively rewrite the strain tree. */
  updateBaseStrain(genes: StrainGenes): void {
    const cur = this.list[0];
    this.list[0] = { id: 0, parentId: null, birthTick: cur.birthTick, ...sanitize(genes) };
  }

  count(): number {
    return this.list.length;
  }

  /** Possibly produce a child strain (mutated genome) at this tick. */
  spawnChild(parentId: number, tick: number, rng: Rng): number {
    const parent = this.get(parentId);
    const rate = parent.mutationRate;
    if (rate <= 0) return parentId;

    const child: StrainGenes = {
      attackRate: parent.attackRate,
      incubation: parent.incubation,
      infectious: parent.infectious,
      ifr: parent.ifr,
      range: parent.range,
      immunityDays: parent.immunityDays,
      mutationRate: parent.mutationRate,
    };

    let mutated = false;

    if (rng.bernoulli(rate)) {
      child.attackRate = clamp(parent.attackRate + parent.attackRate * 0.05 * rng.gaussian(), 0, 1);
      mutated = true;
    }
    if (rng.bernoulli(rate)) {
      child.ifr = clamp(parent.ifr + parent.ifr * 0.05 * rng.gaussian(), 0, 1);
      mutated = true;
    }
    if (rng.bernoulli(rate)) {
      // Drift the immune-duration window. Hold to a sane corridor.
      const drift = parent.immunityDays * 0.05 * rng.gaussian();
      child.immunityDays = Math.max(1, Math.min(36500, parent.immunityDays + drift));
      mutated = true;
    }
    if (rng.bernoulli(rate)) {
      child.mutationRate = clamp(
        parent.mutationRate + parent.mutationRate * 0.05 * rng.gaussian(),
        0,
        0.5,
      );
      mutated = true;
    }
    if (rng.bernoulli(rate)) {
      child.incubation = Math.max(1, parent.incubation + (rng.bernoulli(0.5) ? 1 : -1));
      mutated = true;
    }
    if (rng.bernoulli(rate)) {
      child.infectious = Math.max(1, parent.infectious + (rng.bernoulli(0.5) ? 1 : -1));
      mutated = true;
    }
    if (rng.bernoulli(rate)) {
      child.range = Math.max(1, Math.min(8, parent.range + (rng.bernoulli(0.5) ? 1 : -1)));
      mutated = true;
    }

    if (!mutated) return parentId;
    if (this.list.length >= MAX_STRAINS) return parentId; // cap pool to fit Uint16

    const id = this.list.length;
    this.list.push({ id, parentId, birthTick: tick, ...sanitize(child) });
    return id;
  }
}

function sanitize(g: StrainGenes): StrainGenes {
  return {
    attackRate: clamp(g.attackRate, 0, 1),
    incubation: Math.max(1, Math.round(g.incubation)),
    infectious: Math.max(1, Math.round(g.infectious)),
    ifr: clamp(g.ifr, 0, 1),
    range: Math.max(1, Math.min(8, Math.round(g.range))),
    immunityDays: Math.max(1, Math.min(36500, Math.round(g.immunityDays))),
    mutationRate: clamp(g.mutationRate, 0, 0.5),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
