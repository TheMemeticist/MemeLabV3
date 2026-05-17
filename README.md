# MemeLab · Cellular Defense Automata v3

**[→ Live Demo: thememeticist.github.io/MemeLabV3](https://thememeticist.github.io/MemeLabV3/)**

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

## Model

MemeLab is a discrete-time cellular automaton over an N×N torus grid. Each tick is one simulated day. Every cell is one individual in exactly one of five compartments — the classic **SEIRS** structure plus a terminal **Dead** state:

| Cell | State | What it means |
|---|---|---|
| <img src="public/assets/CellSprites/person.svg" width="48" alt="Susceptible"> | **S — Susceptible** | Healthy; can be infected by an infectious neighbor. |
| <img src="public/assets/CellSprites/personExposed.svg" width="48" alt="Exposed"> | **E — Exposed** | Caught the pathogen but is still incubating; not yet contagious. |
| <img src="public/assets/CellSprites/personInfectious.svg" width="48" alt="Infectious"> | **I — Infectious** | Shedding pathogen; attacks susceptible neighbors each tick. |
| <img src="public/assets/CellSprites/zombie.svg" width="48" alt="Recovered"> | **R — Recovered** | Survived the infectious phase; temporarily immune. May wane back to S. |
| <img src="public/assets/CellSprites/headstone.svg" width="48" alt="Dead"> | **D — Dead** | Removed from circulation. Terminal unless birth-rate is non-zero. |

### Per-tick update

Each day, in this order:

1. **Snapshot.** Current grid `state` is copied into a `next` buffer. All transitions write to `next`, preventing within-tick infection cascades.
2. **Transmission pass.** For every cell currently in `I`, scan a precomputed Manhattan neighborhood (radius = strain `range`). For each Susceptible neighbor, roll Bernoulli with probability

   `p = attackRate × (1 − sourceControl_attacker) × (1 − protection_target) × interventionMultipliers`

   On success, the target flips to `E` in `next` and is tagged with the attacker's strain (mutated per `mutationRate` when natural selection is on).
3. **Quarantine detection** (if enabled). Each undetected `I` cell rolls Bernoulli(`detectionRate`); on hit, the cell and its Moore neighbors within `contactsRange` are flagged quarantined for `duration` ticks.
4. **Life-cycle pass.** Per-cell transitions:
   - `E → I` after `incubation` days.
   - `I → D` with probability `IFR × (1 − mortalityReduction)` after `incubation + infectious` days, otherwise `I → R`.
   - `R → S` per-day Bernoulli with `p = 1 / immunityDays` (exponentially-distributed immune duration; mean = `immunityDays`).
   - `D → S` (rebirth) iff `birthRate > 0` and most neighbors are alive.
5. **Swap buffers.** `next` becomes the new `state`.
6. **Stats.** Recompute compartment totals and rolling R_eff.

### What R₀ and R_eff mean here

- **R₀** is computed analytically from strain phenotype: distinct reachable neighbors × `1 − (1 − attackRate)^infectious`. It's a property of the disease, not the run, and is independent of seed.
- **R_eff** is measured as a 14-tick rolling average of new infections ÷ new infectious cells. It reflects what the active interventions are actually doing.

### Interventions

Four toggle-able defense layers, all default-off. Each multiplies into the transmission probability:

- **Mask** — per-cell flag rolled at uptake-rate. Reduces both `protection` (target-side) and `sourceControl` (attacker-side).
- **Vaccine** — per-cell flag rolled at uptake-rate. Same shape as mask but with separate sliders + a `mortalityReduction` term applied to IFR.
- **Lockdown** — global. `transmissionReduction` multiplies into every roll; `mobilityReduction` probabilistically culls neighbors a compliant attacker can reach; `compliance` is the fraction of the population playing along.
- **Quarantine** — reactive. On detection, the infectious cell and its contacts get a perimeter for `duration` days. Inside the perimeter, `sourceControl` attenuates outgoing transmission and `protection` attenuates incoming.

Adjusting any slider while the sim is running uses a live-patch path: per-cell flag buffers are stochastically resampled to match the new distribution without resetting the RNG, tick, or grid state.

### Defaults and seeding

- Patient zero is planted at the grid centre at tick 0 (Exposed). With `seedInfections > 0`, additional cells are seeded uniformly at random.
- **Anti-extinction reseed is OFF by default.** Once the epidemic dies, it stays dead — that's what lets you observe whether your interventions actually ended it. Opt back into reseeding by setting `reseedOnExtinction: true` in config.
- Default preset: **Bundibugyo ebolavirus (BDBV)**. 8×8 grid. All four interventions disabled. Themes: `Petri` (light) and `Lab` (dark).

## Determinism

Every run is reproducible. Click **Permalink** in the topbar to copy a URL that encodes seed + grid size + disease genes + defenses + theme + speed. Anyone who opens that URL replays the same simulation byte-for-byte.

## What's in here

- `src/sim/` — pure TypeScript simulation engine. SoA typed arrays, two-buffer SEIR-D step, seeded xoshiro128** RNG, multi-strain pool with Gaussian-drift mutation.
- `src/worker/` — Web Worker host for the engine. State buffers transferred zero-copy to the UI thread.
- `src/ui/` — UI shell, control panel, petri canvas renderer, uPlot chart, onboarding.
- `src/lib/` — URL hash codec, localStorage wrapper, file export helpers.
- `tests/` — Vitest unit tests for the engine.
- `public/assets/` — sprites and logo SVGs.

## Keyboard

- `Space` — play/pause
- `→` — step one day
- `R` — reset
- `M` — toggle natural selection
- `T` — toggle theme
- `?` — about modal

## Deploy to GitHub Pages

`.github/workflows/deploy.yml` builds and deploys on push to `main`. For a project-page deploy (`username.github.io/<repo>/`), set `VITE_BASE` in the workflow to `/<repo>/`. For a user/org page, leave as `/`.

## Branding

- Logo mark: `public/assets/logo-mark.svg`
- Lockup: `public/assets/logo-lockup.svg`
- Themes: `Petri` (light, agar) and `Lab` (dark, oscilloscope).
- Cell-state colors are color-blind safe (encoded by lightness as well as hue) and parsed from CSS variables, so retheming is purely a stylesheet edit.
