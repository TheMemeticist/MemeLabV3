// Economic cost-model editor. A live modal: it edits the App-owned CostConfig
// in place and fires onChange so the cost tile, chart, and totals re-price the
// entire run instantly (the cost layer is a pure function of recorded counts).

import { installFocusTrap } from './focus';
import type { CostConfig, CostLedger, CurrencySpec, PathogenCostProfile } from '../types';
import { icon } from './icons';
import {
  CURRENCIES,
  REGION_PRESETS,
  findCurrency,
  findRegion,
  formatMoney,
} from '../lib/cost';

interface CostModalEvents {
  onChange: () => void;
}

type FieldKind = 'money' | 'percent' | 'number' | 'multiplier' | 'perThousand';

interface FieldDesc {
  key: keyof PathogenCostProfile;
  label: string;
  tip: string;
  kind: FieldKind;
  unit?: string;
  step?: number;
  max?: number;
}

interface Section {
  title: string;
  blurb: string;
  fields: FieldDesc[];
}

// Category colors for the breakdown bar — kept in sync with Chart.ts COST_COLORS.
const CAT_COLORS: Record<string, string> = {
  Medical: 'rgb(249, 115, 22)',
  Deaths: 'rgb(239, 68, 68)',
  Quarantine: 'rgb(225, 178, 25)',
  Mask: 'rgb(34, 197, 94)',
  Vaccine: 'rgb(59, 130, 246)',
  Lockdown: 'rgb(148, 163, 184)',
  Surge: 'rgb(168, 85, 247)',
};

const SECTIONS: Section[] = [
  {
    title: 'Severity',
    blurb: 'How bad an infection is — splits infectious cases across care arms.',
    fields: [
      { key: 'hospitalizationRate', label: 'Hospitalization rate', kind: 'percent', tip: 'Fraction of infectious cases needing inpatient care. ~1% for flu, ~95% for Ebola.' },
      { key: 'icuRate', label: 'ICU rate', kind: 'percent', tip: 'Of those hospitalized, the fraction needing intensive care.' },
      { key: 'symptomaticFraction', label: 'Symptomatic fraction', kind: 'percent', tip: 'Fraction of infectious cases with noticeable symptoms (drives outpatient cost + work loss).' },
      { key: 'workCapacityLoss', label: 'Work capacity loss', kind: 'percent', tip: '1 = fully bedridden, 0.2 = minor impairment. Drives lost-productivity cost for outpatients.' },
    ],
  },
  {
    title: 'Economic context',
    blurb: 'Regional wealth — sets productivity loss and the value of a life. The region preset above fills these in.',
    fields: [
      { key: 'gdpPerCapitaAnnual', label: 'GDP per capita', kind: 'money', unit: '/yr', step: 500, tip: 'Annual output per person. Daily productivity loss is derived from this.' },
      { key: 'laborParticipationRate', label: 'Labor participation', kind: 'percent', tip: 'Fraction of the population economically active.' },
    ],
  },
  {
    title: 'Medical unit costs',
    blurb: 'Per-patient daily care costs by setting.',
    fields: [
      { key: 'medCostMild', label: 'Outpatient / home care', kind: 'money', unit: '/day', step: 10, tip: 'Cost per symptomatic outpatient day.' },
      { key: 'medCostHospWard', label: 'Hospital ward bed-day', kind: 'money', unit: '/day', step: 50, tip: 'Cost per general hospital bed-day.' },
      { key: 'medCostICU', label: 'ICU bed-day', kind: 'money', unit: '/day', step: 100, tip: 'Cost per ICU bed-day.' },
    ],
  },
  {
    title: 'Mortality',
    blurb: 'The headline cost of each death.',
    fields: [
      { key: 'vsl', label: 'Value of a statistical life', kind: 'money', step: 100_000, tip: 'One-time cost charged per death. The region preset sets this; high-income ≈ $10M, low-income ≈ $0.7M.' },
    ],
  },
  {
    title: 'Intervention costs',
    blurb: 'What each defense costs to run, per person per day.',
    fields: [
      { key: 'maskCostPerDayPerPerson', label: 'Mask', kind: 'money', unit: '/person/day', step: 0.05, tip: 'Daily cost per masked person.' },
      { key: 'vaccineDosePrice', label: 'Vaccine dose price', kind: 'money', unit: '/dose', step: 1, tip: 'Price of a single vaccine dose. Amortized over the immunity window.' },
      { key: 'vaccineDosesRequired', label: 'Doses required', kind: 'number', unit: 'doses', max: 4, tip: 'Doses per full vaccination (1 or 2 for most).' },
      { key: 'vaccineDeliveryExtra', label: 'Delivery overhead', kind: 'money', unit: '/dose', step: 1, tip: 'Administration / logistics cost added per dose.' },
      { key: 'quarantineDailyCommunity', label: 'Quarantine (community)', kind: 'money', unit: '/person/day', step: 5, tip: 'Daily cost of community-level isolation / monitoring per person.' },
      { key: 'quarantineDailyHospital', label: 'Quarantine (hospital)', kind: 'money', unit: '/person/day', step: 50, tip: 'Daily cost of hospital-grade isolation per person (used when the toggle below is on).' },
      { key: 'lockdownGdpFractionPerUnit', label: 'Lockdown GDP loss', kind: 'percent', tip: 'Fraction of daily GDP lost at full lockdown stringency (stringency = mobility-reduction × compliance). ~30% at peak is realistic.' },
    ],
  },
  {
    title: 'Healthcare capacity (surge)',
    blurb: 'A cost-side overlay: when hospital demand exceeds capacity, overflow is priced higher. This does NOT change the simulated death count — only the cost.',
    fields: [
      { key: 'hospitalBedsPerCapita', label: 'Hospital beds', kind: 'perThousand', unit: 'per 1,000', step: 0.1, tip: 'Bed capacity per 1,000 people. Overflow above this incurs surge costs.' },
      { key: 'surgeCostMultiplier', label: 'Surge cost multiplier', kind: 'multiplier', unit: '×', step: 0.1, tip: 'Care-cost multiplier applied to overflow cases that exceed bed capacity.' },
      { key: 'surgeMortalityCostPerOverflowCase', label: 'Surge mortality cost', kind: 'money', unit: '/case/day', step: 5_000, tip: 'Modeled excess-mortality cost per overflow case-day when capacity is breached.' },
    ],
  },
];

