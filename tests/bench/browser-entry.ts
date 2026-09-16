// The same protocol, in a real browser page — the only place the SHIPPED
// WebGPU engine (`src/sim/gpu-engine.ts`) can be measured at all, and the only
// place any of these numbers reflects the runtime the app actually ships to.
//
// Bundled to an IIFE by `tests/bench/run-browser.mjs`, served over
// http://127.0.0.1 (WebGPU needs a secure context; localhost counts) and driven
// with a headed Chrome. It exposes one global:
//
//   await window.memelabBench({ backends, geometries, sizes, reps, label })
//
// returning the same result shape the Node entries print, so both runtimes feed
// one dataset.
//
// GPU note: `GpuEngine` is async and batches up to 2,048 ticks per submit, so
// it cannot implement the sync `Steppable` interface. It is timed by the SAME
// protocol — build, run the warm-up ticks off the clock, then time the measured
// ticks including the readback that makes the census available. A batched
// dispatch whose result is never read back is not a tick rate.

import {
  GEOMETRIES, PROTOCOL, benchConfig, measure, measureTs, measureTsSplit,
  type BenchResult, type Census, type Steppable,
} from './protocol';
import { WasmEngine, wasmAvailable } from '../../src/sim/wasm-engine';
import { GpuEngine, gpuSupported } from '../../src/sim/gpu-engine';
import type { GeometryType } from '../../src/types';

export interface BenchRequest {
  backends?: string[];
  geometries?: string[];
  sizes?: number[];
  reps?: number;
  label?: string;
  split?: boolean;
}

export interface BenchReport {
  label: string;
  runtime: 'browser';
  userAgentBrand: string;
  adapter: { vendor: string; architecture: string; device: string; description: string } | null;
  softwareAdapter: boolean;
  protocol: typeof PROTOCOL;
  results: BenchResult[];
  splits: BenchResult[];
  errors: string[];
}

/** The GPU tier, on the shared protocol. Best-of-N like every other backend. */
async function measureGpu(geometry: GeometryType, size: number, reps: number): Promise<BenchResult> {
  const samples: number[] = [];
  let bestRate = 0;
  let bestMs = 0;
  let census: Census = { s: 0, e: 0, i: 0, r: 0, d: 0 };
  let stable = true;
  let first = true;

  for (let rep = 0; rep < reps; rep++) {
    const engine = await GpuEngine.create(benchConfig(geometry, size));
    try {
      await engine.run(PROTOCOL.warmupTicks);
      const t0 = performance.now();
      const last = await engine.run(PROTOCOL.measureTicks);
      const totalMs = performance.now() - t0;
      if (last === null) throw new Error('gpu run returned no stats');
      const c: Census = { s: last.s, e: last.e, i: last.i, r: last.r, d: last.d };
      const rate = (PROTOCOL.measureTicks / totalMs) * 1000;
      samples.push(rate);
      if (first) { census = c; first = false; }
      else if (c.s !== census.s || c.e !== census.e || c.i !== census.i || c.r !== census.r || c.d !== census.d) stable = false;
      if (rate > bestRate) { bestRate = rate; bestMs = totalMs / PROTOCOL.measureTicks; }
    } finally {
      engine.dispose();
    }
  }

  return {
    backend: 'gpu', geometry, size, reps,
    ticksPerSec: bestRate, msPerTick: bestMs, samples, census, censusStable: stable, split: null,
  };
}

async function adapterInfo(): Promise<{ info: BenchReport['adapter']; software: boolean }> {
  if (!gpuSupported()) return { info: null, software: false };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { info: null, software: false };
  const i = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  const info = {
    vendor: i?.vendor ?? '',
    architecture: i?.architecture ?? '',
    device: i?.device ?? '',
    description: i?.description ?? '',
  };
  const blob = `${info.vendor} ${info.architecture} ${info.description}`.toLowerCase();
  const software = /swiftshader|llvmpipe|software/.test(blob)
    || (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter === true;
  return { info, software };
}

async function runBench(req: BenchRequest): Promise<BenchReport> {
  const backends = req.backends ?? ['ts'];
  const geometries = (req.geometries ?? GEOMETRIES) as GeometryType[];
  const sizes = req.sizes ?? [PROTOCOL.size];
  const reps = req.reps ?? PROTOCOL.reps;
  const { info, software } = await adapterInfo();

  const report: BenchReport = {
    label: req.label ?? 'HEAD',
    runtime: 'browser',
    userAgentBrand: 'chromium',
    adapter: info,
    softwareAdapter: software,
    protocol: PROTOCOL,
    results: [],
    splits: [],
    errors: [],
  };

  for (const size of sizes) {
    for (const geometry of geometries) {
      for (const backend of backends) {
        try {
          if (backend === 'ts') {
            report.results.push(measureTs(geometry, size, reps));
          } else if (backend === 'wasm') {
            if (!wasmAvailable()) throw new Error('wasm core unavailable');
            report.results.push(measure('wasm', geometry, size, () => new WasmEngine(benchConfig(geometry, size)) as Steppable, reps));
          } else if (backend === 'gpu') {
            if (software) throw new Error('software WebGPU adapter — numbers would be meaningless');
            report.results.push(await measureGpu(geometry, size, reps));
          } else {
            throw new Error(`unknown backend ${backend}`);
          }
        } catch (err) {
          report.errors.push(`${backend} ${geometry} ${size}²: ${(err as Error).message}`);
        }
      }
      // Yield to the event loop so a long sweep does not trip the page's
      // unresponsive-script watchdog.
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  if (req.split === true) {
    for (const size of sizes) {
      for (const geometry of geometries) {
        report.splits.push(measureTsSplit(geometry, size));
      }
    }
  }

  return report;
}

declare global {
  interface Window {
    memelabBench: (req: BenchRequest) => Promise<BenchReport>;
  }
}

window.memelabBench = runBench;
