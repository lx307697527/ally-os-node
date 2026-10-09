/* [FEAT-622 / #4081] Site-wide ad tracking for allynutra.com.
 *
 * WHAT THIS FILE IS FOR, in plain terms. The company buys ads on Facebook and
 * Google. Those platforms can only learn where to spend the budget if the page an
 * ad click lands on reports back — "someone arrived", "someone asked for a quote".
 * The small scripts that do that reporting are what this file loads. Without them
 * the ads still cost money and people still click, but the platforms see nothing,
 * their automatic bidding loses its signal, and the remarketing audiences stop
 * refilling and age out over the following weeks.
 *
 * WHY IT HAD TO BE WRITTEN AT ALL. `allynutra.com` used to serve a different
 * deployment, whose homepage carried ten of these things. On 2026-09-20 the domain
 * was pointed at this app, which carried none — so every tag disappeared in one
 * step. This file is the port, and it is deliberately ONE file: the three HTML
 * entry documents (`apps/landing/index.html`, `public/quote/index.html`,
 * `public/schedule/index.html`) all load it, so they cannot drift into "the
 * homepage has GA4 and the quote page does not", which is a divergence nothing
 * would report.
 *
 * WHY IT LIVES IN `public/shared/` AND NOT IN `src/`. Two of those three pages are
 * hand-written static HTML with no build step; they cannot import anything from
 * `src/`. `public/shared/` is already where this app keeps the script those two
 * share (`demo-role.js`), so this sits beside it.
 *
 * WHY IT TAKES `window` AND `document` AS PARAMETERS. So the test suite can hand it
 * a fake pair — `new Function('window', 'document', source)(fakeWindow, fakeDoc)`
 * makes the parameters shadow the real globals for the whole file. In a browser
 * these same two names resolve to the real globals, so nothing test-only ships.
 * It is also why nothing below reaches for a bare global: `localStorage`,
 * `location` and the rest are always read THROUGH `window`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - This LOADER fires no Google Ads conversion and no Meta `Lead`. Since
 *     [BUG-740], the quote page sends its fixed Ads action after CRM acceptance.
 *     Booked calls: since [BUG-840] /thank-you-booked pushes `call_scheduled`
 *     once per booking iClosed's booking message handed over, and the container
 *     loaded here hangs its conversion tags on it. The iClosed
 *     frame's own container (`GTM-K66NLG5N`) reported bookings before that and
 *     must not keep doing so, or each booking counts twice. No generic conversion
 *     belongs in a file that runs on every page view.
 *   - It does not initialise the ad campaign's Meta dataset (the /work-with-us
 *     one). Since [FEAT-839] the HubSpot tracking code loaded below initialises
 *     it, on every page, from HubSpot's own configuration; registering it here too
 *     would count every page view twice. The id is deliberately not repeated
 *     here: a test asserts that it appears nowhere in this file, and an assertion
 *     that has to make an exception for a comment is an assertion with a hole in it.
 *   - It sends nothing a visitor typed. The only page-specific signals it enables are
 *     two fixed-field events: `quote_request_submitted`, pushed by the quote page, and
 *     `call_scheduled`, pushed by /thank-you-booked for a handed-over booking [BUG-840].
 */
