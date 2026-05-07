# MemeLab · Cellular Defense Automata v3

> Simulate outbreaks. Evolve strains. Master defenses.
>
> Institute of Armchair Epidemiology — clean-room V3 rebuild.

V3 is a from-scratch TypeScript reimplementation of the MemeLab/CDA simulator. Compared to v2 it is roughly an order of magnitude faster, fully deterministic from a seed, mobile-friendly, and ships zero per-cell DOM elements.

## Quickstart

```bash
npm install
npm run dev          # local dev server at http://localhost:5173
npm run build        # static dist/ ready for any static host
npm run preview      # preview the built bundle
npm run test         # run the engine unit tests
npm run typecheck    # tsc strict
```

## What's in here

- `src/sim/` — pure TypeScript simulation engine. SoA typed arrays, two-buffer SEIR-D step, seeded xoshiro128** RNG, multi-strain pool with Gaussian-drift mutation, real R₀ estimation.
- `src/worker/` — Web Worker host for the engine. State buffers transferred zero-copy to the UI thread.
- `src/ui/` — UI shell, control panel, petri canvas renderer, uPlot chart, onboarding.
- `src/lib/` — URL hash codec, localStorage wrapper, file export helpers.
- `tests/` — Vitest unit tests for the engine.
- `public/assets/` — sprites and logo SVGs.

## Determinism

Every run is reproducible. Click **Permalink** in the topbar to copy a URL that encodes seed + grid size + disease genes + defenses + theme + speed. Anyone who opens that URL replays the same simulation byte-for-byte.

## Keyboard

- `Space` — play/pause
- `→` — step one day
- `R` — reset
- `M` — toggle natural selection
- `T` — toggle theme

## Deploy to GitHub Pages

`.github/workflows/deploy.yml` builds and deploys on push to `main`. For a project-page deploy (`username.github.io/<repo>/`), set `VITE_BASE` in the workflow to `/<repo>/`. For a user/org page, leave as `/`.

## Branding

- Logo mark: `public/assets/logo-mark.svg`
- Lockup: `public/assets/logo-lockup.svg`
- Themes: `Petri` (light, agar) and `Lab` (dark, oscilloscope).
- Cell-state colors are color-blind safe (encoded by lightness as well as hue) and parsed from CSS variables, so retheming is purely a stylesheet edit.

## License

See `LICENSE` (inherited from the v1 repo) — MIT-compatible.
