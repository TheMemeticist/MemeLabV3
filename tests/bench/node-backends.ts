// TypeScript vs WebAssembly on the shared protocol, for PLAIN Node — plus the
// tick-by-tick parity check that is what makes the ratio mean anything, and an
// optional grid-size sweep.
//
// Not graftable past the WASM commit (it imports `src/sim/wasm-engine.ts`);
// the ladder runs `node-ts.ts` on the older rungs instead.
//
// Never run through vite-node. See tests/README.md.
//
// Env knobs:
//   BENCH_GEOMETRIES / BENCH_SIZES / BENCH_REPS / BENCH_LABEL  (as node-ts.ts)
//   BENCH_SWEEP=1     also run the square-lattice grid-size sweep
//   BENCH_PARITY=0    skip the parity pass (it is on by default)

import {
  GEOMETRIES, PROTOCOL, benchConfig, formatResult, measure, measureTs, protocolBanner,
  type BenchResult, type Steppable,
} from './protocol';
import { Engine } from '../../src/sim/engine';
import { WasmEngine, wasmAvailable } from '../../src/sim/wasm-engine';
import type { GeometryType, SimStats } from '../../src/types';

const env = (k: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p && p.env ? p.env[k] : undefined;
};

const PARITY_TICKS = 501;
const SWEEP_SIZES = [64, 128, 256, 320, 512, 768, 1024, 1448, 2048];

const geometries: GeometryType[] = (env('BENCH_GEOMETRIES') || '').trim()
  ? (env('BENCH_GEOMETRIES') as string).split(',').map((s) => s.trim() as GeometryType)
  : GEOMETRIES;
const sizes: number[] = (env('BENCH_SIZES') || '').trim()
  ? (env('BENCH_SIZES') as string).split(',').map((s) => parseInt(s.trim(), 10))
  : [128, PROTOCOL.size];
const reps = parseInt(env('BENCH_REPS') || String(PROTOCOL.reps), 10);
const label = env('BENCH_LABEL') || 'HEAD';

function measureWasm(geometry: GeometryType, size: number): BenchResult {
  return measure('wasm', geometry, size, () => new WasmEngine(benchConfig(geometry, size)) as Steppable, reps);
}

/** First tick at which the two backends disagree on the full SimStats tuple,
 *  or -1 for parity across the whole window. A speedup can never come from the
 *  WASM core quietly doing less work without this reporting a tick index. */
function parityBreakTick(geometry: GeometryType, size: number): number {
  const ts = new Engine(benchConfig(geometry, size));
  const wa = new WasmEngine(benchConfig(geometry, size));
  const key = (s: SimStats): string => `${s.s},${s.e},${s.i},${s.r},${s.d},${s.newInfections},${s.newDeaths}`;
  for (let t = 0; t < PARITY_TICKS; t++) {
    if (key(ts.step()) !== key(wa.step())) return t;
  }
  return -1;
}

if (!wasmAvailable()) throw new Error('wasm core unavailable in this runtime');

console.log(protocolBanner(label));
console.log(`runtime: plain Node, ${env('BENCH_BUNDLER') || 'vite'} bundle (NOT vite-node)  engines: TypeScript + Rust/WASM`);
console.log('');

const doParity = (env('BENCH_PARITY') || '1') !== '0';
const results: BenchResult[] = [];
const pairs: Array<{ geometry: string; size: number; ts: number; wasm: number; ratio: number; parity: boolean | null }> = [];

for (const size of sizes) {
  for (const geometry of geometries) {
    const t = measureTs(geometry, size, reps);
    const w = measureWasm(geometry, size);
    results.push(t, w);
    const parity = doParity ? parityBreakTick(geometry, size) === -1 : null;
    pairs.push({ geometry, size, ts: t.ticksPerSec, wasm: w.ticksPerSec, ratio: w.ticksPerSec / t.ticksPerSec, parity });
    console.log(formatResult(t));
    console.log(formatResult(w));
    console.log(
      `      ${String(size).padStart(4)}²  ${geometry.padEnd(10)} WASM/TS ${(w.ticksPerSec / t.ticksPerSec).toFixed(2)}×  ` +
      `parity ${parity === null ? 'skipped' : parity ? `OK over ${PARITY_TICKS} ticks` : 'BROKEN'}`,
    );
  }
}

const sweep: Array<{ size: number; cells: number; ts: number; wasm: number }> = [];
if ((env('BENCH_SWEEP') || '') === '1') {
  console.log('');
  console.log('square-lattice grid-size sweep');
  for (const size of SWEEP_SIZES) {
    const t = measureTs('square', size, reps);
    const w = measureWasm('square', size);
    const cells = size * size;
    sweep.push({ size, cells, ts: t.ticksPerSec, wasm: w.ticksPerSec });
    console.log(
      `${String(size).padStart(4)}²  ${String(cells).padStart(8)} cells  ` +
      `TS ${t.ticksPerSec.toFixed(1).padStart(9)} t/s (${((t.ticksPerSec * cells) / 1e6).toFixed(1)} Mcell/s)  ` +
      `WASM ${w.ticksPerSec.toFixed(1).padStart(9)} t/s (${((w.ticksPerSec * cells) / 1e6).toFixed(1)} Mcell/s)`,
    );
  }
}

console.log(`##BENCH_JSON## ${JSON.stringify({ label, runtime: 'node', protocol: PROTOCOL, parityTicks: doParity ? PARITY_TICKS : 0, results, pairs, sweep })}`);

if (pairs.some((pair) => pair.parity === false)) {
  throw new Error('CPU/WASM parity failed; benchmark results are not valid for comparison');
}
