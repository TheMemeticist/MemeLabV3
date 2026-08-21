/// <reference lib="webworker" />
import type { EngineBackend, FrameMessage, SimConfig, TopologyMessage, WorkerCommand } from '../types';
import { buildVoronoi } from '../sim/voronoi';
import { Rng } from '../sim/rng';
import { WasmEngine, createEngine, wasmAvailable, wasmCompatible, type AnyEngine } from '../sim/wasm-engine';
import { GpuEngine, gpuCompatible, gpuSupported } from '../sim/gpu-engine';

declare const self: DedicatedWorkerGlobalScope;

// ── Backend selection ────────────────────────────────────────────────────────
// `requested` is the user's preference (UI toggle; default wasm — it is
// bit-identical to the TS engine, just faster, so switching it on silently is
// safe). The worker falls back gpu → wasm → cpu per config/runtime support and
// reports what actually runs via a `backend` message.
let requestedBackend: EngineBackend = wasmAvailable() ? 'wasm' : 'cpu';

let engine: AnyEngine | null = null; // cpu / wasm backends (synchronous)
let gpu: GpuEngine | null = null; // gpu backend (asynchronous)
// All GPU work is serialized through this chain — commands never interleave
// with an in-flight batch.
let gpuChain: Promise<void> = Promise.resolve();
let currentConfig: SimConfig | null = null;
// Fitted R(t) transmission schedule (per-tick multiplier) from the estimator's
// Apply. Stored here and handed to the engine as EngineOptions at the next
// rebuild — the sender always follows setSchedule with a reset/init.
let txSchedule: number[] | null = null;

let playing = false;
let tps = 30;
let scheduled = false;
let lastFrame = 0;
let lastPost = 0;
let lastStats: import('../types').SimStats | null = null;
// Tick through which the UI's long-history mirror is up to date. -1 forces the
// next post to carry a full snapshot (new engine / reset).
let lastLongTick = -1;

// The sim steps at full `tps` for determinism, but visual frames are only
// useful up to display refresh. Cap posted frames at ~60/s so high speeds
// don't flood the UI thread with repaints it can't keep up with.
const POST_INTERVAL = 1000 / 60;
// GPU batch bound per loop turn (matches GpuEngine's stats window).
const GPU_MAX_BATCH = 2048;

function activeSource(): AnyEngine | GpuEngine | null {
  return gpu ?? engine;
}

function postBackend(active: EngineBackend, reason?: string): void {
  self.postMessage({ type: 'backend', active, requested: requestedBackend, reason });
}

function postFrame(): void {
  const src = activeSource();
  if (!src) return;
  const { state, defenses, quarantined, size } = src.buffers();
  // Copy buffers so we can transfer ownership without losing the engine state.
  const stateCopy = new Uint8Array(state);
  const defCopy = new Uint8Array(defenses);
  // Only send the quarantine buffer when there's at least one quarantined cell —
  // saves a per-frame transfer when the intervention is unused.
  let qCopy: Uint8Array | null = null;
  for (let i = 0; i < quarantined.length; i++) {
    if (quarantined[i]) { qCopy = new Uint8Array(quarantined); break; }
  }
  const stats = lastStats
    ? lastStats
    : { tick: 0, s: size * size, e: 0, i: 0, r: 0, d: 0, newInfections: 0, newDeaths: 0, reff: 0, strains: 1 };

  const msg: FrameMessage = {
    type: 'frame',
    tick: src.tick,
    state: stateCopy,
    defenses: defCopy,
    quarantined: qCopy,
    size,
    stats,
    retiredCost: { ...src.retiredCost },
    rNaught: src.rNaught,
  };
  // Send only the rows the UI hasn't seen; fall back to a full snapshot after
  // a rebuild/reset or if more ticks elapsed than the window still holds.
  const newRows = src.tick - lastLongTick;
  if (lastLongTick < 0 || newRows < 0 || newRows > src.history.length) {
    msg.longFull = src.history.toLongStats();
  } else {
    msg.longDelta = src.history.lastRows(newRows);
  }
  lastLongTick = src.tick;
  const transfer: Transferable[] = [stateCopy.buffer, defCopy.buffer];
  if (qCopy) transfer.push(qCopy.buffer);
  self.postMessage(msg, transfer);
}

