// [FEAT-586, issue #3873] Catching the old fragment addresses after the move to
// path routing.
//
// Until this change every page of this site lived after a `#` — `/#/about`,
// `/#/contact`. Those addresses are indexed, printed in ad creative, sitting in
// already-sent email and in visitors' bookmarks. Changing the router does not
// retire them.
//
// THE SECOND SOURCE IS THE ONE THAT NEEDS CODE. `/about -> /#/about` was a
// PERMANENT (308) redirect, so a browser that has visited this site even once
// has it cached. Deleting the rule from vercel.json does not un-cache it: that
// browser answers the redirect from its own cache and no request leaves the
// machine for any server rule to reconsider. Nothing on the server can reach
// this; only something running IN the page can undo it.
//
// So main.jsx corrects the address once, before the first render. Doing it in an
// effect instead would draw the page at the wrong route and visibly correct
// itself.
//
// The decision lives here as a PURE function because this app has no jsdom
// setup — see apps/landing/CLAUDE.md. main.jsx keeps only the `window` glue.

/**
 * The address a fragment-routed URL should be rewritten to, or `null` when
 * there is nothing to migrate.
 *
 * `null` IS THE LOAD-BEARING ANSWER. It tells main.jsx to leave the address
 * alone. A function that returned a string for an already-correct address would
 * rewrite the URL on every single page load — and it would swallow `#book`, the
 * in-page anchor on /work-with-us, treating it as a route exactly the way the
 * old router did. That is the defect this whole change exists to remove, so the
 * guard is `#/` and nothing looser: only a fragment that opens a path is a
 * route, `#book` and `#!/about` are not.
 *
 * @param {string} pathname `window.location.pathname` — may carry a role prefix
 *   (`/visitor/`), which is a real path segment and is kept in front of the
 *   migrated route.
 * @param {string} hash `window.location.hash`, including the leading `#`.
 * @param {string} [search] `window.location.search`, including the leading `?`.
 * @returns {string|null}
 */
export function hashRouteToPath(pathname, hash, search = '') {
  if (typeof hash !== 'string' || !hash.startsWith('#/')) return null;

  const route = hash.slice(1);
  const queryAt = route.indexOf('?');
  const routePath = queryAt === -1 ? route : route.slice(0, queryAt);
  const routeQuery = queryAt === -1 ? '' : route.slice(queryAt + 1);

  // '' for the site root, '/visitor' for a role-prefixed load. Stripping the
  // trailing slash here is what lets the route below own the single separator,
  // so `/visitor/` + `/about` cannot become `/visitor//about`.
  const prefix = pathname.replace(/\/+$/, '');

  // NEITHER query string is dropped. An ad link arrives as
  // `/?utm_source=google#/work-with-us` — the attribution layer reads
  // location.search, so losing it would silently unattribute paid traffic —
  // while a hand-built link can carry its own query after the fragment. The
  // outer one keeps its position; the fragment's is appended.
  let query = search.startsWith('?') ? search.slice(1) : search;
  if (routeQuery) query = query ? `${query}&${routeQuery}` : routeQuery;

  const path = `${prefix}${routePath}` || '/';
  return query ? `${path}?${query}` : path;
}
