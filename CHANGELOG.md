# Changelog

One line per user-visible change, newest first. Adding an entry is the last item on the dev checklist in `docs/ROADMAP.md`.

## Unreleased

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
