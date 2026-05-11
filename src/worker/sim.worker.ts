/// <reference lib="webworker" />
import { Engine } from '../sim';
import type { FrameMessage, SimConfig, WorkerCommand } from '../types';

declare const self: DedicatedWorkerGlobalScope;

let engine: Engine | null = null;
let playing = false;
let tps = 30;
let scheduled = false;
let lastFrame = 0;
let lastStats: import('../types').SimStats | null = null;

function ensure(config?: SimConfig): Engine {
  if (engine) return engine;
  if (!config) throw new Error('engine not initialized');
  engine = new Engine(config);
  return engine;
}

function postFrame(): void {
  if (!engine) return;
  const { state, defenses, quarantined, size } = engine.buffers();
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
    : { tick: 0, s: size * size, e: 0, i: 0, r: 0, d: 0, newInfections: 0, reff: 0, strains: 1 };

  const msg: FrameMessage = {
    type: 'frame',
    tick: engine.tick,
    state: stateCopy,
    defenses: defCopy,
    quarantined: qCopy,
    size,
    stats,
    longStats: cloneLong(engine.longStats),
    rNaught: engine.rNaught,
  };
  const transfer: Transferable[] = [stateCopy.buffer, defCopy.buffer];
  if (qCopy) transfer.push(qCopy.buffer);
  self.postMessage(msg, transfer);
}

function cloneLong<T>(long: T): T {
  // structuredClone preserves arrays without prototype tricks.
  return structuredClone(long);
}

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
  if (steps > 0) postFrame();
  if (!scheduled) {
    scheduled = true;
    setTimeout(loop, Math.max(4, interval / 4));
  }
}

self.onmessage = (ev: MessageEvent<WorkerCommand>) => {
  const m = ev.data;
  switch (m.cmd) {
    case 'init': {
      engine = new Engine(m.config);
      lastFrame = performance.now();
      lastStats = null;
      postFrame();
      break;
    }
    case 'reset': {
      engine = new Engine(m.config);
      lastFrame = performance.now();
      playing = false;
      lastStats = null;
      postFrame();
      break;
    }
    case 'updateConfig': {
      // Hard update: rebuild for changes that alter sim shape (size, seed,
      // strain genes). Resets RNG trajectory + population.
      engine = new Engine(m.config);
      lastFrame = performance.now();
      lastStats = null;
      postFrame();
      break;
    }
    case 'patchConfig': {
      // Soft update: change intervention / defense parameters mid-run without
      // a reset. Engine applies minimal stochastic adjustment.
      if (!engine) engine = new Engine(m.config);
      else engine.patchConfig(m.config);
      postFrame();
      break;
    }
    case 'play': {
      ensure();
      tps = m.tps;
      playing = true;
      lastFrame = performance.now();
      if (!scheduled) {
        scheduled = true;
        setTimeout(loop, 0);
      }
      break;
    }
    case 'pause': {
      playing = false;
      break;
    }
    case 'step': {
      const e = ensure();
      const n = Math.max(1, m.n);
      for (let k = 0; k < n; k++) lastStats = e.step();
      postFrame();
      break;
    }
  }
};

export {};
