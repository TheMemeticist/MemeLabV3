# MemeLab CDA v3 — UX Analysis & Improvement Proposals

*Authored from the dual vantage of simulation science and cognitive interface theory.*
*Every finding is traceable to source files cited inline.*

---

## Theoretical Framework

Three bodies of theory drive this analysis.

**Don Hoffman's Interface Theory of Perception.** Hoffman's central claim — developed formally in *The Case Against Reality* (2019) and grounded in evolutionary game theory — is that perception did not evolve to represent the world faithfully. It evolved to present *fitness-relevant icons*: simplified action affordances that hide mechanistic reality behind task-relevant surfaces. The desktop metaphor is his canonical example: a file-deletion icon does not represent transistors switching; it represents the *action* of deleting a file in terms the user can act on. The organism that sees the "truth" of quantum fields loses the fitness game to the organism that sees a tiger.

Applied to MemeLab: the petri dish is an icon of a population. The parameters exposed in the control panels are *not* icons — they are raw computational parameters with no direct fitness-relevant mapping to user goals ("will this outbreak end?", "do masks help?"). The first principle of improvement, therefore, is: **translate computational parameters into action-relevant icons wherever possible.**

**Cognitive Load Theory (Sweller, 1988; Paas & van Merriënboer, 2020).** Working memory can process roughly 7 ± 2 chunks simultaneously (Miller, 1956). Extraneous cognitive load — load not directly serving the learning goal — competes with the germane load that builds schema. MemeLab currently exposes up to 30 sliders across two panels before a user has formed a mental model of SEIRS dynamics. This is not a critique of the implementation (collapsible cards, log-scale immunity slider, live patch — all excellent) but of *information architecture*: the full parameter space is reachable in two clicks from a blank state.

**Ecological Interface Design (Rasmussen, 1985; Vicente & Rasmussen, 1992).** EID holds that interfaces should map *domain constraints* — the laws that govern the work domain — directly onto perceptual forms. A nuclear plant operator doesn't need to see valve positions; they need to see *mass balance*. An epidemiologist doesn't need to see `attackRate = 0.22`; they need to see *"one infectious person generates 2.3 secondary infections in a naïve population"*. The constraint driving an epidemic is R₀ relative to 1.0 and the herd immunity threshold (HIT) relative to current immunity prevalence. Neither of these constraints is rendered anywhere in MemeLab v3.

---

## Current-State Audit





### 4. The Chart — Missing Epidemiological Landmarks

**File:** `src/ui/Chart.ts:1–18`

The chart shows compartment trajectories (S/E/I/R/D) or R_eff over time, with intervention markers. This is correct and the architecture is clean.

What is absent, by EID standards, are *domain constraints rendered as perceptual landmarks*:

- **Herd immunity threshold line:** A horizontal reference line at `HIT = (1 - 1/R₀) × population` on the Recovered series shows the user *when* immunity will suppress transmission. Without it, the chart shows a curve that rises to some value the user cannot interpret.
- **Epidemic peak annotation:** When `newInfections` crosses its maximum and begins falling, a labeled dot ("Peak: Day X, Y% infected") makes the most important moment in an outbreak trajectory legible. This is standard in CDC epidemiological curve representations (the classic "epi curve" with peak annotation).
- **R_eff = 1.0 reference line on the R_eff view:** Already close (the view exists) but lacking the horizontal threshold line that gives R_eff its meaning. R_eff > 1 is growth; < 1 is collapse. Without the line, it's just a number bouncing around.
- **Series toggle discoverability:** Clicking a `<th>` legend element hides/shows a series (mech-log item 23). This is an invisible affordance — no visual cue that column headers are clickable.

### 5. Onboarding — Passive Instructions vs. Active Encounter

**File:** `src/ui/Onboarding.ts:34–44`

The onboarding card presents four bullet instructions: pick a disease, tune defenses, press Space, share via Permalink. This is a *procedural* first-run experience. It describes actions but creates no *encounter with the phenomenon*.

