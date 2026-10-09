/* [FEAT-859 / #5775] Where did this visitor FIRST come from? Saved on arrival, handed over
 * when they identify themselves.
 *
 * WHAT THIS FILE IS FOR, in plain terms. An ad click puts tags in the address
 * (utm_source=facebook …) and the ad platforms add a click id (fbclid for Meta, gclid for
 * Google Ads). Those tags are gone as soon as the visitor clicks to another page, comes
 * back tomorrow by typing the address, or books a call inside the iClosed frame — which
 * cannot see this page's address at all (vercel.json's Referrer-Policy hides the query from
 * a cross-origin frame). Since 2026-09-20 that is exactly how every iClosed booking lost
 * its source. So, on every page load:
 *
 *   1. FIRST TOUCH. On the very first landing, the tags, click ids, the referring site's
 *      host, the landing path and the time are saved — in a 90-day first-party cookie
 *      `an_ft` AND in localStorage. It is NEVER overwritten while it lives.
 *   2. LAST TOUCH. Any later arrival that carries tags or comes from another site replaces
 *      `an_lt`. A typed address (no tags, no referrer) does not: "came back directly" is not
 *      a new source.
 *   3. VISITOR ID. The site's anonymous id, `an_visitor_id` in localStorage (the same key
 *      touchpointCapture.js and the quote page use), mirrored into a 90-day `an_vid` cookie.
 *   4. LAST PAID CLICK [FEAT-899 / #6232]. Which ad platform the visitor's most recent PAID
 *      click came from, and when: `an_lp`, a 90-day cookie AND localStorage holding the click
 *      TYPE and TIME only, never the click id. Only an arrival that carries a paid click
 *      moves it, so a later organic visit, a typed-in address or an unpaid Facebook link
 *      cannot erase a Google ad click the way they can replace `an_lt`:
 *        gclid / gbraid / wbraid  → Google (gbraid / wbraid are Google's ids for some iOS
 *                                   clicks, which may carry no gclid at all);
 *        ttclid                   → TikTok;
 *        fbclid                   → Meta, but ONLY when the same arrival says
 *                                   utm_medium=paid_social (or "paid social"): Facebook and
 *                                   Instagram add an fbclid to unpaid post and bio-link
 *                                   clicks too, and those are not ad clicks (owner,
 *                                   2026-10-08).
 *      The booked-call page asks it whether to report a booking to Google Ads
 *      (src/lib/bookedCall.js). Nothing here forwards it anywhere.
 *
 * …and `window.AllyLeadAttribution` hands them to whoever needs them: every iClosed frame
 * (iclosedParams), the quote form (firstTouchRpcParams / sessionUtm), and the booked-call
 * page (lastPaidClick).
 *
 * ⚠️ IDS AND AD TAGS ONLY. Nothing a visitor typed, no name, no email, no phone, and not
 * the landing page's whole query string (which could carry anything) — the request's
 * "don't put personal data in URLs" rule, and the reason every value below is checked
 * against a character set and a length before it is stored or forwarded.
 *
 * WHY IT LIVES IN `public/shared/` AND IS A PLAIN SCRIPT. Two of the three entry documents
 * (`public/quote/index.html`, `public/schedule/index.html`) are static HTML with no build
 * step; `tracking.js` beside this file is the precedent. It takes `window` and `document`
 * as parameters so the test can hand it fakes; nothing below reaches for a bare global.
 * It never throws: a beacon must not be able to take the page down.
 */
