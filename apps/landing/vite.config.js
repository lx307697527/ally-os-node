import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Ported from the old repo's apps/landing/vite.config.js (the comments there
// carry the reasoning; the short form lives here).
//
// base '/': the site is served at its domain root, matching the old Vercel
// Root-Directory deploy.
//
// envPrefix: `ALLY_OS_` is the repo-wide prefix for "where another app in THIS
// repo lives" (ALLY_OS_PORTAL_URL / ALLY_OS_STAFF_URL are read by
// src/lib/demoRole.js) and `VITE_` is kept because an explicit envPrefix
// REPLACES the default rather than extending it, and this app still reads
// VITE_ICLOSED_CONSULTATION_URL (src/views/Contact.jsx). The contract this
// buys: every ALLY_OS_* variable in the build environment ships inside the
// client bundle, so the prefix is reserved for PUBLIC app addresses — no
// secret may ever use it.
//
// NOT `define`: that rewrites the property access itself into a literal at
// compile time, which would kill `vi.stubEnv` in the lib tests that drive
// every env case through it.
export default defineConfig({
  plugins: [react()],
  base: '/',
  envPrefix: ['VITE_', 'ALLY_OS_'],
  server: {
    // apps/web dev owns 5173; this app has no /api of its own (the marketing
    // site is fully static against the visitor), so no proxy block.
    port: 5176,
  },
});