PhET Interactive Simulations (Perkins et al., 2006; Wieman et al., 2008) — the gold standard for educational simulation UX — found consistently that passive instruction lists fail to prime the discovery mindset. The most effective onboarding for a simulation is a guided *observation*: show the system doing something, annotate it, then hand control to the user. The encounter with the emergent behavior (an outbreak spreading across a grid, visibly accelerating) creates the intrinsic motivation to understand the parameters.

The CTA "Run a Bundibugyo Ebola outbreak →" is specific but opaque to the uninitiated. Bundibugyo ebolavirus (BDBV) has a 34% IFR and attack rate of 7% — it kills brutally but spreads slowly. The first-run visual experience is: most cells stay green for many days, then a few die without ever infecting many others. The intended drama (high lethality) is undermined by the slow spread, particularly on an 8×8 grid where the outbreak often extinguishes before peak. The educational insight — that high lethality alone doesn't make a pandemic; spread rate does — is sophisticated and correct, but it requires an *explanation* to land. Without annotation, the user sees "nothing happened" and leaves.

### 6. The About Modal — Buried Calibration

**File:** `src/ui/AboutModal.ts:63–66`

The About modal explains R₀ and R_eff correctly: "R₀: expected secondary infections from one infectious cell on a fully-susceptible grid. Above 1 → outbreak grows; below 1 → it fizzles." This is the exact calibration information users need to interpret the stat row.

It is buried behind a `?` key or an "About" button. Users who have not found it are operating the simulation with R₀ and R_eff as uninterpreted numbers. The key insight — that R_eff = 1.0 is the phase transition — should be surfaced *adjacent* to the stat cell, not in a separate modal.

---

## Proposed Improvements

### P1 — Epidemic Phase Badge (Stats row)

**Priority: High. Implementation: ~2 hours. Research anchor: EID, Hoffman icon theory.**

Replace the raw R_eff number with a composite "phase badge" that combines R_eff value with an action-relevant classification:

```
[ GROWING  R_eff 2.3 ]   — red background when R_eff > 1.0
[ DECLINING  R_eff 0.7 ] — green background when R_eff < 1.0
[ ENDEMIC  R_eff ≈ 1.0 ] — amber, when oscillating around 1 for 20+ ticks
[ EXTINCT ]              — slate, E + I = 0 with no reseed pending
```

This is a direct Hoffman icon: it hides the rolling-window calculation behind a fitness-relevant category the user can act on. Keep the numeric R_eff in a tooltip or secondary position for users who want the raw value. Implementation touches `Stats.ts` only — no sim changes.

The epidemic phases map directly to classical SEIRS theory (Anderson & May, 1991; Hethcote, 2000): the phase transition at R_eff = 1.0 is the deterministic boundary between epidemic growth and decline.

### P2 — Herd Immunity Threshold Line on Chart

**Priority: High. Implementation: ~3 hours. Research anchor: EID, standard epi curve representation.**

Render a horizontal dotted line on the chart at `y = HIT * N` on the Recovered series (or `y = HIT * 100` in percentage terms). Label it "Herd immunity threshold (HIT)".

Formula: `HIT = (1 - 1/R₀) × 100%`

When the Recovered curve crosses this line, R_eff will (deterministically) fall below 1.0 and the epidemic will begin declining. This is the single most important landmark in an SEIRS simulation and it is currently invisible.

Implementation in `Chart.ts`: add a `paintHIT(r0: number)` method that draws a horizontal rule and label in `hooks.draw`, analogous to the existing `paintMarkers()`. The R₀ value is already passed to the chart via `App.ts` after worker `rNaught` messages. Update `App.ts` to pass `rNaught` to `chart.setHIT(rNaught)`.

### P3 — Epidemic Peak Annotation

**Priority: Medium. Implementation: ~2 hours. Research anchor: CDC epi curve standard.**

When `newInfections[t] < newInfections[t-1]` for the first time after a minimum threshold (e.g., peak > 5% of N), mark the chart with a labeled dot at the peak value: "Peak: Day X · Y% infected".

This annotation is the iconic form of the CDC "epidemic curve peak" — the most reproduced visualization in outbreak surveillance literature. It answers the question users most want to ask: "when did it get worst?"

