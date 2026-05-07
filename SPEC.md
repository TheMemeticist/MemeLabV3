# Cellular Defense Automata V3 — Build Spec

**Status:** Draft for engineering reverse-engineer / clean-room rebuild
**Predecessors:** v1 = `Cellular-Defense-Automata/` (Python, 2021, source obfuscated, partially broken). v2 = `MemeLab-main/` (browser, 2023, runs but rough — see `ISSUES.md`).
**Deployment target:** GitHub Pages (static hosting only; no backend, no build server beyond CI).

---

## 1. Vision

A browser-native, zero-backend simulation sandbox for contagion dynamics on a 2-D cellular automaton. The user can:

- Watch an outbreak spread across a population of cells (1k–1M+).
- Tune disease parameters (incubation, infectious period, attack rate, IFR, range, immunity wane, mutation rate).
- Tune defense parameters (mask, vaccine — protection / source-control / mortality reduction / uptake).
- Pick from disease presets (SARS-1, SARS-2 lineages, Measles, TB, Nipah, etc.) or hand-craft.
- Toggle natural selection (mutation + selection pressure) and watch lineages evolve.
- Compare two runs side-by-side (A/B mode).
- Export run data (CSV / JSON / PNG snapshots / MP4 of the petri dish).
- Share a configured run via permalink (state encoded in URL hash).

V3 is a **clean-room rewrite**. Treat v2 as a reference for the *intent* of the simulation, not a code source. The visual identity (petri-dish framing, syringe / mask / virus iconography) is worth preserving; the implementation underneath is not.

---

## 2. Scope

### In scope (V3.0)

- Single-page web app served from `/` on GitHub Pages.
- Compartmental SEIR(S) + D model with spatial structure (each cell occupies a grid position).
- Canvas2D primary renderer, WebGL fallback for populations > ~100k.
- Simulation runs in a Web Worker; UI thread never blocks.
- Deterministic, seedable PRNG so any run is reproducible from a permalink.
- Disease and defense presets editable at runtime; user presets persisted in `localStorage`.
- Real-time time-series chart (incidence, prevalence, cumulative dead, R_eff).
- Pause / play / step / reset / speed (0.25× → 32×).
- Mobile-friendly responsive layout.
- Light + dark theme, prefers-color-scheme aware.

### Out of scope (V3.0 — punt to V3.1+)

- Multi-population / network-graph mode (non-grid topology).
- Server-side run sharing (parameters via URL only).
- Agent-level mobility (cells stay on grid).
- Multiplayer / collaborative.
- Native mobile apps.

---

## 3. Deployment

