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
}

export class Slider {
  el: HTMLElement;
  private input: HTMLInputElement;
  private valueEl: HTMLElement;
  private opts: SliderOptions;

  constructor(opts: SliderOptions) {
    this.opts = opts;
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
      this.refreshDisplay();
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.opts.onChange(pending);
      });
    });
    this.input.addEventListener('change', () => {
      this.opts.onChange(parseFloat(this.input.value));
    });
  }

  setValue(v: number, silent = false): void {
    this.input.value = String(v);
    this.refreshDisplay();
    if (!silent) this.opts.onChange(v);
  }

  value(): number {
    return parseFloat(this.input.value);
  }

  private refreshDisplay(): void {
    const v = parseFloat(this.input.value);
    this.valueEl.textContent = this.format(v);
  }

  onValueChange(cb: (v: number) => void): void {
    const prev = this.opts.onChange;
    this.opts.onChange = (v) => { prev(v); cb(v); };
  }

  private format(v: number): string {
    if (this.opts.format) return this.opts.format(v);
    switch (this.opts.unit) {
      case '%': return `${Math.round(v)}%`;
      case 'days': return `${v} days`;
      case 'cells': return `${v}×${v} (${v * v})`;
      case 'tiles': return `${v} tiles`;
      default: return String(v);
    }
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
