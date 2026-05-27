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
  /** Header quick-toggle. When false, this defense's per-cell flag is preserved
   *  in the buffer but its multipliers behave as identity (no effect). */
  enabled: boolean;
  /** Reduces incoming attack success against the wearer. 0..1. */
  protection: number;
  /** Reduces outgoing attack success from the wearer. 0..1. */
  sourceControl: number;
  /** Reduces IFR if infected. 0..1. */
  mortalityReduction: number;
  /** Population uptake. 0..1. */
  uptake: number;
}

export interface LockdownSpec {
  enabled: boolean;
  /** Probabilistically skips neighbor visits for compliant cells. 0..1. */
  mobilityReduction: number;
  /** Global multiplicative reduction on transmission. 0..1. */
  transmissionReduction: number;
  /** Per-cell stochastic adherence. 0..1. */
  compliance: number;
}

export interface QuarantineSpec {
  enabled: boolean;
  /** Per-tick probability that an infectious cell is detected. 0..1. */
  detectionRate: number;
  /** Manhattan radius of "close contacts" isolated alongside a detected case. */
  contactsRange: number;
  /** Reduces transmission INTO quarantined cells. 0..1. */
  protection: number;
  /** Reduces transmission FROM quarantined cells. 0..1. */
  sourceControl: number;
  /** Quarantine persistence, in ticks. */
  duration: number;
}

export type GeometryType = 'square' | 'triangular' | 'hexagonal' | 'meanfield' | 'voronoi';
export type VoronoiMode = 'uniform' | 'jittered' | 'relaxed' | 'settlements';
export interface VoronoiConfig {
  mode: VoronoiMode;
  irregularity: number; // 0..1
}

export interface VoronoiTopology {
  n: number;
  cx: Float32Array; // centroid x [0..1], length n
  cy: Float32Array; // centroid y [0..1], length n
  adjOffsets: Int32Array; // CSR, length n+1
  adjList: Int32Array; // absolute cell indices
  // Polygon data — built only when withPolygons=true, null otherwise.
  polyOffsets: Int32Array | null; // length n+1
  polyVerts: Float32Array | null; // flat [x0,y0,x1,y1,...] normalized
}

export interface SimConfig {
  seed: number; // 32-bit unsigned PRNG seed
  size: number; // grid edge length; population = size * size
  geometry?: GeometryType; // lattice topology; defaults to 'square'
  voronoiConfig?: VoronoiConfig; // only used when geometry === 'voronoi'
  seedInfections: number; // 0..1 fraction starting as Exposed
  birthRate: number; // 0..1 per-tick respawn chance for dead cells with healthy neighbors
  mutate: boolean;
  /** When true, force-import one infectious cell whenever E+I=0 and immunity
   *  is finite — mirrors external migration in a SEIRS model. Defaults to
   *  false so that effective measures actually end an outbreak instead of
   *  triggering perpetual reseeds. */
  reseedOnExtinction?: boolean;
  strain: StrainGenes;
  defenses: DefenseSpec[];
  lockdown: LockdownSpec;
  quarantine: QuarantineSpec;
}

export type InterventionKey = 'mask' | 'vaccine' | 'lockdown' | 'quarantine';

export interface InterventionEvent {
  tick: number;
  intervention: InterventionKey;
  on: boolean;
  label?: string;
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

export interface TopologyMessage {
  type: 'topology';
  topo: VoronoiTopology;
}

export interface FrameMessage {
  type: 'frame';
  tick: number;
  /** Transferable view onto the population state byte buffer. */
  state: Uint8Array;
  /** Defense bitmask byte buffer, transferable. */
  defenses: Uint8Array;
  /** Per-cell quarantined flag (0/1). Null when quarantine isn't active. */
  quarantined: Uint8Array | null;
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
  | { cmd: 'updateConfig'; config: SimConfig }
  | { cmd: 'patchConfig'; config: SimConfig };