Implementation: track peak in `App.ts` by comparing `lastFrame.stats.newInfections` values. Emit a non-intervention marker to `interventionEvents[]` (or a separate `peakEvent`) that `Chart.ts` renders as a circle + label rather than a chip.

### P4 — R_eff = 1.0 Reference Line on R_eff Chart View

**Priority: High. Implementation: ~30 minutes.**

In `Chart.ts`, when `view === 'reff'`, draw a dotted horizontal line at y = 1.0 in the Y-axis area. Label it "Epidemic grows above this line". This is a sub-case of P2 but for the R_eff view specifically.

This is the most minimal possible EID fix: a single horizontal rule transforms an uninterpreted time-series into a phase-diagnostic display.

### P5 — Semantic Slider Tiers (Contextual Labels)

**Priority: Medium. Implementation: ~3 hours. Research anchor: Cognitive load theory, Hoffman icon theory.**

The current slider label for attack rate is "Attack Rate" with a numeric value. This requires the user to know epidemiological vocabulary to interpret it. Add a *tier label* next to the value that maps the numeric range to a human-scale descriptor:

| Slider | Value | Current label | Add: tier label |
|--------|-------|---------------|-----------------|
| Attack Rate | 0.22 | `22%` | `Moderate (1 in 5 contacts)` |
| IFR | 0.32 | `32%` | `High (1 in 3 die)` |
| Range | 2 | `2` | `Droplet (≤ 2m)` |
| Range | 4 | `4` | `Airborne (≤ 4m)` |
| Incubation | 18 | `18 days` | `Long (silent spread window)` |
| Immunity | 3650 | `10 years` | `Durable` |
| Immunity | 180 | `6 months` | `Short (endemic risk)` |

These are Hoffman icons: they translate the computational parameter into the fitness-relevant category that drives user decisions. Implementation in `ControlPanel.ts` as a helper `strainTierLabel(key, value)`.

The "silent spread window" descriptor for long incubation is particularly important: it maps to the core epidemiological insight that Exposed cells spread infection invisibly before symptoms appear — which is *the* central teaching moment of MemeLab's SEIRS vs. SIR distinction.

### P6 — Fix Seed Infections Slider Label

**Priority: High. Implementation: 15 minutes. File: `ControlPanel.ts:81`**

The slider reads `0%` but the format function overrides it to `"1 cell (center)"`. This is a perceptual contradiction. The slider thumb sits at zero; the label says something positive exists. Hoffman would call this a broken icon.

Correct options:
1. Set slider `min: 1` and relabel to "Additional seed infections", with 1 meaning "center only"
2. Or: remove the slider from the population section entirely and add a `<select>`: "Seed: 1 cell (center) | 5% | 10% | 25% | 50%"
3. Or: keep slider but start thumb at `min: 1` and make the `format(1)` call return `"1 cell (center)"` at min value

Option 1 is the lightest touch. The key fix is that the visual position of the slider (at leftmost = zero) must not contradict what the simulation will do.

### P7 — Herd Immunity Threshold in Stats Row

**Priority: Medium. Implementation: ~1 hour.**

Add a seventh stat cell: `HIT %` showing `(1 - 1/R₀) × 100`, updated whenever `rNaught` updates. Label it "Need immune" or "Herd threshold". This surfaces the most important derived quantity in SEIR theory directly in the stats row, adjacent to the Recovered% that the user watches accumulate.

When Recovered% ≥ HIT, style the HIT cell with the "phase achieved" treatment (green tint). This gives users a concrete, real-time progress indicator toward epidemic suppression.

### P8 — Absolute Population Count in Stats

**Priority: Medium. Implementation: ~30 minutes. File: `Stats.ts`**

Add `N = size² - dead_count` as a secondary figure beneath or beside the infected percentage. On a 64-cell grid, "Infected: 15.6%" is nearly meaningless (10 cells) — showing "10 / 61 alive" anchors the user to the stochasticity of small grids.

This also makes the epidemic phase more legible: at N=64, peak R_eff fluctuates wildly; at N=10,000, it stabilizes. Showing N gives users a calibration for how much to trust the numbers they see.