// Build topology once and share it:
// - pass to Engine so it skips its own buildVoronoi call
// - post to main thread via structured clone (no transfer; engine keeps its refs)
//
// We also cache the most recent build by a key derived from every parameter
// that affects topology (seed + size + voronoi sub-config). Reset (R key) and
// rebuilds that don't actually change topology (e.g. a strain-gene change that
// somehow still slipped through) reuse the cached graph, which is the dominant
// cost on large voronoi grids.
let cachedTopo: import('../types').VoronoiTopology | null = null;
let cachedTopoKey: string | null = null;

function topologyKey(c: SimConfig): string {
  const v = c.voronoiConfig ?? { mode: 'jittered', irregularity: 0.5 };
  return `${c.seed}|${c.size}|${v.mode}|${v.irregularity}`;
}

function buildAndPostTopology(config: SimConfig): import('../types').VoronoiTopology | null {
  if ((config.geometry ?? 'square') !== 'voronoi') {
    cachedTopo = null;
    cachedTopoKey = null;
    return null;
  }
  const key = topologyKey(config);
  if (cachedTopo && cachedTopoKey === key) {
    // Re-post so the main thread can rehydrate after a geometry toggle without
    // paying the build cost again.
    self.postMessage({ type: 'topology', topo: cachedTopo } satisfies TopologyMessage);
    return cachedTopo;
  }
  const n = config.size * config.size;
  const topoRng = new Rng(config.seed ^ 0x564f524f);
  // withPolygons:false — the renderer uses a centroid LUT and color-tint
  // quarantine, never reading polyVerts/polyOffsets for voronoi. The polygon
  // build (per-triangle circumcenter + per-cell dedup + atan2 sort) is the
  // biggest avoidable cost in buildVoronoi.
  const topo = buildVoronoi(n, config.voronoiConfig, topoRng, false);
  cachedTopo = topo;
  cachedTopoKey = key;
  const msg: TopologyMessage = { type: 'topology', topo };
  self.postMessage(msg); // structured clone — engine's typed array refs stay valid
  return topo;
}

function disposeGpu(): void {
  const g = gpu;
  gpu = null;
  if (g) gpuChain = gpuChain.then(() => g.dispose()).catch(() => {});
}

/** Why this config can't run on the wasm engine — names the feature AND the
 *  fix, because a bare "CPU" label reads as a broken toggle. */
function wasmBlockReason(_config: SimConfig): string {
  return '🧬 natural selection is multi-strain — CPU engine only. Turn 🧬 off to use WASM/GPU';
}

function gpuBlockReason(config: SimConfig): string {
  if (config.mutate === true) return wasmBlockReason(config);
  return 'extinction reseed runs on the CPU engines — disable it to use GPU';
}

function gpuInitFailReason(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? '');
  if (/software/i.test(msg)) {
    return 'only a software WebGPU adapter (SwiftShader) is available — enable chrome://flags/#enable-vulkan and relaunch to use your real GPU';
  }
  if (/adapter/i.test(msg)) {
    return 'no GPU adapter — on Linux Chrome enable chrome://flags/#enable-vulkan and relaunch';
  }
  return `WebGPU init failed (${msg || 'unknown error'})`;
}

/** Availability probe for the engine picker menu — the worker is the single
 *  authority on what can actually run, so the menu asks it rather than
 *  guessing. Checks runtime support AND the current config's gates; the GPU
 *  check goes as far as acquiring a real adapter (refusing software ones). */
