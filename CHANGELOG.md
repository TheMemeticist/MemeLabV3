# Changelog

One line per user-visible change, newest first. Adding an entry is the last item on the dev checklist in `docs/ROADMAP.md`.

## 2026-09-16

- Interpretation: observed E+I trend, incubation/readiness states, and infectious peak-so-far annotation with day and cumulative deaths; retains peaks through skipped frames and resets cleanly.
- Accessibility: closing the expanded chart with Escape restores focus to its trigger; verified responsive trend/peak layout and keyboard operation.
- Input handling: bound grid sizes, disease-stage durations, and fitted schedules; tolerate malformed links/saved sessions; escape estimator input/history markup.
- Reproducibility: validate saved simulation and cost settings directly, preserving fitted precision, disabled controls, reseeding, and fractional prices; rebuild embedded WASM with schedule-allocation bounds.
- Benchmarks: reproducible production-bundle runners for engine backends, fitting, frame posting, browser GPU, and historical comparisons.
- Build maintenance: pin Pages actions and enable Dependabot updates.

## 2026-08-26

- Brand and rendering: new identity, expressive state sprites, protection-tier masks, and live cell motion on small boards across all five geometries.

## 2026-08-22

- Interface: Configure/Observe workspaces, revised controls and charts, and a dedicated estimation workspace.

## 2026-08-20

- Simulation: event-driven CPU core plus WASM and WebGPU backends, five-geometry support, backend availability/fallback feedback, and golden/parity regression tests.
- Estimator: replay the fitted world and representative seed, show fitted curves and intervention cards, validate against held-out seeds, and display index-date and uncertainty overlays.
- Rendering: prevent population-change freezes and stale Voronoi paints during rebuilds.

## 2026-08-13

- Repo hygiene: `core.fileMode` disabled (was showing 78 files as modified with no content change), workspace restructured, `docs/` added with the delivery roadmap, architecture diagram, ABCD spec, UX analysis, and deploy guide.

## 3.0.0-rc.1

Everything below predates the changelog and is reconstructed from git history.

### 2026-06-01
- R₀ Estimator: fitted deaths now reproduce in the live sim.
- R₀ Estimator: corrected confidence interval, added the genetic-algorithm optimizer, UI polish.

### 2026-05-30
- R₀ Estimator (inverse parameter fitting) added, with card launcher, persistence, live chart, and precise parameter entry.

### 2026-05-29
- Share popover with QR code; permalinks minified.

### 2026-05-28
- Chart: Active/Total toggle, expand modal, legend polish.
- Live disease patching, Voronoi performance work, full-screen petri layout.
- CI: removed the conflicting `static.yml` workflow that broke Pages.

### 2026-05-27
- Voronoi geometry with urban/rural settlement networks.
- Germ-agnostic economic cost model; quarantine render fix.

### 2026-05-24
- Lattice geometry modes (square, triangular, hexagonal, mean-field) with mean-field R₀ slider.
- Fixed hex/triangular rendering stalls; corrected R₀ geometry scaling.

### 2026-05-21
- Genetic algorithm added.

### 2026-05-17
- BDBV default preset, dark-mode chart fix, nav and panel UX improvements.

### 2026-05-07
- Initial GitHub Pages deploy workflow.
