// Engine backend picker — anchored to the ⚙/⚡ toolbar button. Replaces blind
// cycling: every backend is a row with an explicit state (running / requested
// but fell back / unavailable + why), so "is GPU on?" is answered by reading,
// not by cycling and guessing. Availability comes from a worker probe (the
// worker is the single authority on what can actually run).

import type { BackendAvailability, BackendProbeMessage, EngineBackend } from '../types';

export interface BackendMenuOptions {
  /** Current requested/active/reason state, read at render time. */
  getState: () => { requested: EngineBackend; active: EngineBackend | null; reason: string | null };
  /** Ask the worker for availability; resolves with its probe reply. */
  probe: () => Promise<BackendProbeMessage>;
  onSelect: (backend: EngineBackend) => void;
}

const ROWS: Array<{ id: EngineBackend; icon: string; name: string; desc: string }> = [
  { id: 'cpu', icon: '⚙', name: 'CPU', desc: 'reference engine — always available' },
  { id: 'wasm', icon: '⚙', name: 'WASM', desc: 'identical results, faster (default)' },
  { id: 'gpu', icon: '⚡', name: 'GPU', desc: 'WebGPU compute — own random stream, huge grids' },
];

export class BackendMenu {
  private readonly anchor: HTMLElement;
  private readonly opts: BackendMenuOptions;
  private el: HTMLDivElement | null = null;

  constructor(anchor: HTMLElement, opts: BackendMenuOptions) {
    this.anchor = anchor;
    this.opts = opts;
  }

  toggle(): void {
    if (this.el) this.close();
    else this.open();
  }

  open(): void {
    if (this.el) return;
    const pop = document.createElement('div');
    pop.className = 'backend-pop';
    pop.setAttribute('role', 'menu');
    pop.setAttribute('aria-label', 'Engine backend');
    document.body.appendChild(pop);
    this.el = pop;
    this.render(null);
    this.position();

    requestAnimationFrame(() => {
      document.addEventListener('pointerdown', this.onOutside, true);
    });
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onReflow, true);
    window.addEventListener('scroll', this.onReflow, true);

    // Availability arrives async; re-render rows in place when it lands.
    void this.opts.probe().then((p) => {
      if (this.el === pop) {
        this.render(p);
        this.position();
      }
    });
  }

  close(): void {
    if (!this.el) return;
    document.removeEventListener('pointerdown', this.onOutside, true);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onReflow, true);
    window.removeEventListener('scroll', this.onReflow, true);
    const e = this.el;
    this.el = null;
    e.remove();
  }

  /** Re-render the open menu (e.g. after a backend message changes state). */
  refresh(): void {
    if (this.el) void this.opts.probe().then((p) => { if (this.el) this.render(p); });
  }

  private render(probe: BackendProbeMessage | null): void {
    if (!this.el) return;
    const { requested, active, reason } = this.opts.getState();
    const avail: Record<EngineBackend, BackendAvailability | null> = {
      cpu: { ok: true },
      wasm: probe ? probe.wasm : null,
      gpu: probe ? probe.gpu : null,
    };
    const rows = ROWS.map((r) => {
      const a = avail[r.id];
      const isActive = active === r.id;
      const isRequested = requested === r.id;
      let stateHtml: string;
      let cls = '';
      if (isActive) {
        cls = 'on';
        stateHtml = '<span class="bp-state bp-on">● running</span>';
      } else if (isRequested && active !== null) {
        cls = 'fell';
        stateHtml = `<span class="bp-state bp-fell">requested — fell back${reason ? `: ${esc(reason)}` : ''}</span>`;
      } else if (a === null) {
        stateHtml = '<span class="bp-state bp-dim">checking…</span>';
      } else if (!a.ok) {
        cls = 'blocked';
        stateHtml = `<span class="bp-state bp-blocked">unavailable${a.reason ? ` — ${esc(a.reason)}` : ''}</span>`;
      } else {
        stateHtml = '<span class="bp-state bp-dim">available</span>';
      }
      return `
        <button class="bp-row ${cls}" type="button" role="menuitemradio" aria-checked="${isActive}" data-backend="${r.id}">
          <span class="bp-icon">${r.icon}</span>
          <span class="bp-body">
            <span class="bp-name">${r.name}<span class="bp-desc">${r.desc}</span></span>
            ${stateHtml}
          </span>
        </button>`;
    }).join('');
    this.el.innerHTML = `
      <div class="bp-head">Engine backend</div>
      ${rows}
      <div class="bp-foot">Switching restarts the run from day 0 (keeps playing). Unavailable rows can still be selected — the engine falls back and says why.</div>
    `;
    this.el.querySelectorAll<HTMLButtonElement>('.bp-row').forEach((b) => {
      b.addEventListener('click', () => {
        this.opts.onSelect(b.dataset['backend'] as EngineBackend);
        this.close();
      });
    });
  }

  /** Left-align under the anchor, clamped inside the viewport. */
  private position(): void {
    if (!this.el) return;
    const margin = 8;
    const r = this.anchor.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - w - margin));
    this.el.style.top = `${Math.round(r.bottom + margin)}px`;
    this.el.style.left = `${Math.round(left)}px`;
  }

  private onOutside = (ev: Event) => {
    const t = ev.target as Node;
    if (this.el && !this.el.contains(t) && !this.anchor.contains(t)) this.close();
  };

  private onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') this.close();
  };

  private onReflow = () => this.position();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
