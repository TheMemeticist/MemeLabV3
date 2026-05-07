import type { SimConfig, StrainGenes } from '../types';
import { Slider } from './Slider';
import { PresetPicker } from './PresetPicker';
import { findPreset, type DiseasePreset } from '../sim/presets';

export interface ControlPanelEvents {
  onConfigChange: (cfg: SimConfig) => void;
  onPresetChange: (preset: DiseasePreset) => void;
  onCustomNameChange?: (name: string | null) => void;
}

export class ControlPanel {
  private cfg: SimConfig;
  private presetId: string;
  private events: ControlPanelEvents;

  // refs to slider components for programmatic updates
  private popSlider!: Slider;
  private seedInfSlider!: Slider;
  private birthSlider!: Slider;
  private maskSliders!: { protection: Slider; sourceControl: Slider; mortalityReduction: Slider; uptake: Slider };
  private vaxSliders!: { protection: Slider; sourceControl: Slider; mortalityReduction: Slider; uptake: Slider };
  private strainSliders!: { attackRate: Slider; incubation: Slider; infectious: Slider; ifr: Slider; range: Slider; immunityDays: Slider; mutationRate: Slider };
  private picker!: PresetPicker;

  constructor(cfg: SimConfig, presetId: string, events: ControlPanelEvents) {
    this.cfg = cfg;
    this.presetId = presetId;
    this.events = events;
  }

