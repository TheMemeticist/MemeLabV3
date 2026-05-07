// Lightweight tooltip — single shared popover, attached to anchors via the
// `data-tip` attribute. Replaces native `title=` (slow + ugly) with a styled,
// theme-aware popover that appears on hover or focus.

let tip: HTMLDivElement | null = null;
let activeAnchor: Element | null = null;
let hideTimer = 0;

function ensure(): HTMLDivElement {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.role = 'tooltip';
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}

function show(anchor: Element, text: string): void {
  const t = ensure();
  t.textContent = text;
  t.hidden = false;
  activeAnchor = anchor;
  // Position after layout settles.
  const r = anchor.getBoundingClientRect();
  const tw = t.offsetWidth;
  const th = t.offsetHeight;
  // Prefer above; flip below if not enough room.
  let left = r.left + r.width / 2 - tw / 2;
  let top = r.top - th - 10;
  if (top < 8) top = r.bottom + 10;
  // Keep within viewport.
  const maxLeft = window.innerWidth - tw - 8;
  if (left < 8) left = 8;
  if (left > maxLeft) left = maxLeft;
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
  t.classList.add('tip-in');
}

function hideSoon(): void {
  if (hideTimer) return;
  hideTimer = window.setTimeout(() => {
    hideTimer = 0;
    if (!tip) return;
    tip.classList.remove('tip-in');
    tip.hidden = true;
    activeAnchor = null;
  }, 80);
}

function cancelHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
}

/** Initialize the global tooltip listener — call once at boot. */
export function installTooltip(): void {
  document.addEventListener('mouseover', (ev) => {
    const target = ev.target as Element | null;
    if (!target) return;
    const anchor = target.closest('[data-tip]') as HTMLElement | null;
    if (!anchor) {
      if (activeAnchor) hideSoon();
      return;
    }
    cancelHide();
    if (anchor === activeAnchor) return;
    const text = anchor.dataset['tip'] ?? '';
    if (!text) return;
    show(anchor, text);
  }, { passive: true });

  document.addEventListener('mouseout', (ev) => {
    const target = ev.target as Element | null;
    if (!target) return;
    if (target.closest('[data-tip]') === activeAnchor) hideSoon();
  }, { passive: true });

  document.addEventListener('focusin', (ev) => {
    const anchor = (ev.target as Element)?.closest('[data-tip]') as HTMLElement | null;
    if (!anchor) return;
    const text = anchor.dataset['tip'] ?? '';
    if (text) show(anchor, text);
  });
  document.addEventListener('focusout', (ev) => {
    if ((ev.target as Element)?.closest('[data-tip]') === activeAnchor) hideSoon();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && tip) hideSoon();
  });
}
