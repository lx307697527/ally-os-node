import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

// AN-DESIGN-001 sweep, Group C item 7 — a certificate click-to-popup, built as
// a smaller sibling of VarietiesPopup.jsx (since retired; replaced by
// KindsPopup.jsx) rather than a new interaction pattern: same portal-to-body,
// focus-trap, Escape/backdrop-close, and scroll-lock behavior, reusing the
// .varieties-popup* CSS family instead of introducing new colors,
// breakpoints, or a different overlay mechanism.
export default function CertificatePopup({ image, imageAlt, heading, meta, triggerRef, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const scrollYRef = useRef(0);

  useEffect(() => {
    const triggerEl = triggerRef?.current;
    scrollYRef.current = window.scrollY;
    const body = document.body;
    body.style.position = 'fixed';
    body.style.top = `-${scrollYRef.current}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';

    const firstFocusable = dialogRef.current?.querySelector(FOCUSABLE);
    (firstFocusable || dialogRef.current)?.focus();

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
      window.scrollTo(0, scrollYRef.current);
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
        className="varieties-popup cert-popup"
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

        <h2 id={headingId} className="varieties-popup-heading">{heading}</h2>
        <p className="varieties-popup-intro">{meta}</p>

        <img className="cert-popup-img" src={image} alt={imageAlt} />
      </div>
    </div>,
    document.body
  );
}
