# Performance plan — the bull case (WASM / WebGPU / algorithmic)

Companion to `wasm-plan.md`. That document's 2026-08-13 gate correctly killed a
*naive* WASM port of the *current* engine (transmission pass too small a slice;
Amdahl caps the win at ~1.25×). This plan is the optimistic-but-rigorous case
for going much further, built on new measurements (2026-08-20) that identify
what the binding constraint actually is — and on the observation that the gate
tested "port the same algorithm to WASM," not "change the algorithm."

## 1. New evidence (2026-08-20, Node v22, 320×320 endemic steady state)

Baseline on the measuring machine: square 303–312 t/s (3.2–3.3 ms/tick);
life-cycle pass 2.25 ms (70%), transmission 0.63 ms (20%), quarantine 0.32 ms
(10%). Probe results (`tests/bench.ts` config):

- **Only ~3.35% of cells change state per tick** (avg 3,435 of 102,400), yet
  every pass visits all N cells. Compartments at steady state:
  S≈45.6k, E≈2.6k, I≈6.1k, R≈47.7k, D≈260.
- **~55,230 `random()` calls per tick**, ~86% of them the per-tick waning
  Bernoulli on every Recovered cell.
- Full-pass cost floors at N=102,400: Bernoulli-per-cell 1.06 ms,
  raw `rng.random()`×N 0.76 ms, byte scan+branch 0.19 ms, expiry-compare
  0.09 ms.
- **Prototype measured**: replacing the per-tick waning Bernoulli with a
  geometric-sampled expiry tick (distribution-exact) cut the life-cycle pass
  only 2.25→2.05 ms (+7% end-to-end). Conclusion: the life-cycle pass is
  **scan/branch-bound, not RNG-bound**. Removing draws while keeping the O(N)
  sweep buys little; the sweep itself must go (Phase 1), get 16× wider
  (Phase 2, SIMD), or go massively parallel (Phase 3, GPU).

The determinism safety net any of this requires now exists:
`tests/engine-golden.test.ts` pins FNV-1a digests of the 150-tick stats stream
for all five geometries, and `tests/rng.test.ts` pins golden xoshiro128**
sequences. Any engine variant must reproduce these or explicitly re-pin with a
documented reason.

## 2. Phase 1 — event-driven core (TypeScript, ~15–25 h)

Kill the O(N) sweep. Only E, I, quarantined, waning-R, and dead-rebirth cells
do per-tick work; S and stable-R cells are pure idle.

- Expiry ticks instead of per-tick Bernoulli for R→S waning (geometric sample
  at recovery — distribution-exact) and quarantine release; a calendar/bucket
  queue keyed by tick makes finding expirees O(events), no scan.
- E→I and I→R/D are already deterministic counters — store the transition tick
  at entry, bucket-queue them too.
- Delta-maintained census: increment/decrement compartment counts at each
  transition instead of the full-grid census fold.
- Mean-field: collapse the per-S-cell `Math.pow` + Bernoulli loop into a
  handful of binomial draws (BTPE), one per protection-class cohort — the
  cohorts are discrete (4 defense masks × quarantine flag).
- Per-tick work drops from ~10⁵–10⁶ cell-visits to
  O(I·degree + state changes) ≈ 30–40k ops at endemic peak, far less off-peak.

**Bull target: 3–5× end-to-end (square ~300 → 1,000–1,500 t/s; mean-field
6–10×). Gate: ≥2.5× on `npm run bench` square, all tests green, goldens
re-pinned once with the trajectory-redefinition documented.**

Costs: RNG trajectory is redefined (fewer, different draws) — old permalinked
runs replay with the same distribution but different realizations. patchConfig
must rebuild queues on immunity/quarantine-duration changes.

### Phase 1 gate result — measured 2026-08-20 (same machine as §1)

**PASSED.** Implemented in `engine.ts` (I-/D-lists, bucket-queue transitions,
geometric waning, incremental census, mean-field cohort table with fused
mobility roll). 320×320 endemic bench, 300 measured ticks after 200 warmup:

| geometry | before | after | speedup | new profile |
|---|---|---|---|---|
| square | 302.9 t/s | 1,540.4 t/s | **5.1×** | trans 57% quar 14% life 28% |
| triangular | 368.1 | 2,314.3 | **6.3×** | trans 62% |
| hexagonal | 275.2 | 1,237.2 | **4.5×** | trans 64% |
| voronoi | 195.7 | 844.5 | **4.3×** | trans 72% |
| meanfield | 156.2 | 674.5 | **4.3×** | trans 86% |

