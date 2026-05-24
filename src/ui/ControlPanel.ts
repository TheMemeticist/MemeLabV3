import type { GeometryType, InterventionKey, SimConfig, StrainGenes } from '../types';
import { Slider } from './Slider';
import { PresetPicker } from './PresetPicker';
import { findPreset, type DiseasePreset } from '../sim/presets';

export interface ControlPanelEvents {
  onConfigChange: (cfg: SimConfig) => void;
  onPresetChange: (preset: DiseasePreset) => void;
  onCustomNameChange?: (name: string | null) => void;
  onInterventionToggle?: (key: InterventionKey, on: boolean) => void;
}

export class ControlPanel {
  private cfg: SimConfig;
  private presetId: string;
  private events: ControlPanelEvents;

  // refs to slider components for programmatic updates
  private geoSelect!: HTMLSelectElement;
  private popSlider!: Slider;
  private seedInfSlider!: Slider;
  private birthSlider!: Slider;
  private maskSliders!: { protection: Slider; sourceControl: Slider; mortalityReduction: Slider; uptake: Slider };
  private vaxSliders!: { protection: Slider; sourceControl: Slider; mortalityReduction: Slider; uptake: Slider };
  private lockdownSliders!: { mobility: Slider; transmission: Slider; compliance: Slider };
  private quarantineSliders!: { detection: Slider; range: Slider; protection: Slider; sourceControl: Slider; duration: Slider };
  private strainSliders!: { attackRate: Slider; incubation: Slider; infectious: Slider; ifr: Slider; range: Slider; immunityDays: Slider; mutationRate: Slider };
  private r0Slider!: Slider;
  private picker!: PresetPicker;
  private switches: Record<string, HTMLInputElement> = {};

  constructor(cfg: SimConfig, presetId: string, events: ControlPanelEvents) {
    this.cfg = cfg;
    this.presetId = presetId;
    this.events = events;
  }

