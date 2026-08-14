# WebAssembly plan

Scope note: this covers the Rust/WASM half of the proposal's "WebGPU + Rust/WASM" claim. WebGPU is a rendering concern and is planned separately — the two are independent and should not be bundled into one decision.

## 1. Position

WASM is a **benchmark-gated spike (~30 hrs, Phase 4)**, not a committed deliverable. The roadmap's stated risk is that a full Rust port eats 150–200 hrs and forks the determinism invariant across two implementations. The plan below is built so that "we profiled it and optimized TypeScript instead" is a legitimate, documented outcome — not a failure.

**Non-goal:** porting the whole `Engine`. TypeScript stays the reference implementation permanently.

## 2. Prerequisite — the benchmark (must exist first)

Phase 0 calls for a perf harness and it does not exist yet (`package.json` has no `bench` script, `tests/` has no benchmark file). Nothing else in this plan can start without it.

- Headless tick-rate benchmark, 320×320, one number per geometry (`square`, `triangular`, `hexagonal`, `voronoi`, `meanfield`).
- Runnable as `npm run bench`, checked into `tests/`, baseline number committed.
- Report ticks/sec **and** a coarse split of time between the transmission pass, quarantine pass, and life-cycle pass. The split is what makes the gate decision, not the total.

## 3. The gate

Profile against the baseline, then answer one question: **is `stepSpatial()` the binding constraint at target grid sizes?**

Go to WASM only if all three hold:

1. The transmission pass is >60% of frame time at 320×320 (i.e. the sim, not the renderer or `postMessage`, is the bottleneck).
2. Cheap TS optimizations have already been tried and measured — hoisting the defense-multiplier lookups out of the neighbor loop, flattening `getOffsets()` access, avoiding recomputation of per-cell multipliers that are constant across the inner loop.
3. A throwaway prototype of the transmission pass alone shows **≥2×** over the optimized TS. Below 2×, the maintenance cost of a second implementation is not repaid.

If any fail: spend the hours on the TS hot loop, write the decision and the numbers into this file, and close the item. That is the expected outcome and it satisfies the proposal honestly.

## 4. If the gate passes — approach

**Toolchain:** Rust + `wasm-bindgen` + `wasm-pack`, integrated via `vite-plugin-wasm`. Rust over AssemblyScript because the codon/phylogeny work in Phase 3 is the other plausible WASM consumer and benefits from real crates.

**Port surface — only these, in this order:**

1. `Rng` (xoshiro128** + splitmix32) — pure integer ops, ports bit-exactly.
2. The transmission pass inner loop of `stepSpatial()`.
3. The life-cycle pass, only if step 2 lands and profiling still justifies it.

Everything else — config resolution, geometry construction, Voronoi/Delaunay, stats, the worker protocol — stays in TypeScript.

**Memory:** WASM operates on views into its own linear memory; `PopulationBuffers` is allocated there and the TS side holds `Uint8Array`/`Uint16Array` views over it. No per-tick copying. Geometry offset caches are copied in once at init and treated as immutable on both sides (the existing neighbor-cache invariant).

**Determinism strategy** — this is the whole risk and it gets handled explicitly:

- The RNG traversal order must match exactly. Same call sequence, same order of neighbor iteration, same short-circuit conditions.
- `bernoulli()` and `gaussian()` must use the identical algorithm, not merely an equivalent distribution. Gaussian in particular: match the exact transform and the cached-second-sample behavior.
- Floating-point: keep all per-cell math in `f64` to match JS number semantics. No SIMD in the first pass — SIMD reorders accumulation and is a separate, later gate.
- **Cross-implementation golden test:** run TS and WASM engines side by side from the same `SimConfig` and assert identical `SimStats` on every tick for N ticks, across all geometries and a spread of seeds. This test is the deliverable, as much as the speedup is.

**Runtime integration:**

- WASM lives behind a flag in `sim.worker.ts` with the TS path as fallback. If instantiation fails, the sim runs — no blank screen.
- The `.wasm` asset must resolve under `VITE_BASE=/MemeLabV3/`; verify against `npm run preview` on the production-matching build, not just dev.
- Add the flag to `types.ts`, `needsRebuild()` in `App.ts`, and both `encode()`/`applyEncoded()` in `url-state.ts` if it is user-visible. If it is a build-time constant instead, say so and skip the permalink work — decide this before writing the flag.

## 5. Kill criteria

