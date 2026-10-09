// [BUG-837 / #6028] The booked-call conversion: ONE `call_scheduled` per iClosed booking.
//
// [BUG-840 / #6034] A booking reaches the thank-you page in one of two ways:
//   * THE MESSAGE, in memory (/work-with-us, /work-with-us-b and — since FEAT-899 —
//     /contact). iClosed's frame posts `iclosed.call_scheduled`; `handOverBookedCall()`
//     leaves a fresh single-use token in memory, and the page moves in-app to
//     /thank-you-booked 2.5 s later. BUG-837 assumed this message never arrives; it does:
//     the in-app move has no other trigger, and since 2026-09-30 every recorded visit to
//     /thank-you-booked carries the ad referrer of the /work-with-us load, none an
//     app.iclosed.io one.
//   * THE REDIRECT, a full page load to /thank-you-booked?previewId=<id>.
//     `public/shared/booking-redirect.js` reads the id, wipes the address and hands it over
//     before any tag loads. [FEAT-899] The static /schedule/ page takes this path for every
//     booking, with a `sch_` token it minted; iClosed's own redirect to it has never been
//     seen landing.
// Either way the same hand-over slot carries it, so only one path can count a booking: a
// full page load wipes the memory the message path wrote, and the confirmation removes the
// iClosed frame the moment the message arrives, so it cannot redirect afterwards.
//
// The thank-you page calls `reportBookedCall()` once mounted, which is after tracking.js
// has put the consent default in the data layer, so GTM always sees the consent state
// before this event.
//
// Exactly once per booking:
//   * the hand-over is single use: it is deleted on the first read, so a second mount in
//     the same page load reports nothing;
//   * every booking id reported is remembered in localStorage (`an_booked_calls`, the 50
//     most recent), so opening the same redirect again on this device reports nothing;
//   * a direct visit or a reload has no hand-over at all (the address was wiped and the
//     hand-over lives in memory), so it reports nothing.
// Where storage is blocked the id cannot be remembered, but the single-use hand-over still
// caps it at one per redirect.
//
// What is pushed is fixed, the event BUG-835 introduced, field for field. Neither the
// booking id nor anything else from the address is ever in it, so no name, email or phone
// can reach the data layer. `scheduler_event` stays the control's event name: the redirect
// does not say which page the booking was made on.
//
// [FEAT-899 / #6232] Every page that takes a booking hands it over here: /work-with-us and
// /work-with-us-b and /contact through the in-memory token, and the static /schedule/ (a
// separate document, so a full page load) through the redirect path's
// `?previewId=sch_<token>`. And in the same guarded spot, right after the push, the booking
// is reported to Google Ads — AN | Call Scheduled | 2026 — but ONLY when the visitor's most
// recent paid click was a Google ad (`lastPaidClick()`, public/shared/lead-attribution.js).
// A Meta or TikTok paid click, or none, sends nothing to Google: Meta's bookings must not be
// claimed by Google (19 of that action's last 21 conversions were). `send_to` is the only
// parameter, as on the quote page; Consent Mode decides what that call may store or send.

import { lastPaidClick } from './leadAttribution.js';

export const BOOKED_CALL_HANDOFF = '__allyBookedCallId';
/** [FEAT-899] Google Ads "AN | Call Scheduled | 2026" (account 739-591-9486). */
export const GOOGLE_ADS_BOOKED_CALL_SEND_TO = 'AW-17822720736/jAsQCPiCwcwcEODFxLJC';
export const BOOKED_CALL_SEEN_KEY = 'an_booked_calls';
const BOOKED_CALL_SEEN_MAX = 50;
const BOOKING_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Exactly what the site's GTM receives for one booking. */
export const CALL_SCHEDULED_EVENT = Object.freeze({
  event: 'call_scheduled',
  conversion_name: 'invitee_meeting_scheduled',
  booking_source: 'iclosed',
  scheduler_event: 'ally-nutra-consultation',
});

function storageOf(win) {
  try {
    return win.localStorage ?? null;
  } catch {
    return null; // a browser that blocks storage throws on the property itself
  }
}

function readSeen(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(BOOKED_CALL_SEEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeSeen(storage, ids) {
  try {
    storage?.setItem(BOOKED_CALL_SEEN_KEY, JSON.stringify(ids.slice(-BOOKED_CALL_SEEN_MAX)));
  } catch {
    // Storage blocked or full: the single-use hand-over still allows one push per redirect.
  }
}

/**
 * [BUG-840 / #6034] Hand over the booking iClosed's booking-confirmed message reported, for
 * the thank-you page to count after the in-app move. Returns the token it left.
 *
 * The message carries no booking id this site has ever measured, so a fresh token stands in
 * for one. It is unique per call, so the dedupe in `reportBookedCall` stops the SAME
 * hand-over counting twice and never a second real booking.
 */
export function handOverBookedCall(win = window) {
  const token = `msg_${mintToken(win)}`;
  win[BOOKED_CALL_HANDOFF] = token;
  return token;
}

function mintToken(win) {
  try {
    const uuid = win.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid) return uuid;
  } catch {
    // An insecure context has no randomUUID; the fallback below is unique enough here.
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Push `call_scheduled` if a booking was handed over in this page load (by the booking
 * message or by iClosed's redirect) and not reported before on this device. Returns whether
 * it pushed.
 */
export function reportBookedCall(win = window) {
  const bookingId = win[BOOKED_CALL_HANDOFF];
  try {
    delete win[BOOKED_CALL_HANDOFF];
  } catch {
    win[BOOKED_CALL_HANDOFF] = undefined;
  }
  if (typeof bookingId !== 'string' || !BOOKING_ID_RE.test(bookingId)) return false;

  const storage = storageOf(win);
  const seen = readSeen(storage);
  if (seen.includes(bookingId)) return false;
  writeSeen(storage, [...seen, bookingId]);

  win.dataLayer = win.dataLayer || [];
  win.dataLayer.push({ ...CALL_SCHEDULED_EVENT });
  reportToGoogleAds(win);
  return true;
}

/**
 * [FEAT-899] The booking, reported to Google Ads, when the visitor's most recent paid click
 * was a Google ad. Called only from inside `reportBookedCall`'s guard, so it inherits its
 * "once per booking". The booking is already counted in the data layer: a missing or broken
 * gtag (an ad blocker, a preview host where tracking.js loads nothing) costs this one report
 * and never the thank-you page.
 */
function reportToGoogleAds(win) {
  if (lastPaidClick(win)?.platform !== 'google') return;
  try {
    if (typeof win.gtag === 'function') {
      win.gtag('event', 'conversion', { send_to: GOOGLE_ADS_BOOKED_CALL_SEND_TO });
    }
  } catch (err) {
    console.warn('[FEAT-899] the booked call was not reported to Google Ads:', err);
  }
}