(function (window, document) {
  'use strict';

  var FIRST_KEY = 'an_ft';
  var LAST_KEY = 'an_lt';
  var VISITOR_KEY = 'an_visitor_id';
  var VISITOR_COOKIE = 'an_vid';
  var TTL_MS = 90 * 24 * 3600 * 1000;
  var MARKER_MAX = 200;
  var CLICK_ID_MAX = 512;
  var CLICK_ID_RE = /^[A-Za-z0-9_.-]+$/;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var HOST_RE = /^[a-z0-9.-]+$/;
  /* eslint-disable-next-line no-control-regex */
  var CONTROL_RE = /[\u0000-\u001f\u007f]/;
  var OWN_DOMAIN = 'allynutra.com';

  /* The tags read from an address, and the short keys they are stored under. */
  var MARKERS = [
    ['utm_source', 's'],
    ['utm_medium', 'm'],
    ['utm_campaign', 'c'],
    ['utm_content', 'n'],
    ['utm_term', 't'],
  ];
  var CLICK_IDS = [
    ['gclid', 'g'],
    ['fbclid', 'f'],
    ['ttclid', 'k'],
  ];

  /* [FEAT-899] The last paid click. The click ids that make an arrival a PAID click, in the
     order they are tried (first match wins), and the ad platform each belongs to. gbraid and
     wbraid are read for this record ONLY: they are not stored in an_ft / an_lt and are not
     forwarded to iClosed or to the database. */
  var PAID_KEY = 'an_lp';
  var PAID_CLICKS = [
    ['gclid', 'google'],
    ['gbraid', 'google'],
    ['wbraid', 'google'],
    ['ttclid', 'tiktok'],
    ['fbclid', 'meta'],
  ];
  var META_PAID_MEDIA = ['paid_social', 'paid social'];

  function marker(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim();
    return v !== '' && v.length <= MARKER_MAX && !CONTROL_RE.test(v) ? v : null;
  }

  function clickId(value, max) {
    if (typeof value !== 'string') return null;
    var v = value.trim();
    return v !== '' && v.length <= (max || CLICK_ID_MAX) && CLICK_ID_RE.test(v) ? v : null;
  }

  function hostOf(url) {
    try {
      var h = new URL(url).hostname.toLowerCase();
      return h.length <= 253 && HOST_RE.test(h) ? h : null;
    } catch (e) {
      return null;
    }
  }

  /* Our own hosts (www / apex / portal / dev) are internal hops, not sources. */
  function isOwnHost(host, currentHost) {
    if (!host) return false;
    if (host === currentHost) return true;
    return host === OWN_DOMAIN || host.slice(-(OWN_DOMAIN.length + 1)) === '.' + OWN_DOMAIN;
  }

  /** The arrival this page load represents, in stored (short-key) form. */
  function readArrival(href, referrer, now) {
    var url;
    try {
      url = new URL(href);
    } catch (e) {
      return null;
    }
    var q = url.searchParams;
    var touch = { v: 1, at: now };
    var i;
    for (i = 0; i < MARKERS.length; i++) {
      var m = marker(q.get(MARKERS[i][0]));
      if (m) touch[MARKERS[i][1]] = m;
    }
    for (i = 0; i < CLICK_IDS.length; i++) {
      var c = clickId(q.get(CLICK_IDS[i][0]));
      if (c) touch[CLICK_IDS[i][1]] = c;
    }
    var ref = referrer ? hostOf(referrer) : null;
    if (ref && !isOwnHost(ref, url.hostname.toLowerCase())) touch.r = ref;
    var path = url.pathname;
    if (typeof path === 'string' && path.charAt(0) === '/' && path.length <= 1024 && path.indexOf('//') !== 0) {
      touch.p = path;
    }
    return touch;
  }

  function isMarked(touch) {
    if (!touch) return false;
    return !!(touch.s || touch.m || touch.c || touch.n || touch.t || touch.g || touch.f || touch.k || touch.r);
  }

  /* ── storage, every access guarded ──────────────────────────────────────── */

  function storage() {
    try {
      return window.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function readCookie(name) {
    var all;
    try {
      all = String(document.cookie || '');
    } catch (e) {
      return null;
    }
    var parts = all.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].replace(/^\s+/, '');
      if (kv.indexOf(name + '=') === 0) {
        try {
          return decodeURIComponent(kv.slice(name.length + 1));
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }

  function cookieDomain(hostname) {
    var h = String(hostname || '').toLowerCase();
    return h === OWN_DOMAIN || h.slice(-(OWN_DOMAIN.length + 1)) === '.' + OWN_DOMAIN ? '.' + OWN_DOMAIN : null;
  }

  function writeCookie(name, value, maxAgeSeconds) {
    try {
      var loc = window.location || {};
      var parts = [
        name + '=' + encodeURIComponent(value),
        'Max-Age=' + Math.max(0, Math.floor(maxAgeSeconds)),
        'Path=/',
        'SameSite=Lax',
      ];
      var domain = cookieDomain(loc.hostname);
      if (domain) parts.push('Domain=' + domain);
      if (loc.protocol === 'https:') parts.push('Secure');
      document.cookie = parts.join('; ');
    } catch (e) {
      /* best effort */
    }
  }

  function parseTouch(text, now) {
    if (!text) return null;
    try {
      var t = JSON.parse(text);
      if (!t || typeof t !== 'object' || typeof t.at !== 'number') return null;
      if (t.at > now + 60000 || now - t.at > TTL_MS) return null; // expired or nonsense
      return t;
    } catch (e) {
      return null;
    }
  }

  function readTouch(key, now) {
    var fromCookie = parseTouch(readCookie(key), now);
    var store = storage();
    var fromStorage = null;
    try {
      fromStorage = store ? parseTouch(store.getItem(key), now) : null;
    } catch (e) {
      fromStorage = null;
    }
    return fromCookie || fromStorage;
  }

  function writeTouch(key, touch, now) {
    var text = JSON.stringify(touch);
    writeCookie(key, text, (touch.at + TTL_MS - now) / 1000);
    var store = storage();
    try {
      if (store) store.setItem(key, text);
    } catch (e) {
      /* best effort */
    }
  }

  function mintId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) {
      /* fall through */
    }
    return null;
  }

  function resolveVisitorId() {
    var store = storage();
    var id = null;
    try {
      id = store ? store.getItem(VISITOR_KEY) : null;
    } catch (e) {
      id = null;
    }
    if (!id || !UUID_RE.test(id)) {
      var fromCookie = readCookie(VISITOR_COOKIE);
      id = fromCookie && UUID_RE.test(fromCookie) ? fromCookie : mintId();
      if (id) {
        try {
          if (store) store.setItem(VISITOR_KEY, id);
        } catch (e) {
          /* best effort */
        }
      }
    }
    if (id) writeCookie(VISITOR_COOKIE, id, TTL_MS / 1000);
    return id ? id.toLowerCase() : null;
  }

  /* ── the last paid click [FEAT-899] ──────────────────────────────────────── */

  /** utm_medium paid_social or "paid social", whatever the case and spacing. */
  function isMetaPaidMedium(value) {
    var m = marker(value);
    return !!m && META_PAID_MEDIA.indexOf(m.toLowerCase().replace(/\s+/g, ' ')) !== -1;
  }

  function platformOf(type) {
    for (var i = 0; i < PAID_CLICKS.length; i++) if (PAID_CLICKS[i][0] === type) return PAID_CLICKS[i][1];
    return null;
  }

  /** The paid click this page load's address carries, as stored, or null. */
  function readPaidArrival(href, now) {
    var url;
    try {
      url = new URL(href);
    } catch (e) {
      return null;
    }
    var q = url.searchParams;
    for (var i = 0; i < PAID_CLICKS.length; i++) {
      var type = PAID_CLICKS[i][0];
      if (!clickId(q.get(type))) continue;
      if (type === 'fbclid' && !isMetaPaidMedium(q.get('utm_medium'))) continue;
      return { v: 1, k: type, at: now };
    }
    return null;
  }

  /** The same rule over a touch saved before an_lp existed (short keys, its own time). */
  function seedPaid(touch) {
    if (!touch) return null;
    if (touch.g) return { v: 1, k: 'gclid', at: touch.at };
    if (touch.k) return { v: 1, k: 'ttclid', at: touch.at };
    if (touch.f && isMetaPaidMedium(touch.m)) return { v: 1, k: 'fbclid', at: touch.at };
    return null;
  }

  function parsePaid(text, now) {
    if (!text) return null;
    try {
      var p = JSON.parse(text);
      if (!p || typeof p !== 'object' || typeof p.at !== 'number' || !platformOf(p.k)) return null;
      if (p.at > now + 60000 || now - p.at > TTL_MS) return null; // expired or nonsense
      return { v: 1, k: p.k, at: p.at };
    } catch (e) {
      return null;
    }
  }

  function readPaid(now) {
    var fromCookie = parsePaid(readCookie(PAID_KEY), now);
    var store = storage();
    var fromStorage = null;
    try {
      fromStorage = store ? parsePaid(store.getItem(PAID_KEY), now) : null;
    } catch (e) {
      fromStorage = null;
    }
    return fromCookie || fromStorage;
  }

  /** Same two copies as an_ft / an_lt, expiring 90 days after the CLICK, never extended. */
  function writePaid(paid, now) {
    var text = JSON.stringify(paid);
    writeCookie(PAID_KEY, text, (paid.at + TTL_MS - now) / 1000);
    var store = storage();
    try {
      if (store) store.setItem(PAID_KEY, text);
    } catch (e) {
      /* best effort */
    }
  }

  /* ── record this arrival ─────────────────────────────────────────────────── */

  var state = { first: null, last: null, visitorId: null, paid: null };

  function record(now) {
    var loc = window.location || {};
    var arrival = readArrival(String(loc.href || ''), String(document.referrer || ''), now);
    var first = readTouch(FIRST_KEY, now);
    if (!first && arrival) {
      first = arrival;
      writeTouch(FIRST_KEY, first, now);
    } else if (first) {
      // Present in one place only (cleared storage, a cookie-blocking session that later
      // allowed cookies): restore the other copy without changing the value.
      writeTouch(FIRST_KEY, first, now);
    }
    var last = readTouch(LAST_KEY, now);
    // [FEAT-899] The last touch as it was BEFORE this arrival: the one-time seed below must
    // see a Google click that an organic or referral arrival is about to replace.
    var previousLast = last;
    if (arrival && isMarked(arrival)) {
      last = arrival;
      writeTouch(LAST_KEY, last, now);
    }
    // [FEAT-899] Only an arrival with a paid click moves the last paid click. Without
    // one, it is seeded once from the touches this browser saved before an_lp existed
    // (the last touch as it was before this arrival first, being the more recent), and
    // otherwise kept as it was, with
    // a lost copy restored.
    var paid = readPaidArrival(String(loc.href || ''), now) || readPaid(now) || seedPaid(previousLast) || seedPaid(first);
    if (paid) writePaid(paid, now);
    state.first = first;
    state.last = last;
    state.paid = paid;
    state.visitorId = resolveVisitorId();
  }

  /* ── what each consumer gets ─────────────────────────────────────────────── */

  function longTouch(t) {
    if (!t) return null;
    return {
      at: t.at,
      source: t.s || null,
      medium: t.m || null,
      campaign: t.c || null,
      content: t.n || null,
      term: t.t || null,
      gclid: t.g || null,
      fbclid: t.f || null,
      ttclid: t.k || null,
      referrerHost: t.r || null,
      landingPath: t.p || null,
    };
  }

  /**
   * The parameters every iClosed frame gets (AC-3): the latest arrival's tags as utm_* /
   * click ids (what this booking session came from — iClosed's own reports read these),
   * the first arrival as ft_*, the visitor id, and Meta's browser cookies. A fixed list,
   * values already checked — nothing else can leave through here.
   */
  function iclosedParams() {
    var out = {};
    var session = state.last || state.first;
    var i;
    if (session) {
      for (i = 0; i < MARKERS.length; i++) if (session[MARKERS[i][1]]) out[MARKERS[i][0]] = session[MARKERS[i][1]];
      for (i = 0; i < CLICK_IDS.length; i++) if (session[CLICK_IDS[i][1]]) out[CLICK_IDS[i][0]] = session[CLICK_IDS[i][1]];
    }
    if (state.visitorId) out.an_vid = state.visitorId;
    var fbp = clickId(readCookie('_fbp'), 255);
    if (fbp) out._fbp = fbp;
    var fbc = clickId(readCookie('_fbc'));
    if (fbc) out._fbc = fbc;
    var f = state.first;
    if (f) {
      out.ft_at = String(Math.floor(f.at / 1000));
      if (f.s) out.ft_source = f.s;
      if (f.m) out.ft_medium = f.m;
      if (f.c) out.ft_campaign = f.c;
      if (f.n) out.ft_content = f.n;
      if (f.t) out.ft_term = f.t;
      if (f.g) out.ft_gclid = f.g;
      if (f.f) out.ft_fbclid = f.f;
      if (f.k) out.ft_ttclid = f.k;
      if (f.r) out.ft_ref = f.r;
      if (f.p) out.ft_path = f.p;
    }
    return out;
  }

  /** marketing.capture_first_touch's parameters, or null when there is nothing to send. */
  function firstTouchRpcParams() {
    var f = state.first;
    if (!f || !state.visitorId) return null;
    return {
      p_visitor_id: state.visitorId,
      p_occurred_at: new Date(f.at).toISOString(),
      p_landing_path: f.p || null,
      p_source: f.s || null,
      p_medium: f.m || null,
      p_campaign: f.c || null,
      p_content: f.n || null,
      p_term: f.t || null,
      p_gclid: f.g || null,
      p_fbclid: f.f || null,
      p_ttclid: f.k || null,
      p_fbp: clickId(readCookie('_fbp'), 255),
      p_referrer_host: f.r || null,
    };
  }

  /** The latest arrival's utm_source / medium / campaign, for a form's p_utm_* fields. */
  function sessionUtm() {
    var t = state.last || state.first;
    return {
      source: (t && t.s) || null,
      medium: (t && t.m) || null,
      campaign: (t && t.c) || null,
    };
  }

  try {
    record(Date.now());
  } catch (e) {
    /* never take the page down */
  }

  window.AllyLeadAttribution = {
    iclosedParams: iclosedParams,
    firstTouchRpcParams: firstTouchRpcParams,
    sessionUtm: sessionUtm,
    firstTouch: function () {
      return longTouch(state.first);
    },
    lastTouch: function () {
      return longTouch(state.last);
    },
    visitorId: function () {
      return state.visitorId;
    },
    /** [FEAT-899] `{ type, platform, at }` of the most recent paid click, or null. */
    lastPaidClick: function () {
      var p = state.paid;
      return p ? { type: p.k, platform: platformOf(p.k), at: p.at } : null;
    },
  };
})(window, document);