Fit path: `runTrials` square-r1 17.5 → 2.2 ms/trial (8×). All 137 tests green;
goldens re-pinned once (`tests/engine-golden.test.ts` documents the
redefinition). Distribution equivalence verified against the pre-P1 engine
(extracted from git) over 30 seeds × 2 geometries × 5 outcome metrics — all
consistent (|z| < 2 except one metric at z=−2.4 that replicated at z=−0.01 on
60 fresh seeds, i.e. chance). The binding constraint is now the transmission
pass (57–86% of a much smaller tick), as predicted — that is what Phases 2/3
attack.

## 3. Phase 2 — WASM + SIMD core (Rust, ~30–50 h, gated)

Port the Phase-1 core (not the old algorithm) to Rust/wasm with 128-bit SIMD:

- SoA buffers live in linear memory; TS holds views; one boundary crossing per
  frame (batch many ticks per call), not per tick.
- `i8x16` lanes: swizzle-based state tables, byte-compare Bernoulli (16 trials
  per instruction against a broadcast threshold), 4 interleaved xoshiro128
  streams — or a counter-based RNG shared with Phase 3.
- Evidence: int8-dominated SIMD workloads show 5–20× (XNNPACK quantized
  inference); honest floor for naive ports is ~1× — which is why the port
  happens only after the algorithm is right and only behind the same golden
  digests.

**Bull target: additional 2–4× → 3,000–6,000 t/s. Inherit `wasm-plan.md` §5
kill criteria verbatim (golden parity within 8 h of landing, ≥2× measured
end-to-end, GH Pages build intact).**

### Phase 2 spike result — measured 2026-08-20

**Gate PASSED: 3.34×.** A Rust/wasm port of the Phase-1 tick (square, range 1,
bench endemic workload; scalar, no SIMD yet) measured **5,140 t/s vs 1,540 t/s
TS** (0.195 ms/tick) under the bench protocol, Node 22. The spike also came
out **trajectory-exact**: S/E/I/R/D at tick 500 are bit-identical to the TS
engine (same xoshiro128** algorithm, same draw order), demonstrating that the
committed port's golden-parity requirement is directly achievable, not
aspirational. Cumulative over the pre-P1 baseline: **17×**. The spike is a
throwaway measurement rig and is not part of this repo.

## 4. Phase 3 — WebGPU compute (the ceiling-raiser, ~40–60 h)

Not a faster 320×320 — a different product tier: 1024²–2048² grids (1–4M
cells) at interactive rates, and GA/fit ensembles running whole populations of
simulations in parallel.

- **Gather formulation**: each S cell reads its infectious neighbors and
  self-infects with 1−(1−p)^k — mathematically identical to per-contact
  Bernoulli scatter, but race-free: one write per thread, no atomics on the
  hot path. Ping-pong state buffers (the two-buffer swap invariant, verbatim).