  buildLeft(host: HTMLElement): void {
    host.innerHTML = `
      <section class="panel collapsible" aria-label="Population" data-collapsed="false">
        <button type="button" class="panel-head" aria-expanded="true" data-toggle="population">
          <h3>Population <span class="rate-badge" data-badge="popsize">—</span></h3>
          <span class="panel-icon" aria-hidden="true">👥</span>
          <span class="panel-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="panel-body" data-section="population"></div>
      </section>
      <section class="panel collapsible" aria-label="Interventions" data-collapsed="false">
        <button type="button" class="panel-head" aria-expanded="true" data-toggle="interventions">
          <h3>Interventions</h3>
          <span class="panel-icon" aria-hidden="true">🛡️</span>
          <span class="panel-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="panel-body intervention-stack">
          ${this.interventionCardMarkup('mask', 'Mask', '😷')}
          ${this.interventionCardMarkup('vaccine', 'Vaccine', '💉')}
          ${this.interventionCardMarkup('lockdown', 'Lockdown', '🚧')}
          ${this.interventionCardMarkup('quarantine', 'Quarantine', '🚷')}
        </div>
      </section>
    `;
    const popHost = host.querySelector('[data-section="population"]') as HTMLElement;
    const maskHost = host.querySelector('[data-section="mask"]') as HTMLElement;
    const vaxHost = host.querySelector('[data-section="vaccine"]') as HTMLElement;
    const lockHost = host.querySelector('[data-section="lockdown"]') as HTMLElement;
    const qHost = host.querySelector('[data-section="quarantine"]') as HTMLElement;

    // Geometry selector
    const geoWrap = document.createElement('div');
    geoWrap.className = 'slider-row geo-row';
    geoWrap.innerHTML = `
      <label class="slider-label" for="geo-select">
        Lattice geometry
        <span class="slider-info" tabindex="0" data-tip="Mean-field: fully mixed, no spatial structure. Triangular: 3-neighbour cells. Square: 4-neighbour Manhattan diamond. Hexagonal: 6-neighbour isotropic tiles." aria-label="More info: Mean-field: fully mixed, no spatial structure. Triangular: 3-neighbour cells. Square: 4-neighbour Manhattan diamond. Hexagonal: 6-neighbour isotropic tiles.">i</span>
      </label>
      <select id="geo-select" class="geo-select">
        <option value="meanfield">⊙ Mean-field</option>
        <option value="triangular">▲ Triangular</option>
        <option value="square">■ Square</option>
        <option value="hexagonal">⬡ Hexagonal</option>
      </select>
    `;
    popHost.appendChild(geoWrap);
    this.geoSelect = geoWrap.querySelector('select') as HTMLSelectElement;
    this.geoSelect.value = this.cfg.geometry ?? 'square';
    this.geoSelect.addEventListener('change', () => {
      const prev = this.cfg.geometry ?? 'square';
      const next = this.geoSelect.value as GeometryType;
      if (prev !== 'meanfield' && next === 'meanfield') {
        // lattice → mean-field: convert current attackRate to R0 using MF_K
        const r0 = r0FromAttackRate(this.cfg.strain.attackRate, this.cfg.strain.infectious, MF_K);
        this.r0Slider.setValue(Math.round(r0 * 10) / 10, true);
      } else if (prev === 'meanfield' && next !== 'meanfield') {
        // mean-field → lattice: convert R0 back to attackRate using spatial k
        const r0 = this.r0Slider.value();
        const ar = attackRateFromR0(r0, this.cfg.strain.infectious, squareContactCount(this.cfg.strain.range));
        this.cfg.strain.attackRate = ar;
        this.strainSliders.attackRate.setValue(Math.round(ar * 100), true);
      }
      this.cfg.geometry = next;
      this.applyGeometryVisibility(next);
      this.dirty();
    });

    // Population
    this.popSlider = new Slider({
      id: 'pop-size', label: 'Grid size', min: 8, max: 320, step: 8,
      value: this.cfg.size,
      format: (v) => `${v}×${v}`,
      onChange: (v) => {
        this.cfg.size = v | 0;
        this.refreshPopBadge(this.cfg.size);
        this.dirty();
      },
    });
    this.refreshPopBadge(this.cfg.size);
    this.seedInfSlider = new Slider({
      id: 'seed-inf', label: 'Seed infections', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(this.cfg.seedInfections * 100),
      hint: '0% = single Exposed cell planted at the grid center. Any value above 0% seeds that fraction of cells uniformly at random in addition to the center cell.',
      format: (v) => v === 0 ? '1 cell (center)' : `${v}%`,
      onChange: (v) => { this.cfg.seedInfections = v / 100; this.dirty(); },
    });
    this.birthSlider = new Slider({
      id: 'birth-rate', label: 'Birth rate', min: 0, max: 5, step: 1, unit: '%',
      value: Math.round(this.cfg.birthRate * 100),
      onChange: (v) => { this.cfg.birthRate = v / 100; this.dirty(); },
    });
    popHost.appendChild(this.popSlider.el);
    popHost.appendChild(this.seedInfSlider.el);
    popHost.appendChild(this.birthSlider.el);

    // Mask
    this.maskSliders = this.buildDefenseSliders(maskHost, 'mask', 0);
    this.maskSliders.uptake.onValueChange((v) => { this.refreshBadge('mask', v); this.refreshSummary('mask'); });
    this.maskSliders.protection.onValueChange(() => this.refreshSummary('mask'));
    this.maskSliders.sourceControl.onValueChange(() => this.refreshSummary('mask'));
    this.maskSliders.mortalityReduction.onValueChange(() => this.refreshSummary('mask'));
    this.refreshBadge('mask', Math.round(this.cfg.defenses[0].uptake * 100));
    this.refreshSummary('mask');
    // Vaccine
    this.vaxSliders = this.buildDefenseSliders(vaxHost, 'vax', 1);
    this.vaxSliders.uptake.onValueChange((v) => { this.refreshBadge('vaccine', v); this.refreshSummary('vaccine'); });
    this.vaxSliders.protection.onValueChange(() => this.refreshSummary('vaccine'));
    this.vaxSliders.sourceControl.onValueChange(() => this.refreshSummary('vaccine'));
    this.vaxSliders.mortalityReduction.onValueChange(() => this.refreshSummary('vaccine'));
    this.refreshBadge('vaccine', Math.round(this.cfg.defenses[1].uptake * 100));
    this.refreshSummary('vaccine');
    // Lockdown
    this.lockdownSliders = this.buildLockdownSliders(lockHost);
    this.lockdownSliders.transmission.onValueChange((v) => { this.refreshBadge('lockdown', v); this.refreshSummary('lockdown'); });
    this.lockdownSliders.mobility.onValueChange(() => this.refreshSummary('lockdown'));
    this.lockdownSliders.compliance.onValueChange(() => this.refreshSummary('lockdown'));
    this.refreshBadge('lockdown', Math.round(this.cfg.lockdown.transmissionReduction * 100));
    this.refreshSummary('lockdown');
    // Quarantine
    this.quarantineSliders = this.buildQuarantineSliders(qHost);
    this.quarantineSliders.detection.onValueChange((v) => { this.refreshBadge('quarantine', v); this.refreshSummary('quarantine'); });
    this.quarantineSliders.protection.onValueChange(() => this.refreshSummary('quarantine'));
    this.quarantineSliders.sourceControl.onValueChange(() => this.refreshSummary('quarantine'));
    this.quarantineSliders.range.onValueChange(() => this.refreshSummary('quarantine'));
    this.quarantineSliders.duration.onValueChange(() => this.refreshSummary('quarantine'));
    this.refreshBadge('quarantine', Math.round(this.cfg.quarantine.detectionRate * 100));
    this.refreshSummary('quarantine');

    // Collapsible toggles (ignore clicks landing inside [data-stop] like switches)
    host.querySelectorAll<HTMLButtonElement>('.panel-head[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if ((e.target as HTMLElement | null)?.closest('[data-stop]')) return;
        const panel = btn.closest('.panel') as HTMLElement;
        const collapsed = panel.dataset['collapsed'] === 'true';
        panel.dataset['collapsed'] = collapsed ? 'false' : 'true';
        btn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
      });
    });

    // Wire intervention quick-toggle switches.
    this.switches = {};
    host.querySelectorAll<HTMLInputElement>('input[data-switch]').forEach((input) => {
      const key = input.dataset['switch'] as InterventionKey;
      this.switches[key] = input;
      // Initial state reflects config.
      input.checked = this.isInterventionEnabled(key);
      // Reflect on the panel for CSS styling cues.
      this.markInterventionState(key, input.checked);
      input.addEventListener('change', () => {
        this.setInterventionEnabled(key, input.checked);
        this.markInterventionState(key, input.checked);
        this.events.onInterventionToggle?.(key, input.checked);
        this.dirty();
      });
    });

    // On mobile, collapse all top-level panels by default.
    if (window.matchMedia('(max-width: 1080px)').matches) {
      host.querySelectorAll<HTMLElement>(':scope > .panel.collapsible').forEach((panel) => {
        panel.dataset['collapsed'] = 'true';
        const btn = panel.querySelector<HTMLButtonElement>('[data-toggle]');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }
  }

  private interventionCardMarkup(key: InterventionKey, label: string, icon: string): string {
    return `
      <section class="panel collapsible intervention-item" aria-label="${label}" data-collapsed="true" data-intervention="${key}">
        <button type="button" class="panel-head" aria-expanded="false" data-toggle="${key}">
          <h3>${label} <span class="rate-badge" data-badge="${key}">—</span></h3>
          <span class="panel-summary" data-summary="${key}"></span>
          <span class="panel-icon" aria-hidden="true">${icon}</span>
          <label class="panel-switch" data-stop title="Enable / disable ${label}">
            <input type="checkbox" data-switch="${key}" aria-label="${label} enabled" />
            <span class="panel-switch-track" aria-hidden="true"></span>
          </label>
          <span class="panel-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="panel-body" data-section="${key}"></div>
      </section>
    `;
  }

  private isInterventionEnabled(key: InterventionKey): boolean {
    if (key === 'mask') return this.cfg.defenses[0]?.enabled !== false;
    if (key === 'vaccine') return this.cfg.defenses[1]?.enabled !== false;
    if (key === 'lockdown') return this.cfg.lockdown.enabled;
    if (key === 'quarantine') return this.cfg.quarantine.enabled;
    return false;
  }

  private setInterventionEnabled(key: InterventionKey, on: boolean): void {
    if (key === 'mask') this.cfg.defenses[0].enabled = on;
    else if (key === 'vaccine') this.cfg.defenses[1].enabled = on;
    else if (key === 'lockdown') this.cfg.lockdown.enabled = on;
    else if (key === 'quarantine') this.cfg.quarantine.enabled = on;
  }

  private markInterventionState(key: InterventionKey, on: boolean): void {
    const panel = document.querySelector(`[data-intervention="${key}"]`) as HTMLElement | null;
    if (panel) panel.dataset['enabled'] = on ? 'true' : 'false';
  }

  private refreshSummary(key: InterventionKey): void {
    const el = document.querySelector(`[data-summary="${key}"]`);
    if (!el) return;
    const parts: string[] = [];
    if (key === 'mask' || key === 'vaccine') {
      const def = key === 'mask' ? this.cfg.defenses[0] : this.cfg.defenses[1];
      parts.push(`${Math.round(def.protection * 100)}% prot`);
      parts.push(`${Math.round(def.sourceControl * 100)}% src`);
      parts.push(`${Math.round(def.mortalityReduction * 100)}% mort`);
    } else if (key === 'lockdown') {
      const l = this.cfg.lockdown;
      parts.push(`${Math.round(l.mobilityReduction * 100)}% mob`);
      parts.push(`${Math.round(l.transmissionReduction * 100)}% trans`);
      parts.push(`${Math.round(l.compliance * 100)}% comp`);
    } else if (key === 'quarantine') {
      const q = this.cfg.quarantine;
      parts.push(`${Math.round(q.protection * 100)}% prot`);
      parts.push(`${Math.round(q.sourceControl * 100)}% src`);
      parts.push(`±${q.contactsRange} · ${q.duration}d`);
    }
    el.textContent = parts.join(' · ');
  }

  private refreshBadge(key: InterventionKey, value: number): void {
    const el = document.querySelector(`[data-badge="${key}"]`);
    if (el) el.textContent = `${Math.round(value)}%`;
  }

  private refreshPopBadge(size: number): void {
    const el = document.querySelector('[data-badge="popsize"]');
    if (el) el.textContent = `${(size * size).toLocaleString()} cells`;
  }

  buildRight(host: HTMLElement): void {
    host.innerHTML = `
      <section class="panel collapsible" aria-label="Disease" data-collapsed="false">
        <button type="button" class="panel-head" aria-expanded="true" data-toggle="disease">
          <h3>Disease</h3>
          <span class="panel-icon" aria-hidden="true">🦠</span>
          <span class="panel-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="panel-body">
          <div class="preset-host"></div>
          <div class="strain-sliders" data-section="strain"></div>
        </div>
      </section>
    `;
    const presetHost = host.querySelector('.preset-host') as HTMLElement;
    const strainHost = host.querySelector('[data-section="strain"]') as HTMLElement;

    this.picker = new PresetPicker(presetHost, this.presetId, (p) => {
      this.presetId = p.id;
      this.applyStrain(p.genes);
      this.events.onPresetChange(p);
      this.events.onCustomNameChange?.(null);
    });
    this.picker.onRenameChange((name) => this.events.onCustomNameChange?.(name));

    const s = this.cfg.strain;
    this.strainSliders = {
      attackRate: new Slider({
        id: 'attack-rate', label: 'Attack rate', min: 0, max: 100, step: 1, unit: '%',
        value: Math.round(s.attackRate * 100),
        hint: 'Per-contact transmission probability.',
        onChange: (v) => { this.cfg.strain.attackRate = v / 100; this.dirty(); },
      }),
      incubation: new Slider({
        id: 'incubation', label: 'Incubation', min: 1, max: 60, step: 1, unit: 'days',
        value: s.incubation,
        hint: 'Days from exposure to becoming infectious.',
        onChange: (v) => { this.cfg.strain.incubation = v | 0; this.dirty(); },
      }),
      infectious: new Slider({
        id: 'infectious', label: 'Infectious period', min: 1, max: 60, step: 1, unit: 'days',
        value: s.infectious,
        hint: 'Days the host can transmit.',
        onChange: (v) => {
          this.cfg.strain.infectious = v | 0;
          if ((this.cfg.geometry ?? 'square') === 'meanfield') {
            // Keep R0 fixed; recompute attackRate for the new infectious period
            const r0 = this.r0Slider.value();
            const ar = attackRateFromR0(r0, this.cfg.strain.infectious, MF_K);
            this.cfg.strain.attackRate = ar;
            this.strainSliders.attackRate.setValue(Math.round(ar * 100), true);
          }
          this.dirty();
        },
      }),
      ifr: new Slider({
        id: 'ifr', label: 'Kill rate (IFR)', min: 0, max: 100, step: 1, unit: '%',
        value: Math.round(s.ifr * 100),
        hint: 'Infection-fatality rate at recovery roll.',
        onChange: (v) => { this.cfg.strain.ifr = v / 100; this.dirty(); },
      }),
      range: new Slider({
        id: 'range', label: 'Transmission range', min: 1, max: 6, step: 1, unit: 'tiles',
        value: s.range,
        hint: 'Manhattan radius. 1 = nearest neighbors.',
        onChange: (v) => { this.cfg.strain.range = v | 0; this.dirty(); },
      }),
      immunityDays: new Slider({
        // Log-scaled 0..1000 → 90 days .. 36500 days. Linear was useless: 25%
        // of slider already read "lifelong" and 99% of the dial sat in years
        // 25-100. Log distribution puts 1 year at ~25%, 10 years at ~62%,
        // and "lifelong" at the very top.
        id: 'imm', label: 'Immunity duration', min: 0, max: 1000, step: 1,
        value: immunityDaysToPos(Math.max(90, s.immunityDays)),
        hint: 'Mean days a recovered cell stays immune before becoming susceptible again. With a finite window plus a large enough population, infections persist endemically — the classic CDA insight.',
        format: (pos) => formatDays(immunityPosToDays(pos)),
        onChange: (pos) => { this.cfg.strain.immunityDays = immunityPosToDays(pos); this.dirty(); },
      }),
      mutationRate: new Slider({
        id: 'mut', label: 'Mutation rate', min: 0, max: 50, step: 1, unit: '%',
        value: Math.round(s.mutationRate * 100),
        hint: 'Per-replication chance per gene to drift (when natural selection is on).',
        onChange: (v) => { this.cfg.strain.mutationRate = v / 100; this.dirty(); },
      }),
    };
    for (const k of Object.keys(this.strainSliders) as (keyof typeof this.strainSliders)[]) {
      strainHost.appendChild(this.strainSliders[k].el);
      // Whenever any disease gene changes, re-check whether we've drifted from
      // the current preset and reflect that in the picker label.
      this.strainSliders[k].onValueChange(() => this.recheckCustom());
    }

    // R0 slider — only shown in mean-field mode; replaces attack rate + range sliders.
    const initR0 = r0FromAttackRate(s.attackRate, s.infectious, geometryK(this.cfg.geometry ?? 'square', s.range));
    this.r0Slider = new Slider({
      id: 'r0',
      label: 'Basic reproduction number (R₀)',
      min: 0, max: 20, step: 0.1,
      value: Math.round(initR0 * 10) / 10,
      hint: 'Expected secondary infections from one case in a fully susceptible population. Automatically translates to a per-contact attack rate for the engine.',
      format: (v) => v.toFixed(1),
      onChange: (r0) => {
        const ar = attackRateFromR0(r0, this.cfg.strain.infectious, MF_K);
        this.cfg.strain.attackRate = ar;
        this.strainSliders.attackRate.setValue(Math.round(ar * 100), true);
        this.dirty();
      },
    });
    // Insert before attackRate so it occupies the same visual slot.
    strainHost.insertBefore(this.r0Slider.el, this.strainSliders.attackRate.el);
    // Apply initial visibility based on the starting geometry.
    this.applyGeometryVisibility(this.cfg.geometry ?? 'square');

    // Collapsible toggle for the Disease panel.
    host.querySelectorAll<HTMLButtonElement>('.panel-head[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = btn.closest('.panel') as HTMLElement;
        const collapsed = panel.dataset['collapsed'] === 'true';
        panel.dataset['collapsed'] = collapsed ? 'false' : 'true';
        btn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
      });
    });

    // On mobile, collapse all top-level panels by default.
    if (window.matchMedia('(max-width: 1080px)').matches) {
      host.querySelectorAll<HTMLElement>(':scope > .panel.collapsible').forEach((panel) => {
        panel.dataset['collapsed'] = 'true';
        const btn = panel.querySelector<HTMLButtonElement>('[data-toggle]');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }
  }

  private recheckCustom(): void {
    const preset = findPreset(this.presetId);
    const g = this.cfg.strain;
    const same =
      Math.abs(g.attackRate - preset.genes.attackRate) < 1e-6 &&
      g.incubation === preset.genes.incubation &&
      g.infectious === preset.genes.infectious &&
      Math.abs(g.ifr - preset.genes.ifr) < 1e-6 &&
      g.range === preset.genes.range &&
      g.immunityDays === preset.genes.immunityDays &&
      Math.abs(g.mutationRate - preset.genes.mutationRate) < 1e-6;
    this.picker.markCustom(!same);
  }

  private buildDefenseSliders(host: HTMLElement, idPrefix: string, defIdx: number) {
    // Read live: hydrate() swaps `this.cfg` for a fresh config object, so we
    // must resolve the defense ref at change-time, not capture by closure.
    const def = () => this.cfg.defenses[defIdx];
    const uptake = new Slider({
      id: `${idPrefix}-rate`, label: 'Rate', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(def().uptake * 100),
      hint: 'Fraction of the population that has this defense. Changes apply mid-run via stochastic adjustment.',
      onChange: (v) => { def().uptake = v / 100; this.dirty(); },
    });
    const protection = new Slider({
      id: `${idPrefix}-prot`, label: 'Protection', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(def().protection * 100),
      hint: 'Reduces incoming infection chance against the wearer.',
      onChange: (v) => { def().protection = v / 100; this.dirty(); },
    });
    const sourceControl = new Slider({
      id: `${idPrefix}-src`, label: 'Source control', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(def().sourceControl * 100),
      hint: 'Reduces outgoing infection from a sick wearer.',
      onChange: (v) => { def().sourceControl = v / 100; this.dirty(); },
    });
    const mortalityReduction = new Slider({
      id: `${idPrefix}-mort`, label: 'Mortality reduction', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(def().mortalityReduction * 100),
      hint: 'Reduces fatality if a wearer is infected.',
      onChange: (v) => { def().mortalityReduction = v / 100; this.dirty(); },
    });
    [uptake, protection, sourceControl, mortalityReduction].forEach((s) => host.appendChild(s.el));
    return { protection, sourceControl, mortalityReduction, uptake };
  }

  private buildLockdownSliders(host: HTMLElement) {
    const ld = () => this.cfg.lockdown;
    const mobility = new Slider({
      id: 'ld-mob', label: 'Mobility reduction', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(ld().mobilityReduction * 100),
      hint: 'Stay-at-home effect: compliant cells skip neighbor contacts with this probability per attempt.',
      onChange: (v) => { ld().mobilityReduction = v / 100; this.dirty(); },
    });
    const transmission = new Slider({
      id: 'ld-trans', label: 'Transmission reduction', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(ld().transmissionReduction * 100),
      hint: 'Global multiplicative reduction on transmission while lockdown is on.',
      onChange: (v) => { ld().transmissionReduction = v / 100; this.dirty(); },
    });
    const compliance = new Slider({
      id: 'ld-comp', label: 'Compliance', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(ld().compliance * 100),
      hint: 'Per-cell adherence. Non-compliant cells move and transmit normally.',
      onChange: (v) => { ld().compliance = v / 100; this.dirty(); },
    });
    [mobility, transmission, compliance].forEach((s) => host.appendChild(s.el));
    return { mobility, transmission, compliance };
  }

  private buildQuarantineSliders(host: HTMLElement) {
    const q = () => this.cfg.quarantine;
    const detection = new Slider({
      id: 'q-rate', label: 'Detection rate', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(q().detectionRate * 100),
      hint: 'Per-tick probability that an infectious case is detected and isolated along with close contacts.',
      onChange: (v) => { q().detectionRate = v / 100; this.dirty(); },
    });
    const range = new Slider({
      id: 'q-range', label: 'Close-contacts range', min: 1, max: 5, step: 1, unit: 'tiles',
      value: q().contactsRange,
      hint: 'Manhattan radius of neighbors quarantined alongside a detected case.',
      onChange: (v) => { q().contactsRange = v | 0; this.dirty(); },
    });
    const protection = new Slider({
      id: 'q-prot', label: 'Protection', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(q().protection * 100),
      hint: 'Reduces incoming transmission to a quarantined cell.',
      onChange: (v) => { q().protection = v / 100; this.dirty(); },
    });
    const sourceControl = new Slider({
      id: 'q-src', label: 'Source control', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(q().sourceControl * 100),
      hint: 'Reduces outgoing transmission from a quarantined cell.',
      onChange: (v) => { q().sourceControl = v / 100; this.dirty(); },
    });
    const duration = new Slider({
      id: 'q-dur', label: 'Duration', min: 1, max: 60, step: 1, unit: 'days',
      value: q().duration,
      hint: 'How long a quarantine persists from the tick of detection.',
      onChange: (v) => { q().duration = v | 0; this.dirty(); },
    });
    [detection, range, protection, sourceControl, duration].forEach((s) => host.appendChild(s.el));
    return { detection, range, protection, sourceControl, duration };
  }

  applyStrain(g: StrainGenes): void {
    this.cfg.strain = { ...g };
    this.strainSliders.attackRate.setValue(Math.round(g.attackRate * 100), true);
    this.strainSliders.incubation.setValue(g.incubation, true);
    this.strainSliders.infectious.setValue(g.infectious, true);
    this.strainSliders.ifr.setValue(Math.round(g.ifr * 100), true);
    this.strainSliders.range.setValue(g.range, true);
    this.strainSliders.immunityDays.setValue(immunityDaysToPos(Math.max(90, g.immunityDays)), true);
    this.strainSliders.mutationRate.setValue(Math.round(g.mutationRate * 100), true);
    if ((this.cfg.geometry ?? 'square') === 'meanfield') {
      const r0 = r0FromAttackRate(g.attackRate, g.infectious, MF_K);
      this.r0Slider.setValue(Math.round(r0 * 10) / 10, true);
    }
  }

  hydrate(cfg: SimConfig, presetId: string): void {
    this.cfg = cfg;
    this.presetId = presetId;
    this.geoSelect.value = cfg.geometry ?? 'square';
    this.popSlider.setValue(cfg.size, true);
    this.refreshPopBadge(cfg.size);
    this.seedInfSlider.setValue(Math.round(cfg.seedInfections * 100), true);
    this.birthSlider.setValue(Math.round(cfg.birthRate * 100), true);
    const m = cfg.defenses[0];
    this.maskSliders.protection.setValue(Math.round(m.protection * 100), true);
    this.maskSliders.sourceControl.setValue(Math.round(m.sourceControl * 100), true);
    this.maskSliders.mortalityReduction.setValue(Math.round(m.mortalityReduction * 100), true);
    this.maskSliders.uptake.setValue(Math.round(m.uptake * 100), true);
    this.refreshBadge('mask', Math.round(m.uptake * 100));
    this.refreshSummary('mask');
    const v = cfg.defenses[1];
    this.vaxSliders.protection.setValue(Math.round(v.protection * 100), true);
    this.vaxSliders.sourceControl.setValue(Math.round(v.sourceControl * 100), true);
    this.vaxSliders.mortalityReduction.setValue(Math.round(v.mortalityReduction * 100), true);
    this.vaxSliders.uptake.setValue(Math.round(v.uptake * 100), true);
    this.refreshBadge('vaccine', Math.round(v.uptake * 100));
    this.refreshSummary('vaccine');
    // Lockdown
    const ld = cfg.lockdown;
    this.lockdownSliders.mobility.setValue(Math.round(ld.mobilityReduction * 100), true);
    this.lockdownSliders.transmission.setValue(Math.round(ld.transmissionReduction * 100), true);
    this.lockdownSliders.compliance.setValue(Math.round(ld.compliance * 100), true);
    this.refreshBadge('lockdown', Math.round(ld.transmissionReduction * 100));
    this.refreshSummary('lockdown');
    // Quarantine
    const q = cfg.quarantine;
    this.quarantineSliders.detection.setValue(Math.round(q.detectionRate * 100), true);
    this.quarantineSliders.range.setValue(q.contactsRange, true);
    this.quarantineSliders.protection.setValue(Math.round(q.protection * 100), true);
    this.quarantineSliders.sourceControl.setValue(Math.round(q.sourceControl * 100), true);
    this.quarantineSliders.duration.setValue(q.duration, true);
    this.refreshBadge('quarantine', Math.round(q.detectionRate * 100));
    this.refreshSummary('quarantine');
    // Switches
    for (const key of ['mask', 'vaccine', 'lockdown', 'quarantine'] as InterventionKey[]) {
      const input = this.switches[key];
      if (!input) continue;
      const on = this.isInterventionEnabled(key);
      input.checked = on;
      this.markInterventionState(key, on);
    }
    this.applyStrain(cfg.strain);
    this.picker.setCurrent(presetId);
    this.recheckCustom();
    this.applyGeometryVisibility(cfg.geometry ?? 'square');
    if ((cfg.geometry ?? 'square') === 'meanfield') {
      const r0 = r0FromAttackRate(cfg.strain.attackRate, cfg.strain.infectious, MF_K);
      this.r0Slider.setValue(Math.round(r0 * 10) / 10, true);
    }
  }

  private applyGeometryVisibility(geo: GeometryType): void {
    const isMF = geo === 'meanfield';
    this.r0Slider.el.style.display = isMF ? '' : 'none';
    this.strainSliders.attackRate.el.style.display = isMF ? 'none' : '';
    this.strainSliders.range.el.style.display = isMF ? 'none' : '';
  }

  /** Notify the host App that config changed. App decides whether to rebuild
   *  the engine or live-patch based on which fields actually differ. */
  private dirty(): void {
    this.events.onConfigChange(this.cfg);
  }

  config(): SimConfig {
    return this.cfg;
  }

  currentPresetId(): string {
    return this.presetId;
  }

  setCustomName(name: string | null): void {
    this.picker.setCustomName(name);
  }

  getCustomName(): string | null {
    return this.picker.getCustomName();
  }
}

