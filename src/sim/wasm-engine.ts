// WASM engine backend (docs/perf-plan.md Phase 2).
//
// `WasmEngine` is a drop-in for `Engine` over the single-strain configuration
// space: square / triangular / hexagonal / mean-field geometries with the full
// intervention surface (defenses, lockdown, quarantine, births, waning,
// txSchedule, extinction reseed). Voronoi and strain mutation stay on the TS
// engine — `wasmCompatible()` is the gate, and `createEngine()` is the factory
// callers use so the fallback is automatic.
//
// Determinism: bit-identical to the TS engine, by construction —
//  - the population is seeded by the TS `seed()` writing directly into wasm
//    memory (identical draws, identical buffers);
//  - the post-seed xoshiro128** state is handed to wasm, which continues the
//    exact stream with the identical algorithm and draw order;
//  - neighbor tables come from the TS geometry layer verbatim.
// `tests/wasm-engine.test.ts` enforces equality against the TS golden digests.
//
// The wasm binary is embedded as base64 (rust/build.sh) so Vite, GitHub Pages
// CI, workers, and vitest all load it with no asset-path or toolchain concerns.

import { CellState } from '../types';
import type { LongStats, RetiredCostTotals, SimConfig, SimStats, VoronoiTopology } from '../types';
import { LongHistory } from './long-history';
import { Rng } from './rng';
import { seed } from './population';
import { makeGeometry } from './neighbors';
import { resolveDefenses } from './defense';
import { Engine, estimateAnalyticR0, type EngineOptions, type PassProfile } from './engine';
import { ENGINE_CORE_WASM_B64 } from './wasm/engine-core-b64';

const REFF_WINDOW = 14;

interface CoreExports {
  memory: WebAssembly.Memory;
  init(size: number): void;
  set_rng(s0: number, s1: number, s2: number, s3: number): void;
  set_strain(attack: number, incub: number, infectious: number, ifr: number, immunityDays: number, range: number): void;
  set_defenses(
    p0: number, p1: number, p2: number, p3: number,
    s0: number, s1: number, s2: number, s3: number,
    m0: number, m1: number, m2: number, m3: number,
    u0: number, u1: number,
  ): void;
  set_lockdown(on: number, mobility: number, transMul: number): void;
  set_quarantine(on: number, detRate: number, qProtMul: number, qSrcMul: number, duration: number): void;
  set_misc(geometry: number, birthRate: number, reseedOn: number): void;
  table_alloc(role: number, parity: number, len: number): number;
  sched_alloc(len: number): number;
  finalize_init(): void;
  step(): void;
  tick(): number;
  state_ptr(): number;
  defenses_ptr(): number;
  lockdown_ptr(): number;
  quarantined_ptr(): number;
  qexpiry_ptr(): number;
  stats_ptr(): number;
  resample_defense(flagIdx: number, oldP: number, newP: number): void;
  resample_lockdown(oldP: number, newP: number): void;
  quarantine_clear(): void;
  recount_flags(): void;
  rebuild_schedules(timingChanged: number, waneChanged: number): void;
}

let compiledModule: WebAssembly.Module | null = null;
let moduleFailed = false;