Stop and revert to TS if any of these hit:

- The golden test cannot be made to pass within ~8 hrs of the port landing.
- The measured end-to-end speedup at 320×320 is under 2× after integration overhead.
- The build stops working on GitHub Pages and the fix is not obvious.

## 6. Gate result — measured 2026-08-13

The benchmark (`npm run bench`, `tests/bench.ts`) and the cheap-TS-optimization
round both exist now. Numbers from a 320×320 endemic-steady-state workload
(fixed seed, identical trajectory across all variants; node v22), 300 measured
ticks after 200 warmup:

| geometry | baseline t/s | after TS wins | speedup | transmission share (after) |
|---|---|---|---|---|
| square | 97.7 | 132.7 | 1.36× | 17.5% |
| triangular | 108.2 | 140.9 | 1.30× | 16.1% |
| hexagonal | 86.8 | 123.7 | 1.42× | 19.6% |
| voronoi | 90.0 | 108.2 | 1.20× | 21.2% |
| meanfield | 70.3 | 90.7 | 1.29× | 44.4% |

Per-win contributions (square unless noted): defense-multiplier bitmask tables
+2–10% (largest on voronoi/meanfield); `baseAttack*srcMul` hoist ≈0% (V8 had
already hoisted it); interior torus fast path −18…−26% off the transmission
pass itself (1.68→1.38 ms/tick square, 2.23→1.66 hex) but small end-to-end;
folding the S/E/I/R/D census into the life-cycle pass (with an indexed
`Int32Array` census instead of a `switch`) +30…+35% — the single biggest win;
ring-buffered history + delta frame posts: no tick-rate change, but the
per-posted-frame long-history cost fell ~150 µs → ~6 µs (~25×), and the old
16×`Array.shift()` window slide is now O(1) (it measured only ~2 µs/tick, so
that half was already cheap).

**Gate criterion 1 fails decisively: the transmission pass is 16–21% of tick
time on spatial geometries (44% on mean-field), nowhere near the >60% bar.**
The binding constraint is the life-cycle pass (~70% of tick time after the
stats fold). By Amdahl, even an infinitely fast WASM transmission pass would
buy at most ~1.25× end-to-end. Criterion 2 is satisfied (the cheap TS wins are
applied and measured). Criterion 3 was therefore not attempted.

**Decision: no WASM port.** The TS hot loop was optimized instead — the
documented "optimize TypeScript and close the item" outcome from §1.

### Round 2 — life-cycle pass (same day)

V8 tick profiling (`node --prof`) on the life-cycle-dominated profile found the
actual engine bottleneck: **esbuild does not inline cross-module `const enum`
members** (isolatedModules semantics), so every `CellState.*` comparison in the
hot loops — plus the per-cell `this.tick` read — compiled to a runtime property
load. `Builtin: LoadIC` alone was ~36% of all CPU ticks. Hoisting the enum
values and `this.tick` into per-step locals (plus a single-strain fast path
that skips `strains.get()` per cell while the pool holds only strain 0, an
interior fast path in `neighborAliveFraction`, and dropping the never-read
per-cell `age` increment) gave:

| geometry | original baseline | final | end-to-end speedup |
|---|---|---|---|
| square | 97.7 t/s | 373 t/s | **3.8×** |
| triangular | 108.2 | 432 | **4.0×** |
| hexagonal | 86.8 | 328 | **3.8×** |
| voronoi | 90.0 | 307 | **3.4×** |
| meanfield | 70.3 | 182 | **2.6×** |

Outputs remained bit-identical to the pre-optimization engine throughout (same
end-state on every geometry at the same seed; all 70 tests green). One
attempted micro-optimization was measured and reverted: a branchless
mask/vaccine census via lookup tables was ~6% *slower* than the existing
well-predicted branches.

Post-round splits: life-cycle is still ~66–73% of tick time on spatial
geometries (everything scaled down together), and mean-field's transmission
pass now sits at ~59% (its `Math.pow` global-mixing loop). The same
cross-module const-enum cost likely applies to the renderer's per-cell
`CellState` reads in `Petri.ts` — unmeasured, worth checking if UI-thread
paint ever profiles hot.

## 7. Exit

Either: a committed benchmark showing ≥2× with a green cross-implementation determinism test and a working fallback path — or a committed benchmark, a documented profiling result, and an optimized TS transmission pass. Both are shippable answers. Only "we started a Rust port and left it half-done" is not.
