// [FEAT-859 / #5775] The SPA's view of `public/shared/lead-attribution.js`.
//
// That script runs before the app (index.html loads it synchronously right after
// tracking.js), saves the first / last touch and the visitor id, and publishes
// `window.AllyLeadAttribution`. This module only reads it, so the rules live in ONE file
// that the two static pages (/quote/, /schedule/) share — they cannot import from src/.
//
// Absent API (a test without the script, a blocked script, an old cached index.html) is
// not an error: the frame then gets whatever the page passes itself, exactly as before.

/**
 * The parameters to append to an iClosed frame: saved ad tags, first touch (`ft_*`), the
 * visitor id (`an_vid`) and Meta's browser cookies — ids and ad tags only. `null` when the
 * attribution script is not on the page.
 *
 * @param {object} [win] injected window, for tests
 * @returns {Record<string, string> | null}
 */
export function iclosedAttributionParams(win = typeof window === 'undefined' ? undefined : window) {
  const api = win && win.AllyLeadAttribution;
  if (!api || typeof api.iclosedParams !== 'function') return null;
  try {
    const params = api.iclosedParams();
    return params && typeof params === 'object' && Object.keys(params).length > 0 ? params : null;
  } catch {
    return null;
  }
}

const PAID_PLATFORMS = ['google', 'meta', 'tiktok'];

/**
 * [FEAT-899 / #6232] The visitor's most recent PAID click — `{ type, platform, at }`, where
 * `platform` is `google` (gclid / gbraid / wbraid), `meta` (an fbclid that arrived with
 * utm_medium paid_social) or `tiktok` (ttclid) — or `null` when there is none, or when the
 * attribution script is not on the page. The rule itself lives in the script.
 *
 * @param {object} [win] injected window, for tests
 * @returns {{ type: string, platform: 'google'|'meta'|'tiktok', at: number } | null}
 */
export function lastPaidClick(win = typeof window === 'undefined' ? undefined : window) {
  const api = win && win.AllyLeadAttribution;
  if (!api || typeof api.lastPaidClick !== 'function') return null;
  try {
    const paid = api.lastPaidClick();
    if (!paid || typeof paid !== 'object' || !PAID_PLATFORMS.includes(paid.platform)) return null;
    return paid;
  } catch {
    return null;
  }
}

/**
 * Saved attribution first, then the page's own markers on top: when a page passes the
 * current address's tags (`iclosedPassthroughParams`), they describe THIS arrival and win.
 *
 * @param {Record<string,string>|null} saved
 * @param {Record<string,string>|null} fromPage
 * @returns {Record<string,string>|null}
 */
export function mergeIClosedParams(saved, fromPage) {
  if (!saved && !fromPage) return null;
  return { ...(saved || {}), ...(fromPage || {}) };
}