function wasmBytes(): Uint8Array<ArrayBuffer> {
  const bin = atob(ENGINE_CORE_WASM_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Compile-once module cache. Sync compilation is fine here: WasmEngine is
 *  only constructed inside workers and tests, never on the UI thread. */
function getModule(): WebAssembly.Module | null {
  if (compiledModule) return compiledModule;
  if (moduleFailed) return null;
  try {
    compiledModule = new WebAssembly.Module(wasmBytes());
    return compiledModule;
  } catch {
    moduleFailed = true;
    return null;
  }
}

/** Can this runtime instantiate the wasm engine at all? */
export function wasmAvailable(): boolean {
  return typeof WebAssembly !== 'undefined' && getModule() !== null;
}

/** Is this config inside the wasm engine's feature space? Voronoi needs the
 *  CSR topology and mutation needs the strain pool — both stay on the TS
 *  reference engine. */
export function wasmCompatible(config: SimConfig): boolean {
  return (config.geometry ?? 'square') !== 'voronoi' && config.mutate !== true;
}

const GEOMETRY_CODE: Record<string, number> = { square: 0, triangular: 1, hexagonal: 2, meanfield: 3 };

export class WasmEngine {
  private exports!: CoreExports;
  private config!: SimConfig;
  private txSchedule: number[] | null = null;

  tick = 0;
  history: LongHistory = new LongHistory();
  retiredCost: RetiredCostTotals = emptyRetired();
  rNaught: number | null = null;
  voronoiTopo: VoronoiTopology | null = null;
  /** Pass-level profiling is a TS-engine facility; ignored here. */
  profile: PassProfile | null = null;

  private newInfectionsHistory: number[] = [];
  private newInfectiousHistory: number[] = [];
  private cumExposed = 0;
  private cumInfectious = 0;
  private cumRecovered = 0;
  private cumDead = 0;

  get longStats(): LongStats {
    return this.history.toLongStats();
  }

  constructor(config: SimConfig, _prebuiltTopo?: VoronoiTopology | null, opts?: EngineOptions) {
    const mod = getModule();
    if (!mod) throw new Error('wasm unavailable');
    if (!wasmCompatible(config)) throw new Error('config outside wasm engine feature space');
    this.exports = new WebAssembly.Instance(mod).exports as unknown as CoreExports;
    this.reset(config, _prebuiltTopo, opts);
  }

  reset(config: SimConfig, _prebuiltTopo?: VoronoiTopology | null, opts?: EngineOptions): void {
    if (!wasmCompatible(config)) throw new Error('config outside wasm engine feature space');
    this.config = config;
    const ex = this.exports;
    const n = config.size * config.size;
    ex.init(config.size);

    // Seed the population with the TS seed() writing straight into wasm
    // memory — identical draws, identical layout. Buffers the wasm core does
    // not keep (next/age/infectedAge/strainId) get throwaways so the draw
    // sequence is untouched.
    const D = resolveDefenses(config.defenses);
    const rng = new Rng(config.seed);
    const buf = ex.memory.buffer as ArrayBuffer;
    const pop = {
      size: config.size,
      n,
      state: new Uint8Array(buf, ex.state_ptr(), n),
      next: new Uint8Array(n),
      age: new Uint16Array(n),
      infectedAge: new Uint16Array(n),
      defenses: new Uint8Array(buf, ex.defenses_ptr(), n),
      strainId: new Uint16Array(n),
      lockdownCompliant: new Uint8Array(buf, ex.lockdown_ptr(), n),
      quarantined: new Uint8Array(buf, ex.quarantined_ptr(), n),
      quarantineExpiry: new Int32Array(buf, ex.qexpiry_ptr(), n),
    };
    seed(pop, rng, {
      seedInfections: config.seedInfections,
      maskUptake: D.uptake[0],
      vaccineUptake: D.uptake[1],
      lockdownCompliance: config.lockdown.enabled ? config.lockdown.compliance : 0,
      patientZero: true,
      indexCell: opts?.indexCell,
    });
    const s = rng.snapshot();
    ex.set_rng(s[0], s[1], s[2], s[3]);

    // Initial cumulative counters, from the seeded state (before views can be
    // invalidated by later allocating calls).
    let e0 = 0, i0 = 0;
    for (let k = 0; k < n; k++) {
      if (pop.state[k] === CellState.Exposed) e0++;
      else if (pop.state[k] === CellState.Infectious) i0++;
    }
    this.cumExposed = e0 + i0;
    this.cumInfectious = i0;
    this.cumRecovered = 0;
    this.cumDead = 0;

    this.pushParams(config);
    this.pushTables(config);
    this.txSchedule = opts?.txSchedule && opts.txSchedule.length > 0 ? opts.txSchedule : null;
    this.pushSchedule(this.txSchedule);
    ex.finalize_init();

    this.tick = 0;
    this.newInfectionsHistory = [];
    this.newInfectiousHistory = [];
    this.history.clear();
    this.retiredCost = emptyRetired();
    this.rNaught = opts !== undefined && opts.rNaught !== undefined
      ? opts.rNaught
      : estimateAnalyticR0(config, makeGeometry(config.geometry), null);
  }

  private pushParams(config: SimConfig): void {
    const ex = this.exports;
    const D = resolveDefenses(config.defenses);
    const g = config.strain;
    ex.set_strain(g.attackRate, g.incubation, g.infectious, g.ifr, g.immunityDays, g.range);
    ex.set_defenses(
      D.protByMask[0], D.protByMask[1], D.protByMask[2], D.protByMask[3],
      D.srcByMask[0], D.srcByMask[1], D.srcByMask[2], D.srcByMask[3],
      D.mortByMask[0], D.mortByMask[1], D.mortByMask[2], D.mortByMask[3],
      D.uptake[0], D.uptake[1],
    );
    const ld = config.lockdown;
    const ldOn = ld.enabled === true;
    ex.set_lockdown(ldOn ? 1 : 0, ld.mobilityReduction, ldOn ? 1 - ld.transmissionReduction : 1);
    const q = config.quarantine;
    const qOn = q.enabled === true;
    ex.set_quarantine(qOn ? 1 : 0, q.detectionRate, qOn ? 1 - q.protection : 1, qOn ? 1 - q.sourceControl : 1, q.duration);
    ex.set_misc(GEOMETRY_CODE[config.geometry ?? 'square'] ?? 0, config.birthRate, config.reseedOnExtinction === true ? 1 : 0);
  }

  /** Copy the TS geometry layer's parity offset tables into wasm. role 0 =
   *  transmission (strain.range), 1 = quarantine contacts, 2 = birth range 1.
   *  Square/mean-field have no parity dependence — the same table fills both
   *  slots (empty for mean-field). */
  private pushTables(config: SimConfig): void {
    const ex = this.exports;
    const geoType = config.geometry ?? 'square';
    const geo = makeGeometry(geoType);
    const contactsRange = Math.max(1, config.quarantine.contactsRange | 0);
    const roles: Array<[number, number]> = [
      [0, Math.max(1, Math.floor(config.strain.range))],
      [1, contactsRange],
      [2, 1],
    ];
    for (const [role, range] of roles) {
      for (const parity of [0, 1]) {
        let offsets: Int32Array;
        if (geoType === 'meanfield') {
          offsets = new Int32Array(0);
        } else if (geoType === 'triangular') {
          // cell parity = (x + y) & 1 → (0,0) even, (1,0) odd
          offsets = geo.getOffsets(range, parity, 0);
        } else if (geoType === 'hexagonal') {
          // row parity = y & 1 → (0,0) even, (0,1) odd
          offsets = geo.getOffsets(range, 0, parity);
        } else {
          offsets = geo.getOffsets(range, 0, 0);
        }
        const ptr = ex.table_alloc(role, parity, offsets.length);
        if (offsets.length > 0) {
          new Int32Array(ex.memory.buffer as ArrayBuffer, ptr, offsets.length).set(offsets);
        }
      }
    }
  }

  private pushSchedule(sched: number[] | null): void {
    const ex = this.exports;
    const len = sched ? sched.length : 0;
    const ptr = ex.sched_alloc(len);
    if (sched && len > 0) {
      new Float64Array(ex.memory.buffer as ArrayBuffer, ptr, len).set(sched);
    }
  }

  /** Exact port of Engine.patchConfig — same operation order, and every draw
   *  happens on the wasm-side RNG stream. */
  patchConfig(newCfg: SimConfig): void {
    const ex = this.exports;
    const old = this.config;
    let flagsChanged = false;
    for (let k = 0; k < newCfg.defenses.length && k < old.defenses.length; k++) {
      const oldEff = old.defenses[k].enabled === false ? 0 : old.defenses[k].uptake;
      const newEff = newCfg.defenses[k].enabled === false ? 0 : newCfg.defenses[k].uptake;
      if (oldEff !== newEff) {
        ex.resample_defense(k, oldEff, newEff);
        flagsChanged = true;
      }
    }
    if (flagsChanged) ex.recount_flags();
    const oldComp = old.lockdown.enabled ? old.lockdown.compliance : 0;
    const newComp = newCfg.lockdown.enabled ? newCfg.lockdown.compliance : 0;
    if (oldComp !== newComp) ex.resample_lockdown(oldComp, newComp);
    if (old.quarantine.enabled && !newCfg.quarantine.enabled) ex.quarantine_clear();
    const timingChanged =
      old.strain.incubation !== newCfg.strain.incubation ||
      old.strain.infectious !== newCfg.strain.infectious;
    const waneChanged = old.strain.immunityDays !== newCfg.strain.immunityDays;
    this.pushParams(newCfg);
    this.pushTables(newCfg);
    if (timingChanged || waneChanged) {
      ex.rebuild_schedules(timingChanged ? 1 : 0, waneChanged ? 1 : 0);
    }
    this.config = newCfg;
    this.rNaught = estimateAnalyticR0(newCfg, makeGeometry(newCfg.geometry), null);
  }

  step(): SimStats {
    const ex = this.exports;
    ex.step();
    this.tick = ex.tick();
    const st = new Int32Array(ex.memory.buffer as ArrayBuffer, ex.stats_ptr(), 12);
    const [s, e, i, r, d, newInfections, newInfectious, newDeaths, newRecovered, masked, vaccinated, quar] = st;
    const maskEnabled = this.config.defenses[0]?.enabled === true;
    const vaxEnabled = this.config.defenses[1]?.enabled === true;
    const quarantineOn = this.config.quarantine.enabled === true;
    return this.computeStats(newInfections, newInfectious, newDeaths, newRecovered, {
      s, e, i, r, d,
      masked: maskEnabled ? masked : 0,
      vaccinated: vaxEnabled ? vaccinated : 0,
      quar: quarantineOn ? quar : 0,
    });
  }

  // Identical to Engine.computeStats (single-strain: strains ≡ 1).
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

    let reffInf = 0, reffBecame = 0;
    for (let k = 0; k < this.newInfectiousHistory.length; k++) {
      reffInf += this.newInfectionsHistory[k] ?? 0;
      reffBecame += this.newInfectiousHistory[k] ?? 0;
    }
    const reff = reffBecame <= 0 ? 0 : reffInf / reffBecame;

    const stats: SimStats = {
      tick: this.tick,
      s, e, i: inf, r, d,
      newInfections,
      newDeaths,
      reff,
      strains: 1,
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

  buffers(): { state: Uint8Array; defenses: Uint8Array; quarantined: Uint8Array; size: number } {
    const ex = this.exports;
    const n = this.config.size * this.config.size;
    // Fresh views every call — wasm memory may have grown since the last one.
    return {
      state: new Uint8Array(ex.memory.buffer as ArrayBuffer, ex.state_ptr(), n),
      defenses: new Uint8Array(ex.memory.buffer as ArrayBuffer, ex.defenses_ptr(), n),
      quarantined: new Uint8Array(ex.memory.buffer as ArrayBuffer, ex.quarantined_ptr(), n),
      size: this.config.size,
    };
  }
}

/** The backend union every consumer of an engine can hold. */
export type AnyEngine = Engine | WasmEngine;

/** Factory with automatic fallback: wasm when requested, available, and the
 *  config is inside its feature space; the TS reference engine otherwise. */
export function createEngine(
  config: SimConfig,
  prebuiltTopo: VoronoiTopology | null | undefined,
  opts: EngineOptions | undefined,
  preferWasm: boolean,
): AnyEngine {
  if (preferWasm && wasmCompatible(config) && wasmAvailable()) {
    try {
      return new WasmEngine(config, prebuiltTopo, opts);
    } catch {
      // fall through to the reference engine
    }
  }
  return new Engine(config, prebuiltTopo, opts);
}

function emptyRetired(): RetiredCostTotals {
  return { ticks: 0, i: 0, dnew: 0, masked: 0, vaccinated: 0, quarantined: 0, lockdownStringency: 0 };
}
