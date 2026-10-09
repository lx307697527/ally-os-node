/* [BUG-837 / #6028] iClosed's redirect after a booking: keep the booking id, wipe the
 * address before anything else on the page can read it.
 *
 * WHAT THIS FILE IS FOR, in plain terms. iClosed can send a booker's browser to
 * https://allynutra.com/thank-you-booked?previewId=<booking id>&… after a booking.
 * [BUG-840 / #6034] On this site that redirect has never been seen landing: bookings arrive
 * through the `iclosed.call_scheduled` message on /work-with-us instead (BUG-837 believed
 * the opposite), and `src/lib/bookedCall.js` counts those. This file is the FALLBACK for
 * the day the redirect does land. The redirect can also carry what the visitor typed into
 * iClosed, so the address must not survive long enough for any tag to record it.
 *
 * So, on /thank-you-booked only, and before tracking.js has loaded a single tag:
 *   1. read `previewId`, and keep it only if it looks like an iClosed booking id —
 *      letters, digits, `_` and `-`, 8 to 64 characters (every one of the 152 booking ids
 *      iClosed had sent this site by 2026-10-07 is 17 such characters);
 *   2. remove EVERY query parameter (and any fragment) from the address with
 *      history.replaceState, so GTM, GA4, Meta, HubSpot and the rest only ever see
 *      `/thank-you-booked`;
 *   3. hand the id to the app as `window.__allyBookedCallId`. It lives in memory only, so
 *      a reload has nothing to hand over. The thank-you page pushes `call_scheduled` once
 *      per id (`src/lib/bookedCall.js`); nothing in this file sends anything.
 *
 * WHY IT IS A PLAIN SCRIPT, FIRST IN index.html's <head>. It has to run before tracking.js
 * (which starts GTM) and lead-attribution.js (which reads the landing address); the app's
 * own bundle runs far too late for that. It takes `window` as a parameter so the test can
 * hand it a fake (tracking.js's pattern), and it never throws: a page that cannot rewrite
 * its address must still render.
 */
(function (window) {
  'use strict';

  var PATH = '/thank-you-booked';
  var BOOKING_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

  var location;
  try {
    location = window.location;
    if (location.pathname.replace(/\/+$/, '') !== PATH) return;
    if (!location.search && !location.hash) return;
  } catch (e) {
    return;
  }

  /* 1. The booking id, read before the address is wiped. */
  var bookingId = null;
  try {
    bookingId = new window.URLSearchParams(location.search).get('previewId');
  } catch (e) {
    bookingId = null;
  }

  /* 2. Wipe every parameter. A browser that refuses keeps its address; the id is still
     handed over, because the booking really happened. */
  try {
    window.history.replaceState(window.history.state, '', location.pathname);
  } catch (e) {
    /* nothing to do */
  }

  /* 3. The id alone, in memory, for the app. */
  if (typeof bookingId === 'string' && BOOKING_ID_RE.test(bookingId)) {
    window.__allyBookedCallId = bookingId;
  }
})(window);