export class CostModal {
  private el: HTMLDivElement | null = null;
  private untrap: (() => void) | null = null;
  private cfg: CostConfig;
  private events: CostModalEvents;
  private lastLedger: CostLedger | null = null;

  constructor(cfg: CostConfig, events: CostModalEvents) {
    this.cfg = cfg;
    this.events = events;
  }

  /** Point the modal at a (possibly new) config object — e.g. after a preset load. */
  setConfig(cfg: CostConfig): void {
    this.cfg = cfg;
    if (this.el) this.renderBody();
  }

  isOpen(): boolean {
    return this.el != null;
  }

  /** Update the live burden readout (called each frame while open). */
  setLedger(ledger: CostLedger): void {
    this.lastLedger = ledger;
    if (this.el) this.renderSummary();
  }

  open(): void {
    if (this.el) return;
    const overlay = document.createElement('div');
    overlay.className = 'about-overlay cost-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Cost model');
    overlay.innerHTML = `
      <div class="about-card cost-card">
        <button class="about-close" type="button" aria-label="Close">${icon('close')}</button>
        <div class="about-body cost-body">
          <header class="cost-head">
            <h2>Cost model</h2>
            <p class="about-tag">Economic burden of the outbreak. Edit any value — the whole run re-prices instantly.</p>
          </header>
          <div class="cost-summary" data-cost-summary></div>
          <div class="cost-region" data-cost-region></div>
          <div class="cost-sections" data-cost-sections></div>
          <p class="cost-disclaimer">All figures are modeled estimates from the parameters above, not forecasts. The capacity surge is a cost overlay and does not alter the simulated epidemic.</p>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;

    const close = () => this.close();
    overlay.querySelector('.about-close')?.addEventListener('click', close);
    // Same pointerdown guard as R0Modal: a drag that starts inside an input and
    // ends on the backdrop fires `click` on the overlay and must not dismiss.
    let pressOnBackdrop = false;
    overlay.addEventListener('pointerdown', (ev) => { pressOnBackdrop = ev.target === overlay; });
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay && pressOnBackdrop) close();
      pressOnBackdrop = false;
    });
    document.addEventListener('keydown', this.onKey);
    this.untrap = installFocusTrap(
      overlay.querySelector('.about-card') as HTMLElement,
      overlay.querySelector('.about-close') as HTMLElement,
    );

    this.renderBody();
  }

  close(): void {
    if (!this.el) return;
    this.untrap?.();
    this.untrap = null;
    document.removeEventListener('keydown', this.onKey);
    const e = this.el;
    this.el = null;
    e.classList.add('about-out');
    setTimeout(() => e.remove(), 200);
  }

  private onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') this.close();
  };

  private currency(): CurrencySpec {
    return { ...findCurrency(this.cfg.currencyCode), rateVsUsd: this.cfg.currencyRate };
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private renderBody(): void {
    this.renderSummary();
    this.renderRegion();
    this.renderSections();
  }

  private renderSummary(): void {
    const host = this.el?.querySelector('[data-cost-summary]') as HTMLElement | null;
    if (!host) return;
    const cur = this.currency();
    const led = this.lastLedger;
    if (!led || led.grandTotal <= 0) {
      host.innerHTML = `<div class="cost-total-big">${formatMoney(0, cur)}</div><div class="cost-total-sub">Total burden so far — run the simulation to accumulate cost.</div>`;
      return;
    }
    const cats: Array<[string, number]> = [
      ['Medical', led.totalMedical], ['Deaths', led.totalDeaths], ['Quarantine', led.totalQuarantine],
      ['Mask', led.totalMask], ['Vaccine', led.totalVaccine], ['Lockdown', led.totalLockdown], ['Surge', led.totalSurge],
    ];
    const total = led.grandTotal || 1;
    const segs = cats
      .filter(([, v]) => v > 0)
      .map(([name, v]) => `<span class="cost-seg" style="flex:${v / total};background:${CAT_COLORS[name]}" title="${name}: ${formatMoney(v, cur)}"></span>`)
      .join('');
    const legend = cats
      .filter(([, v]) => v > 0)
      .map(([name, v]) => `<span class="cost-legend-item"><span class="cost-dot" style="background:${CAT_COLORS[name]}"></span>${name} ${formatMoney(v, cur)}</span>`)
      .join('');
    host.innerHTML = `
      <div class="cost-total-big">${formatMoney(led.grandTotal, cur)}</div>
      <div class="cost-total-sub">Total burden · ${formatMoney(led.dailyTotal, cur)}/day current</div>
      <div class="cost-bar">${segs}</div>
      <div class="cost-legend">${legend}</div>
    `;
  }

  private renderRegion(): void {
    const host = this.el?.querySelector('[data-cost-region]') as HTMLElement | null;
    if (!host) return;
    const regionOpts = REGION_PRESETS.map(
      (r) => `<option value="${r.id}"${r.id === this.cfg.regionId ? ' selected' : ''}>${r.label}</option>`,
    ).join('') + `<option value="custom"${this.cfg.regionId === 'custom' ? ' selected' : ''}>Custom</option>`;
    const curOpts = CURRENCIES.map(
      (c) => `<option value="${c.code}"${c.code === this.cfg.currencyCode ? ' selected' : ''}>${c.code} (${c.symbol})</option>`,
    ).join('');
    host.innerHTML = `
      <div class="cost-section">
        <div class="cost-section-head"><h3>Region &amp; currency</h3></div>
        <p class="cost-section-blurb">Region sets GDP-per-capita and value-of-life. Currency only changes display units.</p>
        <label class="cost-field">
          <span class="cost-field-label">Income region
            <span class="slider-info" tabindex="0" data-tip="Picks a GDP-per-capita and value-of-statistical-life. You can still edit those directly below — doing so switches this to Custom.">i</span>
          </span>
          <span class="cost-field-input"><select class="geo-select" data-cost-region-select>${regionOpts}</select></span>
        </label>
        <label class="cost-field">
          <span class="cost-field-label">Currency
            <span class="slider-info" tabindex="0" data-tip="Display currency. Figures are computed in USD and converted by the rate.">i</span>
          </span>
          <span class="cost-field-input"><select class="geo-select" data-cost-currency-select>${curOpts}</select></span>
        </label>
        <label class="cost-field">
          <span class="cost-field-label">Exchange rate
            <span class="slider-info" tabindex="0" data-tip="Multiplier applied to USD figures for display. Editable.">i</span>
          </span>
          <span class="cost-field-input"><span class="cost-prefix">×</span><input type="number" min="0" step="0.01" value="${this.cfg.currencyRate}" data-cost-rate /></span>
        </label>
      </div>
    `;
    const regionSel = host.querySelector('[data-cost-region-select]') as HTMLSelectElement;
    regionSel.addEventListener('change', () => {
      if (regionSel.value === 'custom') { this.cfg.regionId = 'custom'; this.fire(); return; }
      const r = findRegion(regionSel.value);
      this.cfg.regionId = r.id;
      this.cfg.profile.gdpPerCapitaAnnual = r.gdpPerCapitaAnnual;
      this.cfg.profile.vsl = r.vsl;
      this.renderSections(); // gdp/vsl inputs changed
      this.fire();
    });
    const curSel = host.querySelector('[data-cost-currency-select]') as HTMLSelectElement;
    curSel.addEventListener('change', () => {
      this.cfg.currencyCode = curSel.value;
      this.cfg.currencyRate = findCurrency(curSel.value).rateVsUsd;
      this.renderRegion(); // refresh rate input
      this.renderSummary();
      this.fire();
    });
    const rate = host.querySelector('[data-cost-rate]') as HTMLInputElement;
    rate.addEventListener('input', () => {
      const v = parseFloat(rate.value);
      if (Number.isFinite(v) && v >= 0) { this.cfg.currencyRate = v; this.renderSummary(); this.fire(); }
    });
  }

  private renderSections(): void {
    const host = this.el?.querySelector('[data-cost-sections]') as HTMLElement | null;
    if (!host) return;
    host.innerHTML = SECTIONS.map((sec) => this.sectionMarkup(sec)).join('') + this.quarantineHospitalMarkup();
    // Wire numeric fields.
    host.querySelectorAll<HTMLInputElement>('input[data-cost-key]').forEach((input) => {
      const key = input.dataset['key'] as keyof PathogenCostProfile;
      const kind = input.dataset['kind'] as FieldKind;
      input.addEventListener('input', () => {
        const raw = parseFloat(input.value);
        if (!Number.isFinite(raw)) return;
        let val = raw;
        if (kind === 'percent') val = Math.max(0, Math.min(100, raw)) / 100;
        else if (kind === 'perThousand') val = Math.max(0, raw) / 1000;
        else val = Math.max(0, raw);
        (this.cfg.profile[key] as number) = val;
        // Editing GDP/VSL directly means the region no longer matches a preset.
        if (key === 'gdpPerCapitaAnnual' || key === 'vsl') {
          this.cfg.regionId = 'custom';
          const sel = this.el?.querySelector('[data-cost-region-select]') as HTMLSelectElement | null;
          if (sel) sel.value = 'custom';
        }
        this.renderSummary();
        this.fire();
      });
    });
    // Quarantine-is-hospital toggle.
    const qHosp = host.querySelector('[data-cost-qhosp]') as HTMLInputElement | null;
    qHosp?.addEventListener('change', () => {
      this.cfg.profile.quarantineIsHospital = qHosp.checked;
      this.renderSummary();
      this.fire();
    });
  }

  private sectionMarkup(sec: Section): string {
    const rows = sec.fields.map((f) => this.fieldMarkup(f)).join('');
    return `
      <div class="cost-section">
        <div class="cost-section-head"><h3>${sec.title}</h3></div>
        <p class="cost-section-blurb">${sec.blurb}</p>
        ${rows}
      </div>
    `;
  }

  private fieldMarkup(f: FieldDesc): string {
    const raw = this.cfg.profile[f.key] as number;
    let displayVal: number;
    let prefix = '';
    let step = f.step ?? 1;
    let min = 0;
    let max = f.max;
    if (f.kind === 'percent') { displayVal = Math.round(raw * 1000) / 10; step = 0.5; max = 100; }
    else if (f.kind === 'perThousand') { displayVal = Math.round(raw * 1000 * 100) / 100; }
    else if (f.kind === 'money') { displayVal = raw; prefix = '$'; }
    else if (f.kind === 'multiplier') { displayVal = raw; min = 1; }
    else { displayVal = raw; }
    const unit = f.unit ? `<span class="cost-unit">${f.unit}</span>` : (f.kind === 'percent' ? '<span class="cost-unit">%</span>' : '');
    const pre = prefix ? `<span class="cost-prefix">${prefix}</span>` : '';
    const maxAttr = max != null ? ` max="${max}"` : '';
    return `
      <label class="cost-field">
        <span class="cost-field-label">${f.label}
          <span class="slider-info" tabindex="0" data-tip="${f.tip}">i</span>
        </span>
        <span class="cost-field-input">${pre}<input type="number" min="${min}"${maxAttr} step="${step}" value="${displayVal}" data-cost-key data-key="${f.key}" data-kind="${f.kind}" />${unit}</span>
      </label>
    `;
  }

  private quarantineHospitalMarkup(): string {
    // A checkbox that lives logically with the intervention costs.
    return `
      <div class="cost-section cost-section-inline">
        <label class="cost-field cost-field-check">
          <span class="cost-field-label">Hospital-grade quarantine
            <span class="slider-info" tabindex="0" data-tip="When on, isolation uses the hospital daily rate instead of the community rate (e.g. for hemorrhagic fevers).">i</span>
          </span>
          <input type="checkbox" data-cost-qhosp ${this.cfg.profile.quarantineIsHospital ? 'checked' : ''} />
        </label>
      </div>
    `;
  }

  private fire(): void {
    this.events.onChange();
  }
}