(function (window, document) {
  'use strict';

  /* ── The identifiers, all in one place ──────────────────────────────────────
   * Every value here was read off the legacy homepage's served HTML on
   * 2026-09-20 and is carried verbatim. The ZoomInfo pair arrived obfuscated —
   * a self-decoding routine over two base64 strings — and is written out plainly
   * here instead: the decode was RUN, not eyeballed, and both the inputs and the
   * results are recorded in ops/specs/FEAT-622-landing-ad-tracking/prd.md. A line
   * of code nobody can read is a line of code nobody can audit. */

  /* Exact hostnames, never a suffix or substring test. A suffix test on the bare
   * domain would admit the development host, which is the one host this gate exists
   * to keep out of the live ad accounts; a substring test would additionally admit
   * anything an attacker registers with the domain as a prefix. The cost of
   * exactness is that a future production hostname must be added to this array by
   * hand — which is the right cost, because "does this host count as production" is
   * a decision someone should make rather than a string match. */
  var PRODUCTION_HOSTS = ['www.allynutra.com', 'allynutra.com'];

  var CONSENT_KEY = 'analytics_consent';
  /* The event a page listens for to learn that consent has just been applied
     [FEAT-642 / #4157]. See `notifyConsent` below for what it does and does not
     carry. Named here beside the storage key because the two are the same fact in
     two forms: what was decided, and when it was decided. */
  var CONSENT_EVENT = 'ally:consent';
  var GTM_ID = 'GTM-PKQVSCPB';
  var GOOGLE_ADS_ID = 'AW-17822720736';
  var META_PIXEL_IDS = ['4568582493371054', '877679608563522'];
  var META_PIXEL_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
  var ZOOMINFO_KEY = '3f0b24e8e41759851804';
  var ZOOMINFO_SRC = 'https://js.zi-scripts.com/zi-tag.js';
  var MOUSEFLOW_SRC = '//cdn.mouseflow.com/projects/80ec4255-e74b-4b94-b0f3-db2fdeb55ac4.js';
  var THOMASNET_SRC = 'https://services.thomasnet.com/roi/client.js?tid=31004308';
  var WEBTRAXS_ID = 'wt-267b2152-3f0c-4ba8-8b57-9412f4cf226e';
  var WEBTRAXS_SRC = '//www.webtraxs.com/wt.php';
  /* [FEAT-839] HubSpot's tracking code for portal 244045057 (region na2), carried
     exactly as HubSpot issues it: the element id and the protocol-relative URL are
     HubSpot's, not ours. */
  var HUBSPOT_SCRIPT_ID = 'hs-script-loader';
  var HUBSPOT_SRC = '//js-na2.hs-scripts.com/244045057.js';

  var GRANT_ALL = {
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
    analytics_storage: 'granted',
  };
  var GRANT_ANALYTICS_ONLY = {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  };
  var DENY_ALL = {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  };

  /* ── Gates ────────────────────────────────────────────────────────────────── */

  // Two entry documents could in principle both reference this file; a container
  // could inject it a second time. Either way the page must end up with one set of
  // tags, not two.
  if (window.__allyAdTrackingInstalled) return;

  // Nothing at all happens off production. Not the tags, not the data layer, not
  // the consent banner — a preview deployment or a developer's laptop must not put
  // a single event into a live ad account.
  if (PRODUCTION_HOSTS.indexOf(window.location.hostname) === -1) return;

  window.__allyAdTrackingInstalled = true;

  /* ── Helpers ──────────────────────────────────────────────────────────────── */

  /** Inject a script tag. Never blocking: a marketing page must survive a vendor
   *  CDN having a bad day, so every third-party tag here is async (or, for
   *  Mouseflow, defer — the attribute the legacy page used for it). */
  function loadScript(src, options) {
    var opts = options || {};
    var el = document.createElement('script');
    el.type = 'text/javascript';
    if (opts.defer) el.defer = true;
    else el.async = true;
    el.src = src;
    var parent = opts.intoBody && document.body ? document.body : document.head;
    if (parent) parent.appendChild(el);
    return el;
  }

  /** Read the stored consent choice. Storage THROWS rather than returning null in
   *  a browser with site data switched off (Safari private browsing, among
   *  others), and that is a different situation from "has not chosen yet" — see
   *  `showBanner` for why the difference matters. */
  function readConsent() {
    try {
      return window.localStorage.getItem(CONSENT_KEY);
    } catch (err) {
      return null;
    }
  }

  function writeConsent(value) {
    try {
      window.localStorage.setItem(CONSENT_KEY, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  function storageWorks() {
    try {
      window.localStorage.getItem(CONSENT_KEY);
      return true;
    } catch (err) {
      return false;
    }
  }

  function whenBodyReady(run) {
    if (document.body) run();
    else document.addEventListener('DOMContentLoaded', run);
  }

  /* ── 1. Google Consent Mode v2 ────────────────────────────────────────────── */

  /* This block runs FIRST, and that ordering is the whole point of a default: the
   * container and gtag.js read the consent state on their very first look at the
   * data layer, so anything pushed after them is too late. Everything starts
   * denied; only a visitor's stored choice, or a click on the banner, moves it. */

  window.dataLayer = window.dataLayer || [];

  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;

  gtag('consent', 'default', DENY_ALL);

  /** Load the Meta pixel. Called only after consent is granted — never at parse
   *  time — which is why the loader is a function rather than a straight-line
   *  snippet. `__metaPixelLoaded` makes it idempotent: a returning visitor whose
   *  stored choice already granted consent, who then somehow reaches the banner,
   *  must not get two copies of fbevents.js and two PageViews. */
  function loadMetaPixel() {
    if (window.__metaPixelLoaded) return;
    window.__metaPixelLoaded = true;

    if (!window.fbq) {
      var queue = function () {
        if (queue.callMethod) queue.callMethod.apply(queue, arguments);
        else queue.queue.push(arguments);
      };
      queue.push = queue;
      queue.loaded = true;
      queue.version = '2.0';
      queue.queue = [];
      window.fbq = queue;
      if (!window._fbq) window._fbq = queue;
      loadScript(META_PIXEL_SRC);
    }

    window.fbq('init', META_PIXEL_IDS[0]);
    window.fbq('init', META_PIXEL_IDS[1]);
    /* [FEAT-839] `trackSingle`, NOT `track`. A plain `fbq('track', 'PageView')` is a
       BROADCAST: it reaches every dataset registered on the page, not just these
       two. Since HubSpot's tracking code registers the ad campaign's dataset on
       every page, a first-time visitor who clicks Accept All after HubSpot has
       loaded would have given that dataset a SECOND PageView here. Targeted calls
       give exactly these two ids one each, whoever else is on the page. */
    window.fbq('trackSingle', META_PIXEL_IDS[0], 'PageView');
    window.fbq('trackSingle', META_PIXEL_IDS[1], 'PageView');
  }
  window.loadMetaPixel = loadMetaPixel;

  /** Apply a stored or freshly-clicked choice. `all` grants everything Google
   *  recognises and loads Meta; `essential` grants analytics only and loads NO
   *  Meta, because Meta has no analytics-only mode — there is no partial pixel to
   *  load. Any other value (including a legacy `none`) is treated as no choice,
   *  which leaves the denied default in place. */
  /** Tell the rest of the page a consent decision has been applied [FEAT-642].
   *
   *  A PAGE may have tracking of its own that must wait for the same moment this
   *  function acts on, and there was previously no way to learn about it: consent
   *  is applied here, and the only trace was `window.fbq` quietly coming into
   *  existence. A listener is how a page joins in without this file having to know
   *  anything about that page. (Its first listener, `/work-with-us`'s own dataset,
   *  was retired by [FEAT-839] when HubSpot took that dataset over; no page listens
   *  today, and the event costs nothing until one does.)
   *
   *  ⚠️ IT CARRIES THE CHOICE AND NOTHING ELSE. No dataset id belongs in this file
   *  — #4157 requirement 3 — and none is needed: a listener that knows its own id
   *  only needs to be told WHEN, not WHO.
   *
   *  Guarded, because everything in this file is: it runs before anything else on
   *  the page and must never be the reason a page fails to load. A host without
   *  `CustomEvent` or `dispatchEvent` simply gets no notification, which costs it
   *  the page-level pixel and nothing else. */
  function notifyConsent(choice) {
    try {
      if (typeof window.dispatchEvent !== 'function') return;
      if (typeof window.CustomEvent !== 'function') return;
      window.dispatchEvent(new window.CustomEvent(CONSENT_EVENT, { detail: { choice: choice } }));
    } catch (e) {
      /* A listener that throws is its own problem, not this script's. */
    }
  }

  function applyConsent(choice) {
    if (choice === 'all') {
      gtag('consent', 'update', GRANT_ALL);
      loadMetaPixel();
      notifyConsent(choice);
      return true;
    }
    if (choice === 'essential') {
      gtag('consent', 'update', GRANT_ANALYTICS_ONLY);
      notifyConsent(choice);
      return true;
    }
    return false;
  }

  /* Applied here, once, and the answer is kept: the banner at the bottom of this
   * file needs to know whether a choice already exists, and calling `applyConsent`
   * a second time to find out would push a second consent update for the same
   * decision. */
  var hasStoredChoice = applyConsent(readConsent());

  /* ── 2. Google Tag Manager ────────────────────────────────────────────────── */

  /* The container owns the parent-page GA4 property and legacy conversion tags, so
   * it is loaded in addition to the standalone Google Ads tag below. [BUG-740]
   * removed the legacy direct GA4 property after the live container was measured
   * loading its own property; keeping both split the same visit across two datasets.
   *
   * The matching `<noscript>` frame is static markup at the top of each entry
   * document's <body>; it cannot live here, because by definition it only runs
   * when this file does not. */
  window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  loadScript('https://www.googletagmanager.com/gtm.js?id=' + GTM_ID);

  /* ── 3. Google Ads conversion tag ─────────────────────────────────────────── */

  loadScript('https://www.googletagmanager.com/gtag/js?id=' + GOOGLE_ADS_ID);
  gtag('js', new Date());
  gtag('config', GOOGLE_ADS_ID);

  /* ── 4. GA4: owned by GTM-PKQVSCPB (G-KZSC9XFB0E), not loaded twice ───────── */

  /* ── 5. Meta pixel: already handled above, on consent only ────────────────── */

  /* ── 6. ZoomInfo ──────────────────────────────────────────────────────────── */

  /* Appended to <body> after the page has finished loading, as the legacy page
   * did — this one identifies visiting companies and has no reason to compete with
   * the page's own resources. */
  window.ZIProjectKey = ZOOMINFO_KEY;
  function appendZoomInfo() {
    loadScript(ZOOMINFO_SRC, { intoBody: true });
  }
  if (document.readyState === 'complete') appendZoomInfo();
  else window.addEventListener('load', appendZoomInfo);

  /* ── 7. Mouseflow session recording ───────────────────────────────────────── */

  window._mfq = window._mfq || [];
  loadScript(MOUSEFLOW_SRC, { defer: true });

  /* ── 8. ThomasNet ROI ─────────────────────────────────────────────────────── */

  /* Deliberately async, where the legacy page used a blocking <script src>. This
   * reports leads back to an industrial directory's paid programme; what it
   * reports does not depend on when it runs, and no reporting tag has any business
   * holding up the page a visitor came to read. */
  loadScript(THOMASNET_SRC);

  /* ── 9. Webtraxs ──────────────────────────────────────────────────────────── */

  window.wto = window.wto || [];
  window.wto.push(['setWTID', WEBTRAXS_ID]);
  window.wto.push(['webTraxs']);
  loadScript(window.location.protocol + WEBTRAXS_SRC);

  /* ── 9b. HubSpot tracking code [FEAT-839 / #5705] ─────────────────────────── */

  /* Loaded for EVERY visitor on the two production hostnames, and NOT gated on the
   * consent banner below — the requester's ruling (2026-10-02), taken knowing what
   * it means: HubSpot is configured to load the ad campaign's Meta dataset, so that
   * dataset now reports visitors who chose "Essential Only" too. It sits inside this
   * file rather than as a tag in each entry document so that it shares the
   * production-host gate above: a preview build or a laptop puts nothing into the
   * live HubSpot portal, exactly like every other tag here.
   *
   * Measured 2026-10-02 from HubSpot's own published files: this loader injects
   * HubSpot's analytics, forms collector, cookie banner (configured EMPTY, so none
   * appears) and ads-pixel script; the ads-pixel script's configuration lists one
   * Meta dataset and no Google or LinkedIn tag. Its PageView is a broadcast, which
   * is why `loadMetaPixel` above uses `trackSingle`.
   *
   * Attributes as HubSpot issues them — `async` AND `defer`, the element id HubSpot
   * looks for to avoid loading itself twice — and skipped if that element already
   * exists, so a copy pasted in by hand elsewhere cannot make it load twice. */
  function loadHubSpot() {
    if (typeof document.getElementById === 'function' && document.getElementById(HUBSPOT_SCRIPT_ID)) {
      return;
    }
    var el = document.createElement('script');
    el.type = 'text/javascript';
    el.id = HUBSPOT_SCRIPT_ID;
    el.async = true;
    el.defer = true;
    el.src = HUBSPOT_SRC;
    if (document.head) document.head.appendChild(el);
  }
  loadHubSpot();

  /* ── 10. The consent banner ───────────────────────────────────────────────── */

  /* WHY THIS IS NOT OPTIONAL, and is the part most likely to be dropped as
   * "chrome": consent starts denied and the Meta pixel only loads from inside a
   * consent-gated function. The banner is the ONLY thing that ever changes that.
   * Ship the tags without it and the site looks correct, emits Google traffic, and
   * silently never grants consent or loads Meta — with nothing to signal it.
   *
   * It is plain DOM rather than a React component because it has to appear on all
   * three entry documents, and two of them have no React and no build step. One
   * implementation cannot drift from itself; two would, and the drift would show up
   * as "consent works on the homepage but not on the quote page", which no test
   * and no alarm would catch.
   *
   * The styles are inline for the same reason: the two static pages never load
   * `global.css`, so a class name would resolve on one page and to nothing on the
   * other two. */

  var BANNER_TEXT =
    'We use cookies and similar technologies to measure how our advertising ' +
    'performs and to improve this site. You can accept all of them, or keep only ' +
    'the ones this site needs to work.';

  function showBanner() {
    var banner = document.createElement('div');
    banner.setAttribute('data-ally-consent-banner', 'true');
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483000;' +
      'background:#1E3A5F;color:#FFFFFF;padding:16px 24px;' +
      "font-family:'Roboto',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;" +
      'display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:center;' +
      'box-shadow:0 -2px 12px rgba(0,0,0,.25);';

    var message = document.createElement('p');
    message.textContent = BANNER_TEXT;
    message.style.cssText = 'margin:0;max-width:720px;flex:1 1 320px;';
    banner.appendChild(message);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:12px;flex:0 0 auto;';
    banner.appendChild(actions);

    function dismiss() {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }

    function addButton(label, choice, style) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('data-ally-consent', choice);
      button.style.cssText =
        'font:inherit;font-weight:600;padding:10px 20px;border-radius:6px;' +
        'cursor:pointer;white-space:nowrap;' +
        style;
      button.addEventListener('click', function () {
        // Record first, then act. If storage refuses the write the visitor's
        // choice cannot be remembered, but the choice they just made still
        // deserves to be honoured for this page view.
        writeConsent(choice);
        applyConsent(choice);
        dismiss();
      });
      actions.appendChild(button);
      return button;
    }

    addButton('Accept All', 'all', 'background:#F0A829;color:#18181B;border:1px solid #F0A829;');
    addButton(
      'Essential Only',
      'essential',
      'background:transparent;color:#FFFFFF;border:1px solid rgba(255,255,255,.55);',
    );

    if (document.body) document.body.appendChild(banner);
  }

  /* Three conditions, and the middle one is the subtle one. A browser whose storage
   * THROWS gets no banner at all: its buttons could not record anything, so it
   * would be a prompt that reappears on every page view forever and never changes
   * the outcome. Consent stays denied for that visitor, which is the safe
   * direction — Google stays cookieless and Meta never loads. */
  if (!hasStoredChoice && storageWorks()) {
    whenBodyReady(showBanner);
  }
})(window, document);
