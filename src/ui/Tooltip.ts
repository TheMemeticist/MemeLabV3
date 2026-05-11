// Lightweight tooltip — single shared popover, attached to anchors via the
// `data-tip` attribute. Replaces native `title=` (slow + ugly) with a styled,
// theme-aware popover that appears on hover (desktop) or tap (touch).

let tip: HTMLDivElement | null = null;
let activeAnchor: Element | null = null;
let hideTimer = 0;
let autoDismissTimer = 0;
// When a touch/pen pointer was the last input, suppress the synthetic
// mouseover events the browser emits after a tap — otherwise the tooltip
// would flicker on/off because mouseover would re-show right after a tap
// toggled it closed.
let touchSuppressUntil = 0;

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

function hideNow(): void {
  cancelHide();
  cancelAutoDismiss();
  if (!tip) return;
  tip.classList.remove('tip-in');
  tip.hidden = true;
  activeAnchor = null;
}

function cancelHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
}

function cancelAutoDismiss(): void {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = 0;
  }
}

function scheduleAutoDismiss(anchor: Element, delay = 4500): void {
  cancelAutoDismiss();
  autoDismissTimer = window.setTimeout(() => {
    autoDismissTimer = 0;
    if (activeAnchor === anchor) hideNow();
  }, delay);
}

/** Info-only anchors (no primary click action) tap-to-toggle; buttons let
 *  their click action fire without a tip getting in the way. */
function isTipOnly(el: Element): boolean {
  if (el.tagName === 'BUTTON') return false;
  if ((el as HTMLElement).dataset['act']) return false;
  return true;
}

/** Initialize the global tooltip listener — call once at boot. */
export function installTooltip(): void {
  // ---- Touch / pen: tap to toggle, tap outside to dismiss ----
  document.addEventListener('pointerdown', (ev) => {
    const pe = ev as PointerEvent;
    if (pe.pointerType !== 'touch' && pe.pointerType !== 'pen') return;
    // Block the synthetic mouseover that follows a tap for ~600ms so it
    // can't immediately re-show the tooltip we just toggled closed.
    touchSuppressUntil = performance.now() + 600;

    const anchor = (ev.target as Element | null)?.closest('[data-tip]') as HTMLElement | null;

    // Tap outside any tip-anchor → dismiss any active tip.
    if (!anchor) {
      if (activeAnchor) hideNow();
      return;
    }
    // Tap a button/control with a tip: don't intercept; let its primary
    // action fire and dismiss any open tip from a prior tap.
    if (!isTipOnly(anchor)) {
      if (activeAnchor) hideNow();
      return;
    }
    // Tap on an info anchor: toggle.
    if (anchor === activeAnchor) {
      hideNow();
      return;
    }
    const text = anchor.dataset['tip'] ?? '';
    if (!text) return;
    cancelHide();
    show(anchor, text);
    scheduleAutoDismiss(anchor);
  }, { passive: true });

  // ---- Mouse: hover to show, leave to hide ----
  document.addEventListener('mouseover', (ev) => {
    if (performance.now() < touchSuppressUntil) return;
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
    if (performance.now() < touchSuppressUntil) return;
    const target = ev.target as Element | null;
    if (!target) return;
    if (target.closest('[data-tip]') === activeAnchor) hideSoon();
  }, { passive: true });

  // ---- Keyboard focus: show on focus, hide on blur, Esc to dismiss ----
  document.addEventListener('focusin', (ev) => {
    if (performance.now() < touchSuppressUntil) return;
    const anchor = (ev.target as Element)?.closest('[data-tip]') as HTMLElement | null;
    if (!anchor) return;
    const text = anchor.dataset['tip'] ?? '';
    if (text) show(anchor, text);
  });
  document.addEventListener('focusout', (ev) => {
    if ((ev.target as Element)?.closest('[data-tip]') === activeAnchor) hideSoon();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && tip) hideNow();
  });

  // Dismiss when the page scrolls — otherwise the tip stays pinned to a
  // viewport position the anchor has moved out of.
  window.addEventListener('scroll', () => { if (activeAnchor) hideNow(); }, { passive: true, capture: true });
}
