# Benchmarks — how to reproduce every number

Everything here measures **one** workload, defined **once**, in
[`tests/bench/protocol.ts`](bench/protocol.ts): a 320×320 endemic-steady-state
dish (fast-waning immunity so the infectious pool never dies, quarantine on, a
little mortality and birth), fixed seed `0xb175b175`, **200 warm-up ticks**
(off the clock) and **300 measured ticks**, reported as **best of 3**.

Because the engine is deterministic, the *final census* is a fingerprint of the
workload. Every runner prints it. Two runs that report the same
`S/E/I/R/D` stepped the same trajectory and are comparable; two runs that do
not, are not — no matter how similar the tick rates look.

```
ts     320²  square       2421.3 t/s   0.4130 ms/tick  best of 3  | S=41546 E=2610 I=6126 R=51869 D=249 N=102400
                                                                    └─ this is the receipt
```

## The runtime matters more than you think

The same engine source, on the same machine, in the same minute, measured three
ways. The only thing that differs is how the module graph was turned into
running code.

`src/types.ts` declares `CellState` and `DefenseFlag` as `const enum`. The
engine reads them in the per-cell hot loop. What each pipeline does with
`CellState.Infectious`:

| pipeline | what the hot loop executes | is this what ships? |
|---|---|---|
| **vite-node** (`npm run bench`) | `__vite_ssr_import_0__.CellState.Infectious` — and that first property is an **accessor**, defined by vite's SSR runtime as `Object.defineProperty(exports, 'CellState', { get() { … } })`. So: a **getter call**, then a property load. Per read, per cell, per tick. | ❌ no |
| **vite/rollup** (`vite build`, and this harness by default) | `CellState.Infectious` — one plain data-property load on a module-scope object. Rollup does not inline cross-module const enum members. | ✅ **yes** — this is the worker chunk the app ships |
| **esbuild `--bundle`** (`BENCH_BUNDLER=esbuild`) | `2` — esbuild in bundle mode inlines the member to a literal. | ❌ no |

The gap between the two honest pipelines is small: V8 serves a monomorphic
data-property load on a stable module-scope object almost for free. The gap to
vite-node is not small, because a getter call is a function call and cannot be
folded the same way.

**The consequence for benchmarking:** the vite-node penalty is *not a constant
factor across engine versions*. An engine that reads those enums inside the hot
loop pays it on every cell; an engine that hoists them into locals at the top of
the function pays it once. So a ratio taken between two vite-node runs of two
different engine versions is inflated by an unknown amount, and the inflation
looks exactly like a real optimization.

`tests/bench.ts` is kept because it is the original Phase 0 instrument and
because its per-pass split is still useful for A/B work *within one engine
version*. **Do not quote its numbers**, and never compare one of them to
another version's. Its frame-post micro-bench — the last published figure that
still traced back to it — now has a runner of its own (`npm run bench:frame`);
its history-maintenance micro-bench is the only thing left here without one.
Use the runners below.

## The runners

| command | what it measures | runtime |
|---|---|---|
| `npm run bench:node` | TS engine, five geometries | plain `node`, Vite production bundle |
| `npm run bench:backends` | TS vs WASM + tick-by-tick parity (+ optional sweep) | plain `node`, Vite production bundle |
| `npm run bench:fit` | the R₀ estimator's inner loop (`runTrials`) | plain `node`, Vite production bundle |
| `npm run bench:frame` | frame-post cost: full history snapshot vs 1-row delta | plain `node`, vite bundle |
| `npm run bench:browser` | TS, WASM **and the shipped WebGPU engine** | real Chrome |
| `npm run bench:ladder` | the whole engine history, one harness per rung | plain `node`, Vite production bundle |
| `npm run bench` | legacy Phase 0 instrument + micro-benches | ⚠️ vite-node |

Every runner except `npm run bench` builds its measured code with the **app's
own production pipeline** (`vite build` in library mode — esbuild transform,
rollup bundle), so what is timed is as close as a benchmark gets to the chunk
the browser actually downloads. `BENCH_BUNDLER=esbuild` switches to esbuild's
own bundler, which is quicker but inlines const enums the shipped build keeps;
use it to measure that difference, not to publish.

Raw logs and bundles land in `bench-out/` (gitignored). Override with
`BENCH_OUT=/some/dir`.

### Env knobs

```
BENCH_GEOMETRIES=square,voronoi   default: all five
BENCH_SIZES=320,2048              default: 320 (backends: 128,320)
BENCH_REPS=5                      default: 3 (frame: 5)
BENCH_TICKS=600                   (frame) history depth to snapshot
BENCH_WARM=50                     (frame) clones per payload before the clock
BENCH_LABEL="my machine"          free text, echoed into the log header
BENCH_SPLIT=1                     also report the per-pass profile split
BENCH_SWEEP=1                     (backends) grid-size scaling sweep
BENCH_BACKENDS=ts,wasm,gpu        (browser) which engines to run
BENCH_BUNDLER=vite|esbuild        default: vite (matches `vite build`)
BENCH_ROOT=/path/to/worktree      (browser) checkout to bundle from
BENCH_BROWSER_ENTRY=...           (browser) which browser entry to build
```

## The frame-post micro-bench

`npm run bench:frame` measures what `sim.worker`'s `postFrame` pays, per posted
frame, to hand the UI thread its slice of the long history — the one cost in
the frame path that is *not* zero-copy. The grid buffers are transferred, so
they are deliberately outside the measured window; what is inside it is the
`LongHistory.slice()` that materializes plain arrays out of the ring buffer,
plus the structured clone `postMessage` performs on the way out. Two payload
shapes, the same ones the worker chooses between:

* **full snapshot** (`history.toLongStats()`) — every stored row, 16 series.
  Posted on init/reset and when more ticks elapsed than the window still holds.
