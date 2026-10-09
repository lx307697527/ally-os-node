import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

// [owner directive 2026-09-20] The kinds list that used to live on the flip card's
// back face, moved verbatim into a modal. Shell mechanics (portal, focus trap,
// Escape/backdrop close, scroll lock, focus return) are the same vetted pattern
// VarietiesPopup.jsx used before the kinds popup replaced the visual-rung grid:
// rendered in a PORTAL at document.body so the dialog never inherits a 3D/stacking
// context from its trigger.
//
// Content contract: heading = varieties.format, intro = varieties.intro, then one
// row per kind (name / spec chip / note) — the same fields the back face rendered.
// No CTA is appended: the back face never had one, and this popup adds no wording.
export default function KindsPopup({ varieties, triggerRef, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const scrollYRef = useRef(0);

  // Focus enters the dialog on open, is trapped inside, and returns to the trigger
  // on close. Escape and backdrop click close it. Background scroll is locked
  // (position fixed at the current offset, restored exactly on close — no jump).
  //
  // [hero-jump fix 2026-09-20] The restore scroll MUST be 'instant': html has
  // scroll-behavior:smooth, so a plain window.scrollTo() animates — and under
  // React StrictMode's dev double-invoke, the remounted effect read window.scrollY
  // while that animation was still at the top, locking the body at top:0 and
  // visually jumping the page to the hero. The capture is also reentrant-safe:
  // if the lock is already held (remount while open), the offset is recovered
  // from the body's own top style rather than from window.scrollY (which is 0
  // whenever the lock is engaged).
  useEffect(() => {
    const triggerEl = triggerRef?.current;
    const body = document.body;
    scrollYRef.current = body.style.position === 'fixed'
      ? -parseFloat(body.style.top || '0') || window.scrollY
      : window.scrollY;
    body.style.position = 'fixed';
    body.style.top = `-${scrollYRef.current}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';

    (dialogRef.current?.querySelector(FOCUSABLE) || dialogRef.current)?.focus();

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      body.style.width = '';
      window.scrollTo({ top: scrollYRef.current, behavior: 'instant' });
      triggerEl?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return createPortal(
    <div className="varieties-popup-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        className="varieties-popup kinds-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <button type="button" className="varieties-popup-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <h2 id={headingId} className="varieties-popup-heading">{varieties.format}</h2>
        <p className="varieties-popup-intro">{varieties.intro}</p>

        <ul className="kinds-popup-list">
          {varieties.varieties.map((v) => (
            <li className="kinds-popup-kind" key={v.id}>
              <div className="kinds-popup-topline">
                <span className="kinds-popup-name">{v.name}</span>
                <span className="kinds-popup-spec mono-chip">{v.spec}</span>
              </div>
              <span className="kinds-popup-note">{v.note}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  );
}
