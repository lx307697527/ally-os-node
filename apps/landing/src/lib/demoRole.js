// AN-DEMO role model (feature/role-and-links, feature/admin-role, FEAT-060
// p13 role-as-URL-path) — presentation-only, no auth, no account, no
// password. Three roles: 'visitor' (default), 'client', and 'admin' (a
// superset of client — see ADMIN below).
//
// *** SECURITY NOTE — READ BEFORE REUSING ANY OF THIS ***
// Which surface renders is NOT access control. Anyone can type the URL and
// see any surface — there is no server-side check, no session, no
// permission of any kind behind it. This is fine for a demo/prototype whose
// purpose is to LOOK like a real product to a viewer clicking around, but
// it would be a serious security vulnerability if this pattern (or this
// code) ever shipped to a real product. Do not mistake this for a
// permission system.
//
// Source of truth: the URL path prefix, and ONLY the path prefix — no
// query param, no sessionStorage, no toggle. `/visitor/...` is visitor,
// `/client/...` is client, `/admin/...` is admin; anything else is visitor.
// This is deliberately not a runtime-mutable value: which role renders is
// decided by which URL was requested (and, for the two static mockups,
// which real file the host served), not by in-page state — see
// `apps/landing/CLAUDE.md`'s "Deployment" section for the vercel.json
// rewrites this depends on.
//
// Read window.location.pathname directly rather than react-router's
// useLocation. The role prefix lives in the REAL path specifically so it
// survives a full page navigation to the static /quote/, /client/ and /admin/
// files, which have no access to React Router state at all — reading it from
// the router would make it invisible exactly where it has to keep working.
//
// [FEAT-586] Until this change there was a second reason, now gone: the app
// routed on the fragment, so the router's own Location could not see the path
// in front of the `#` even in principle. Routing on the real path, the router
// CAN see it, and `readRoleBasename()` below is what stops it from reading the
// prefix as part of the page address.
//
// ADMIN is a superset of CLIENT, not a parallel branch: an admin is a
// logged-in user who additionally has staff access, so `isAdmin` implies
// `isClient` (see DemoRoleContext.jsx) rather than the two being modeled as
// separate, mutually-exclusive tiers. This keeps exactly one client-surface
// layout to maintain instead of two near-identical ones.
export const VISITOR = 'visitor';
export const CLIENT = 'client';
export const ADMIN = 'admin';
export const VALID_ROLES = { [VISITOR]: true, [CLIENT]: true, [ADMIN]: true };
const VALID = VALID_ROLES;

// import.meta.env.BASE_URL is Vite's configured `base` ('/' in this repo),
// always trailing-slash-terminated. Stripped off before reading the first
// path segment so this still works if `base` is ever a sub-path again.
export function readRoleFromLocation() {
  const base = import.meta.env.BASE_URL;
  let path = window.location.pathname;
  if (path.startsWith(base)) path = path.slice(base.length);
  const first = path.split('/')[0];
  return VALID[first] ? first : VISITOR;
}

/**
 * [FEAT-586, issue #3873] The router's `basename` — the literal role prefix in
 * front of the site, or the site root when there is none.
 *
 * WHY THIS IS NOT `readRoleFromLocation()` WITH A SLASH IN FRONT. That function
 * answers "which role is this?", and `visitor` is BOTH a real prefix and the
 * default answer: it returns `'visitor'` for `/visitor/about` (prefix present)
 * and `'visitor'` for `/about` (no prefix at all). Those are the two cases a
 * basename has to tell apart, and it cannot. Deriving the basename from it
 * would prepend `/visitor` to every unprefixed URL on the site.
 *
 * So this answers a different question — "what is the prefix, literally?" —
 * off the same VALID_ROLES table and the same BASE_URL handling, so the two
 * can never disagree about which segments count as roles.
 *
 * WHAT IT IS FOR. The role prefix is a real path segment. Under the old
 * fragment router that was free: the router read only what followed the `#` and
 * never saw the path in front of it. Routing on the real path, `/visitor/about`
 * would be looked up as a route, match nothing and fall to `<Route path="*">` —
 * the homepage. Handing this to `<BrowserRouter basename>` makes `/visitor`
 * the root, so `/visitor/about` renders the about page AND every `<Link>` on it
 * emits `/visitor/...`, which is how the prefix survives navigation.
 *
 * In practice only `/visitor` reaches this app: `/client/` and `/admin/` are
 * real directories under `public/` that the filesystem answers, and
 * `/super-admin` / `/employee` are rewritten to `public/admin/index.html`. All
 * three roles are handled anyway so this stays a mirror of the function above
 * rather than a special case that has to be remembered.
 */
