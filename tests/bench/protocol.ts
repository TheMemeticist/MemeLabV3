// THE benchmark protocol — one definition, every entry point.
//
// This file is the contract. `benchConfig` here is the same workload
// `tests/bench.ts` has measured since the day the harness was written, and
// every runner in `tests/bench/` (plain Node, browser, the historical ladder)
// gets its config, its warm-up/measure counts and its timing loop from here.
// If the workload ever drifts, it drifts for all of them at once, and the
// census printed with every result makes the drift visible.
//
// GRAFTABILITY RULE — do not break it.
// The historical commits this harness is replayed against contain only
// `src/sim/*` and `src/types.ts`. So this file may import from those two
// places and nothing else: no test helpers, no `src/lib`, no npm packages.
// That restriction is the entire reason old commits can be measured with
// today's harness instead of with whatever each of them happened to ship.
//
// It also means: no optional-chaining on APIs that did not exist yet, no
// assumption that `Engine` has a `profile` field (it does not before the
// hot-loop commit), and no reliance on `engine.history` (added later).

import { Engine } from '../../src/sim/engine';
import type { GeometryType, SimConfig, SimStats } from '../../src/types';

/** Fixed protocol. Changing any of these invalidates comparison with every
 *  number ever published from this harness. */
export const PROTOCOL = {
  /** Grid edge length; population = size². */
  size: 320,
  seed: 0xb175b175 >>> 0,
  warmupTicks: 200,
  measureTicks: 300,
  /** Best-of-N. Noise can only ever make a run slower, so the fastest repeat
   *  is the cleanest estimate of what the code costs. */
  reps: 3,
};

export const GEOMETRIES: GeometryType[] = ['square', 'triangular', 'hexagonal', 'voronoi', 'meanfield'];

// Endemic-steady-state config: fast-waning immunity keeps a large infectious
// pool alive through the whole measured window (so the transmission pass is
// actually exercised — R0 must stay >1 even on the 3-neighbour triangular and
// k=2 mean-field geometries), quarantine is on so pass 2b runs, and a little
// mortality + birth exercises the dead-cell rebirth path.
//
// Byte-for-byte the config `tests/bench.ts` has always used, with `size`
// promoted to a parameter so the same workload can be measured at other dish
// sizes. At the default size it is the identical object.
export function benchConfig(geometry: GeometryType, size: number = PROTOCOL.size): SimConfig {
  return {
    seed: PROTOCOL.seed,
    size,
    geometry,
    voronoiConfig: { mode: 'jittered', irregularity: 0.5 },
    seedInfections: 0.05,
    birthRate: 0.05,
    mutate: false,
    strain: {
      attackRate: 0.4,
      incubation: 3,
      infectious: 7,
      ifr: 0.02,
      range: 1,
      immunityDays: 60,
      mutationRate: 0,
    },
    defenses: [
      { id: 'mask', label: 'Mask', enabled: true, protection: 0.2, sourceControl: 0.2, mortalityReduction: 0, uptake: 0.3 },
      { id: 'vaccine', label: 'Vaccine', enabled: true, protection: 0.4, sourceControl: 0, mortalityReduction: 0.8, uptake: 0.4 },
    ],
    lockdown: { enabled: false, mobilityReduction: 0, transmissionReduction: 0, compliance: 0 },
    quarantine: { enabled: true, detectionRate: 0.02, contactsRange: 1, protection: 0.3, sourceControl: 0.5, duration: 14 },
  };
}

/** The final census of a measured window. Printed with every result: two runs
 *  of the same rung that report different censuses were not measuring the same
 *  workload, and the comparison between them is void. */
export interface Census {
  s: number; e: number; i: number; r: number; d: number;
}

export interface Sample {
  ticksPerSec: number;
  msPerTick: number;
  census: Census;
  split: PassSplit | null;
}

/** Shape of `Engine.profile` — milliseconds accumulated per pass. */
interface RawProfile {
  transmission: number;
  quarantine: number;
  lifecycle: number;
  stats: number;
}

/** Coarse per-pass split, as a fraction of the measured window. Available
 *  only when the engine exposes the `profile` hook — the PRE-OPTIMIZATION
 *  engine does not have it, so `null` there is a fact about that commit, not a
 *  harness failure. */
export interface PassSplit {
  transmission: number;
  quarantine: number;
  lifecycle: number;
  stats: number;
  /** Measured window minus the four profiled passes. */
  other: number;
}

export interface BenchResult {
  backend: string;
  geometry: string;
  size: number;
  reps: number;
  ticksPerSec: number;
  msPerTick: number;
  /** Every repeat's rate, fastest first entry order preserved. */
  samples: number[];
  census: Census;
  /** True when every repeat ended on the identical census. */
  censusStable: boolean;
  /** Per-pass split of the best repeat, or null when the engine at this commit
   *  has no `profile` hook. */
  split: PassSplit | null;
}

/** Anything that steps one tick and returns the census. The TS engine, the
 *  WASM engine and (via an adapter) the GPU engine all satisfy it. */
