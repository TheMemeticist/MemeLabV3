# MemeLabV3 — Geometry-Extended Engine Architecture

## System Overview

```mermaid
graph TD
    subgraph UI_THREAD["🖥️  UI Thread"]
        direction TB
        APP["App.ts\n─────────────\nConfig hydration\nWorker commands\nEpidemic lifecycle\nPermalink · Export"]
        CP["ControlPanel.ts\nSliders + Switches\nLeft panel · Right panel"]
        GEO_UI["🆕 Geometry Selector\ndropdown / segmented\ntriggers updateConfig"]
        PETRI["Petri.ts\nCanvas renderer"]
        CHART["Chart.ts\nuPlot time-series\nCompartments · R_eff"]
        STATS["Stats.ts\nDay · I · R · D · R₀ · R_eff"]

        APP --> CP
        APP --> PETRI
        APP --> CHART
        APP --> STATS
        CP --> GEO_UI
    end

    subgraph TYPES["types.ts — shared protocol"]
        SC["SimConfig\n─────────────────────────────\nseed · size · strain · defenses\nlockdown · quarantine\n🆕 geometry: 'square'|'tri'|'hex'|'meanfield'"]
        WC["WorkerCommand (discriminated union)\ninit | play | pause | step\nreset | updateConfig | patchConfig"]
        FM["FrameMessage (Transferable)\n────────────────────────────────\nstate: Uint8Array  ← zero-copy\ndefenses: Uint8Array\nquarantined: Uint8Array | null\nstats: SimStats · longStats: LongStats\nrNaught: number | null"]
    end

    subgraph WORKER["⚙️  Web Worker  (sim.worker.ts)"]
        direction TB
        LOOP["setTimeout loop\nTPS-paced · catch-up capped at 4 steps"]
        ENG["Engine"]
        LOOP --> ENG
    end

    APP -->|"postMessage(WorkerCommand)"| WC
    WC --> WORKER
    ENG -->|"postMessage(FrameMessage, [transfers])"| FM
    FM -->|"onmessage"| APP
```

---

## Engine Internals + Geometry Abstraction

```mermaid
graph TD
    subgraph ENGINE["Engine  (engine.ts)"]
        direction TB

        subgraph BUFFERS["PopulationBuffers  SoA typed arrays  (population.ts)"]
            direction LR
            B1["state: Uint8Array\nnext:  Uint8Array\n— SEIR-D per cell —\n(double-buffer, swapped)"]
            B2["age:         Uint16Array\ninfectedAge: Uint16Array\nstrainId:    Uint16Array"]
            B3["defenses:        Uint8Array\nlockdownCompliant: Uint8Array\nquarantined:       Uint8Array\nquarantineExpiry:  Int32Array"]
        end

        RNG["Rng  (rng.ts)\n──────────────────\nxoshiro128**\nSole entropy source\nbernoulli · gaussian · intRange"]
        SP["StrainPool  (strain.ts)\n──────────────────────────\nlineage registry  ≤ 4096\nspawnChild() — Gaussian drift\nper gene at mutationRate"]
        DEF["ResolvedDefenses  (defense.ts)\n───────────────────────────────\nprotection[]  sourceControl[]\nmortalityReduction[]  uptake[]\nindexed by bitmask bit position"]

        subgraph GEO["🆕 Geometry Abstraction  (neighbors.ts)"]
            direction TB
            IFACE["LatticeGeometry interface\n─────────────────────────────────────────────────\ngetOffsets(range) → Int32Array  ← [dx,dy,...] pairs\ngetBirthOffsets()  → Int32Array  ← Moore-equiv per lattice\ncoordToIndex(q, r, size) → number"]

            SQ["SquareLattice\n────────────────\nManhattan |dx|+|dy| ≤ range\nexisting behavior, unchanged\ntorus(x, size) wrapping"]
            TRI["TriangularLattice\n──────────────────\n6 neighbors, offset-row layout\nalternating up/down triangles\nrow-parity neighbor table"]
            HEX["HexLattice\n────────────────\n6 equidistant neighbors\naxial coords (q,r)\nflat-top or pointy-top\nRed Blob Games formula"]
            MF["MeanField\n────────────────\nreturns EMPTY offsets\nstep() special-cases:\nglobal Bernoulli(I/N × attack)"]

            IFACE --> SQ
            IFACE --> TRI
            IFACE --> HEX
            IFACE --> MF
        end

        subgraph TICK["step() — tick loop"]
            direction TB
            T0["① Snapshot\nnext.set(state)"]
            T1["② Transmission pass\nfor each Infectious cell i:\n  get attackerStrain range\n  offsets = geometry.getOffsets(range)\n  for each (dx,dy) in offsets:\n    j = torus(x+dx) · torus(y+dy)\n    if state[j] == Susceptible:\n      Bernoulli(attack × srcMul × protMul)\n      → next[j] = Exposed"]
            T2["③ Quarantine detection\nfor each Infectious cell i:\n  Bernoulli(detectionRate)\n  offsets = geometry.getOffsets(contactsRange)\n  mark quarantined[i..neighbors]"]
            T3["④ Life-cycle pass\nExposed → Infectious (incubation)\nInfectious → Recovered|Dead (IFR)\nRecovered → Susceptible (wane)\nDead → Susceptible (birth × aliveNeighborFraction)"]
            T4["⑤ Buffer swap\npop.state ↔ pop.next\ntick++"]
            T5["⑥ Stats\ncount S E I R D\ncompute R_eff (14-tick window)\npushLong() ← LONG_CAP=4096"]

            T0 --> T1 --> T2 --> T3 --> T4 --> T5
        end

        GEO --> T1
        GEO --> T2
        RNG --> T1
        RNG --> T2
        RNG --> T3
        SP  --> T1
        SP  --> T3
        DEF --> T1
        DEF --> T3
        DEF --> T4
        BUFFERS --> TICK
    end
```