export function readRoleBasename() {
  const base = import.meta.env.BASE_URL;
  let path = window.location.pathname;
  if (path.startsWith(base)) path = path.slice(base.length);
  const first = path.split('/')[0];
  return VALID[first] ? `${base}${first}` : base;
}

// import.meta.env.BASE_URL is Vite's configured `base` ('/' in this repo,
// since FEAT-060 p1's move — was '/ally-nutra-landing/' for the old GitHub
// Pages deploy), always trailing-slash-terminated — using it here (rather
// than a hardcoded path) keeps these links correct in dev, preview, and the
// deployed build without hand-tracking the base path in three places.
const BASE = import.meta.env.BASE_URL;

// [FEAT-091] These two used to be unconditional links into this app's own
// static mockups, and FEAT-060 p12 said so deliberately — only `portalUrl` /
// `adminUrl` were upgraded to prefer a real deployment. **That decision is
// reversed here**, because the mockups were silently swallowing real demand:
// `public/quote/index.html` runs a fake "Submitting…" spinner and tells the
// visitor their estimate is on its way, with ZERO network calls (the honesty
// invariant in src/lib/quote-mockup-disclosure.test.js is what keeps that
// disclosed rather than fixed). The site's primary CTA therefore led every
// real enquiry into a dead end — measured 2026-08-27: a visitor filled the
// home page's "Start your quote", then registered, and `crm.inquiries` had no
// row to match their email against.
//
// The shape is copied verbatim from portalUrl/adminUrl: configured → the real
// app, unconfigured → the mockup exactly as before. So this is reversible by
// unsetting one variable, and a preview build with no env keeps its old
// behaviour. #723 recorded three options (wire the mockup up, replace it with
// the real form, keep it disclosed); this is the second, done at the link
// layer so the mockup itself stays untouched and reviewable.
//
// NO `?role=` on the real links — same rule the two helpers below already
// follow: that parameter is this demo's presentation mechanism, and forwarding
// it to an app with real authentication would imply it means something there.
// [BUG-069] REVERTED, and this one is a STANDING CONSTRAINT, not a preference.
//
// FEAT-091 pointed this at apps/funnel's /request-quote because that form does
// record submissions while `public/quote/index.html` does not. The business
// ruling (2026-08-27) overrides that trade: **the quote form must live on this
// site.** It is a security-posture decision — the marketing site does not hand
// its visitors off to another origin to collect their details — so "the other
// form works better" is not a reason that applies.
//
// This leaves a KNOWN GAP, stated rather than hidden: the mockup this points at
// makes no network call, so enquiries submitted here are still lost. Closing it
// is #723's first option (wire the mockup to crm.create_inquiry_from_form),
// which is in flight as its own epic. Until that lands, this link is correct
// per the ruling and lossy in fact — both at once.
//
// Do not "fix" this by repointing it again.
export function quoteUrl(role) {
  return `${BASE}quote/?role=${role}`;
}

// [BUG-069] REVERTED to the pre-FEAT-091 form, and it must stay this way.
//
// FEAT-091 moved this one alongside `quoteUrl` on the reasoning "same helper,
// same class of defect, same issue (#723)". **That reasoning was half wrong,
// and this is the wrong half.** `public/quote/index.html` really is inert — it
// runs a fake spinner and makes no network call. `public/schedule/index.html`
// is NOT: it embeds a real iClosed booking iframe
// (`https://app.iclosed.io/e/allynutra/ally-nutra-consultation`, line ~252,
// with the postMessage handling `src/lib/iclosedBooking.js` documents from a
// real 2026-08-13 booking). Visitors book actual calls through it.
//
// So FEAT-091 pointed a WORKING page at `apps/funnel`'s `/schedule`, whose own
// source reads `PICK_LABEL = "Simulate: time picked (demo stand-in)"` — the
// scheduling domain is dormant for customers (DR-24 rules v1 booking is
// external). Real → simulated. Reverted.
//
// The mistake came from trusting a line in apps/landing/CLAUDE.md that
// described this page as "a booking flow, no network, an 'on its way' line".
// That line was wrong; it is corrected in the same commit. **Measure the page,
// don't read about it.**
//
// `quoteUrl` above deliberately keeps its funnel branch: that mockup IS inert,
// so pointing it at a form that records submissions is a strict improvement
// until #723's wiring lands.
export function scheduleUrl(role) {
  return `${BASE}schedule/?role=${role}`;
}

