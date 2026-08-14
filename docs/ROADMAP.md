# MemeLabV3 — Delivery Roadmap (B175)

Derived from `MemeLabV3_Proposal.md` (May 2026) and reconciled against what is actually in `src/` as of 2026-08-13.

Funding envelope: **240 hrs / 6 weeks (low band)** to **640 hrs / 16 weeks (high band)** at $90/hr CAD, plus AI compute. This roadmap is written to the high band at ~40 hrs/week, with an explicit low-band cut line so the project has a defensible shippable state either way.

---

## 1. Where the code actually stands

The proposal describes four phases. Two of them are partly built already, and one proposal claim (WebGPU + Rust/WASM) has no code behind it at all. Being honest about this up front is what makes the schedule realistic.

| Proposal capability | State in `src/` | Evidence |
|---|---|---|
| SEIRS-D engine, deterministic, worker-threaded | **Done** | `src/sim/engine.ts`, `src/worker/sim.worker.ts` |
| Permalink reproducibility | **Done** | `src/lib/url-state.ts`, `src/ui/ShareMenu.ts` (+ QR) |
| Multi-topology lattices (grid, triangular, Voronoi, mean-field) | **Done** | `src/types.ts` geometry union, `src/sim/voronoi.ts`, `src/sim/delaunay.ts` |
| Interventions + live patching | **Done** | `src/sim/defense.ts`, `Engine.patchConfig()` |
| Inverse fitting / R₀ estimator with GA optimizer | **Done** | `src/lib/ga.ts`, `src/lib/fit*.ts`, `src/ui/R0Modal.ts` |
| Economic cost model | **Done** | `src/lib/cost.ts`, `src/ui/CostModal.ts` |
| R_eff = 1 reference line on chart | **Partial** | `Chart.ts:358 paintReffThreshold()` — the line exists, the *interpretation* (phase badge, HIT gap) does not |
| Phase badge, HIT stat, HIT line on chart | **Not built** | no herd-immunity computation anywhere outside comments |
| ABCD codon genome, degeneracy table, landscape seed | **Not built** | `strain.ts` mutates a float phenotype vector by Gaussian drift; there is no genotype |
| Synthesize Memenome (phenotype → genome back-solve) | **Not built** | — |
| Genome panel, phylodynamic timeline, Newick export | **Not built** | no phylogeny data structure exists |
| Network topologies (Erdős–Rényi, Barabási–Albert, GraphML) | **Not built** | geometry is lattice-only; no adjacency-list path in `neighbors.ts` |
| AI agent: paper → permalink | **Not built** | — |
| WebGPU + Rust/WASM | **Not built** | pure TS in a Web Worker |
| Validation against historical outbreaks | **Informal** | Ebola permalink in the proposal; no reproducible validation set |

**The single biggest scope risk is the ABCD engine.** Everything downstream in the proposal — genome panel, phylodynamic timeline, Newick export, Synthesize Memenome, the agent layer's "synthesizes memenome" step — depends on replacing the current float-vector strain model with a real genotype→phenotype map. It is the critical path and it must start early, not in the back half.

**The second-biggest risk is Rust/WASM + WebGPU.** At 640 hours total, a Rust port of the engine plus a WebGPU render path could plausibly eat 150–200 hours by itself and would fork the determinism invariant across two implementations. Recommendation below: treat it as a benchmark-gated spike, not a committed deliverable.

---

## 2. Phase plan

Each phase ends on a **demoable permalink** and a build-in-public post, which is what the proposal promises as the development process.

### Phase 0 — Foundations (Week 1, ~30 hrs)

Not in the proposal, but the repo needs it before anything else lands cleanly.

- Fix the 78-file permission churn: `git config core.fileMode false`, commit once.
- Baseline the test suite; add the two invariant tests everything else will lean on (determinism, population conservation) as reusable helpers in `tests/`.
- Add a perf harness: headless tick-rate benchmark at 320×320 for each geometry, checked into `tests/` and runnable as `npm run bench`. Every later phase compares against this number.
- Adopt the dev checklist in §3 and the repo structure in the companion restructure note.

**Exit:** clean `git status`, green `npm run typecheck && npm run test`, a committed baseline benchmark number.

### Phase 1 — EID foundations (Weeks 1–2, ~60 hrs)

Proposal Phase 1. No engine changes; this is pure interpretation of numbers the engine already produces.

