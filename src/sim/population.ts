import { CellState, DefenseFlag } from '../types';
import type { SimConfig } from '../types';
import type { Rng } from './rng';

/** The effective susceptibility CV for a config: the field when it is a
 *  finite number > 0, else 0 (feature off). */
export function susceptibilityCVOf(config: SimConfig): number {
  const cv = config.susceptibilityCV;
  return typeof cv === 'number' && Number.isFinite(cv) && cv > 0 ? cv : 0;
}

/**
 * Fill `out` with per-cell susceptibility multipliers s_i ~ Gamma(shape 1/CV²,
 * scale CV²) — mean 1, coefficient of variation `cv` — drawn in cell order
 * from `rng`. Requires cv > 0. The engines call it on their single main RNG
 * ONLY when the option is on, immediately after `seed()` (after every other
 * setup draw), so the option-off stream is untouched. `WasmEngine` makes the
 * same draws in Rust (`susceptibility_init`) on the handed-over stream.
 */
export function drawSusceptibility(out: Float64Array, cv: number, rng: Rng): void {
  const theta = cv * cv;
  const shape = 1 / theta;
  for (let i = 0; i < out.length; i++) out[i] = rng.gamma(shape) * theta;
}

export interface PopulationBuffers {
  size: number;
  n: number;
  state: Uint8Array; // current SEIR-D
  next: Uint8Array; // staging buffer (swapped at end of step)
  // Reset to 0 at birth but NOT incremented per tick — nothing reads it, and
  // the per-cell increment cost real frame time. Reinstate maintenance in the
  // life-cycle pass before building any age-dependent feature on it.
  age: Uint16Array;
  infectedAge: Uint16Array; // ticks since exposure (capped)
  defenses: Uint8Array; // bitmask
  strainId: Uint16Array;
  lockdownCompliant: Uint8Array; // 0/1 — per-cell adherence to lockdown
  quarantined: Uint8Array; // 0/1 — currently isolated
  quarantineExpiry: Int32Array; // tick at which quarantine lifts
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
    lockdownCompliant: new Uint8Array(n),
    quarantined: new Uint8Array(n),
    quarantineExpiry: new Int32Array(n),
  };
}

export interface SeedOptions {
  seedInfections: number; // 0..1
  maskUptake: number;
  vaccineUptake: number;
  lockdownCompliance: number;
  patientZero: boolean;
  /** Cell index for patient zero. Defaults to the grid center. Draws no
   *  randomness, so overriding it cannot perturb the PRNG trajectory. */
  indexCell?: number;
}

export function seed(buf: PopulationBuffers, rng: Rng, opts: SeedOptions): void {
  const { state, defenses, age, infectedAge, strainId, lockdownCompliant, quarantined, quarantineExpiry, n } = buf;
  for (let i = 0; i < n; i++) {
    state[i] = CellState.Susceptible;
    age[i] = 0;
    infectedAge[i] = 0;
    strainId[i] = 0;
    let flags = 0;
    if (rng.bernoulli(opts.maskUptake)) flags |= DefenseFlag.Mask;
    if (rng.bernoulli(opts.vaccineUptake)) flags |= DefenseFlag.Vaccine;
    defenses[i] = flags;
    lockdownCompliant[i] = rng.bernoulli(opts.lockdownCompliance) ? 1 : 0;
    quarantined[i] = 0;
    quarantineExpiry[i] = 0;
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
    const cell = opts.indexCell != null && opts.indexCell >= 0 && opts.indexCell < n
      ? opts.indexCell
      : center;
    state[cell] = CellState.Exposed;
    infectedAge[cell] = 0;
    strainId[cell] = 0;
  }
  buf.next.set(state);
}