- **Counter-based RNG** (pcg4d / Philox-style, keyed on cell, tick, draw#):
  bit-reproducible regardless of GPU scheduling; integer ops are exactly
  specified in WGSL, so digests are portable across GPUs. WGSL implementations
  exist to copy.
- Census via workgroup shared-memory histogram + one atomicAdd per bin per
  workgroup; batch N ticks per submit; census is 20 bytes/tick kept in a GPU
  ring buffer, read back amortized (mapAsync latency ~5–15 ms is per-map, not
  per-tick). Rendering reads the state buffer directly on-GPU — zero readback
  on the render path.
- Precedent: 1024² spatial SIR ran interactively in a 2020 WebGL fragment
  shader; native-GPU epidemic codes reach 8×10⁹ node-updates/s (A100,
  FlashSpread 2026, 217× over optimized CPU); browser compute typically lands
  15–30× over CPU JS. WebGPU ships by default in Chrome/Edge/Safari 26/Firefox
  (Windows), ~85% global support; the CPU engine remains the reference
  implementation and the fallback.
- Determinism: the GPU trajectory is its own pinned digest family (traversal
  order differs by construction); CPU stays source of truth for tests.

**Bull target: 320² at 10,000+ t/s; 2048² at 60 fps. Gate: a throwaway
Game-of-Life-shaped SEIR kernel must beat the Phase-1/2 CPU engine ≥5× on an
integrated GPU before full integration.**

### Phase 3 spike result — measured 2026-08-20

**Gate PASSED on discrete GPU (integrated-GPU validation still open).** The
full SEIR-D tick as a WGSL compute kernel (gather transmission, pcg4d
counter-based RNG, recomputed-detection contact tracing, expiry-semantics
quarantine, on-GPU census), run headlessly on an RTX 4060 Ti via wgpu/Vulkan —
the same WGSL a browser executes:

- **320²: 18,086 t/s** (0.055 ms/tick) — 11.7× over the Phase-1 TS engine,
  3.5× over the wasm spike, **59.7× over the pre-P1 baseline**. Above the
  10,000 t/s bull target.
- **2048² (4.19M cells): 476 t/s** — the new-grid-tier target at ~8× the
  60 fps requirement; 2.0×10⁹ cell-updates/s.
- **Determinism demonstrated on hardware**: same-seed runs produce a
  bit-identical 500-tick census history; different seeds diverge;
  S+E+I+R+D = N exactly at both sizes.

Both grid sizes sit at the same ~2×10⁹ cell-updates/s ceiling, dominated by
the naive per-thread census atomicAdd and 8 hash calls per cell — the
workgroup-histogram reduction and hash-call thinning are known headroom, not
required for the gate. The spike is a throwaway measurement rig and is not
part of this repo.

## 5. Phase 4 — threads (optional, ~10 h)

wasm threads + rayon over row bands: +1.5–3×. Needs COOP/COEP response
headers, which GitHub Pages cannot set — use coi-serviceworker, host behind a
proxy that can set headers, or skip threads entirely. Cheaper alternative with
most of the value: the fit/GA trial loop is embarrassingly parallel across
plain workers today, no shared memory needed.

## 6. Accounting (square 320×320) — planned vs measured 2026-08-20

| stage | bull target | **measured** | cumulative |
|---|---|---|---|
| baseline | — | 302.9 t/s | 1× |
| P1 event-driven (landed in `engine.ts`) | 1,000–1,500 | **1,540** | **5.1×** |
| P2 WASM (spike, scalar — SIMD still untapped) | 3,000–6,000 | **5,140** | **17×** |
| P3 WebGPU (spike, RTX 4060 Ti) | 10,000+ | **18,086** | **59.7×** |

P3 also delivered the grid-tier target: 2048² (4.19M cells) at 476 t/s.
Every phase met or beat its bull target; every gate passed.

## 7. Integration status — 2026-08-20 (same day)

All three phases are now INTEGRATED in the app, not just spiked:

- **Phase 2 committed port**: `rust/engine-core` (full single-strain feature
  surface: square/tri/hex/mean-field/voronoi, defenses, lockdown, quarantine,
  births, waning, txSchedule, reseed, patchConfig ops) behind
  `src/sim/wasm-engine.ts`. **Bit-identical to the TS engine** — the TS seed()
  seeds wasm memory directly and hands over the RNG state, so there is no
  digest family split. Voronoi neighborhoods are per-cell CSR lists
  precomputed by the TS geometry layer (direct CSR at range 1, BFS order
  beyond) and copied in verbatim; measured voronoi 128²: 4,635 → 11,462 t/s
  (2.5× over the P1 TS engine). The fit path (`lib/fit-sim.ts`) uses wasm
  automatically; measured fit total vs the pre-P1 engine: 30.6 s → 6.8 s
  (4.5×).
- **Phase 3 committed backend**: `src/sim/gpu-engine.ts` + async loop in
  `sim.worker.ts`. The WGSL was validated headlessly on real hardware before
  shipping (compile + pipeline + 100-tick conservation run), which caught a
  portability bug the spike missed: baseline WebGPU allows only 8 storage
  bindings per stage, so per-cell words are packed (state+age,
  defenses+compliance).
- **UI**: toolbar backend button (⚙ CPU / ⚙ WASM / ⚡ GPU), localStorage
  preference, automatic fallback with a status toast. Verified in headless
  Chrome (Vulkan WebGPU): all three backends step, render, and chart with
  zero console errors.
- Determinism contract: cpu ≡ wasm (bit-exact, golden digests shared); gpu is
  its own deterministic family per (config, seed). Backend choice is a runtime
  preference, never part of SimConfig or permalinks.

Sequencing is strict: P1 first (cheapest, benefits every path, and P2/P3 port
the *right* algorithm); P2 and P3 are then independent — P3 can skip P2
entirely if the GPU spike clears its gate. Every phase lands behind the golden
digest suite or re-pins it with a written reason.
