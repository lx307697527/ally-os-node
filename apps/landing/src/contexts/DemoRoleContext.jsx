import { createContext, useCallback, useContext, useState } from 'react';
import { ADMIN, CLIENT, VALID_ROLES, readRoleFromLocation } from '../lib/demoRole.js';

const DemoRoleContext = createContext(null);

export function DemoRoleProvider({ children }) {
  const [role] = useState(() => readRoleFromLocation());

  // Role is derived once from the URL prefix at load (readRoleFromLocation)
  // and is not runtime-mutable state — there is no toggle anymore. "Changing
  // role" now means navigating to a different role-prefixed URL, which is a
  // real page load (this app has no server, so there's nothing to preserve
  // across it). Kept as `setRole` rather than renamed so Header.jsx's
  // "Log out" action (the only remaining caller) reads the same as before.
  const setRole = useCallback((next) => {
    if (!VALID_ROLES[next]) return;
    window.location.assign(`${import.meta.env.BASE_URL}${next}/`);
  }, []);

  // admin is a superset of client (see demoRole.js) — isClient is true for
  // both, so the account menu/portal surface doesn't need a second,
  // near-duplicate gate. isAdmin is the separate, narrower flag for the
  // staff-only Admin entry.
  const isAdmin = role === ADMIN;
  const isClient = role === CLIENT || isAdmin;

  return (
    <DemoRoleContext.Provider value={{ role, setRole, isClient, isAdmin }}>
      {children}
    </DemoRoleContext.Provider>
  );
}

export function useDemoRole() {
  const ctx = useContext(DemoRoleContext);
  if (!ctx) throw new Error('useDemoRole must be used within a DemoRoleProvider');
  return ctx;
}