### P10 — Disease Preset "Watch for" Contextual Blurbs

**Priority: Medium. Implementation: ~2 hours. File: `src/sim/presets.ts`**

Each preset has a `blurb` field. These are currently descriptive ("High IFR, direct-contact transmission"). Extend them to include *simulation-specific insight* — what should the user watch for that they could not predict from the parameters alone?

Examples:

- **BDBV Ebola:** *"Despite 34% IFR, this outbreak usually ends quickly — the virus kills faster than it can spread. Watch R₀: it's close to 1.0. Defenses don't need to be perfect to end it."*
- **Andes Hantavirus:** *"18-day incubation means 18 days of invisible spread before any cells turn red. Turn on 'Natural Selection' and watch new strains appear during that silent window."*
- **Measles:** *"Range = 4 means airborne transmission — each infectious cell touches 40+ neighbors per tick. HIT is ~94%: nearly everyone must be vaccinated. Try the vaccine at 95% uptake."*
- **Omega Virus:** *"Hypothetical worst-case: R₀ ≈ 45, 30-day immunity, 80% IFR. This cannot end. Watch the model cycle through extinction and re-import indefinitely. This is the endemic equilibrium of something that kills faster than it can establish herd immunity."*

These blurbs are Hoffman icons in prose: they translate computational parameters into the narratives of causal mechanisms users can reason about.

### P11 — Legend Series Toggle Discoverability

**Priority: Low. Implementation: ~1 hour. File: `Chart.ts`**

The click-to-hide series mechanic on chart legend `<th>` elements is invisible. Add a `cursor: pointer`, a subtle hover underline, and a small `◉ / ○` toggle indicator. A one-line tooltip `data-tip="Click to hide this series"` on each legend header would suffice.

### P12 — Quarantine Visibility at Pixel Mode Densities

**Priority: Medium. Implementation: ~3 hours. File: `src/ui/Petri.ts`**

Currently, quarantine amber borders are rendered only when tile ≥ 3px. At typical pixel-mode grid sizes (80–200 cells), tiles are 1–4px and the border is invisible or a single pixel that disappears in the color field.

Alternative rendering for sub-3px tiles: apply a distinct *LUT color* to quarantined cells — e.g., tint their existing state color toward amber. A quarantined Susceptible (green) becomes tan; a quarantined Infectious (red) becomes orange-red. This preserves the SEIRS state information while adding the quarantine dimension through a consistent hue shift rather than a border that disappears at density.

Implementation: add a `quarantineTint(r, g, b)` function in `Petri.ts` that blends the cell color 30% toward amber `(245, 158, 11)` for any quarantined cell, applied in the pixel-mode LUT pass.

### P13 — "About" Inline Tooltip for R₀ and R_eff

**Priority: High. Implementation: ~30 minutes.**

The calibration explanation for R₀ and R_eff is buried in the About modal. Add `data-tip` attributes to the R₀ and R_eff stat cells in `Stats.ts`:

- `data-tip="R₀: expected infections from one case in a fully susceptible population. Above 1 = outbreak grows."` on the R₀ cell
- `data-tip="R_eff: current growth factor. Above 1 = growing; below 1 = collapsing. Target: push below 1."` on the R_eff cell

The tooltip infrastructure is already in place (`Tooltip.ts`). This is a two-line change that surfaces the most critical calibration information exactly at the point of use.

### P14 — Onboarding Encounter Redesign

**Priority: Medium. Implementation: ~4 hours. File: `src/ui/Onboarding.ts`**

Replace the four-step instruction list with a *two-beat encounter*:

**Beat 1 (0–3 seconds after accept):** The sim starts automatically. An overlay annotation appears adjacent to the petri dish: `"One infected person (red) enters a community of 64."` After 3 real-seconds, annotation fades.

**Beat 2 (~Day 6 in-sim):** When the first E→I transition fires and a red cell appears, a second annotation: `"Neighbors are now infectious. Watch R_eff — if it stays above 1.0, the outbreak will grow."` This annotation dismisses on any interaction.

