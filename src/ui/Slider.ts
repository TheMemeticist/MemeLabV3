export interface SliderOptions {
  id: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: '%' | 'days' | '' | 'cells' | 'tiles';
  hint?: string;
  /** When true, value displayed as min..max literally; otherwise scaled by unit. */
  format?: (v: number) => string;
  onChange: (v: number) => void;
  /** Allow click-to-type an exact value on the value label. */
  editable?: boolean;
  /** Number to prefill the inline editor with (defaults to the slider value).
   *  Use when the display unit differs from slider-space (e.g. immunity days). */
  editGet?: () => number;
  /** Apply a typed number (defaults to setValue clamped to [min,max], snapped to
   *  an integer step). Override when the editor's unit differs from slider-space. */
  editSet?: (n: number) => void;
  /** Suffix shown beside the inline editor (e.g. '%', 'days'). */
  editSuffix?: string;
}

export class Slider {
  el: HTMLElement;
  private input: HTMLInputElement;
  private valueEl: HTMLElement;
  private opts: SliderOptions;
  // The slider's authoritative value, decoupled from the range input's `step`
  // so a manually-typed value can carry finer precision than the dial snaps to
  // (e.g. a fitted attack rate of 7.34%).
  private current: number;
  private editing = false;

  constructor(opts: SliderOptions) {
    this.opts = opts;
    this.current = opts.value;
    const el = document.createElement('label');
    el.className = 'slider';
    el.htmlFor = `slider-${opts.id}`;
    el.innerHTML = `
      <div class="slider-row">
        <span class="slider-label">${opts.hint
          ? `${opts.label}<span class="slider-info" tabindex="0" data-tip="${escapeAttr(opts.hint)}" aria-label="More info: ${escapeAttr(opts.hint)}">i</span>`
          : opts.label}</span>
        <span class="slider-value" data-value></span>
      </div>
      <input id="slider-${opts.id}" type="range"
        min="${opts.min}" max="${opts.max}" step="${opts.step ?? 1}" value="${opts.value}"
        aria-label="${opts.label}" ${opts.hint ? `aria-description="${escapeAttr(opts.hint)}"` : ''} />
    `;
    this.el = el;
    this.input = el.querySelector('input') as HTMLInputElement;
    this.valueEl = el.querySelector('[data-value]') as HTMLElement;
    this.refreshDisplay();

    let raf = 0;
    let pending = 0;
    this.input.addEventListener('input', () => {
      pending = parseFloat(this.input.value);
      this.current = pending;
      this.refreshDisplay();
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.opts.onChange(pending);
      });
    });
    this.input.addEventListener('change', () => {
      this.current = parseFloat(this.input.value);
      this.opts.onChange(this.current);
    });

    if (opts.editable) this.setupEditable();
  }

  setValue(v: number, silent = false): void {
    this.current = v;
    this.input.value = String(v);
    this.refreshDisplay();
    if (!silent) this.opts.onChange(v);
  }

  value(): number {
    return this.current;
  }

  /** Re-label the slider (and optionally its info tooltip) after construction. */
  setLabel(label: string, hint?: string): void {
    this.opts.label = label;
    if (hint !== undefined) this.opts.hint = hint;
    const h = this.opts.hint;
    const labelEl = this.el.querySelector('.slider-label') as HTMLElement;
    labelEl.innerHTML = h
      ? `${label}<span class="slider-info" tabindex="0" data-tip="${escapeAttr(h)}" aria-label="More info: ${escapeAttr(h)}">i</span>`
      : label;
    this.input.setAttribute('aria-label', label);
  }

  private refreshDisplay(): void {
    if (this.editing) return; // don't clobber the inline editor
    this.valueEl.textContent = this.format(this.current);
  }

  // ── Click-to-type exact value ──
  private setupEditable(): void {
    this.valueEl.classList.add('editable');
    this.valueEl.setAttribute('role', 'button');
    this.valueEl.setAttribute('tabindex', '0');
    this.valueEl.title = 'Click to type an exact value';
    this.valueEl.addEventListener('click', () => this.enterEdit());
    this.valueEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.enterEdit(); }
    });
  }

  private enterEdit(): void {
    if (this.editing) return;
    this.editing = true;
    const start = this.opts.editGet ? this.opts.editGet() : this.current;
    const suffix = this.opts.editSuffix ?? '';
    this.valueEl.classList.add('is-editing');
    this.valueEl.innerHTML =
      `<input class="slider-value-edit" type="number" step="any" aria-label="${escapeAttr(this.opts.label)} value" />` +
      (suffix ? `<span class="slider-value-suffix">${suffix}</span>` : '');
    const field = this.valueEl.querySelector('input') as HTMLInputElement;
    field.value = String(Number(start.toFixed(4)));
    field.focus();
    field.select();
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); field.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); }
    });
    field.addEventListener('blur', () => this.commitEdit(field));
  }

  private cancelEdit(): void {
    if (!this.editing) return;
    this.editing = false;
    this.valueEl.classList.remove('is-editing');
    this.refreshDisplay();
  }

  private commitEdit(field: HTMLInputElement): void {
    if (!this.editing) return;
    this.editing = false;
    this.valueEl.classList.remove('is-editing');
    const n = parseFloat(field.value);
    if (Number.isFinite(n)) {
      if (this.opts.editSet) this.opts.editSet(n);
      else this.setValue(snap(clamp(n, this.opts.min, this.opts.max), this.opts.step));
    } else {
      this.refreshDisplay();
    }
  }

  onValueChange(cb: (v: number) => void): void {
    const prev = this.opts.onChange;
    this.opts.onChange = (v) => { prev(v); cb(v); };
  }

  private format(v: number): string {
    if (this.opts.format) return this.opts.format(v);
    switch (this.opts.unit) {
      // Show a decimal only when the value carries one (e.g. a fitted 7.34%);
      // whole-percent sliders still read "50%".
      case '%': return `${trimNum(v)}%`;
      case 'days': return `${trimNum(v)} days`;
      case 'cells': return `${v}×${v} (${v * v})`;
      case 'tiles': return `${v} tiles`;
      default: return String(v);
    }
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Integer-grained sliders (step ≥ 1) snap typed values to the step; finer
// sliders (step < 1, e.g. attack rate at 0.1) keep the exact typed number so
// sub-step precision survives.
function snap(v: number, step?: number): number {
  if (!step || step < 1) return v;
  return Math.round(v / step) * step;
}

// Trim float noise to at most 2 decimals and drop trailing zeros (7.30 → 7.3).
function trimNum(v: number): string {
  return String(Number(v.toFixed(2)));
}
