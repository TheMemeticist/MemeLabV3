// SEIR-D state encoding (one byte per cell).
export const enum CellState {
  Susceptible = 0,
  Exposed = 1,
  Infectious = 2,
  Recovered = 3,
  Dead = 4,
}

// Defense bitmask flags, packed into Uint8Array per cell.
export const enum DefenseFlag {
  None = 0,
  Mask = 1 << 0,
  Vaccine = 1 << 1,
}

export interface StrainGenes {
  attackRate: number; // 0..1 per-contact
  incubation: number; // days
  infectious: number; // days
  ifr: number; // 0..1 base infection-fatality rate
  range: number; // Manhattan radius
  /** Mean duration of post-infection immunity, in days. Use a very large value
   *  (e.g. 36500) for "lifelong" immunity. Daily wane probability = 1/immunityDays. */
  immunityDays: number;
  mutationRate: number; // 0..1 per-replication per-gene
}

export interface Strain extends StrainGenes {
  id: number;
  parentId: number | null;
  birthTick: number;
}

export interface DefenseSpec {
  id: string;
  label: string;
  /** Reduces incoming attack success against the wearer. 0..1. */
  protection: number;
  /** Reduces outgoing attack success from the wearer. 0..1. */
  sourceControl: number;
  /** Reduces IFR if infected. 0..1. */
  mortalityReduction: number;
  /** Population uptake. 0..1. */
  uptake: number;
}

export interface SimConfig {
  seed: number; // 32-bit unsigned PRNG seed
  size: number; // grid edge length; population = size * size
  seedInfections: number; // 0..1 fraction starting as Exposed
  birthRate: number; // 0..1 per-tick respawn chance for dead cells with healthy neighbors
  mutate: boolean;
  /** When true (default), forcibly reseed one infectious cell whenever E+I=0
   *  and immunity is not lifelong — keeps endemic dynamics from going extinct
   *  due to stochastic flutter on small grids. */
  reseedOnExtinction?: boolean;
  strain: StrainGenes;
  defenses: DefenseSpec[];
}

export interface SimStats {
  tick: number;
  s: number;
  e: number;
  i: number;
  r: number;
  d: number;
  newInfections: number;
  reff: number;
  strains: number;
}

export interface FrameMessage {
  type: 'frame';
  tick: number;
  /** Transferable view onto the population state byte buffer. */
  state: Uint8Array;
  /** Defense bitmask byte buffer, transferable. */
  defenses: Uint8Array;
  size: number;
  stats: SimStats;
  longStats: LongStats;
  rNaught: number | null;
}

export interface LongStats {
  tick: number[];
  s: number[];
  e: number[];
  i: number[];
  r: number[];
  d: number[];
  reff: number[];
}

export type WorkerCommand =
  | { cmd: 'init'; config: SimConfig }
  | { cmd: 'play'; tps: number }
  | { cmd: 'pause' }
  | { cmd: 'step'; n: number }
  | { cmd: 'reset'; config: SimConfig }
  | { cmd: 'updateConfig'; config: SimConfig };
