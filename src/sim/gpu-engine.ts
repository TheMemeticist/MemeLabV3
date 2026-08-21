// WebGPU engine backend (docs/perf-plan.md Phase 3).
//
// The SEIR-D tick as a WGSL compute kernel, generalized from the gate spike:
//  - GATHER transmission: each susceptible reads its infectious neighbors and
//    self-infects with 1 − Π(1−pⱼ) — race-free, one write per thread, no
//    atomics on the hot path;
//  - counter-based RNG (pcg4d keyed on seed, cell, tick, stream): reproducible
//    regardless of GPU scheduling — same seed ⇒ same run, on any adapter;
//  - contact tracing by RECOMPUTING neighbors' detection rolls (no scatter);
//  - quarantine as expiry semantics; per-tick census + transition counters via
//    atomicAdd into a batch-relative stats row;
//  - N ticks per submit (ping-pong bind groups, per-tick uniform ring with
//    dynamic offsets); one readback per posted frame.
//
// Storage-binding budget: baseline WebGPU guarantees only EIGHT storage
// buffers per stage, so per-cell words are packed — the state word carries the
// SEIR state (bits 0..7) and the infection-age counter (bits 8+), and the
// defenses word carries the flag bits (0..1) plus the lockdown-compliance bit
// (bit 8). Seven storage bindings total; never exceed eight here.
//
// Determinism family: the GPU engine is deterministic per (config, seed,
// txSchedule) but runs the classic per-cell sweep semantics with its own RNG —
// its trajectories are their own family, NOT bit-comparable with the TS/WASM
// engines (which are bit-identical to each other). The census-conservation
// invariant (ΣS..D = N) holds exactly. The compatibility gate routes mutation
// and extinction-reseed configs back to the CPU backends. The fitted R(t)
// transmission schedule rides the per-tick uniform (Tick.tx) and scales the
// attack rate only, exactly where the CPU engines apply txMul.
//
// Voronoi (geometry 4) rides the same single tables buffer as the lattice
// parity tables, reinterpreted as per-cell CSR: seg.x = base of the offsets
// array (n+1 i32s), seg.y = base of the neighbor list (absolute cell
// indices). The gather stays valid because voronoi adjacency — and its BFS
// range expansions — is symmetric: "my neighbors" and "who can reach me" are
// the same set.
//
// GpuEngine exposes the same read surface `sim.worker.ts` posts frames from
// (tick / history / retiredCost / rNaught / buffers()), plus an async
// `run(nTicks)` in place of the sync `step()`.

import type { LongStats, RetiredCostTotals, SimConfig, SimStats, VoronoiTopology } from '../types';
import { LongHistory } from './long-history';
import { Rng } from './rng';
import { seed } from './population';
import { makeGeometry, VoronoiLattice } from './neighbors';
import { buildVoronoi } from './voronoi';
import { resolveDefenses } from './defense';
import { estimateAnalyticR0 } from './engine';

const REFF_WINDOW = 14;
const STATS_STRIDE = 12; // [s,e,i,r,d,newInf,newInfectious,newDeaths,newRecovered,masked,vax,quar]
const MAX_BATCH = 2048; // ticks per submit (uniform-ring + stats-window capacity)
const WG = 256;

export function gpuCompatible(config: SimConfig): boolean {
  return config.mutate !== true && config.reseedOnExtinction !== true;
}

export function gpuSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

