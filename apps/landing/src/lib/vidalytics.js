// [FEAT-820] Vidalytics — the hosted player the sales videos play from, so marketing can
// see plays, watch time and clicks (owner, 2026-09-30).
//
// THE TWO EMBEDS, copied from each video's "Embed/Share → Inline Embed" code in the
// Vidalytics account. An embed's id and base URL are all its snippet carries; every
// player setting (Smart Autoplay, the seek bar with skipping turned off, Resume Play,
// picture-in-picture) lives in Vidalytics and is fetched with `loader.min.js`, so
// changing one there needs no deploy here.
export const WORK_WITH_US_VSL = Object.freeze({
  embedId: 'vidalytics_embed_24k4tZVTteZVJW17',
  base: 'https://fast.vidalytics.com/embeds/tczeutA7/24k4tZVTteZVJW17/',
});

export const THANK_YOU_VSL = Object.freeze({
  embedId: 'vidalytics_embed_Mf_11Vgriw88QZWH',
  base: 'https://fast.vidalytics.com/embeds/tczeutA7/Mf_11Vgriw88QZWH/',
});

/** Script URL → its load, so a return visit in this SPA never appends the loader twice. */
const scripts = new Map();

/**
 * Container element → its start, so React StrictMode's second effect reuses the first. The
 * start also records the player that was ALREADY registered under this embed id (a visit
 * earlier in this SPA session), so `vidalyticsPlayer` waits for the new one.
 */
const starts = new WeakMap();

/** A script load that FAILS when the script does (the vendor snippet has no failure path). */
function loadScript(src, doc) {
  if (scripts.has(src)) return scripts.get(src);
  const load = new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.async = true;
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => {
      scripts.delete(src);
      reject(new Error(`could not load ${src}`));
    };
    doc.head.appendChild(script);
  });
  scripts.set(src, load);
  return load;
}

/** The player registered under this embed id right now, never throwing. */
function registeredPlayer(embedId, win) {
  try {
    return win._vidalytics?.embeds?.[embedId]?.player ?? null;
  } catch {
    return null; // a getter the vendor defined that throws is "no player yet", not a crash
  }
}

/**
 * Start `embed` in `container` (the empty `<div id={embed.embedId}>` the snippet's first
 * line is). Resolves once the player is asked to run; REJECTS only when something fails —
 * a script that cannot load (an ad blocker, an outage) above all — so the caller can fold
 * the empty box away. It never throws synchronously: everything runs inside the promise.
 * A SLOW load is not a failure and has no deadline: the visitor waits for the player like
 * any embed, rather than a timer guessing wrong on a slow phone (owner, 2026-09-30: the
 * page "that gets us meetings" stays light and free of moving parts).
 *
 * This is the vendor snippet's own sequence — `loader.min.js`, then the loader fetches
 * `player.min.js` (its URL is versioned inside the loader, so a direct GET of the name
 * the snippet passes answers 404), then `new Vidalytics.Embed().run(id)` — with two
 * changes. The snippet has no failure path at all: an ad blocker or an outage leaves an
 * empty box and nothing else. And it appends the loader again on every run, which an SPA
 * revisiting the page would do each time.
 *
 * ⚠️ [FEAT-820 p2] THE GLOBALS ARE CREATED ONLY WHEN MISSING, exactly as the snippet does
 * (`if(!v[c]){v[c]={};}`), never `x = x || {}`. Once the loader has run it makes
 * `window.VidalyticsL` READ-ONLY, so re-assigning it — even to itself — throws in a module
 * (strict mode). The first version did that, and the second embed of a visit (the
 * thank-you video after the sales video) took the whole page down: measured in Chrome.
 */
export function startVidalyticsEmbed(embed, container, { win = window, doc = document } = {}) {
  const known = starts.get(container);
  if (known) return known.run;
  const stale = registeredPlayer(embed.embedId, win);
  const run = (async () => {
    if (!win.Vidalytics) win.Vidalytics = {};
    if (!win.VidalyticsL) win.VidalyticsL = {};
    if (!win._vidalytics) win._vidalytics = {};
    await loadScript(`${embed.base}loader.min.js`, doc);
    const Loader = win.VidalyticsL.Loader;
    if (typeof Loader !== 'function') throw new Error('the Vidalytics loader did not register');
    const loader = win._vidalytics.Loader || new Loader();
    await new Promise((resolve) => loader.loadScript(`${embed.base}player.min.js`, resolve));
    const Embed = win.Vidalytics.Embed;
    if (typeof Embed !== 'function') throw new Error('the Vidalytics player did not register');
    new Embed().run(embed.embedId);
  })();
  starts.set(container, { run, stale });
  return run;
}

/**
 * The player of THIS start once it exists, for the page to steer (the Player API:
 * play, pause, paused, on…). It WATCHES `_vidalytics.embeds[<embed id>].player` rather
 * than trapping the assignment the way the docs' `getVidalyticsPlayer` does: a trap needs
 * `Object.defineProperty` on an object the vendor owns and may lock, which is the same
 * class of failure as the read-only global above. The key is the FULL element id
 * (`vidalytics_embed_…`), measured in the loader and on a live page — the docs' "embed ID"
 * page says the short part, and that key is never written.
 *
 * Never rejects and never throws. If no new player appears within `timeoutMs` (the embed
 * was blocked, or the page left), it simply never resolves.
 */
export function vidalyticsPlayer(embed, container, { win = window, timeoutMs = 60000, intervalMs = 200 } = {}) {
  const stale = starts.get(container)?.stale ?? null;
  const began = Date.now();
  return new Promise((resolve) => {
    const look = () => {
      const player = registeredPlayer(embed.embedId, win);
      if (player && player !== stale) return resolve(player);
      if (Date.now() - began < timeoutMs) setTimeout(look, intervalMs);
      return undefined;
    };
    look();
  });
}