// FEAT-060 p12 — the two destinations that are REAL applications
// ---------------------------------------------------------------
// `portalUrl` and `adminUrl` used to be pure siblings of the two above: links
// into this app's own static mockups. They now prefer a real deployment when
// one is configured — `apps/portal` (the Next.js customer portal) and
// `apps/funnel` (the internal staff surface) respectively.
//
// The addresses are CONFIGURATION, never literals: the root CLAUDE.md forbids
// hardcoding an external system's properties, and these are two independent
// Vercel projects whose URLs can change without any code changing. They arrive
// as env vars, read at CALL time rather than module load so a test can stub them
// per case; Vite still inlines `import.meta.env.*` statically at build time, so
// the shipped bundle pays nothing for that choice.
//
// [FEAT-082, issue #977] Their names carry the `ALLY_OS_` prefix, not `VITE_`.
// One name shape for "where another app in this repo lives", whichever framework
// happens to read it — apps/portal names the same class of value
// ALLY_OS_LANDING_URL rather than NEXT_PUBLIC_LANDING_URL for the same reason.
// The prefix is ALSO the build tool's exposure switch, so this rename only works
// because `vite.config.js` lists `ALLY_OS_` in `envPrefix`; read that comment
// before renaming anything here again, because dropping the prefix from the
// config makes these reads `undefined` and the two helpers below then fall back
// to the mockups with no error anywhere.
//
// Nothing is shared across the three origins — no cookie, no session, no token.
// This app has no session at all (see the security note at the top of this
// file), which is exactly why three separate origins are fine and no
// same-origin proxy is needed. The portal keeps its own Supabase cookies on its
// own origin, like any marketing site linking out to its product.
//
// The real links deliberately carry NO `?role=`. That parameter is this demo's
// own presentation mechanism and it is not access control; forwarding it to an
// application that enforces real authentication would suggest it means
// something there. It does not.

/**
 * A configured deployment address, reduced to a base these helpers can append
 * to — or null when there is nothing usable to append to.
 *
 * Only an absolute http(s) URL is accepted. A blank string, a scheme-less host
 * (`portal.example.com`), a protocol-relative `//host`, a bare path and a
 * `javascript:` payload all yield null, and the caller then returns the mockup
 * URL it would have returned anyway. Falling back to a link that WORKS beats
 * emitting a relative or non-http href that navigates somewhere unintended —
 * the same fail-closed instinct as apps/funnel/src/lib/csp.ts, applied to the
 * matching risk on this side (the wrong destination rather than a wide policy).
 */