async function probeBackends(): Promise<void> {
  const cfg = currentConfig;
  const wasm: import('../types').BackendAvailability = !wasmAvailable()
    ? { ok: false, reason: 'WebAssembly unavailable in this browser' }
    : cfg && !wasmCompatible(cfg)
      ? { ok: false, reason: wasmBlockReason(cfg) }
      : { ok: true };
  let gpuAvail: import('../types').BackendAvailability;
  if (!gpuSupported()) {
    gpuAvail = {
      ok: false,
      reason: self.isSecureContext
        ? 'WebGPU not available in this browser'
        : 'WebGPU needs a secure origin — open the app over HTTPS (or localhost)',
    };
  } else if (cfg && !gpuCompatible(cfg)) {
    gpuAvail = { ok: false, reason: gpuBlockReason(cfg) };
  } else {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        gpuAvail = { ok: false, reason: 'no GPU adapter — on Linux Chrome enable chrome://flags/#enable-vulkan and relaunch' };
      } else {
        const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
        const softId = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.description ?? ''}`.toLowerCase();
        gpuAvail = /swiftshader|llvmpipe|software/.test(softId)
          ? { ok: false, reason: 'only a software adapter (SwiftShader) — enable chrome://flags/#enable-vulkan and relaunch to use your real GPU' }
          : { ok: true };
      }
    } catch (err) {
      gpuAvail = { ok: false, reason: gpuInitFailReason(err) };
    }
  }
  self.postMessage({ type: 'backendProbe', wasm, gpu: gpuAvail } satisfies import('../types').BackendProbeMessage);
}

/** After a (re)build, resume the right loop if the user was playing. */
function resumeIfPlaying(): void {
  if (!playing) return;
  lastFrame = performance.now();
  lastPost = 0;
  if (gpu) {
    scheduleGpuLoop(0);
  } else if (engine && !scheduled) {
    scheduled = true;
    setTimeout(loop, 0);
  }
}

/** (Re)build the simulation for `config` under the requested backend, with
 *  automatic fallback gpu → wasm → cpu. */
function rebuild(config: SimConfig): void {
  currentConfig = config;
  const topo = buildAndPostTopology(config);
  disposeGpu();
  engine = null;
  lastStats = null;
  lastLongTick = -1;
  lastFrame = performance.now();

  if (requestedBackend === 'gpu') {
    if (!gpuSupported()) {
      // WebGPU is a secure-context API: on a plain-http origin navigator.gpu
      // does not exist at all, and no browser flag can change that.
      buildCpuEngine(config, topo, self.isSecureContext
        ? 'WebGPU not available in this browser'
        : 'WebGPU needs a secure origin — open the app over HTTPS (or localhost)');
      return;
    }
    if (!gpuCompatible(config)) {
      buildCpuEngine(config, topo, gpuBlockReason(config));
      return;
    }
    gpuChain = gpuChain
      .then(async () => {
        const g = await GpuEngine.create(config, topo, txSchedule);
        // A newer rebuild may have raced us; only install if still current.
        if (currentConfig === config && requestedBackend === 'gpu') {
          gpu = g;
          postBackend('gpu');
          postFrame();
          resumeIfPlaying();
        } else {
          g.dispose();
        }
      })
      .catch((err) => {
        if (currentConfig === config) buildCpuEngine(config, topo, gpuInitFailReason(err));
      });
    return;
  }
  buildCpuEngine(config, topo);
}

function buildCpuEngine(config: SimConfig, topo: import('../types').VoronoiTopology | null, fallbackReason?: string): void {
  const wantWasm = requestedBackend !== 'cpu';
  engine = createEngine(config, topo, txSchedule ? { txSchedule } : undefined, wantWasm);
  const active: EngineBackend = engine instanceof WasmEngine ? 'wasm' : 'cpu';
  let reason = fallbackReason;
  if (wantWasm && active === 'cpu') {
    const wasmWhy = wasmCompatible(config) ? 'wasm unavailable in this browser' : wasmBlockReason(config);
    reason = reason ? `${reason}; ${wasmWhy}` : wasmWhy;
  }
  postBackend(active, reason);
  lastStats = null;
  lastLongTick = -1;
  postFrame();
  resumeIfPlaying();
}

// ── CPU/WASM loop (synchronous stepping, tps-paced) ──────────────────────────

function loop(): void {
  scheduled = false;
  if (!playing || !engine) return;
  const now = performance.now();
  const interval = 1000 / Math.max(1, tps);
  let steps = 0;
  // Catch-up: at most 4 steps per tick to bound stall recovery.
  while (now - lastFrame >= interval && steps < 4) {
    lastStats = engine.step();
    lastFrame += interval;
    steps++;
  }
  if (steps > 0 && now - lastPost >= POST_INTERVAL) {
    postFrame();
    lastPost = now;
  }
  if (!scheduled) {
    scheduled = true;
    setTimeout(loop, Math.max(4, interval / 4));
  }
}

// ── GPU loop (asynchronous batches through gpuChain) ─────────────────────────

let gpuLoopScheduled = false;

function scheduleGpuLoop(delay: number): void {
  if (gpuLoopScheduled) return;
  gpuLoopScheduled = true;
  setTimeout(gpuLoop, delay);
}

function gpuLoop(): void {
  gpuLoopScheduled = false;
  if (!playing || !gpu) return;
  const now = performance.now();
  const interval = 1000 / Math.max(1, tps);
  let due = Math.floor((now - lastFrame) / interval);
  if (due > GPU_MAX_BATCH) {
    // Deep stall: drop the backlog instead of replaying it.
    lastFrame = now - GPU_MAX_BATCH * interval;
    due = GPU_MAX_BATCH;
  }
  if (due > 0) {
    lastFrame += due * interval;
    gpuChain = gpuChain
      .then(async () => {
        if (!gpu) return;
        const s = await gpu.run(due);
        if (s) lastStats = s;
        const t = performance.now();
        if (t - lastPost >= POST_INTERVAL) {
          postFrame();
          lastPost = t;
        }
      })
      .catch(() => {})
      .finally(() => {
        if (playing && gpu) scheduleGpuLoop(Math.max(4, interval / 4));
      });
  } else {
    scheduleGpuLoop(Math.max(4, interval / 4));
  }
}

self.onmessage = (ev: MessageEvent<WorkerCommand>) => {
  const m = ev.data;
  switch (m.cmd) {
    case 'init':
    case 'updateConfig': {
      rebuild(m.config);
      break;
    }
    case 'reset': {
      playing = false;
      rebuild(m.config);
      break;
    }
    case 'patchConfig': {
      const cfg = m.config;
      // Soft params can cross a backend's compatibility boundary (the 🧬
      // mutate toggle is a patch): an engine that can't represent the patched
      // config MUST be rebuilt — a wasm/gpu engine would otherwise keep
      // running silently single-strain. The reverse crossing also rebuilds,
      // so turning the blocker off restores the requested fast backend
      // instead of leaving the sim stuck on CPU until the next reset.
      const downgrade =
        (gpu !== null && !gpuCompatible(cfg)) ||
        (engine instanceof WasmEngine && !wasmCompatible(cfg));
      const upgrade =
        gpu === null &&
        engine !== null &&
        !(engine instanceof WasmEngine) &&
        requestedBackend !== 'cpu' &&
        currentConfig !== null &&
        (requestedBackend === 'gpu'
          ? gpuSupported() && gpuCompatible(cfg) && !gpuCompatible(currentConfig)
          : wasmAvailable() && wasmCompatible(cfg) && !wasmCompatible(currentConfig));
      if (downgrade || upgrade) {
        rebuild(cfg);
        break;
      }
      if (gpu) {
        currentConfig = cfg;
        gpuChain = gpuChain
          .then(async () => {
            if (!gpu) return;
            await gpu.patchConfig(cfg);
            postFrame();
          })
          .catch(() => {});
        break;
      }
      if (!engine) {
        rebuild(cfg);
      } else {
        currentConfig = cfg;
        engine.patchConfig(cfg);
        postFrame();
      }
      break;
    }
    case 'setSchedule': {
      // Stored only — the sender always follows with a reset/init, which is
      // where the engine actually picks it up (schedules start at day 0).
      txSchedule = m.schedule && m.schedule.length > 0 ? m.schedule : null;
      break;
    }
    case 'probeBackends': {
      void probeBackends();
      break;
    }
    case 'play': {
      tps = m.tps;
      playing = true;
      lastFrame = performance.now();
      lastPost = 0; // post the first frame of this run immediately
      if (gpu) {
        scheduleGpuLoop(0);
      } else if (engine && !scheduled) {
        scheduled = true;
        setTimeout(loop, 0);
      }
      break;
    }
    case 'pause': {
      playing = false;
      // Flush the exact stopped state — the throttled loop may have skipped
      // posting the last few steps (or a GPU batch may still be in flight).
      if (gpu) {
        gpuChain = gpuChain.then(() => postFrame()).catch(() => {});
      } else if (engine) {
        postFrame();
      }
      break;
    }
    case 'step': {
      const n = Math.max(1, m.n);
      if (gpu) {
        gpuChain = gpuChain
          .then(async () => {
            if (!gpu) return;
            const s = await gpu.run(n);
            if (s) lastStats = s;
            postFrame();
          })
          .catch(() => {});
      } else if (engine) {
        for (let k = 0; k < n; k++) lastStats = engine.step();
        postFrame();
      }
      break;
    }
    case 'setBackend': {
      if (m.backend === requestedBackend) {
        break;
      }
      requestedBackend = m.backend;
      // Backend switch is a structural change: rebuild (the run restarts from
      // tick 0) but keep playing so the toggle feels alive.
      if (currentConfig) rebuild(currentConfig);
      break;
    }
  }
};

export {};