function formatDays(v: number): string {
  // "lifelong" reserved for the very top of the slider — see IMMUNITY_MAX_DAYS.
  if (v >= IMMUNITY_MAX_DAYS) return 'lifelong';
  if (v >= 365 * 2) {
    const years = v / 365;
    return `${years % 1 === 0 ? years.toFixed(0) : years.toFixed(1)} years`;
  }
  if (v >= 60) {
    const months = v / 30;
    return `${months % 1 === 0 ? months.toFixed(0) : months.toFixed(1)} months`;
  }
  return `${v} day${v === 1 ? '' : 's'}`;
}

// Logarithmic mapping for the immunity-duration slider. Pos is the underlying
// integer slider value (0..1000); days is what the engine actually consumes.
const IMMUNITY_MIN_DAYS = 90;
const IMMUNITY_MAX_DAYS = 36500;
const IMMUNITY_POS_RANGE = 1000;
const IMMUNITY_LOG_RATIO = Math.log(IMMUNITY_MAX_DAYS / IMMUNITY_MIN_DAYS);

function immunityPosToDays(pos: number): number {
  const p = pos / IMMUNITY_POS_RANGE;
  if (p <= 0) return IMMUNITY_MIN_DAYS;
  if (p >= 1) return IMMUNITY_MAX_DAYS;
  return Math.round(IMMUNITY_MIN_DAYS * Math.exp(IMMUNITY_LOG_RATIO * p));
}

