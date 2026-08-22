// Minimal focus trap for modal surfaces. Keeps Tab cycling inside `container`,
// focuses the first tabbable (or `initial`) on install, and restores focus to
// the previously-active element on uninstall.

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function installFocusTrap(container: HTMLElement, initial?: HTMLElement | null): () => void {
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const tabbables = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(TABBABLE)).filter(
      (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
    );

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const items = tabbables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && container.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKey);
  (initial ?? tabbables()[0])?.focus();

  return () => {
    container.removeEventListener('keydown', onKey);
    prev?.focus();
  };
}
