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
      buildCpuEngine(config, topo, 'WebGPU not available in this browser');
      return;
    }
    if (!gpuCompatible(config)) {
      buildCpuEngine(config, topo, 'voronoi / mutation / reseed configs run on the CPU engines');
      return;
    }
    gpuChain = gpuChain
      .then(async () => {
        const g = await GpuEngine.create(config);
        // A newer rebuild may have raced us; only install if still current.
        if (currentConfig === config && requestedBackend === 'gpu') {
          gpu = g;
          postBackend('gpu');
          postFrame();
        } else {
          g.dispose();
        }
      })
      .catch(() => {
        if (currentConfig === config) buildCpuEngine(config, topo, 'WebGPU init failed');
      });
    return;
  }
  buildCpuEngine(config, topo);
}

function buildCpuEngine(config: SimConfig, topo: import('../types').VoronoiTopology | null, fallbackReason?: string): void {
  const wantWasm = requestedBackend !== 'cpu';
  engine = createEngine(config, topo, undefined, wantWasm);
  const active: EngineBackend = engine instanceof WasmEngine ? 'wasm' : 'cpu';
  let reason = fallbackReason;
  if (!reason && wantWasm && active === 'cpu') {
    reason = wasmCompatible(config) ? 'wasm unavailable in this browser' : 'voronoi / mutation configs run on the TS engine';
  }
  postBackend(active, reason);
  lastStats = null;
  lastLongTick = -1;
  postFrame();
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
      if (gpu) {
        const cfg = m.config;
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
        rebuild(m.config);
      } else {
        currentConfig = m.config;
        engine.patchConfig(m.config);
        postFrame();
      }
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
      // Backend switch is a structural change: rebuild (tick resets), paused.
      playing = false;
      if (currentConfig) rebuild(currentConfig);
      break;
    }
  }
};

export {};