  buildLeft(host: HTMLElement): void {
    host.innerHTML = `
      <section class="panel" aria-label="Population">
        <header class="panel-head">
          <h3>Population <span class="rate-badge" data-badge="popsize">—</span></h3>
          <span class="panel-icon" aria-hidden="true">👥</span>
        </header>
        <div class="panel-body" data-section="population"></div>
      </section>
      <section class="panel collapsible" aria-label="Mask defense" data-collapsed="true">
        <button type="button" class="panel-head" aria-expanded="false" data-toggle="mask">
          <h3>Mask <span class="rate-badge" data-badge="mask">50%</span></h3>
          <span class="panel-summary" data-summary="mask"></span>
          <span class="panel-icon" aria-hidden="true">😷</span>
          <span class="panel-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="panel-body" data-section="mask"></div>
      </section>
      <section class="panel collapsible" aria-label="Vaccine defense" data-collapsed="true">
        <button type="button" class="panel-head" aria-expanded="false" data-toggle="vaccine">
          <h3>Vaccine <span class="rate-badge" data-badge="vaccine">12%</span></h3>
          <span class="panel-summary" data-summary="vaccine"></span>
          <span class="panel-icon" aria-hidden="true">💉</span>
          <span class="panel-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="panel-body" data-section="vaccine"></div>
      </section>
    `;
    const popHost = host.querySelector('[data-section="population"]') as HTMLElement;
    const maskHost = host.querySelector('[data-section="mask"]') as HTMLElement;
    const vaxHost = host.querySelector('[data-section="vaccine"]') as HTMLElement;

    // Population
    this.popSlider = new Slider({
      id: 'pop-size', label: 'Grid size', min: 8, max: 320, step: 8,
      value: this.cfg.size,
      format: (v) => `${v}×${v}`,
      onChange: (v) => {
        this.cfg.size = v | 0;
        this.refreshPopBadge(this.cfg.size);
        this.dirty(true);
      },
    });
    this.refreshPopBadge(this.cfg.size);
    this.seedInfSlider = new Slider({
      id: 'seed-inf', label: 'Seed infections', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(this.cfg.seedInfections * 100),
      onChange: (v) => { this.cfg.seedInfections = v / 100; this.dirty(true); },
    });
    this.birthSlider = new Slider({
      id: 'birth-rate', label: 'Birth rate', min: 0, max: 5, step: 1, unit: '%',
      value: Math.round(this.cfg.birthRate * 100),
      onChange: (v) => { this.cfg.birthRate = v / 100; this.dirty(false); },
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

    // Collapsible toggles
    host.querySelectorAll<HTMLButtonElement>('.panel-head[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = btn.closest('.panel') as HTMLElement;
        const collapsed = panel.dataset['collapsed'] === 'true';
        panel.dataset['collapsed'] = collapsed ? 'false' : 'true';
        btn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
      });
    });
  }

  private refreshSummary(key: 'mask' | 'vaccine'): void {
    const el = document.querySelector(`[data-summary="${key}"]`);
    if (!el) return;
    const def = key === 'mask' ? this.cfg.defenses[0] : this.cfg.defenses[1];
    const parts: string[] = [];
    parts.push(`${Math.round(def.protection * 100)}% prot`);
    parts.push(`${Math.round(def.sourceControl * 100)}% src`);
    parts.push(`${Math.round(def.mortalityReduction * 100)}% mort`);
    el.textContent = parts.join(' · ');
  }

  private refreshBadge(key: 'mask' | 'vaccine', value: number): void {
    const el = document.querySelector(`[data-badge="${key}"]`);
    if (el) el.textContent = `${Math.round(value)}%`;
  }

  private refreshPopBadge(size: number): void {
    const el = document.querySelector('[data-badge="popsize"]');
    if (el) el.textContent = `${(size * size).toLocaleString()} cells`;
  }

  buildRight(host: HTMLElement): void {
    host.innerHTML = `
      <section class="panel" aria-label="Disease">
        <header class="panel-head">
          <h3>Disease</h3>
          <span class="panel-icon" aria-hidden="true">🦠</span>
        </header>
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
        onChange: (v) => { this.cfg.strain.attackRate = v / 100; this.dirty(false); },
      }),
      incubation: new Slider({
        id: 'incubation', label: 'Incubation', min: 1, max: 60, step: 1, unit: 'days',
        value: s.incubation,
        hint: 'Days from exposure to becoming infectious.',
        onChange: (v) => { this.cfg.strain.incubation = v | 0; this.dirty(false); },
      }),
      infectious: new Slider({
        id: 'infectious', label: 'Infectious period', min: 1, max: 60, step: 1, unit: 'days',
        value: s.infectious,
        hint: 'Days the host can transmit.',
        onChange: (v) => { this.cfg.strain.infectious = v | 0; this.dirty(false); },
      }),
      ifr: new Slider({
        id: 'ifr', label: 'Kill rate (IFR)', min: 0, max: 100, step: 1, unit: '%',
        value: Math.round(s.ifr * 100),
        hint: 'Infection-fatality rate at recovery roll.',
        onChange: (v) => { this.cfg.strain.ifr = v / 100; this.dirty(false); },
      }),
      range: new Slider({
        id: 'range', label: 'Transmission range', min: 1, max: 6, step: 1, unit: 'tiles',
        value: s.range,
        hint: 'Manhattan radius. 1 = nearest neighbors.',
        onChange: (v) => { this.cfg.strain.range = v | 0; this.dirty(true); },
      }),
      immunityDays: new Slider({
        id: 'imm', label: 'Immunity duration', min: 90, max: 36500, step: 5,
        value: Math.max(90, s.immunityDays),
        hint: 'Mean days a recovered cell stays immune before becoming susceptible again. With a finite window plus a large enough population, infections persist endemically — the classic CDA insight.',
        format: (v) => formatDays(v),
        onChange: (v) => { this.cfg.strain.immunityDays = Math.max(90, v | 0); this.dirty(false); },
      }),
      mutationRate: new Slider({
        id: 'mut', label: 'Mutation rate', min: 0, max: 50, step: 1, unit: '%',
        value: Math.round(s.mutationRate * 100),
        hint: 'Per-replication chance per gene to drift (when natural selection is on).',
        onChange: (v) => { this.cfg.strain.mutationRate = v / 100; this.dirty(false); },
      }),
    };
    for (const k of Object.keys(this.strainSliders) as (keyof typeof this.strainSliders)[]) {
      strainHost.appendChild(this.strainSliders[k].el);
      // Whenever any disease gene changes, re-check whether we've drifted from
      // the current preset and reflect that in the picker label.
      this.strainSliders[k].onValueChange(() => this.recheckCustom());
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
      hint: 'Fraction of the population that has this defense at start.',
      onChange: (v) => { def().uptake = v / 100; this.dirty(true); },
    });
    const protection = new Slider({
      id: `${idPrefix}-prot`, label: 'Protection', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(def().protection * 100),
      hint: 'Reduces incoming infection chance against the wearer.',
      onChange: (v) => { def().protection = v / 100; this.dirty(false); },
    });
    const sourceControl = new Slider({
      id: `${idPrefix}-src`, label: 'Source control', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(def().sourceControl * 100),
      hint: 'Reduces outgoing infection from a sick wearer.',
      onChange: (v) => { def().sourceControl = v / 100; this.dirty(false); },
    });
    const mortalityReduction = new Slider({
      id: `${idPrefix}-mort`, label: 'Mortality reduction', min: 0, max: 100, step: 1, unit: '%',
      value: Math.round(def().mortalityReduction * 100),
      hint: 'Reduces fatality if a wearer is infected.',
      onChange: (v) => { def().mortalityReduction = v / 100; this.dirty(false); },
    });
    [uptake, protection, sourceControl, mortalityReduction].forEach((s) => host.appendChild(s.el));
    return { protection, sourceControl, mortalityReduction, uptake };
  }

  applyStrain(g: StrainGenes): void {
    this.cfg.strain = { ...g };
    this.strainSliders.attackRate.setValue(Math.round(g.attackRate * 100), true);
    this.strainSliders.incubation.setValue(g.incubation, true);
    this.strainSliders.infectious.setValue(g.infectious, true);
    this.strainSliders.ifr.setValue(Math.round(g.ifr * 100), true);
    this.strainSliders.range.setValue(g.range, true);
    this.strainSliders.immunityDays.setValue(g.immunityDays, true);
    this.strainSliders.mutationRate.setValue(Math.round(g.mutationRate * 100), true);
  }

  hydrate(cfg: SimConfig, presetId: string): void {
    this.cfg = cfg;
    this.presetId = presetId;
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
    const v = cfg.defenses[1];
    this.vaxSliders.protection.setValue(Math.round(v.protection * 100), true);
    this.vaxSliders.sourceControl.setValue(Math.round(v.sourceControl * 100), true);
    this.vaxSliders.mortalityReduction.setValue(Math.round(v.mortalityReduction * 100), true);
    this.vaxSliders.uptake.setValue(Math.round(v.uptake * 100), true);
    this.refreshBadge('vaccine', Math.round(v.uptake * 100));
    this.applyStrain(cfg.strain);
    this.picker.setCurrent(presetId);
    this.recheckCustom();
  }

  /** Notify listener — `structural` means the population must be re-seeded. */
  private dirty(_structural: boolean): void {
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
  if (v >= 365 * 25) return 'lifelong';
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