function configuredAppBase(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    // Not absolute — `new URL` needs a base to resolve anything relative.
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // Keep any path prefix the deployment carries; drop trailing slashes so the
  // callers below own the single separator and can never double it.
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

// The landing header offers five account entries; apps/portal has four routes
// under app/portal/ (agreements, orders, pay, quotes). Only the two that
// genuinely correspond are mapped here.
//
// This is an ALLOW-LIST on purpose. Templating the view into `/portal/${view}`
// would mint `/portal/documents`, which is a 404 — a broken link that looks
// configured. Anything not named here falls to the portal's root, which is a
// real entry point (its middleware sends the visitor on to /portal/dashboard or
// /login) and is already where the header's "Workspace" item points.
//
// The one remaining gap is reported, not papered over: `documents` has no
// counterpart (the portal has `agreements` and `pay`, and equating either with
// "documents" would be a guess).
//
// [FEAT-090, issue #1088] `dashboard` used to be listed beside it, on the
// grounds that an authenticated `/` went to /portal/quotes. It no longer does —
// the root now lands exactly there — so the unmapped name reaches the right
// page by falling through, and a row for it would be a table entry that changes
// nothing. Kept OUT on purpose: this header's account menu has no dashboard
// item to map in the first place.
const PORTAL_VIEW_ROUTES = {
  orders: '/portal/orders',
  quotes: '/portal/quotes',
};

/**
 * Look a name up in one of the two allow-list tables below, falling back to the
 * portal root for anything not listed.
 *
 * `TABLE[name] ?? '/'` would have read the same at a glance and been wrong for
 * one family of names: `??` only fires on null/undefined, and every object
 * inherits `toString`, `valueOf`, `__proto__` … from Object.prototype. So
 * `TABLE['toString']` resolves to a FUNCTION, `??` never fires, and the caller
 * gets `https://portal.example.com` + the function's source text appended with
 * no leading slash — a different HOST, not merely a wrong path. Nothing reaches
 * these tables with such a name today (both callers pass literals), which is
 * exactly why it is worth closing while it is still cheap: an own-property test
 * costs one call and removes the whole family. [FEAT-076]
 */
function routeIn(table, name) {
  return Object.hasOwn(table, name) ? table[name] : '/';
}

// `view` deep-links into a specific portal tab. Against the real portal that
// means one of PORTAL_VIEW_ROUTES; against the mockup it is the ?view= handling
// in public/portal/index.html. Omit it to land on the portal's default.
export function portalUrl(role, view) {
  const base = configuredAppBase(import.meta.env.ALLY_OS_PORTAL_URL);
  if (base !== null) {
    return `${base}${routeIn(PORTAL_VIEW_ROUTES, view)}`;
  }
  return view ? `${BASE}client/?view=${view}` : `${BASE}client/`;
}

// FEAT-076 — the PUBLIC face's two auth entries (issue #889)
// -----------------------------------------------------------
// Until now nothing on this site pointed a VISITOR at the portal: every portal
// affordance in Header.jsx sits behind `isClient`, and the deployed app only
// ever renders as visitor, so the sign-in door was never in the DOM at all.
//
// This is a table of its own rather than two more rows in PORTAL_VIEW_ROUTES
// above. That table maps this header's ACCOUNT entries onto apps/portal's
// `/portal/*` views and every value it holds carries that prefix; the portal's
// sign-in and sign-up pages do not live under it. Folding them in would
// falsify the comment that table carries and make `portalUrl(role, 'login')`
// read as if a portal view were being requested. Same allow-list instinct
// (never template a path in — an unmapped name would mint a 404 that looks
// configured), its own table.
const PORTAL_AUTH_ROUTES = { login: '/login', register: '/register' };

/**
 * Where the header's sign-in / sign-up entries point.
 *
 * Configured deployment -> that portal's own auth page. Nothing configured (or
 * a value `configuredAppBase` rejects: blank, scheme-less, protocol-relative,
 * a bare path, a `javascript:` payload) -> this app's client mockup, exactly
 * what `portalUrl(role)` returns with no view. Deliberately WITHOUT a `?view=`:
 * the mockup has no sign-in or sign-up screen, and a parameter naming one would
 * look configured while doing nothing.
 *
 * Like the two helpers above, the real link carries no `?role=` — that is this
 * demo's presentation mechanism, and forwarding it to an application that
 * enforces real authentication would suggest it means something there.
 */
export function portalLoginUrl(_role) {
  const base = configuredAppBase(import.meta.env.ALLY_OS_PORTAL_URL);
  if (base !== null) {
    return `${base}${PORTAL_AUTH_ROUTES.login}`;
  }
  return `${BASE}client/`;
}

export function portalRegisterUrl(_role) {
  const base = configuredAppBase(import.meta.env.ALLY_OS_PORTAL_URL);
  if (base !== null) {
    return `${base}${PORTAL_AUTH_ROUTES.register}`;
  }
  return `${BASE}client/`;
}

/**
 * Who sees which auth entries — the single carrier of that rule.
 *
 * Header.jsx maps this at BOTH of its render sites (desktop actions, mobile
 * drawer) rather than each one testing `isClient` for itself, so the two
 * surfaces cannot drift apart and the rule stays testable without a DOM.
 *
 * A client (and therefore an admin) already has the account menu and "Go to
 * portal": handing them this as well would be a second door to a place they
 * are already standing in.
 *
 * This app CANNOT do that branch itself, and should not be made to: landing and
 * portal are separate origins under a Public-Suffix `vercel.app` domain, so no
 * cookie is shared and no session is visible here (issue #624's ruling, and the
 * security note at the top of this file). Reading portal state from here would
 * mean a credentialed cross-origin probe plus SameSite=None auth cookies —
 * widening the portal's CSRF surface to relabel one link.
 */
export function visitorAccountLinks(role) {
  if (role !== VISITOR) return [];
  return [
    { kind: 'login', href: portalLoginUrl(role) },
    { kind: 'register', href: portalRegisterUrl(role) },
  ];
}

// [BUG-152] This app has no session (see the top-of-file security note) and so
// cannot tell a returning, already-authenticated portal customer from a
// brand-new visitor — "Sign in" reads as "you were logged out" to the former,
// which is exactly the confusion BUG-152 reported (a customer landed here,
// e.g. via a bookmark or shared link, saw "Sign in", and read that as a lost
// session). The destination already does the right thing for both: it is the
// real portal's own /login route, and that route's middleware
// (apps/portal/lib/supabase/middleware.ts) redirects an authenticated request
// straight to /portal/dashboard with no login form ever shown — so the fix
// here is the label, not the link.
//
// "Portal" (not "Client Portal" or similar): reads correctly whether the
// visitor has a session or not, matches the isClient state's own "Go to
// portal" call-btn copy a few lines down in Header.jsx (same noun, same
// destination), and — measured in the deployed font — is narrower than "Sign
// in". That matters here: at 1101-1119px the header-actions row already has
// zero horizontal slack ("Sign in" fits with none to spare), and "Client
// Portal" measured ~10px wider there and overflowed.
const LOGIN_ENTRY_LABEL = 'Portal';

/**
 * Compatibility adapter for FEAT-076 callers. Header.jsx passes the role and
 * receives the FEAT-074 two-entry shape; the boolean form remains for the
 * existing pure-function regression tests and is not used by Header.jsx.
 */
export function headerAuthEntries(roleOrIsClient) {
  if (typeof roleOrIsClient === 'boolean') {
    return roleOrIsClient
      ? []
      : [{ key: 'login', label: 'Sign in', href: portalLoginUrl(VISITOR) }];
  }

  return visitorAccountLinks(roleOrIsClient).map(({ kind, href }) => ({
    key: kind,
    label: kind === 'login' ? LOGIN_ENTRY_LABEL : 'Create account',
    href,
  }));
}

/**
 * Backward-compatible route helper for callers that still use the FEAT-076
 * action name. Auth routes stay separate from PORTAL_VIEW_ROUTES.
 */
export function portalAuthUrl(action) {
  if (action === 'login') return portalLoginUrl();
  if (action === 'register') return portalRegisterUrl();

  const base = configuredAppBase(import.meta.env.ALLY_OS_PORTAL_URL);
  return base !== null ? `${base}/` : `${BASE}client/`;
}

/**
 * Where the account menu's staff entry points.
 *
 * [FEAT-090, issue #1088] established WHY this must not be the funnel's deployment root:
 * that root is the funnel's public marketing page (`apps/funnel/src/main.tsx` mounts
 * `PublicShell` + `Landing` there) — the acquisition demo's outward face, and the last
 * thing a staff link should open. It pointed the link at `/inbox` instead, which was the
 * best INTERNAL destination that existed at the time.
 *
 * [#726] creates the one it was always meant to be. `/overview` is the internal system's
 * ENTRY PAGE — a company-wide rollup rather than one team's queue — so the segment moves
 * there. FEAT-090's reasoning is unchanged and its mechanics are kept verbatim: the
 * segment is appended by this function, `configuredAppBase` has already stripped trailing
 * slashes so this owns the single separator, and `/overview` sits inside the funnel's
 * `Internal` wrapper exactly as `/inbox` does — an unauthenticated click is bounced to
 * the funnel's own `/login` by its gate. No session check happens (or could happen) on
 * this side.
 *
 * [#726] RENAMED from `adminUrl`, and the rename is substantive rather than tidying.
 * `admin` is a PERMISSION concept in this system — `core.app_role` carries `admin` and
 * `super_admin`, and `has_any_role('admin','super_admin')` gates real access — so using
 * it as a navigation word conflated a role with a page. Every staff member goes through
 * the same door; what they may do once inside is decided by their role, not by the URL
 * they arrived on. The `_role` parameter is kept only because the callers still pass one.
 *
 * The MOCKUP fallback keeps the bare root, deliberately, and for FEAT-090's own reason:
 * `public/admin/` is one static page with no `/overview` in it (it had no `/inbox`
 * either), so appending the segment there would mint exactly the kind of
 * configured-looking 404 that `PORTAL_VIEW_ROUTES` above exists to avoid. Two branches,
 * two different worlds, each pointing at an entry that really exists in its own.
 *
 * [FEAT-114 p7] The variable is ALLY_OS_STAFF_URL now, and its value is Ally OS
 * (`apps/allyos`) — funnel's own Vercel project is closed by the same phase, and a
 * name saying FUNNEL while pointing at the staff app would be configuration that
 * lies about itself. `/overview` exists inside Ally OS's RequireAuth wrapper
 * (`apps/allyos/src/main.tsx`), so the mechanics above carry over unchanged: an
 * unauthenticated click is bounced to Ally OS's own `/login` by its gate.
 */
export function overviewUrl(_role) {
  const base = configuredAppBase(import.meta.env.ALLY_OS_STAFF_URL);
  if (base !== null) {
    // `configuredAppBase` has already stripped trailing slashes, so this owns
    // the single separator and cannot double it.
    return `${base}/overview`;
  }
  return `${BASE}admin/`;
}