---

## Config Change Routing  (App.ts → Worker)

```mermaid
flowchart TD
    CHG["User changes a control"]

    CHG --> Q1{"needsRebuild()?"}

    Q1 -->|"YES — structural change\nsize · seed · strain genes\n🆕 geometry"| HARD["cmd: updateConfig\n────────────────────────\nWorker: new Engine(config)\nRNG reset · full reseed\nhideEndedBanner\nauto-play fresh run"]

    Q1 -->|"NO — soft change\ndefense uptakes · multipliers\nlockdown toggles · quarantine params"| SOFT["cmd: patchConfig\n────────────────────────\nEngine.patchConfig()\nstochastic resample of\nper-cell defense flags\nlockdownCompliant flags\nno RNG-sequence reset"]

    HARD --> WORKER_CMD["worker.postMessage(cmd)"]
    SOFT --> WORKER_CMD

    WORKER_CMD --> URL["url-state.ts encode()\n🆕 geometry= param added\nto permalink hash"]
```

---

## Petri Renderer — Geometry-Aware Paint Path  (Petri.ts)

```mermaid
flowchart TD
    FRAME["FrameMessage received\nstate · defenses · quarantined · size\n🆕 geometry"]

    FRAME --> MODE{"size ≤ 60?"}

    MODE -->|"sprite mode\n(small inspectable grids)"| SPRITES["SpriteAtlas.draw()\nper-cell SVG icons\ndefense overlays"]

    MODE -->|"pixel mode\n(large grids, fast path)"| GEO2{"geometry?"}

    GEO2 -->|"square\n(current)"| RECT["putImageData()\nflat Uint8 → RGBA\nO(N) direct write"]

    GEO2 -->|"hexagonal"| HEXPAINT["ctx.beginPath()\nhexPolygon(q, r, tileR)\nctx.fill() per cell\naxial → pixel formula"]

    GEO2 -->|"triangular"| TRIPAINT["ctx.beginPath()\ntriPolygon(col, row, upDown)\nctx.fill() per cell\nalternating orientation"]

    GEO2 -->|"mean-field"| MFPAINT["uniform color fill\n= f(I/N) gradient\nor disable canvas\nrely on uPlot chart"]

    RECT --> QBORDER
    HEXPAINT --> QBORDER
    TRIPAINT --> QBORDER
    MFPAINT --> QBORDER

    QBORDER["drawQuarantineBorders()\ndashed amber outline\n(geometry-adapted stroke path)"]
```

---

## Mean-Field Special Case  (inside Engine.step())

```mermaid
flowchart LR
    subgraph MF_STEP["step() when geometry = 'meanfield'"]
        direction TB
        S1["Skip spatial loop entirely\n(no offense table needed)"]
        S2["Count I = infectious cells\nCount S = susceptible cells\nN = total population"]
        S3["p_contact = attackRate × (I/N)\nnewExp = Binomial(S, p_contact)\n≈ Bernoulli per cell for exact counts"]
        S4["Pick newExp random Susceptible cells\nset next[j] = Exposed\n(uniform random, no spatial bias)"]
        S5["Life-cycle pass runs as normal\n(SEIR transitions, IFR, wane, births)"]
        S6["Stats identical — S E I R D\nR_eff from same 14-tick window"]
        S1 --> S2 --> S3 --> S4 --> S5 --> S6
    end
```
