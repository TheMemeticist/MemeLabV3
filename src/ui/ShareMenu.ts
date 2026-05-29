// Share popover — anchored to the Share button. Copies the permalink to the
// clipboard and shows a mobile-scannable QR code of the same URL so a run can
// be passed phone-to-phone. The framing: a MemeLab permalink is a fully
// self-contained, deterministic spec of a run — a transmissible meme.
//
// The QR is always rendered dark-on-white regardless of theme: scanners need
// the contrast, and a dark-mode QR on a dark card would not read reliably.

import { qrcodegen } from '../lib/qrcodegen';

export interface ShareMenuOptions {
  /** Resolve the current permalink URL at open time (state may have changed). */
  getUrl: () => string;
  /** Surface a status line (reuses the app toast). */
  toast: (msg: string) => void;
}

export class ShareMenu {
  private readonly anchor: HTMLElement;
  private readonly opts: ShareMenuOptions;
  private el: HTMLDivElement | null = null;

  constructor(anchor: HTMLElement, opts: ShareMenuOptions) {
    this.anchor = anchor;
    this.opts = opts;
  }

  /** Open if closed, close if open — wired to the anchor button's click. */
  toggle(): void {
    if (this.el) this.close();
    else this.open();
  }

  open(): void {
    if (this.el) return;
    const url = this.opts.getUrl();

    // The click that opens the popover also copies — sharing is one tap.
    this.copy(url, /*silent*/ false);

    const pop = document.createElement('div');
    pop.className = 'share-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'false');
    pop.setAttribute('aria-label', 'Share this run');
    pop.innerHTML = `
      <button class="share-close" type="button" aria-label="Close">×</button>
      <div class="share-head">
        <h3>Spread your meme model</h3>
        <p class="share-tag">This link is your model, ready to share. Whoever opens it sees the exact same run.</p>
      </div>
      <div class="share-qr" aria-hidden="true">${qrSvg(url)}</div>
      <p class="share-hint">Scan with a phone camera, or pass the link along:</p>
      <div class="share-link">
        <input class="share-url" type="text" readonly value="${escapeAttr(url)}" aria-label="Permalink URL" />
        <button class="share-copy btn btn-primary" type="button">Copy link</button>
      </div>
    `;
    document.body.appendChild(pop);
    this.el = pop;
    this.position();

    // Wire controls.
    pop.querySelector('.share-close')?.addEventListener('click', () => this.close());
    const input = pop.querySelector<HTMLInputElement>('.share-url')!;
    input.addEventListener('focus', () => input.select());
    pop.querySelector('.share-copy')?.addEventListener('click', () => {
      this.copy(input.value, /*silent*/ false);
      input.select();
    });

    // Defer outside-click binding to the next frame so the opening click
    // doesn't immediately close it.
    requestAnimationFrame(() => {
      document.addEventListener('pointerdown', this.onOutside, true);
    });
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onReflow, true);
    window.addEventListener('scroll', this.onReflow, true);
  }

  close(): void {
    if (!this.el) return;
    document.removeEventListener('pointerdown', this.onOutside, true);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onReflow, true);
    window.removeEventListener('scroll', this.onReflow, true);
    const e = this.el;
    this.el = null;
    e.classList.add('share-out');
    setTimeout(() => e.remove(), 160);
  }

  /** Right-align the popover under the anchor button, but clamp it inside the
   *  viewport so it never spills off-screen on a narrow (mobile) layout. */
  private position(): void {
    if (!this.el) return;
    const margin = 8;
    const r = this.anchor.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const left = Math.max(margin, Math.min(r.right - w, window.innerWidth - w - margin));
    this.el.style.top = `${Math.round(r.bottom + margin)}px`;
    this.el.style.left = `${Math.round(left)}px`;
  }

  private copy(url: string, silent: boolean): void {
    navigator.clipboard?.writeText(url).then(
      () => { if (!silent) this.opts.toast('Link copied — share the strain.'); },
      () => { if (!silent) this.opts.toast('Could not copy — select the link and copy manually.'); },
    );
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

/** Render a QR code for `text` as a crisp, scalable inline SVG (dark-on-white).
 *  LOW error-correction keeps the module count (and thus density) minimal — the
 *  code is shown on a pristine screen, so the redundancy of higher ECC buys
 *  nothing and only makes it harder to scan. */
function qrSvg(text: string): string {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.LOW);
  const border = 4; // quiet zone — 4 modules is the spec minimum for reliable scans
  const dim = qr.size + border * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) path += `M${x + border},${y + border}h1v1h-1z`;
    }
  }
  return `<svg viewBox="0 0 ${dim} ${dim}" width="100%" height="100%" `
    + `xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="#ffffff"/>`
    + `<path d="${path}" fill="#0a0a0a"/></svg>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