- **Host:** GitHub Pages from `gh-pages` branch (or `/docs` on `main`).
- **Build:** Vite → static `dist/`. CI: GitHub Actions workflow builds on push to `main`, deploys `dist/` to `gh-pages`.
- **Routing:** Hash-based (`#/sim?seed=...&v=sars2-delta&...`). No 404 fallback needed.
- **Asset pathing:** Use `import.meta.env.BASE_URL` everywhere; never hardcode `/`. The site must work whether deployed to `username.github.io/` (root) or `username.github.io/repo-name/` (subpath).
- **No external CDN required at runtime.** All deps bundled. (v2's `js/plotly.min.js` was vendored — keep that discipline.)
- **Bundle budget:** ≤ 250 KB gzipped JS, ≤ 50 KB CSS, ≤ 500 KB total assets on first paint. Lazy-load chart library and any preset assets.

---

## 4. Tech Stack

**Recommended:**

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Type-checks the simulation invariants; enums for SEIR states. |
| Build | Vite | Fast HMR; sane GH-Pages output via `base` config; first-class Worker support. |
| UI | Vanilla TS + lit-html *or* Preact | Avoid React's bundle weight; keep render simple. No need for state-mgmt libs. |
| Rendering | Canvas 2D + offscreen canvas; WebGL2 (regl or hand-rolled) for >100k cells | Direct pixel draws, no DOM-per-cell. |
| Charting | uPlot | 40 KB, sub-millisecond updates; replaces Plotly's ~3 MB. |
| Math/RNG | `seedrandom` or hand-rolled xoshiro128** | Deterministic, reproducible runs. |
| Storage | `localStorage` for presets; URL hash for shareable state | No backend. |
| Testing | Vitest + Playwright | Unit-test sim engine; e2e the UI. |
| Lint/format | ESLint + Prettier | Standard. |

**Hard rules:**

- No jQuery, no Bootstrap, no Tailwind unless justified — stay tiny.
- Sim core must be **pure TypeScript** (no DOM imports). It runs in a Worker and is unit-testable headlessly.
- All randomness goes through one injected RNG. `Math.random()` must not appear in `src/sim/`.

---

## 5. Architecture

```
┌─────────────────────────── UI thread ───────────────────────────┐
│  App shell (router, theme)                                      │
│   ├─ ControlPanel  (sliders, presets, play/pause)               │
│   ├─ Petri         (Canvas/WebGL renderer)                      │
│   ├─ Chart         (uPlot time-series)                          │
│   └─ Stats         (top-level counters)                         │
│                                                                 │
│           ▲ postMessage(state diff)        ▼ postMessage(cmd)   │
└─────────────────────────────────────────────────────────────────┘
                            │
┌────────────────────────── Worker ───────────────────────────────┐
│  SimulationEngine                                               │
│   ├─ Population: SoA (Structure of Arrays, typed arrays)        │
│   ├─ Spatial index (precomputed neighbor offsets per range)     │
│   ├─ Step loop (turn → mutate viruses → update cells)           │
│   ├─ Stats accumulator                                          │
│   └─ RNG (seeded xoshiro128**)                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Message protocol (UI ↔ Worker):**

- UI → Worker: `{cmd: 'init', config}`, `{cmd: 'step', n}`, `{cmd: 'play', tps}`, `{cmd: 'pause'}`, `{cmd: 'reset', seed}`, `{cmd: 'updateParams', diff}`.
- Worker → UI: `{type: 'frame', tick, stateBuffer (Transferable), stats}`, `{type: 'snapshot', longStats}`, `{type: 'done'}`.

**State is transferred as a `Uint8Array` (one byte per cell encoding SEIR/D + defense flags)** via `postMessage(buf, [buf.buffer])` (zero-copy transfer). The renderer maps bytes → pixel colors directly.

---

## 6. Simulation Engine

### 6.1 Data layout

Cells are an SoA, not an AoS. For a population of N:

```ts
class Population {
  size: number;        // grid edge length; N = size * size
  state:        Uint8Array;  // SEIR-D enum, 1 byte per cell
  age:          Uint16Array; // simulation days lived
  infectedAge:  Uint16Array; // days since exposure (0 if not infected)
  defenses:     Uint8Array;  // bitmask: bit0=mask, bit1=vax, ...
  strainId:     Uint16Array; // index into strain pool, or 0 if uninfected
  // Allocate once, reuse forever.
}
```

This is **~6 bytes/cell**. A 1024×1024 grid (~1M cells) fits in ~6 MB — well within Worker memory. v2's per-cell JS object plus per-cell `<div>` blew this out by ~1000×.

### 6.2 SEIR-D state machine

States (one byte enum):

```
0  S  Susceptible
1  E  Exposed (infected, not yet infectious)
2  I  Infectious
3  R  Recovered (immune, may wane)
4  D  Dead
5  V  Vaccinated-only (still S but with defense bit set)
```

Transitions per tick:

- `S → E` on successful attack from infectious neighbor.
- `E → I` when `infectedAge ≥ strain.incubation`.
- `I → R` when `infectedAge ≥ strain.incubation + strain.infectious`. At that moment, roll `strain.IFR × (1 - vax_mortality_reduction)` for `R → D`.
- `R → S` per-tick probability `strain.immunityWaneRate / 365` (so the param reads "annual wane %").
- `D` is terminal unless `birthRate > 0`, in which case dead cells with ≥50% live neighbors stochastically respawn as `S` (existing v2 mechanic; keep).

### 6.3 Strain / Meme

```ts
type Strain = {
  id: number;
  parentId: number | null;     // for lineage tracking
  attackRate: number;          // [0,1] per-contact
  incubation: number;          // days
  infectious: number;          // days
  IFR: number;                 // [0,1] base infection-fatality rate
  range: number;               // Manhattan radius for transmission
  immunityWaneRate: number;    // annual % chance R→S
  mutationRate: number;        // per-replication chance of drift on each gene
};
```

Multiple strains coexist. Each cell stores `strainId`; new infections inherit the attacker's strain (with optional mutation).

### 6.4 Mutation (natural selection mode)

When enabled, on each successful transmission, gene drift happens with probability `strain.mutationRate` **per gene**:

- Continuous genes (attackRate, IFR, immunityWaneRate, mutationRate): Gaussian drift, σ = 5% of current value, clamped to [0,1].
- Integer genes (incubation, infectious, range): ±1 with equal probability.

A new strain is allocated **only if the genotype changed**. The strain pool is capped (e.g., 65,535 — fits in Uint16). When full, near-identical strains are merged.

**Selection is implicit:** strains that spread well dominate the population because their cells transmit them. No fitness function needed. *This replaces v2's destructive mutation* (`Math.round(Math.random() * 35)` teleports genes to random values, which is drift not selection).

### 6.5 Defenses

```ts
type Defense = {
  protection: number;       // [0,1] reduction in incoming attack success
  sourceControl: number;    // [0,1] reduction in outgoing attack success
  mortalityReduction: number; // [0,1] reduction in IFR if infected anyway
  uptake: number;           // [0,1] proportion of population that has it
};
```

Defenses **stack multiplicatively**. If both attacker and defender wear masks, transmission probability =
`strain.attackRate × (1 - attacker.sourceControl) × (1 - defender.protection)`.

V3 must support **N defenses** as a list, not the v2-hardcoded `[mask, vaccine]`. Adding a third (e.g., antiviral, ventilation) should be a config change, not a code change.

### 6.6 Neighborhood / spatial index

- Toroidal grid (wraps at edges) — eliminates boundary artifacts.
- Manhattan-distance neighborhood, range R. Number of neighbors = 2R(R+1).
- **Precompute the offset list once per range change:**
  `const offsets = [ {dx,dy}, ... ]`. At step time, for each infectious cell, iterate offsets and resolve `(x+dx) mod size, (y+dy) mod size`.
- **Do not store per-cell neighbor object lists** (v2 does, costing ~12 × 8 bytes × N = ~100 MB at 1M cells).

### 6.7 Step algorithm (per tick)

```
1. Snapshot current state into prevState (single Uint8Array clone).
2. For each cell whose prevState == I:
     For each neighbor offset:
        if prevState[neighbor] == S:
           p = attackRate * (1-srcCtrl) * (1-protection)
           if rng() < p: mark neighbor as E in nextState, copy strainId
3. For each cell:
     if E or I: infectedAge++
     if E and infectedAge >= incubation: → I
     if I and infectedAge >= incubation+infectious:
        if rng() < IFR * (1-mortRed): → D else: → R; infectedAge=0
     if R and rng() < waneRate/365: → S
     if D and birthRate>0 and aliveNeighborFraction>0.5 and rng()<birthRate: → S
4. Swap prevState ↔ state.
5. Accumulate stats; postMessage frame.
```

Two-buffer flip is mandatory — without it, infections within a tick cascade and break SEIR ordering (a bug v2 has).

### 6.8 R₀ / R_eff computation

Don't fake it like v2 (`numNeighbors × attackRate × infectiousDays`).

- **R₀:** simulate one infectious cell on an all-susceptible grid; count secondary infections; average over multiple seeds.
- **R_eff (live):** running average of (new infections / new infectious cells) over a sliding window.
- Display both. Show the "naive" formula as a tooltip footnote, not the headline number.

### 6.9 Performance targets

| Population | Target tick rate | Renderer |
|---|---|---|
| 5k    | 60 tps | Canvas2D, sprites OK |
| 50k   | 60 tps | Canvas2D, ImageData |
| 500k  | 30 tps | Canvas2D ImageData |
| 1M+   | 15 tps | WebGL2 instanced |

Sim cost on a modern laptop should be ≤ 5 ms/tick at 50k cells, ≤ 50 ms/tick at 1M.

---

## 7. Renderer

- Renderer reads the transferred `Uint8Array` and paints. **No DOM elements per cell, ever.**
- Default: `ctx.putImageData(...)` — one paint per frame, color LUT indexed by state byte.
- Sprite mode (population ≤ 2500): an OffscreenCanvas atlas of the SVG sprites (person/exposed/infectious/zombie/headstone/baby + mask/vax overlays); blit per cell.
- WebGL2 mode: a single `gl.TEXIMAGE2D` upload of the state buffer + a fragment shader doing the LUT lookup — handles 4096×4096 grids comfortably.
- Color palette is theme-aware; expose CSS variables and read them once at frame start.
- A subtle radial vignette + gridless background = the "petri dish" feel without any DOM-trickery.

---

## 8. UI / UX

V3 is also the UX redux of MemeLab — see `ISSUES.md` for the catalog of v2 UX problems being fixed here.

### 8.1 Layout

Mobile-first, three breakpoints:

- **Compact (<768 px):** single column. Petri dish on top (square, full width). Tabbed control drawer below: `[Disease] [Defenses] [Population] [Stats]`.
- **Comfortable (768–1280 px):** petri left ~60%, controls right ~40%, chart slides under petri.
- **Wide (>1280 px):** three columns — left panel (Population + Defenses), petri + chart center, right panel (Disease + Strain tree).

Use CSS Grid, not floats. (v2 is float-based and breaks below 1024 px.)

### 8.2 Controls

| Control | Behavior |
|---|---|
| **Play / Pause / Step / Reset** | Persistent toolbar above petri. Keyboard: `Space`, `→`, `R`. |
| **Speed** | Discrete: 0.25× / 0.5× / 1× / 2× / 4× / 8× / 16× / 32×. |
| **Disease preset dropdown** | Click-to-open (not hover — broken on touch in v2). Searchable. Custom slot. |
| **Param sliders** | Numeric input + slider + reset-to-default chip. Live-update label as `{name}: {value}{unit}`. Throttle slider → sim updates to 60 Hz. |
| **Defense cards** | One card per defense (mask, vax, …). Cards collapsible. "Add defense" button for custom defenses. |
| **Permalink button** | Copies URL with full state encoded. |
| **Export** | Menu: PNG snapshot, MP4 (MediaRecorder), CSV (long stats), JSON (config + stats). |
| **A/B compare toggle** | Splits petri into two synced simulations with parameter overrides on the right. |

### 8.3 Visual hierarchy

- The petri dish is the hero — at least 60% of viewport area when populated.
- Big-number stats (Day, Dead %, Infected %, R_eff) above the dish.
- Time-series chart **always visible** (collapsible on mobile), with brushable timeline that doubles as a scrubber.
- Strain lineage tree appears **only** when natural selection is on. Tree shows parent→child edges; node size = current population share.

### 8.4 Microinteractions

- Hover a cell → tooltip with that cell's state, age, defenses, current strain ID.
- Click a cell → "follow" mode pins the tooltip and highlights its neighborhood.
- Slider tick marks at named presets (e.g., on Attack Rate, marks for SARS-2, Measles).
- When a slider crosses a critical threshold (e.g., R_eff drops below 1), a thin animated highlight on the chart.

### 8.5 Accessibility

- All controls keyboard-reachable; focus rings preserved.
- ARIA labels on every slider; `aria-live="polite"` on stat counters.
- Color-blind safe palette; never use color *alone* to encode state — pair with sprite or pattern.
- `prefers-reduced-motion` halves animation; sim still runs but transitions are instant.
- Color contrast ≥ 4.5:1 for text.
- All SVG assets get `<title>` and `aria-label`.

### 8.6 Theming

- Two built-in themes: **Petri** (light) and **Lab** (dark). Sprite themes (Emoji, Forest from v1) are independent of color theme.
- All colors via CSS custom properties on `:root` / `[data-theme="dark"]`.

### 8.7 Onboarding

- First visit: one-card overlay explaining the petri dish, with a "Run a SARS-2 outbreak" CTA that auto-loads a preset and presses play.
- "?" in the corner reopens the explainer; below it, a 3-step guided tour highlighting the disease panel, defense panel, and chart.
- No modal walls. No email capture. No analytics consent banner unless analytics is added (don't add analytics for V3.0).

---

## 9. URL state / permalinks

State that round-trips through the URL hash:

```
#/sim
  ?seed=<base36>
  &n=<gridEdge>
  &disease=<presetSlug or 'custom'>
  &dgenes=<base64url packed strain genes>
  &defenses=<base64url packed defense list>
  &mut=<0|1>
  &speed=<int>
  &theme=<petri|lab>
```

- Total length ≤ 1 KB (well under URL practical limits).
- Decoder is tolerant: missing keys → defaults; unknown keys ignored.
- "Copy permalink" is a one-click button that uses the Clipboard API.

---

## 10. Persistence

- `localStorage` keys, all under `cda_v3:` prefix:
  - `cda_v3:userPresets` — user-saved disease/defense presets.
  - `cda_v3:lastConfig` — restored on `/sim` if no URL state.
  - `cda_v3:theme` — explicit theme override.
  - `cda_v3:onboarded` — boolean flag.
- Storage usage ≤ 100 KB. Schema versioned (`cda_v3:schemaVersion`); migrations explicit.

---

## 11. Testing

- **Unit (Vitest):** sim engine. For each step rule, a deterministic test with a fixed seed asserting exact state after N ticks. Tests live next to source (`engine.test.ts`).
- **Property (fast-check):** invariants that must hold every tick — `S+E+I+R+D == N`, no negative counts, `D` is terminal, `infectedAge` is monotonic until recovery.
- **Golden runs:** seeded scenarios committed as JSON; CI re-runs and diffs the long-stats array. Detects sim drift on refactor.
- **e2e (Playwright):** load page, change disease, press play, assert chart renders, copy permalink, reload, assert state restored.
- **Performance budget tests:** headless run of 1M-cell grid for 100 ticks; fail CI if > 2× target.

Coverage target: 90%+ on `src/sim/`. UI coverage less strict.

---

## 12. Project layout

```
/
├── index.html
├── public/
│   └── assets/            # SVGs (cell sprites, masks, syringe, biohazard, …)
├── src/
│   ├── main.ts            # bootstrap
│   ├── ui/
│   │   ├── App.ts
│   │   ├── ControlPanel.ts
│   │   ├── Petri.ts       # canvas / webgl renderer
│   │   ├── Chart.ts       # uPlot wrapper
│   │   ├── Stats.ts
│   │   ├── PresetPicker.ts
│   │   └── theme.css
│   ├── sim/               # pure TS, no DOM imports
│   │   ├── engine.ts      # SimulationEngine
│   │   ├── population.ts  # SoA + spatial index
│   │   ├── strain.ts
│   │   ├── defense.ts
│   │   ├── rng.ts
│   │   └── presets.ts
│   ├── worker/
│   │   └── sim.worker.ts  # owns SimulationEngine; postMessage protocol
│   └── lib/
│       ├── url-state.ts
│       └── storage.ts
├── tests/
│   ├── engine.test.ts
│   ├── invariants.test.ts
│   └── e2e/
├── .github/workflows/deploy.yml
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## 13. CI / CD

`.github/workflows/deploy.yml`:

1. Trigger: push to `main`.
2. Steps: setup-node → `npm ci` → `npm run lint` → `npm run test` → `npm run build` → upload `dist/` as `gh-pages` artifact → `actions/deploy-pages@v4`.
3. PR builds run lint + test + build but skip deploy.
4. Cache `node_modules` and Vite build cache.
5. Failing perf budget = failing CI.

`vite.config.ts` must set `base: '/<repo-name>/'` for project-page deploy. Use an env var so the same config works for `username.github.io` (root).

---

## 14. Migration from v2

There is **no code migration path**. Take from v2:

- The list of disease presets (genes), verbatim, into `src/sim/presets.ts`.
- The SVG sprite assets (CellSprites/, defenses/, TitleScreen/) — copy verbatim into `public/assets/`.
- The visual identity: petri dish framing, biohazard/microbe iconography, the "MemeLab" / "Institute Of Armchair Epidemiology" branding if retained.
- The conceptual model documentation from `Cellular-Defense-Automata/TechnicalOverview.md` (citations, 12-nearest-neighbors rationale, etc.) — keep these as comments where relevant in `src/sim/`.

Do not port any v2 JS classes directly. They have logic bugs (see `ISSUES.md`) that are easier to skip than to fix.

---

## 15. Milestones

**M0 — Skeleton (1 week):** Vite scaffold, TS strict, GH Pages deploy of "hello world", ESLint/Prettier, Vitest, Playwright baseline. CI green.

**M1 — Sim core (2 weeks):** SEIR-D engine with SoA storage, seeded RNG, deterministic golden tests, headless 1M-cell perf benchmark. Worker wired up. *No UI yet — runs from a test harness.*

**M2 — Renderer + minimal UI (2 weeks):** Canvas2D ImageData renderer, play/pause/step/reset, one preset (SARS-2 wild-type), one slider (population size), top-line stats. Looks ugly but works.

**M3 — Full UI (2 weeks):** All panels, all sliders, preset picker, defense cards, chart, theme switcher, permalink. Mobile responsive.

**M4 — Polish & ship V3.0 (1 week):** Onboarding card, accessibility audit, exports (PNG/CSV/JSON), strain lineage tree, performance pass, docs.

**Post-V3.0:** WebGL2 renderer for >1M, A/B compare mode, MP4 export, custom-graph topologies.

---

## 16. Definition of done (V3.0)

- [ ] Site loads in < 1.5 s on a cold cache, ≤ 250 KB gzipped JS.
- [ ] 100k-cell SARS-2 run sustains 30 tps on a 2020-era laptop.
- [ ] Lighthouse ≥ 95 across Performance / Accessibility / Best Practices / SEO.
- [ ] Deterministic: same permalink → same chart, byte-identical.
- [ ] Works in current Chrome, Firefox, Safari (desktop + mobile).
- [ ] Keyboard-navigable end to end.
- [ ] Zero `console.log` in production build; one consolidated dev-mode logger.
- [ ] CI green on every commit; e2e + golden tests required for merge.