* **1-row delta** (`history.lastRows(1)`) — what a steady-state 60 fps post
  actually sends.

The ratio between them is the point, and it is what the delta-posting change
bought. On the production bundle under plain Node, at a 600-tick history, best
of 9: **612 µs** for the full snapshot against **5.3 µs** for the delta — 115×,
or 0.32 ms/s of posting at 60 fps instead of 37 ms/s.

This is one of the numbers `tests/bench.ts` used to be the only source for, and
the difference the honest runtime makes here is small — the vite-node accessor
penalty lands on `const enum` reads in the per-cell hot loop, and a
`structuredClone` of a plain-array payload barely touches that. Measured
cold and single-batch the way `bench.ts` does it (`BENCH_WARM=0 BENCH_REPS=1`),
the production bundle reports 627.0 / 5.64 µs against vite-node's 630.6 / 6.0 —
about 6 % on the delta. Small, but it is the reason this runner exists rather
than a footnote saying the old one was probably fine.

## Browser + WebGPU

`npm run bench:browser` is the only way to measure `src/sim/gpu-engine.ts`, and
the only runtime that is what the app actually ships to.

It needs, none of them app dependencies:

* Chrome or Chromium on PATH, or `CHROME_PATH=/path/to/chrome`
* a Playwright package it can resolve — `npm i -D playwright-core`, or
  `PLAYWRIGHT_MODULE=<specifier-or-path>`
* on a headless Linux box, wrap the whole command in `xvfb-run -a`

```sh
xvfb-run -a npm run bench:browser
BENCH_BACKENDS=gpu BENCH_SIZES=320,2048 xvfb-run -a npm run bench:browser
```

Three things that cost real time if you skip them:

1. **WebGPU needs a secure context.** The runner serves the bundle from
   `http://127.0.0.1` rather than a `file://` URL, because localhost counts as
   secure and `file://` does not.
2. **A software adapter will happily produce numbers, and they are worthless.**
   The runner prints the adapter and refuses to report GPU results from
   SwiftShader/llvmpipe. Check the header says a real GPU vendor and
   architecture. On Linux Chrome the fix is usually
   `chrome://flags/#enable-vulkan` plus the launch flags the runner already
   passes.
3. **The GPU engine batches.** It dispatches up to 2,048 ticks per submit, so
   the 300 measured ticks are one submit. The measured window **includes the
   readback** — a dispatch whose result is never read is not a tick rate.

The GPU engine is deterministic in its **own trajectory family** (parallel draw
order differs by construction), so its census legitimately differs from the
CPU/WASM census. `N` still has to come out exactly right, and it is printed so
you can check.

## The historical ladder

```sh
npm run bench:ladder                              # from a clone with the history
LADDER_REPO=/path/to/MemeLabV3 npm run bench:ladder
```

For each stage of the engine's history the runner:

1. `git worktree add`s a detached checkout at that commit,
2. copies **today's** `tests/bench/protocol.ts`, `node-ts.ts` and `node-fit.ts`
   into it, replacing whatever benchmark that commit shipped,
3. bundles with esbuild and runs it under plain `node`.

Step 2 is the whole point: the old commits are **not** measured with their own
contemporary harness, and no old harness has to be trusted. This is what
`protocol.ts`'s import restriction buys.

### Replaying the ladder in the browser

`tests/bench/browser-ts-entry.ts` is the graftable browser entry — TS engine
only, importing nothing but `./protocol`, so it grafts into the old commits
exactly like `node-ts.ts`. That is what lets the *whole* ladder plus the WebGPU
tier be quoted from one runtime with no cross-runtime splice:

```sh
git worktree add /tmp/rung <commit>
cp tests/bench/protocol.ts tests/bench/browser-ts-entry.ts /tmp/rung/tests/bench/
BENCH_ROOT=/tmp/rung BENCH_BROWSER_ENTRY=tests/bench/browser-ts-entry.ts \
  BENCH_BACKENDS=ts xvfb-run -a npm run bench:browser
```

### The graftability rule

`tests/bench/protocol.ts` and `tests/bench/node-ts.ts` may import **only**
`src/sim/*` and `src/types.ts` — nothing else in the repo, and no npm package.
Those are the only files the oldest commits in the ladder contain. Break the
rule and the ladder stops building at the old rungs; there is no other symptom,
so it is stated here and at the top of `protocol.ts`.

Corollaries the harness already respects, and which you must too:

* `Engine.profile` **does not exist** before the hot-loop commit. Feature-detect
  it (`'profile' in engine`); a missing split is reported as `null`, never as a
  zero.
* `engine.history` arrived later still. The core harness does not touch it.
* `tests/bench/node-fit.ts` additionally needs `src/lib/fit-sim.ts`, which the
  pre-optimization commit has no version of. The ladder skips the fit bench
  there rather than inventing a number.

## Reading the output honestly

* **Best of N, never a mean.** Noise — a GC pause, another process, a scheduler
  hiccup — can only ever make a run *slower*, so the fastest repeat is the
  cleanest estimate of what the code costs. `censusStable: false` (printed as
  `** CENSUS DRIFT **`) means the repeats did not agree and the row is void.
* **The profiled window is not a rate.** `BENCH_SPLIT=1` adds two
  `performance.now()` calls per pass per tick, so it runs in its own window and
  its ms/tick is deliberately labelled as not quotable.
* **Cross-runtime comparisons need the same runtime on both sides.** Plain node
  and Chrome are both V8 but not the same V8 build or flags. Compare
  node-to-node and browser-to-browser; say which when you quote.
* **A native (non-browser) kernel is a different claim.** A Rust/wgpu binary is
  a useful ceiling reference, but it is not what a reader gets by opening the
  app, and the two must never be multiplied into one "speedup".
