// Nav icon set (feature/nav-restructure), reduced to one glyph (AN-DESIGN-001
// nav-uniformity sweep, Group 2A). The other eight exports this module used
// to carry (IconGrid, IconFactory, IconTag, IconBuilding, IconBadge,
// IconPerson, IconHelp, IconMail — one per SERVICE_LINKS/MAIN_LINKS
// destination) are gone: the marketing nav no longer renders an icon next to
// any link, anywhere, at any width. IconCapsule survives because it is not a
// nav-scanning icon here — it's the amber brand mark on the "Ally Nutra" nav
// item (Header.jsx's `nav-brand`, and client.html's `.mknav-brand` mirror),
// which the owner asked to keep. Inline SVG only (no icon library, no
// emoji), 16x16 grid, same stroke as before. aria-hidden + focusable="false":
// the adjacent "Ally Nutra" text carries the meaning, this is decorative.
function NavIcon({ children }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

// Two-piece capsule shell — the brand mark, not a /capsule-manufacturing nav
// icon any more (that render site is gone; see Header.jsx SERVICE_LINKS).
export function IconCapsule() {
  return (
    <NavIcon>
      <rect x="2" y="6" width="12" height="4" rx="2" />
      <line x1="8" y1="6" x2="8" y2="10" />
    </NavIcon>
  );
}