- **Phase badge** — classify the run (`Growing / Peaking / Declining / Contained / Extinct`) from R_eff and its trend, rendered in `Stats.ts` with the sentence form from the proposal ("Still growing — R_eff 2.3").
- **HIT stat** — compute `HIT = 1 − 1/R₀`, render current immune fraction against it, and state the gap in words.
- **HIT line on the chart** — a second reference line beside the existing R=1 threshold, drawn in the same `paintReffThreshold` hook.
- **Tooltip pass** — every control gets an action-relevant tooltip, not a restatement of the variable name.

**Exit:** a fresh user can answer "is this outbreak ending, and how far am I from herd immunity?" without touching a slider.

### Phase 2 — Domain-constraint rendering (Weeks 3–5, ~110 hrs)

Proposal Phase 2, informed by `ux-analysis.md`.

- Peak annotation and epidemic-landmark rendering on the chart (peak day, peak height, cumulative deaths at peak).
- **Progressive disclosure** of the control panel: the current ~30 sliders exposed two clicks from a blank state is the concrete cognitive-load finding in the UX analysis. Ship a three-tier reveal (preset → key levers → full parameter space).
- Strain sparkline (diversity over time) — deliberately built against the *current* strain pool so it exists before the ABCD swap, and is then re-pointed at genomes in Phase 3.
- Mobile layout and accessibility pass: touch targets, keyboard traversal, reduced-motion, contrast audit of both themes.

**Exit:** first-run experience is usable on a phone with no instructions; UX-analysis findings closed or explicitly deferred with reasons.

### Phase 3 — ABCD memetic engine + agent (Weeks 5–11, ~230 hrs)

Proposal Phase 3, and the heart of the grant. Starts overlapping Phase 2 deliberately.

1. **Genome representation** (~40 hrs) — variable-length `{A,B,C,D}*` stored as a packed `Uint8Array` per strain, 2 bits per base, in `StrainPool`. Keep `strainId: Uint16` and the 4096-strain cap intact so `population.ts` is untouched.
2. **Codon table + landscape seed** (~40 hrs) — 64-codon degeneracy table generated from a seeded RNG (`base_value`, `impact`, `locus_bias`), deterministic under the existing `Rng`. Genotype → phenotype is a pure function; unit-test that identical genome + identical landscape seed gives identical phenotype across instances.
3. **Mutation on transmission** (~30 hrs) — point substitutions plus rare indels applied only on successful transmission, replacing Gaussian phenotype drift. This is the change most likely to break determinism tests; land it behind a config flag so the old model stays runnable for A/B comparison during the transition.
4. **Synthesize Memenome** (~35 hrs) — reverse codon lookup plus seeded hill-climb, target <50 ms, reusing the GA infrastructure already in `src/lib/ga.ts` rather than writing a second optimizer.
5. **Phylodynamic DAG + Newick export** (~40 hrs) — parent pointers already implied by `spawnChild()`; materialize them into a lineage tree, render the timeline, export Newick via `src/lib/export.ts`.
6. **Genome panel** (~20 hrs) — winning strain's genome, its phenotype deltas versus the founder, in the proposal's sentence form.
7. **Error-threshold demo** (~10 hrs) — a preset permalink that pushes mutation past the Eigen–Schuster error threshold and visibly collapses adaptation into neutral drift. This is the single most persuasive artifact in the whole grant; it deserves its own permalink and its own post.
8. **Agent layer: paper → permalink** (~15 hrs) — a Claude skill plus a documented tool contract that extracts SEIR parameters from a paper, calls Synthesize Memenome, and emits a permalink. The skill is thin because the URL codec and the synthesizer do the work.

**Exit:** an outbreak run where a variant sweep is visible in the timeline, explainable from the genome panel, and reproducible from a permalink; Newick export opens in a standard tree viewer.

### Phase 4 — Networks, validation, frontier (Weeks 11–15, ~150 hrs)

Proposal Phase 4, plus the validation the proposal commits to but does not schedule.

- **Adjacency-list contact layer** (~50 hrs) — generalize `neighbors.ts` from "offsets into a lattice" to "neighbor list per cell," which the Voronoi work has already half-proven. Then Erdős–Rényi and Barabási–Albert generators, plus GraphML/JSON upload. Superspreader dynamics fall out of the BA degree distribution for free.
- **Historical validation set** (~50 hrs) — COVID-19, mpox, H3N2, and the existing Ebola case, each as a checked-in preset with a source citation, fitted parameters, a permalink, and a short writeup of where the model agrees with published curves and where it does not. Automate as a test so regressions are caught.
- **Nextstrain-adjacent interop** (~20 hrs) — confirm the Newick export and parameter JSON round-trip against real Nextstrain artifacts.
- **Performance spike, benchmark-gated** (~30 hrs) — profile against the Phase 0 baseline. Port to Rust/WASM *only* if profiling shows the TS worker is the binding constraint at target grid sizes; otherwise spend the hours on the transmission-pass hot loop and document the decision. Do not maintain two engines.

