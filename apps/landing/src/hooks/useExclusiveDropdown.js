import { useEffect, useRef, useState } from 'react';

// Shared "at most one open" state machine for the header's click-to-open
// panels (Services, Account). Extracted from the Services dropdown so a
// second panel doesn't reimplement its own outside-click / Escape / focus-
// return logic — every registered menu shares one `openMenu` value, so
// opening one closes any other automatically.
//
// Route-change closing stays in Header.jsx: only Header knows when a
// trigger's own click just caused the navigation (see suppressDesktopCloseRef
// there) and should be exempted from the "close on route change" effect.
export function useExclusiveDropdown() {
  const [openMenu, setOpenMenu] = useState(null);
  const registryRef = useRef({});

  // Called during render (not in an effect) — it just records stable ref
  // objects under a key, no state changes, safe to call every render.
  function registerMenu(key, refs) {
    registryRef.current[key] = refs;
  }

  useEffect(() => {
    if (!openMenu) return;
    function onDocClick(e) {
      const container = registryRef.current[openMenu]?.containerRef?.current;
      if (container && !container.contains(e.target)) setOpenMenu(null);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [openMenu]);

  function onEscapeKeyDown(e) {
    if (e.key !== 'Escape' || !openMenu) return;
    const key = openMenu;
    setOpenMenu(null);
    registryRef.current[key]?.triggerRef?.current?.focus();
  }

  return { openMenu, setOpenMenu, registerMenu, onEscapeKeyDown };
}
