import { CellState, DefenseFlag } from '../types';
import type { Rng } from './rng';

export interface PopulationBuffers {
  size: number;
  n: number;
  state: Uint8Array; // current SEIR-D
  next: Uint8Array; // staging buffer (swapped at end of step)
  age: Uint16Array; // total ticks alive
  infectedAge: Uint16Array; // ticks since exposure (capped)
  defenses: Uint8Array; // bitmask
  strainId: Uint16Array;
}

export function allocate(size: number): PopulationBuffers {
  const n = size * size;
  return {
    size,
    n,
    state: new Uint8Array(n),
    next: new Uint8Array(n),
    age: new Uint16Array(n),
    infectedAge: new Uint16Array(n),
    defenses: new Uint8Array(n),
    strainId: new Uint16Array(n),
  };
}

export interface SeedOptions {
  seedInfections: number; // 0..1
  maskUptake: number;
  vaccineUptake: number;
  patientZero: boolean;
}

export function seed(buf: PopulationBuffers, rng: Rng, opts: SeedOptions): void {
  const { state, defenses, age, infectedAge, strainId, n } = buf;
  for (let i = 0; i < n; i++) {
    state[i] = CellState.Susceptible;
    age[i] = 0;
    infectedAge[i] = 0;
    strainId[i] = 0;
    let flags = 0;
    if (rng.bernoulli(opts.maskUptake)) flags |= DefenseFlag.Mask;
    if (rng.bernoulli(opts.vaccineUptake)) flags |= DefenseFlag.Vaccine;
    defenses[i] = flags;
  }
  if (opts.seedInfections > 0) {
    for (let i = 0; i < n; i++) {
      if (rng.bernoulli(opts.seedInfections)) {
        state[i] = CellState.Exposed;
        infectedAge[i] = 0;
        strainId[i] = 0;
      }
    }
  }
  if (opts.patientZero) {
    const center = ((buf.size >> 1) * buf.size) + (buf.size >> 1);
    state[center] = CellState.Exposed;
    infectedAge[center] = 0;
    strainId[center] = 0;
  }
  buf.next.set(state);
}