const SHADER = /* wgsl */ `
struct Params {
  size: u32,
  n: u32,
  geometry: u32,      // 0 square, 1 triangular, 2 hexagonal, 3 meanfield, 4 voronoi
  seed: u32,
  attack: f32,
  ifr: f32,
  wane_p: f32,
  birth: f32,
  det_rate: f32,
  q_prot: f32,
  q_src: f32,
  trans_mul: f32,
  mobility: f32,
  lockdown_on: u32,
  quarantine_on: u32,
  q_duration: u32,
  incub: u32,
  inf_end: u32,
  up_mask: f32,
  up_vax: f32,
  prot_mask: vec4<f32>,
  src_mask: vec4<f32>,
  mort_mask: vec4<f32>,
  // Lattices: (base, len) pairs into the tables buffer, in i32 units:
  // x=evenBase y=evenLen z=oddBase w=oddLen.
  // Voronoi (geometry 4): x=base of the CSR offsets array (n+1 i32s),
  // y=base of the CSR neighbor list (absolute cell indices); z,w unused.
  tx_seg: vec4<u32>,
  ct_seg: vec4<u32>,
  b_seg: vec4<u32>,
}

// tick = absolute tick (RNG streams, quarantine expiry); row = batch-relative
// stats row (the stats buffer holds one batch window plus the carry row 0);
// tx = this tick's R(t) transmission multiplier (fitted intervention schedule,
// clamped to its last entry; 1 when no schedule) — applied to the attack rate
// only, exactly where the CPU engines apply txMul.
struct Tick { tick: u32, row: u32, tx: f32 }

// Packed cell words — see the storage-binding budget note at the top.
// cells:    bits 0..7 = SEIR state, bits 8.. = infection-age counter
// defenses: bits 0..1 = defense flags, bit 8 = lockdown-compliant
@group(0) @binding(0) var<storage, read> cellsIn: array<u32>;
@group(0) @binding(1) var<storage, read_write> cellsOut: array<u32>;
@group(0) @binding(2) var<storage, read_write> defenses: array<u32>;
@group(0) @binding(3) var<storage, read> quarIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> quarOut: array<u32>;
@group(0) @binding(5) var<storage, read_write> stats: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> tables: array<i32>;
@group(0) @binding(7) var<uniform> P: Params;
@group(0) @binding(8) var<uniform> T: Tick;

const ST_S: u32 = 0u; const ST_E: u32 = 1u; const ST_I: u32 = 2u;
const ST_R: u32 = 3u; const ST_D: u32 = 4u;
const STRIDE: u32 = 12u;
const COMPLIANT_BIT: u32 = 0x100u;

fn pcg4d(v0: vec4<u32>) -> vec4<u32> {
  var v = v0 * 1664525u + 1013904223u;
  v.x = v.x + v.y * v.w; v.y = v.y + v.z * v.x;
  v.z = v.z + v.x * v.y; v.w = v.w + v.y * v.z;
  v = v ^ (v >> vec4<u32>(16u));
  v.x = v.x + v.y * v.w; v.y = v.y + v.z * v.x;
  v.z = v.z + v.x * v.y; v.w = v.w + v.y * v.z;
  return v;
}

fn rand01(cell: u32, tick: u32, stream: u32) -> f32 {
  let h = pcg4d(vec4<u32>(cell ^ P.seed, tick, stream, 0x9e3779b9u));
  return f32(h.x >> 8u) * (1.0 / 16777216.0);
}

fn q_active(expiry: u32, tick: u32) -> bool {
  return expiry > 0u && expiry >= tick;
}

fn parity_of(x: i32, y: i32) -> u32 {
  if (P.geometry == 1u) { return u32((x + y) & 1); }
  if (P.geometry == 2u) { return u32(y & 1); }
  return 0u;
}

fn table_seg(role: u32, parity: u32) -> vec2<u32> {
  var seg: vec4<u32>;
  if (role == 0u) { seg = P.tx_seg; }
  else if (role == 1u) { seg = P.ct_seg; }
  else { seg = P.b_seg; }
  if (parity == 0u) { return vec2<u32>(seg.x, seg.y); }
  return vec2<u32>(seg.z, seg.w);
}

fn neighbor_at(i: u32, base: u32, k: u32) -> u32 {
  let size = i32(P.size);
  let x = i32(i % P.size);
  let y = i32(i / P.size);
  var nx = x + tables[base + 2u * k];
  var ny = y + tables[base + 2u * k + 1u];
  if (nx < 0) { nx = nx + size; } else if (nx >= size) { nx = nx - size; }
  if (ny < 0) { ny = ny + size; } else if (ny >= size) { ny = ny - size; }
  return u32(ny) * P.size + u32(nx);
}

fn state_of(word: u32) -> u32 { return word & 0xFFu; }

// detection roll for cell c at tick t — recomputable by neighbors, which is
// how contact tracing works without scatter writes.
fn detected(c: u32, tick: u32) -> bool {
  if (P.quarantine_on == 0u || P.det_rate <= 0.0 || P.q_duration == 0u) { return false; }
  return state_of(cellsIn[c]) == ST_I && !q_active(quarIn[c], tick) && rand01(c, tick, 2u) < P.det_rate;
}

@compute @workgroup_size(${WG})
fn tick_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let tick = T.tick;
  let word = cellsIn[i];
  let s = state_of(word);
  var ns = s;
  var age = word >> 8u;
  let self_quar = P.quarantine_on != 0u && q_active(quarIn[i], tick);
  let x = i32(i % P.size);
  let y = i32(i / P.size);
  let parity = parity_of(x, y);

  if (s == ST_S) {
    var p_inf = 0.0;
    // Per-tick transmission multiplier (fitted R(t) schedule) scales the
    // attack rate only — mirrors the TS engines' baseAttack = attack * txMul.
    let atk = P.attack * T.tx;
    var prot = P.prot_mask[defenses[i] & 3u];
    if (self_quar) { prot = prot * P.q_prot; }
    if (P.geometry == 3u) {
      // Mean-field: aggregate force of infection from the previous census row.
      let i_count = f32(atomicLoad(&stats[T.row * STRIDE + 2u]));
      if (i_count > 0.0) {
        let mob_keep = select(1.0, 1.0 - P.mobility, P.lockdown_on != 0u);
        let p = atk * P.trans_mul * P.q_src * prot;
        if (p > 0.0) {
          p_inf = mob_keep * (1.0 - pow(1.0 - p, i_count * 2.0 / f32(P.n)));
        }
      }
    } else if (P.geometry == 4u) {
      // Voronoi gather over the per-cell CSR list (symmetric adjacency).
      var miss = 1.0;
      let seg = table_seg(0u, 0u);
      let lo = u32(tables[seg.x + i]);
      let hi = u32(tables[seg.x + i + 1u]);
      for (var k = lo; k < hi; k = k + 1u) {
        let j = u32(tables[seg.y + k]);
        if (state_of(cellsIn[j]) == ST_I) {
          let dj = defenses[j];
          var src = P.src_mask[dj & 3u];
          if (P.quarantine_on != 0u && q_active(quarIn[j], tick)) { src = src * P.q_src; }
          src = src * P.trans_mul;
          if (P.lockdown_on != 0u && (dj & COMPLIANT_BIT) != 0u) { src = src * (1.0 - P.mobility); }
          miss = miss * (1.0 - atk * src * prot);
        }
      }
      p_inf = 1.0 - miss;
    } else {
      var miss = 1.0;
      let seg = table_seg(0u, parity);
      let cnt = seg.y / 2u;
      for (var k = 0u; k < cnt; k = k + 1u) {
        let j = neighbor_at(i, seg.x, k);
        if (state_of(cellsIn[j]) == ST_I) {
          let dj = defenses[j];
          var src = P.src_mask[dj & 3u];
          if (P.quarantine_on != 0u && q_active(quarIn[j], tick)) { src = src * P.q_src; }
          src = src * P.trans_mul;
          if (P.lockdown_on != 0u && (dj & COMPLIANT_BIT) != 0u) { src = src * (1.0 - P.mobility); }
          miss = miss * (1.0 - atk * src * prot);
        }
      }
      p_inf = 1.0 - miss;
    }
    if (p_inf > 0.0 && rand01(i, tick, 1u) < p_inf) {
      ns = ST_E;
      age = 0u;
    }
  } else if (s == ST_E) {
    age = age + 1u;
    if (age >= P.incub) { ns = ST_I; }
  } else if (s == ST_I) {
    age = age + 1u;
    if (age >= P.inf_end) {
      let ifr = P.ifr * P.mort_mask[defenses[i] & 3u];
      if (rand01(i, tick, 3u) < ifr) { ns = ST_D; }
      else { ns = ST_R; age = 0u; }
    }
  } else if (s == ST_R) {
    if (rand01(i, tick, 4u) < P.wane_p) { ns = ST_S; }
  } else {
    // Dead: birth roll scaled by the alive-neighbor fraction (flat mean-field).
    var p = P.birth;
    if (P.geometry == 4u) {
      // Voronoi: direct CSR neighbors; a zero-degree cell uses 0.5 (TS parity).
      let seg = table_seg(2u, 0u);
      let lo = u32(tables[seg.x + i]);
      let hi = u32(tables[seg.x + i + 1u]);
      var alive = 0u;
      for (var k = lo; k < hi; k = k + 1u) {
        if (state_of(cellsIn[u32(tables[seg.y + k])]) != ST_D) { alive = alive + 1u; }
      }
      p = P.birth * select(f32(alive) / f32(max(hi - lo, 1u)), 0.5, hi == lo);
    } else if (P.geometry != 3u) {
      let seg = table_seg(2u, parity);
      let cnt = seg.y / 2u;
      var alive = 0u;
      for (var k = 0u; k < cnt; k = k + 1u) {
        if (state_of(cellsIn[neighbor_at(i, seg.x, k)]) != ST_D) { alive = alive + 1u; }
      }
      p = P.birth * f32(alive) / max(f32(cnt), 1.0);
    }
    if (p > 0.0 && rand01(i, tick, 5u) < p) {
      ns = ST_S;
      age = 0u;
      var f = 0u;
      if (rand01(i, tick, 6u) < P.up_mask) { f = f | 1u; }
      if (rand01(i, tick, 7u) < P.up_vax) { f = f | 2u; }
      // Rebirth re-rolls the defense flags but keeps the cell's lockdown
      // compliance (the TS engines never resample it at birth either).
      defenses[i] = f | (defenses[i] & COMPLIANT_BIT);
    }
  }

  // Quarantine: self-detection or a detected close contact raises the release
  // tick; expiry semantics need no explicit release pass.
  var exp = quarIn[i];
  if (exp > 0u && exp < tick) { exp = 0u; }
  if (P.quarantine_on != 0u && ns != ST_D) {
    var det = detected(i, tick);
    if (!det && P.geometry == 4u) {
      let seg = table_seg(1u, 0u);
      let lo = u32(tables[seg.x + i]);
      let hi = u32(tables[seg.x + i + 1u]);
      for (var k = lo; k < hi; k = k + 1u) {
        if (detected(u32(tables[seg.y + k]), tick)) { det = true; break; }
      }
    } else if (!det && P.geometry != 3u) {
      let seg = table_seg(1u, parity);
      let cnt = seg.y / 2u;
      for (var k = 0u; k < cnt; k = k + 1u) {
        if (detected(neighbor_at(i, seg.x, k), tick)) { det = true; break; }
      }
    }
    if (det) {
      let e2 = tick + P.q_duration;
      if (e2 > exp) { exp = e2; }
    }
  }
  quarOut[i] = exp;
  cellsOut[i] = ns | (age << 8u);

  // Per-tick census + transition counters (batch-relative row + 1; row 0 is
  // the carried-forward census from before this batch).
  let row = (T.row + 1u) * STRIDE;
  atomicAdd(&stats[row + ns], 1u);
  if (s == ST_S && ns == ST_E) { atomicAdd(&stats[row + 5u], 1u); }
  if (s == ST_E && ns == ST_I) { atomicAdd(&stats[row + 6u], 1u); }
  if (s == ST_I && ns == ST_D) { atomicAdd(&stats[row + 7u], 1u); }
  if (s == ST_I && ns == ST_R) { atomicAdd(&stats[row + 8u], 1u); }
  if (ns != ST_D) {
    let d = defenses[i];
    if ((d & 1u) != 0u) { atomicAdd(&stats[row + 9u], 1u); }
    if ((d & 2u) != 0u) { atomicAdd(&stats[row + 10u], 1u); }
    if (q_active(exp, tick + 1u)) { atomicAdd(&stats[row + 11u], 1u); }
  }
}
`;