After both beats, full control transfers to the user. This is the PhET pattern: create the observation, annotate it with the concept, then release. The user has seen the core phenomenon (spread) and the core metric (R_eff threshold) in context before they touch a single slider.

This is also aligned with Hoffman: the *encounter* is the icon. The instructions list is not an icon of an epidemic — it's an icon of a user manual.

### P15 — Mutation/Strain Sparkline in Stats

**Priority: Low. Implementation: ~2 hours.**

When `mutate = true` and `strains > 1`, show a small horizontal sparkline in the stats row tracking strain count over the last 50 ticks. The current "Strains: 3" is a point reading with no temporal context — the user cannot tell if strain diversity is growing (selection pressure active) or collapsed (bottleneck event). A 50-tick sparkline (30px wide, 12px tall) fits within the existing stat cell width.

This connects to the serial passage principle (About modal, link 5): watching strain count rise and then collapse as a dominant variant takes over is the core insight of the natural selection mode, and it currently has no temporal visualization.

---

## Priority Matrix

| ID | Change | Effort | User Impact | Files |
|----|--------|--------|-------------|-------|
| P1 | Epidemic phase badge | Low | Very High | `Stats.ts` |
| P4 | R_eff = 1.0 reference line | Very Low | High | `Chart.ts` |
| P13 | Inline tooltips for R₀ / R_eff | Very Low | High | `Stats.ts` |
| P6 | Fix seed slider label | Very Low | Medium | `ControlPanel.ts` |
| P2 | HIT line on chart | Medium | Very High | `Chart.ts`, `App.ts` |
| P7 | HIT % stat cell | Low | High | `Stats.ts`, `App.ts` |
| P3 | Epidemic peak annotation | Medium | High | `App.ts`, `Chart.ts` |
| P8 | Absolute N in stats | Very Low | Medium | `Stats.ts` |
| P9 | Small grid warning | Low | Medium | `App.ts` or `Stats.ts` |
| P10 | Preset "watch for" blurbs | Low | High | `presets.ts`, UI wiring |
| P5 | Semantic slider tiers | Medium | Medium | `ControlPanel.ts` |
| P11 | Legend toggle discoverability | Very Low | Low | `Chart.ts` |
| P12 | Quarantine tint at pixel mode | Medium | Medium | `Petri.ts` |
| P14 | Onboarding encounter redesign | High | High | `Onboarding.ts`, `App.ts` |
| P15 | Mutation sparkline | Medium | Low | `Stats.ts`, `Chart.ts` |

---

## The Core Thesis, Distilled

Hoffman's icon theory applied to MemeLab produces one diagnostic sentence: **the parameters the user controls are not the same as the questions the user is asking.** The user asks "will this community survive?" The interface shows `attackRate: 0.22`. These are not the same thing.

The improvements above, taken together, translate the simulation from a *parameter explorer* (useful to its author, opaque to its audience) into a *question-answering machine* — one where the answer to "will this community survive?" is surfaced as a phase badge, a threshold line, a HIT counter, and a contextual blurb that tells the user what to watch for before they've learned to watch for it.

The epidemiological science in MemeLab v3 is correct and, in several respects, genuinely sophisticated (the multiplicative defense math, the Gaussian drift mutation model, the anti-extinction reseed gating, the live-patch config diffing). None of the improvements above touch the sim engine. The gap is entirely in the interface layer — in the translation from `float attackRate` to *"one in five contacts leads to infection, and you need 55% immune to stop it"*.

---

*Sources cited: Hoffman, D. (2019). The Case Against Reality. Norton. · Sweller, J. (1988). Cognitive load during problem solving. Cognitive Science 12(2). · Vicente, K. & Rasmussen, J. (1992). Ecological interface design. IEEE Transactions on Systems, Man, and Cybernetics 22(4). · Anderson, R. & May, R. (1991). Infectious Diseases of Humans. Oxford. · Keeling, M. & Rohani, P. (2008). Modeling Infectious Diseases in Humans and Animals. Princeton. · Perkins, K. et al. (2006). PhET: Interactive simulations for teaching and learning physics. The Physics Teacher 44(1). · Miller, G. (1956). The magical number seven. Psychological Review 63(2).*
