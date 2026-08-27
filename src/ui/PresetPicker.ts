import { PRESETS, type DiseasePreset } from '../sim/presets';
import { icon } from './icons';

export class PresetPicker {
  el: HTMLElement;
  private button: HTMLButtonElement;
  private menu: HTMLElement;
  private renameBtn: HTMLButtonElement;
  private currentId: string;
  private custom = false;
  private customName: string | null = null;
  private onPick: (p: DiseasePreset) => void;
  private onRename: (name: string | null) => void = () => {};

  constructor(host: HTMLElement, currentId: string, onPick: (p: DiseasePreset) => void) {
    this.currentId = currentId;
    this.onPick = onPick;
    host.classList.add('preset-picker-host');
    host.innerHTML = `
      <div class="preset-row">
        <button type="button" class="preset-button" aria-haspopup="listbox" aria-expanded="false">
          <span class="preset-label" data-preset-label></span>
          <span class="preset-blurb"></span>
          <span class="preset-chevron" aria-hidden="true">${icon('caretDown')}</span>
        </button>
        <button type="button" class="preset-rename" aria-label="Rename pathogen" data-tip="Give this strain a custom name">${icon('rename')}</button>
      </div>
      <div class="preset-menu" role="listbox" hidden>
        <input type="search" class="preset-search" placeholder="Search diseases…" aria-label="Search diseases" />
        <ul class="preset-options"></ul>
      </div>
    `;
    this.el = host;
    this.button = host.querySelector('.preset-button') as HTMLButtonElement;
    this.renameBtn = host.querySelector('.preset-rename') as HTMLButtonElement;
    this.menu = host.querySelector('.preset-menu') as HTMLElement;
    this.renameBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.startRename();
    });
    this.refreshButton();
    this.renderOptions(PRESETS);

    this.button.addEventListener('click', () => this.toggle());
    document.addEventListener('click', (e) => {
      if (!host.contains(e.target as Node)) this.close();
    });
    const search = host.querySelector('.preset-search') as HTMLInputElement;
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      const filtered = q ? PRESETS.filter((p) => p.label.toLowerCase().includes(q) || p.blurb.toLowerCase().includes(q)) : PRESETS;
      this.renderOptions(filtered);
    });
  }

  setCurrent(id: string): void {
    this.currentId = id;
    this.custom = false;
    this.customName = null;
    this.refreshButton();
  }

  /** Mark the strain as a user-customized version of the current preset. */
  markCustom(isCustom: boolean): void {
    if (this.custom === isCustom) return;
    this.custom = isCustom;
    this.refreshButton();
  }

  setCustomName(name: string | null): void {
    this.customName = name && name.trim() ? name.trim().slice(0, 64) : null;
    this.refreshButton();
  }

  getCustomName(): string | null {
    return this.customName;
  }

  onRenameChange(cb: (name: string | null) => void): void {
    this.onRename = cb;
  }

  private startRename(): void {
    const label = this.button.querySelector('[data-preset-label]') as HTMLElement;
    const original = label.textContent ?? '';
    label.contentEditable = 'plaintext-only';
    label.classList.add('renaming');
    label.focus();
    // Select all
    const range = document.createRange();
    range.selectNodeContents(label);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const finish = (commit: boolean) => {
      label.contentEditable = 'false';
      label.classList.remove('renaming');
      label.removeEventListener('blur', onBlur);
      label.removeEventListener('keydown', onKey);
      if (!commit) {
        label.textContent = original;
        return;
      }
      const next = (label.textContent ?? '').trim();
      const presetLabel = (PRESETS.find((p) => p.id === this.currentId) ?? PRESETS[0]).label;
      // Empty or matches the underlying preset → clear custom name.
      if (!next || next === presetLabel) {
        this.customName = null;
      } else {
        this.customName = next.slice(0, 64);
      }
      this.refreshButton();
      this.onRename(this.customName);
    };
    const onBlur = () => finish(true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        label.blur();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    };
    label.addEventListener('blur', onBlur);
    label.addEventListener('keydown', onKey);
  }

  private refreshButton(): void {
    const p = PRESETS.find((x) => x.id === this.currentId) ?? PRESETS[0];
    const label = this.button.querySelector('.preset-label') as HTMLElement;
    const blurb = this.button.querySelector('.preset-blurb') as HTMLElement;
    if (this.customName) {
      label.textContent = this.customName;
      blurb.textContent = `Custom name · based on ${p.label}`;
    } else if (this.custom) {
      label.textContent = `Custom · ${p.label}`;
      blurb.textContent = 'Modified from preset. Pick another to reset.';
    } else {
      label.textContent = p.label;
      blurb.textContent = p.blurb;
    }
  }

  private renderOptions(list: DiseasePreset[]): void {
    const ul = this.menu.querySelector('.preset-options') as HTMLElement;
    ul.innerHTML = list.map((p) => `
      <li role="option" data-id="${p.id}" tabindex="0" ${p.id === this.currentId ? 'aria-selected="true"' : ''}>
        <div class="opt-label">${p.label}</div>
        <div class="opt-blurb">${p.blurb}</div>
      </li>
    `).join('');
    ul.querySelectorAll<HTMLElement>('li').forEach((li) => {
      const pick = () => {
        const id = li.dataset['id']!;
        const p = PRESETS.find((x) => x.id === id);
        if (!p) return;
        this.setCurrent(id);
        this.close();
        this.onPick(p);
      };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          pick();
        }
      });
    });
  }

  toggle(): void {
    if (this.menu.hidden) this.open();
    else this.close();
  }

  open(): void {
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    (this.menu.querySelector('.preset-search') as HTMLInputElement).focus();
  }

  close(): void {
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }
}