function immunityDaysToPos(days: number): number {
  if (days <= IMMUNITY_MIN_DAYS) return 0;
  if (days >= IMMUNITY_MAX_DAYS) return IMMUNITY_POS_RANGE;
  return Math.round(IMMUNITY_POS_RANGE * Math.log(days / IMMUNITY_MIN_DAYS) / IMMUNITY_LOG_RATIO);
}

// ─── Mean-field R0 ↔ attackRate conversions ──────────────────────────────────
// k hierarchy: mean-field (2) < triangular (3) < square (4) < hexagonal (6)
// Mean-field uses k=2 so its R0 sits below triangular for the same attack rate.
// The engine's stepMeanField uses the same k=2 constant.

const MF_K = 2;

function squareContactCount(range: number): number {
  const r = Math.max(1, range | 0);
  let count = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (Math.abs(dx) + Math.abs(dy) <= r) count++;
    }
  }
  return count;
}

function geometryK(geometry: string, range: number): number {
  return geometry === 'meanfield' ? MF_K : squareContactCount(range);
}

function r0FromAttackRate(attackRate: number, infectious: number, k: number): number {
  const ar = Math.max(0, Math.min(1, attackRate));
  const D = Math.max(1, infectious);
  return k * (1 - Math.pow(1 - ar, D));
}

function attackRateFromR0(r0: number, infectious: number, k: number): number {
  if (k <= 0) return 0;
  const D = Math.max(1, infectious);
  const pInfected = Math.min(1, r0 / k);
  if (pInfected <= 0) return 0;
  return Math.max(0, 1 - Math.pow(1 - pInfected, 1 / D));
}