**Exit:** a network topology can be switched live; every validation preset reproduces its published curve within a stated tolerance.

### Week 16 — Release (~60 hrs)

Open-source release hygiene: LICENSE, CONTRIBUTING, citable version tag, README rewrite around the new capabilities, final grant report with the validation writeup, and the backlog of deferred items filed as issues.

### Low-band cut line (240 hrs / 6 weeks)

If only the low band is funded, ship: **Phase 0 + Phase 1 + Phase 2 + ABCD steps 1–4 and 7** (genome, codon table, mutation-on-transmission, Synthesize Memenome, error-threshold demo). That is ~235 hrs and it delivers the proposal's central scientific claim — a real quasispecies engine with a visible error threshold — while deferring phylogeny UI, networks, and validation. Everything cut is additive, not a rewrite.

---

## 3. Standardized dev checklist

Run this on **every** change before it is considered done. It exists because this codebase has four invariants that are easy to break silently.

### Before writing code
- [ ] Which layer does this touch — `sim/` (pure), `worker/`, `ui/`, `lib/`? Keep `sim/` DOM-free.
- [ ] Does it add a `SimConfig` field? If yes, plan for all four call sites: `types.ts`, `needsRebuild()` in `App.ts`, `encode()` and `applyEncoded()` in `url-state.ts`.
- [ ] Does it change the RNG call sequence? If yes, it is a **rebuild** change, never a `patchConfig` change.

### While building
- [ ] New config field added to `types.ts` `SimConfig`.
- [ ] Routing decided in `App.ts` `needsRebuild()` — structural (size, seed, genes, geometry, genome) → `updateConfig`; soft (uptakes, toggles, multipliers) → `patchConfig`.
- [ ] Permalink codec updated in **both** `encode()` and `applyEncoded()`.
- [ ] No second RNG source introduced; all randomness goes through `this.rng`.
- [ ] No writes into `pop.state` during a tick — only `pop.next`.
- [ ] `getOffsets()` / neighbor-cache results treated as immutable.

### Tests (a change is not done without these)
- [ ] **Determinism**: two `Engine` instances, same `SimConfig`, identical `SimStats` at tick 1, 50, and 500.
- [ ] **Conservation**: `S + E + I + R + D === N` on every tick of a 200-tick run.
- [ ] **Permalink round-trip**: `decode(encode(config))` deep-equals the config, including the new field.
- [ ] **Patch safety** (if `patchConfig` path was touched): patching mid-run leaves tick counter and RNG trajectory unchanged.
- [ ] `npm run typecheck` clean.
- [ ] `npm run test` green.

### Manual verification
- [ ] Both render paths exercised: sprite mode (grid ≤ 60) and pixel mode (grid > 60).
- [ ] Every geometry still renders and steps: grid, triangular, Voronoi, mean-field.
- [ ] `npm run bench` within 10% of the committed baseline, or the regression is explained in the commit message.
- [ ] Mobile viewport: no horizontal scroll, controls reachable one-handed.
- [ ] Fresh-tab permalink test: copy the link the feature produces, open in a new tab, confirm the run reproduces.

### Ship
- [ ] Commit via the `memelab-git` skill (correct identity, the `static.yml` deploy gotcha).
- [ ] `VITE_BASE=/MemeLabV3/ npm run build` succeeds; Pages deploy verified live, not assumed.
- [ ] README / `docs/` updated if user-visible behavior changed.
- [ ] One-line entry appended to `CHANGELOG.md`.

### Weekly cadence
- **Monday:** pick the week's slice from the current phase; write the exit criterion as one sentence before starting.
- **Wednesday:** mid-week integration commit — nothing sits unmerged for a full week.
- **Friday:** ship to Pages, capture a demo permalink, post the build-in-public update. The permalink *is* the release note.

---

## 4. Estimation ground rules

- Hours in §2 are engineering hours, not calendar hours; a 40-hr week absorbs roughly 32 hrs of feature work once review, deploy, and public-update time are counted. The phase totals already reflect that.
- Any task estimated over 40 hrs gets decomposed before it starts. ABCD steps above are already at that granularity.
- When a phase runs over, the deferral comes out of Phase 4 frontier items, never out of the test checklist.