interface GpuBuffers {
  cellsA: GPUBuffer;
  cellsB: GPUBuffer;
  defenses: GPUBuffer;
  quarA: GPUBuffer;
  quarB: GPUBuffer;
  stats: GPUBuffer;
  // One census row (STATS_STRIDE u32s): WebGPU forbids same-buffer copies, so
  // rolling the batch's final census into row 0 goes stats→carry→stats.
  carry: GPUBuffer;
  tables: GPUBuffer;
  params: GPUBuffer;
  tickRing: GPUBuffer;
  staging: GPUBuffer;
}

export class GpuEngine {
  private device!: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private layout!: GPUBindGroupLayout;
  private bufs!: GpuBuffers;
  private bgPing!: GPUBindGroup;
  private bgPong!: GPUBindGroup;
  private config!: SimConfig;
  private n = 0;
  // Voronoi topology + lattice (BFS cache) — set in reset, reused by
  // patchConfig table rebuilds (topology changes always full-rebuild).
  private voronoiTopo: VoronoiTopology | null = null;
  private vorLattice: VoronoiLattice | null = null;
  private lastState!: Uint8Array;
  private lastDefenses!: Uint8Array;
  private lastQuarantined!: Uint8Array;
  private ring: Uint32Array<ArrayBuffer> | null = null;
  // f32 view over the same ring buffer — the Tick uniform's tx word.
  private ringF: Float32Array | null = null;
  // Fitted R(t) transmission schedule (per-tick multiplier, clamped to its
  // last entry — tx_mul_now semantics). Arrives at reset; patchConfig leaves
  // it unchanged (schedule changes always come via a full rebuild).
  private txSchedule: number[] | null = null;