export interface Steppable {
  step(): SimStats;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function censusOf(s: SimStats): Census {
  return { s: s.s, e: s.e, i: s.i, r: s.r, d: s.d };
}

export function censusEqual(a: Census, b: Census): boolean {
  return a.s === b.s && a.e === b.e && a.i === b.i && a.r === b.r && a.d === b.d;
}

export function formatCensus(c: Census): string {
  return `S=${c.s} E=${c.e} I=${c.i} R=${c.r} D=${c.d} N=${c.s + c.e + c.i + c.r + c.d}`;
}

/** One timed window: build, warm up, then time the measured ticks. The warm-up
 *  is outside the clock on purpose — it reaches the endemic steady state and
 *  lets the JIT settle, and it is the same count at every dish size so a
 *  bigger dish is never measured on a smaller infectious pool. */
export function timeOnce(build: () => Steppable, profiled = false): Sample {
  const engine = build();
  for (let t = 0; t < PROTOCOL.warmupTicks; t++) engine.step();

  // `profile` only exists from the hot-loop commit onwards. Feature-detect it
  // rather than assume — the pre-optimization engine in the ladder has no such
  // field, and the harness must run there unmodified.
  const hook = engine as Steppable & { profile?: RawProfile | null };
  const canProfile = profiled && 'profile' in hook;
  if (canProfile) hook.profile = { transmission: 0, quarantine: 0, lifecycle: 0, stats: 0 };

  const t0 = now();
  let last = engine.step();
  for (let t = 1; t < PROTOCOL.measureTicks; t++) last = engine.step();
  const totalMs = now() - t0;

  let split: PassSplit | null = null;
  if (canProfile) {
    const p = hook.profile as RawProfile;
    hook.profile = null;
    const acc = p.transmission + p.quarantine + p.lifecycle + p.stats;
    split = {
      transmission: p.transmission / totalMs,
      quarantine: p.quarantine / totalMs,
      lifecycle: p.lifecycle / totalMs,
      stats: p.stats / totalMs,
      other: Math.max(0, totalMs - acc) / totalMs,
    };
  }

  return {
    ticksPerSec: (PROTOCOL.measureTicks / totalMs) * 1000,
    msPerTick: totalMs / PROTOCOL.measureTicks,
    census: censusOf(last),
    split,
  };
}

/** Best-of-N around `timeOnce`, with the census cross-checked across repeats. */
export function measure(
  backend: string,
  geometry: GeometryType,
  size: number,
  build: () => Steppable,
  reps: number = PROTOCOL.reps,
  profiled = false,
): BenchResult {
  const samples: number[] = [];
  let best: Sample | null = null;
  let stable = true;
  for (let r = 0; r < reps; r++) {
    // The profile hook costs two performance.now() calls per pass per tick, so
    // it is measured in its OWN repeats, never mixed into a timing repeat.
    const s = timeOnce(build, profiled);
    samples.push(s.ticksPerSec);
    if (best === null) best = s;
    else {
      if (!censusEqual(best.census, s.census)) stable = false;
      if (s.ticksPerSec > best.ticksPerSec) best = { ...s, census: best.census };
    }
  }
  const b = best as Sample;
  return {
    backend, geometry, size, reps,
    ticksPerSec: b.ticksPerSec,
    msPerTick: b.msPerTick,
    samples,
    census: b.census,
    censusStable: stable,
    split: b.split,
  };
}

/** The TypeScript engine on the shared protocol. The only backend this file
 *  knows about — `src/sim/engine.ts` is the one engine every historical commit
 *  in the ladder has. */
export function measureTs(geometry: GeometryType, size: number = PROTOCOL.size, reps: number = PROTOCOL.reps): BenchResult {
  return measure('ts', geometry, size, () => new Engine(benchConfig(geometry, size)) as Steppable, reps);
}

/** A separate, PROFILED window on the TS engine. Kept apart from `measureTs`
 *  because the profile hook adds timer calls to the measured loop: the tick
 *  rate reported by this call is NOT the tick rate the ladder quotes. */
export function measureTsSplit(geometry: GeometryType, size: number = PROTOCOL.size, reps = 2): BenchResult {
  return measure('ts-prof', geometry, size, () => new Engine(benchConfig(geometry, size)) as Steppable, reps, true);
}

export function formatSplit(r: BenchResult): string {
  const p = r.split;
  const f = (v: number): string => `${(v * 100).toFixed(1).padStart(5)}%`;
  if (p === null) {
    return `${r.geometry.padEnd(10)} ${String(r.size).padStart(4)}²  no profile hook at this commit`;
  }
  return (
    `${r.geometry.padEnd(10)} ${String(r.size).padStart(4)}²  ` +
    `trans ${f(p.transmission)}  quar ${f(p.quarantine)}  life ${f(p.lifecycle)}  ` +
    `stats ${f(p.stats)}  other ${f(p.other)}  | ${r.msPerTick.toFixed(4)} ms/tick (profiled, not a rate quote)`
  );
}

export function formatResult(r: BenchResult): string {
  return (
    `${r.backend.padEnd(5)} ${String(r.size).padStart(4)}²  ${r.geometry.padEnd(10)} ` +
    `${r.ticksPerSec.toFixed(1).padStart(9)} t/s  ${r.msPerTick.toFixed(4).padStart(8)} ms/tick  ` +
    `best of ${r.reps}  | ${formatCensus(r.census)}${r.censusStable ? '' : '  ** CENSUS DRIFT **'}`
  );
}

export function protocolBanner(label: string): string {
  return (
    `MemeLab bench — protocol: ${PROTOCOL.size}² default, seed 0x${PROTOCOL.seed.toString(16)}, ` +
    `warmup ${PROTOCOL.warmupTicks}, measured ${PROTOCOL.measureTicks}, best of ${PROTOCOL.reps}\n` +
    `run label: ${label}\n` +
    `date: ${new Date().toISOString()}`
  );
}