  tick = 0;
  history: LongHistory = new LongHistory();
  retiredCost: RetiredCostTotals = emptyRetired();
  rNaught: number | null = null;

  private newInfectionsHistory: number[] = [];
  private newInfectiousHistory: number[] = [];
  private cumExposed = 0;
  private cumInfectious = 0;
  private cumRecovered = 0;
  private cumDead = 0;

  get longStats(): LongStats {
    return this.history.toLongStats();
  }

  /** Async constructor — adapter/device acquisition and first upload. Throws
   *  when WebGPU is unavailable; the worker falls back to a CPU backend. */
  static async create(config: SimConfig, prebuiltTopo?: VoronoiTopology | null, txSchedule?: number[] | null): Promise<GpuEngine> {
    if (!gpuSupported()) throw new Error('WebGPU not available');
    if (!gpuCompatible(config)) throw new Error('config outside gpu engine feature space');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    // A software adapter (SwiftShader/llvmpipe) is slower than the WASM engine —
    // treat it as unavailable so the fallback reason can point at the real fix.
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    const softId = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.description ?? ''}`.toLowerCase();
    if (/swiftshader|llvmpipe|software/.test(softId) || (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter === true) {
      throw new Error('software WebGPU adapter');
    }
    const device = await adapter.requestDevice();
    const e = new GpuEngine();
    e.device = device;
    e.buildPipeline();
    e.reset(config, prebuiltTopo, txSchedule);
    return e;
  }

  private buildPipeline(): void {
    const device = this.device;
    const module = device.createShaderModule({ code: SHADER });
    const entries: GPUBindGroupLayoutEntry[] = [];
    for (let b = 0; b <= 8; b++) {
      let type: GPUBufferBindingType = 'storage';
      if (b === 0 || b === 3 || b === 6) type = 'read-only-storage';
      if (b === 7 || b === 8) type = 'uniform';
      entries.push({
        binding: b,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type, hasDynamicOffset: b === 8 },
      });
    }
    this.layout = device.createBindGroupLayout({ entries });
    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: 'tick_main' },
    });
  }

  reset(config: SimConfig, prebuiltTopo?: VoronoiTopology | null, txSchedule?: number[] | null): void {
    if (!gpuCompatible(config)) throw new Error('config outside gpu engine feature space');
    this.config = config;
    this.txSchedule = txSchedule && txSchedule.length > 0 ? txSchedule : null;
    const device = this.device;
    const n = config.size * config.size;
    this.n = n;
    if ((config.geometry ?? 'square') === 'voronoi') {
      // Same derived-seed topology every backend builds; keep the lattice (and
      // its BFS cache) when the topology object is unchanged.
      const topo = prebuiltTopo ?? buildVoronoi(n, config.voronoiConfig, new Rng(config.seed ^ 0x564f524f), false);
      if (topo !== this.voronoiTopo || this.vorLattice === null) this.vorLattice = new VoronoiLattice(topo);
      this.voronoiTopo = topo;
    } else {
      this.voronoiTopo = null;
      this.vorLattice = null;
    }
    this.tick = 0;
    this.history.clear();
    this.retiredCost = emptyRetired();
    this.newInfectionsHistory = [];
    this.newInfectiousHistory = [];

    // Seed the initial population with the TS seed() — the GPU run starts from
    // the exact population a CPU engine would (its trajectory then follows the
    // GPU determinism family).
    const D = resolveDefenses(config.defenses);
    const rng = new Rng(config.seed);
    const pop = {
      size: config.size,
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
    seed(pop, rng, {
      seedInfections: config.seedInfections,
      maskUptake: D.uptake[0],
      vaccineUptake: D.uptake[1],
      lockdownCompliance: config.lockdown.enabled ? config.lockdown.compliance : 0,
      patientZero: true,
    });

    let e0 = 0;
    const cells32 = new Uint32Array(n);
    const def32 = new Uint32Array(n);
    const census0 = new Uint32Array(STATS_STRIDE);
    for (let i = 0; i < n; i++) {
      cells32[i] = pop.state[i]; // age bits start at 0
      def32[i] = pop.defenses[i] | (pop.lockdownCompliant[i] ? 0x100 : 0);
      census0[pop.state[i]]++;
      if (pop.state[i] === 1) e0++;
    }
    this.cumExposed = e0;
    this.cumInfectious = 0;
    this.cumRecovered = 0;
    this.cumDead = 0;
    this.lastState = pop.state.slice();
    this.lastDefenses = pop.defenses.slice();
    this.lastQuarantined = pop.quarantined.slice();

    // (Re)allocate GPU buffers.
    this.destroyBuffers();
    const mk = (label: string, size: number, usage: number, data?: Uint32Array<ArrayBuffer>): GPUBuffer => {
      const buf = device.createBuffer({ label, size, usage });
      if (data) device.queue.writeBuffer(buf, 0, data);
      return buf;
    };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const zero32 = new Uint32Array(n);
    this.bufs = {
      cellsA: mk('cellsA', n * 4, S, cells32),
      cellsB: mk('cellsB', n * 4, S, cells32),
      defenses: mk('defenses', n * 4, S, def32),
      quarA: mk('quarA', n * 4, S, zero32),
      quarB: mk('quarB', n * 4, S, zero32),
      stats: mk('stats', (MAX_BATCH + 1) * STATS_STRIDE * 4, S),
      carry: mk('carry', STATS_STRIDE * 4, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST),
      tables: this.buildTables(config),
      params: mk('params', 256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      tickRing: mk('tickRing', MAX_BATCH * 256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      staging: device.createBuffer({
        label: 'staging',
        size: this.stagingSize(),
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
    };
    device.queue.writeBuffer(this.bufs.stats, 0, census0);
    this.pushParams(config);
    this.buildBindGroups();
    this.rNaught = estimateAnalyticR0(config, this.vorLattice ?? makeGeometry(config.geometry), this.voronoiTopo);
  }

  private stagingSize(): number {
    // stats window + cells + defenses + quarantined (u32 each), 256-aligned.
    const bytes = MAX_BATCH * STATS_STRIDE * 4 + this.n * 4 * 3;
    return Math.ceil(bytes / 256) * 256;
  }

  private destroyBuffers(): void {
    if (!this.bufs) return;
    for (const b of Object.values(this.bufs)) (b as GPUBuffer).destroy();
    this.bufs = undefined as unknown as GpuBuffers;
  }

  /** Concatenate the six parity tables into one storage buffer; segment
   *  descriptors go into the params uniform. */
  private tableSegs!: Uint32Array; // [txEB, txEL, txOB, txOL, ctEB, ctEL, ctOB, ctOL, bEB, bEL, bOB, bOL]
  private buildTables(config: SimConfig): GPUBuffer {
    const geoType = config.geometry ?? 'square';
    if (geoType === 'voronoi') return this.buildCsrTables(config);
    const geo = makeGeometry(geoType);
    const contactsRange = Math.max(1, config.quarantine.contactsRange | 0);
    const roles: number[] = [Math.max(1, Math.floor(config.strain.range)), contactsRange, 1];
    const segs: Int32Array[] = [];
    for (const range of roles) {
      for (const parity of [0, 1]) {
        if (geoType === 'meanfield') segs.push(new Int32Array(0));
        else if (geoType === 'triangular') segs.push(geo.getOffsets(range, parity, 0));
        else if (geoType === 'hexagonal') segs.push(geo.getOffsets(range, 0, parity));
        else segs.push(geo.getOffsets(range, 0, 0));
      }
    }
    const total = Math.max(1, segs.reduce((a, s) => a + s.length, 0));
    const flat = new Int32Array(total);
    this.tableSegs = new Uint32Array(12);
    let base = 0;
    segs.forEach((s, idx) => {
      flat.set(s, base);
      this.tableSegs[idx * 2] = base;
      this.tableSegs[idx * 2 + 1] = s.length;
      base += s.length;
    });
    const buf = this.device.createBuffer({
      label: 'tables',
      size: flat.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, flat as Int32Array<ArrayBuffer>);
    return buf;
  }

  /** Voronoi: per-role [offsets(n+1), list] CSR chunks concatenated into the
   *  same single tables buffer; tableSegs[role*4] = offsets base and
   *  tableSegs[role*4+1] = list base (the shader's voronoi branches read seg.x
   *  and seg.y with that meaning). The contacts CSR (role 1) can be
   *  BFS-expensive at contactsRange > 1, so it is only materialized while
   *  quarantine is enabled — the shader only reads it under the same flag, and
   *  patchConfig rebuilds tables on every change. */
  private buildCsrTables(config: SimConfig): GPUBuffer {
    const lat = this.vorLattice!;
    const n = this.n;
    const contactsRange = Math.max(1, config.quarantine.contactsRange | 0);
    const roles: Array<[number, boolean]> = [
      [Math.max(1, Math.floor(config.strain.range)), true],
      [contactsRange, config.quarantine.enabled === true],
      [1, true],
    ];
    this.tableSegs = new Uint32Array(12);
    const chunks: Int32Array[] = [];
    let base = 0;
    roles.forEach(([range, wanted], role) => {
      const offsets = new Int32Array(n + 1);
      const lists: Int32Array[] = [];
      let total = 0;
      if (wanted) {
        for (let i = 0; i < n; i++) {
          const nb = lat.getNeighborIndices!(i, range);
          lists.push(nb);
          offsets[i] = total;
          total += nb.length;
        }
        offsets[n] = total;
      }
      const flatList = new Int32Array(Math.max(1, total));
      let w = 0;
      for (const nb of lists) {
        flatList.set(nb, w);
        w += nb.length;
      }
      this.tableSegs[role * 4] = base;
      chunks.push(offsets);
      base += offsets.length;
      this.tableSegs[role * 4 + 1] = base;
      chunks.push(flatList);
      base += flatList.length;
    });
    const flat = new Int32Array(base);
    let at = 0;
    for (const c of chunks) {
      flat.set(c, at);
      at += c.length;
    }
    const buf = this.device.createBuffer({
      label: 'tables',
      size: flat.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, flat as Int32Array<ArrayBuffer>);
    return buf;
  }

  private pushParams(config: SimConfig): void {
    const D = resolveDefenses(config.defenses);
    const g = config.strain;
    const ld = config.lockdown;
    const ldOn = ld.enabled === true;
    const q = config.quarantine;
    const qOn = q.enabled === true;
    const geoCode = ({ square: 0, triangular: 1, hexagonal: 2, meanfield: 3, voronoi: 4 } as Record<string, number>)[
      config.geometry ?? 'square'
    ] ?? 0;

    const buf = new ArrayBuffer(256);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    u32[0] = config.size;
    u32[1] = this.n;
    u32[2] = geoCode;
    u32[3] = config.seed >>> 0;
    f32[4] = g.attackRate;
    f32[5] = g.ifr;
    f32[6] = g.immunityDays > 0 ? 1 / g.immunityDays : 1;
    f32[7] = config.birthRate;
    f32[8] = qOn ? q.detectionRate : 0;
    f32[9] = qOn ? 1 - q.protection : 1;
    f32[10] = qOn ? 1 - q.sourceControl : 1;
    f32[11] = ldOn ? 1 - ld.transmissionReduction : 1;
    f32[12] = ld.mobilityReduction;
    u32[13] = ldOn ? 1 : 0;
    u32[14] = qOn ? 1 : 0;
    u32[15] = Math.max(0, q.duration | 0);
    u32[16] = Math.max(0, g.incubation | 0);
    u32[17] = Math.max(0, (g.incubation + g.infectious) | 0);
    f32[18] = D.uptake[0];
    f32[19] = D.uptake[1];
    // vec4 members are 16-byte aligned: prot at byte 80 (f32 idx 20).
    for (let k = 0; k < 4; k++) f32[20 + k] = D.protByMask[k];
    for (let k = 0; k < 4; k++) f32[24 + k] = D.srcByMask[k];
    for (let k = 0; k < 4; k++) f32[28 + k] = D.mortByMask[k];
    for (let k = 0; k < 4; k++) u32[32 + k] = this.tableSegs[k];
    for (let k = 0; k < 4; k++) u32[36 + k] = this.tableSegs[4 + k];
    for (let k = 0; k < 4; k++) u32[40 + k] = this.tableSegs[8 + k];
    this.device.queue.writeBuffer(this.bufs.params, 0, buf);
  }

  private buildBindGroups(): void {
    const b = this.bufs;
    const mk = (cIn: GPUBuffer, cOut: GPUBuffer, qIn: GPUBuffer, qOut: GPUBuffer): GPUBindGroup =>
      this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: cIn } },
          { binding: 1, resource: { buffer: cOut } },
          { binding: 2, resource: { buffer: b.defenses } },
          { binding: 3, resource: { buffer: qIn } },
          { binding: 4, resource: { buffer: qOut } },
          { binding: 5, resource: { buffer: b.stats } },
          { binding: 6, resource: { buffer: b.tables } },
          { binding: 7, resource: { buffer: b.params } },
          { binding: 8, resource: { buffer: b.tickRing, offset: 0, size: 16 } },
        ],
      });
    this.bgPing = mk(b.cellsA, b.cellsB, b.quarA, b.quarB);
    this.bgPong = mk(b.cellsB, b.cellsA, b.quarB, b.quarA);
  }

  /** Soft-patch: parameter groups re-upload; defense uptake changes resample
   *  the (read-back) per-cell flags on the CPU and re-upload. Statistical, not
   *  bit-tracked — the GPU backend is its own determinism family. */
  async patchConfig(newCfg: SimConfig): Promise<void> {
    const old = this.config;
    let flagsChanged = false;
    for (let k = 0; k < newCfg.defenses.length && k < old.defenses.length; k++) {
      const oldEff = old.defenses[k].enabled === false ? 0 : old.defenses[k].uptake;
      const newEff = newCfg.defenses[k].enabled === false ? 0 : newCfg.defenses[k].uptake;
      if (oldEff !== newEff) flagsChanged = true;
    }
    if (flagsChanged) {
      // Read back current flag words, resample toward the new uptakes, re-upload
      // (the compliance bit rides along untouched).
      const def = await this.readbackU32(this.bufs.defenses);
      const rng = new Rng((this.config.seed ^ this.tick ^ 0x9a7c4) >>> 0);
      for (let k = 0; k < newCfg.defenses.length && k < old.defenses.length; k++) {
        const oldEff = old.defenses[k].enabled === false ? 0 : old.defenses[k].uptake;
        const newEff = newCfg.defenses[k].enabled === false ? 0 : newCfg.defenses[k].uptake;
        if (oldEff === newEff) continue;
        const mask = 1 << k;
        if (newEff > oldEff) {
          const q = (newEff - oldEff) / Math.max(1e-9, 1 - oldEff);
          for (let i = 0; i < this.n; i++) if (!(def[i] & mask) && rng.bernoulli(q)) def[i] |= mask;
        } else {
          const q = (oldEff - newEff) / Math.max(1e-9, oldEff);
          for (let i = 0; i < this.n; i++) if ((def[i] & mask) && rng.bernoulli(q)) def[i] &= ~mask;
        }
      }
      this.device.queue.writeBuffer(this.bufs.defenses, 0, def);
    }
    if (old.quarantine.enabled && !newCfg.quarantine.enabled) {
      const zeros = new Uint32Array(this.n);
      this.device.queue.writeBuffer(this.bufs.quarA, 0, zeros);
      this.device.queue.writeBuffer(this.bufs.quarB, 0, zeros);
    }
    this.config = newCfg;
    // Tables can change via contactsRange / strain.range.
    this.bufs.tables.destroy();
    this.bufs.tables = this.buildTables(newCfg);
    this.buildBindGroups();
    this.pushParams(newCfg);
    this.rNaught = estimateAnalyticR0(newCfg, this.vorLattice ?? makeGeometry(newCfg.geometry), this.voronoiTopo);
  }

  private async readbackU32(src: GPUBuffer): Promise<Uint32Array<ArrayBuffer>> {
    const staging = this.device.createBuffer({
      size: this.n * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, this.n * 4);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(staging.getMappedRange().slice(0)) as Uint32Array<ArrayBuffer>;
    staging.destroy();
    return out;
  }

  /** Advance `nTicks` in one submit and read back the stats window + render
   *  buffers. Returns the last tick's SimStats (history gets every tick). */
  async run(nTicks: number): Promise<SimStats | null> {
    const device = this.device;
    const n = Math.max(1, Math.min(nTicks | 0, MAX_BATCH));
    const startTick = this.tick;

    // Row 0 carries the census from before this batch; clear rows 1..n.
    const zero = new Uint32Array(n * STATS_STRIDE);
    device.queue.writeBuffer(this.bufs.stats, STATS_STRIDE * 4, zero);

    // Per-tick uniform ring: absolute tick (RNG + expiry), batch-relative
    // stats row, and this tick's R(t) multiplier, at the 256-byte
    // dynamic-offset stride. Schedule indexes the ABSOLUTE tick and clamps to
    // its last entry — identical to the CPU engines' tx_mul_now.
    if (!this.ring) {
      this.ring = new Uint32Array((MAX_BATCH * 256) / 4);
      this.ringF = new Float32Array(this.ring.buffer);
    }
    const sched = this.txSchedule;
    for (let r = 0; r < n; r++) {
      const abs = startTick + r;
      this.ring[(r * 256) / 4] = abs;
      this.ring[(r * 256) / 4 + 1] = r;
      this.ringF![(r * 256) / 4 + 2] = sched ? sched[Math.min(abs, sched.length - 1)] : 1;
    }
    device.queue.writeBuffer(this.bufs.tickRing, 0, this.ring, 0, (n * 256) / 4);

    const enc = device.createCommandEncoder();
    {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline);
      const groups = Math.ceil(this.n / WG);
      for (let r = 0; r < n; r++) {
        const abs = startTick + r;
        pass.setBindGroup(0, abs % 2 === 0 ? this.bgPing : this.bgPong, [r * 256]);
        pass.dispatchWorkgroups(groups, 1, 1);
      }
      pass.end();
    }
    // Read back stats rows 1..n plus the "out" buffers of the LAST dispatch
    // (an even absolute tick reads A and writes B).
    const lastAbs = startTick + n - 1;
    const outCells = lastAbs % 2 === 0 ? this.bufs.cellsB : this.bufs.cellsA;
    const outQuar = lastAbs % 2 === 0 ? this.bufs.quarB : this.bufs.quarA;
    const statsBytes = n * STATS_STRIDE * 4;
    enc.copyBufferToBuffer(this.bufs.stats, STATS_STRIDE * 4, this.bufs.staging, 0, statsBytes);
    enc.copyBufferToBuffer(outCells, 0, this.bufs.staging, statsBytes, this.n * 4);
    enc.copyBufferToBuffer(this.bufs.defenses, 0, this.bufs.staging, statsBytes + this.n * 4, this.n * 4);
    enc.copyBufferToBuffer(outQuar, 0, this.bufs.staging, statsBytes + this.n * 8, this.n * 4);
    // Roll the batch's final census into row 0 for the next batch. A direct
    // stats→stats copy is a WebGPU validation error (same src and dst buffer
    // invalidates the WHOLE command buffer — every dispatch above dies
    // silently), so bounce it through the one-row carry buffer.
    enc.copyBufferToBuffer(this.bufs.stats, n * STATS_STRIDE * 4, this.bufs.carry, 0, STATS_STRIDE * 4);
    enc.copyBufferToBuffer(this.bufs.carry, 0, this.bufs.stats, 0, STATS_STRIDE * 4);
    device.queue.submit([enc.finish()]);

    await this.bufs.staging.mapAsync(GPUMapMode.READ);
    const mapped = this.bufs.staging.getMappedRange();
    const stats = new Uint32Array(mapped.slice(0, statsBytes));
    const cells32 = new Uint32Array(mapped.slice(statsBytes, statsBytes + this.n * 4));
    const def32 = new Uint32Array(mapped.slice(statsBytes + this.n * 4, statsBytes + this.n * 8));
    const quar32 = new Uint32Array(mapped.slice(statsBytes + this.n * 8, statsBytes + this.n * 12));
    this.bufs.staging.unmap();

    // After this batch the current tick is startTick + n; a cell renders as
    // quarantined when its expiry is still active then.
    const nowTick = startTick + n;
    for (let i = 0; i < this.n; i++) {
      this.lastState[i] = cells32[i] & 0xff;
      this.lastDefenses[i] = def32[i] & 0xff;
      this.lastQuarantined[i] = quar32[i] > 0 && quar32[i] >= nowTick ? 1 : 0;
    }

    let last: SimStats | null = null;
    for (let r = 0; r < n; r++) {
      const row = stats.subarray(r * STATS_STRIDE, (r + 1) * STATS_STRIDE);
      this.tick = startTick + r + 1;
      last = this.assembleStats(row);
    }
    return last;
  }

  private assembleStats(row: Uint32Array): SimStats {
    const [s, e, i, r, d, newInfections, newInfectious, newDeaths, newRecovered, masked, vaccinated, quar] = row;
    const cfg = this.config;
    const maskEnabled = cfg.defenses[0]?.enabled === true;
    const vaxEnabled = cfg.defenses[1]?.enabled === true;
    const quarantineOn = cfg.quarantine.enabled === true;
    const ld = cfg.lockdown;
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
      s, e, i, r, d,
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
      s, e, i, r, d,
      reff,
      dnew: newDeaths,
      masked: maskEnabled ? masked : 0,
      vaccinated: vaxEnabled ? vaccinated : 0,
      quarantined: quarantineOn ? quar : 0,
      lockdownStringency,
      ecum: this.cumExposed,
      icum: this.cumInfectious,
      rcum: this.cumRecovered,
      dcum: this.cumDead,
    }, this.retiredCost);
    return stats;
  }

  buffers(): { state: Uint8Array; defenses: Uint8Array; quarantined: Uint8Array; size: number } {
    return {
      state: this.lastState,
      defenses: this.lastDefenses,
      quarantined: this.lastQuarantined,
      size: this.config.size,
    };
  }

  dispose(): void {
    this.destroyBuffers();
    this.device?.destroy();
  }
}

function emptyRetired(): RetiredCostTotals {
  return { ticks: 0, i: 0, dnew: 0, masked: 0, vaccinated: 0, quarantined: 0, lockdownStringency: 0 };
}
