// iClosed booking — the landing page's inline scheduling integration [FEAT-060 p2].
//
// Every constant and rule below is MEASURED, not assumed. Provenance: a real
// booking captured on allynutra.com/schedule on 2026-08-13, recorded in
// `apps/landing/docs/investigations/2026-08-19-scheduling-booking-flow.md`, and
// the working implementation in Ally-Nutra-LLC-New/ally-nutra
// (`src/lib/iclosedEvents.ts`, `src/components/scheduling/IClosedInlineEmbed.tsx`).
// iClosed publishes no documentation for its postMessage vocabulary, so none of
// this is recoverable from a vendor doc — do not "simplify" it from first
// principles.

/**
 * EXACT origin, always compared with `===`.
 *
 * A substring test (`origin.includes('app.iclosed.io')`) would also accept
 * `https://app.iclosed.io.evil.com`. These messages are the only booking signal
 * an inline embed has, so a loose test is a path to minting fake bookings from
 * any page able to open a frame.
 */
export const ICLOSED_ORIGIN = 'https://app.iclosed.io';

/**
 * The one event that carries both hosts, so iClosed round-robins between them
 * itself. That is why no rep picker and no per-rep URL lookup is needed here.
 */
export const DEFAULT_CONSULTATION_URL =
  'https://app.iclosed.io/e/allynutra/ally-nutra-consultation';

/**
 * [FEAT-839] The A/B test's page B (`/work-with-us-b`) books into its OWN iClosed
 * event, so its qualification questions and its bookings stay apart from the
 * control's. The control keeps `consultationUrl()` — the deployment's setting —
 * untouched.
 *
 * A literal rather than a second deployment variable: the event lives for the
 * length of one test. Page B still renders its frame only where
 * `consultationUrl()` is configured, so an unconfigured build books into neither.
 */
export const TEST_B_CONSULTATION_URL =
  'https://app.iclosed.io/e/allynutra/ally-nutra-consultation-qualified-test-b';

/**
 * [FEAT-839] The ad markers page B forwards into its booking frame — the same
 * names `touchpointCapture.js` records, plus `utm_term`, which iClosed's own
 * `tracking` object carries (supabase/functions/iclosed-webhook).
 *
 * The frame cannot read them for itself: `vercel.json` sends
 * `Referrer-Policy: strict-origin-when-cross-origin`, so a cross-origin frame
 * sees the origin and no query string. The control forwards none (requester
 * ruling, 2026-10-02 — page B only).
 */
export const ICLOSED_PASSTHROUGH_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'ttclid',
];

/**
 * The passthrough markers present in `search` (a `location.search` string), as
 * the `utm` object `buildIClosedBookingUrl` takes, or `null` when there are none.
 * Blank values are dropped. Anything not in the list above stays behind, so a
 * crafted link cannot reach iClosed's prefill parameters through this.
 */
export function iclosedPassthroughParams(search) {
  const query = new URLSearchParams(search || '');
  const out = {};
  for (const key of ICLOSED_PASSTHROUGH_PARAMS) {
    const value = (query.get(key) || '').trim();
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * iClosed's postMessage vocabulary, captured from the real booking.
 *
 * ⚠️ iClosed keys on `type`. It NEVER sets `event`.
 *
 * That one detail is why booking conversions silently stopped at the Calendly
 * cutover in the source repo: the GTM bridge tag read
 * `a.data.event && a.data.event.indexOf('calendly') === 0`, and on every iClosed
 * message `a.data.event` is undefined, so the `&&` short-circuited and the tag
 * quietly never fired. No error, nothing in GTM's debug view.
 *
 * | type                    | when                    |
 * |-------------------------|-------------------------|
 * | iclosed.widget_height   | constantly (~60/visit)  |
 * | scrollIntoView          | step change (NO prefix) |
 * | iclosed.potential       | form submitted          |
 * | iclosed.qualified       | passed qualification    |
 * | iclosed.call_scheduled  | BOOKING CONFIRMED       |
 */
export const ICLOSED_BOOKING_MESSAGE_TYPE = 'iclosed.call_scheduled';

/**
 * The configured scheduling URL, or `null` when unset.
 *
 * Read at CALL time, not module scope, so tests can `vi.stubEnv` it — the same
 * reason `demoRole.js`'s portal/funnel helpers do. Vite still inlines
 * `import.meta.env.VITE_*` statically for the shipped bundle, so this costs
 * nothing at runtime.
 *
 * Returning `null` when unset is deliberate and is what keeps this app honest:
 * `apps/landing/README.md` declares it "a design prototype, not a production
 * site", and its Contact form never transmits. A live booking widget that
 * appeared by default would make one surface on that page real while the form
 * beside it stays fake — a visitor could book a sales call nobody is expecting.
 * So the embed only renders where someone has explicitly configured a URL.
 */
export function consultationUrl() {
  const configured = import.meta.env.VITE_ICLOSED_CONSULTATION_URL;
  if (typeof configured !== 'string') return null;
  const trimmed = configured.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * True only for the booking-confirmed message.
 *
 * Deliberately EXACT equality, never a `startsWith('iclosed')` prefix test: the
 * widget emits ~60 `iclosed.widget_height` messages per visit, so a prefix match
 * fires sixty times for one booking.
 *
 * Origin is NOT checked here — the embed rejects anything not exactly
 * ICLOSED_ORIGIN before this is ever reached.
 */
export function isIClosedBookingMessage(data) {
  const payload = parseMessagePayload(data);
  return payload !== null && payload.type === ICLOSED_BOOKING_MESSAGE_TYPE;
}

/**
 * Normalise a postMessage payload to a plain object, or `null`.
 *
 * Some senders post JSON strings rather than structured clones, so a string is
 * parsed once here rather than at each call site.
 */
function parseMessagePayload(data) {
  let payload = data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return typeof payload === 'object' && payload !== null ? payload : null;
}

/**
 * The message iClosed uses to report how tall its content currently is
 * [BUG-423].
 */
export const ICLOSED_HEIGHT_MESSAGE_TYPE = 'iclosed.widget_height';

/**
 * The accepted range for a reported height, in CSS pixels.
 *
 * A reading outside it is DISCARDED rather than clamped, which keeps whatever
 * height the frame already had. The direction is deliberate: the failure this
 * guards against is a frame that collapses to nothing, and a booking widget
 * that is somewhat too tall is the bug we are fixing here, while a booking
 * widget that is gone is a dead acquisition surface. The floor sits below every
 * height measured on the live widget (the smallest was 392px, an intermediate
 * step during load) and the ceiling well above the tallest (854px, the stacked
 * layout at a narrow width).
 */
export const ICLOSED_MIN_HEIGHT = 320;
export const ICLOSED_MAX_HEIGHT = 4000;

/**
 * The height iClosed reports for its own content, in whole CSS pixels, or
 * `null` when this message does not carry a usable one [BUG-423].
 *
 * ⚠️ MEASURED, not assumed — like every other constant in this file. Captured
 * from the live widget on `https://www.allynutra.com/work-with-us`, 2026-09-21,
 * with a `message` listener installed before the frame loaded:
 *
 *     { type: 'iclosed.widget_height', height: '392px' }
 *     { type: 'iclosed.widget_height', height: '484.5px' }
 *     { type: 'iclosed.widget_height', height: '490px' }
 *
 * Two details that a hand-written parser gets wrong, and both were observed in
 * that one capture:
 *
 *   1. `height` is a STRING carrying a `px` suffix, not a number. `Number()`
 *      returns NaN for it; this reads it with `parseFloat`.
 *   2. The value can be FRACTIONAL (`484.5px`). It is rounded UP, because
 *      rounding down leaves a half-pixel of the widget's last row clipped —
 *      which is the whole complaint in #4154.
 *
 * A number and a bare numeric string are also accepted, because neither costs
 * anything and iClosed publishes no schema anyone could hold them to.
 */
export function readIClosedWidgetHeight(data) {
  const payload = parseMessagePayload(data);
  if (payload === null || payload.type !== ICLOSED_HEIGHT_MESSAGE_TYPE) return null;

  const raw = payload.height;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;

  // parseFloat, not Number: `Number('392px')` is NaN, and the px suffix is what
  // iClosed actually sends. parseFloat on a number is a no-op after coercion.
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return null;

  const height = Math.ceil(parsed);
  if (height < ICLOSED_MIN_HEIGHT || height > ICLOSED_MAX_HEIGHT) return null;
  return height;
}

/**
 * Builds the scheduling URL with the invitee's details prefilled and any UTM
 * parameters forwarded.
 *
 * Uses iClosed's DOCUMENTED prefill parameters — `iclosedName` / `iclosedEmail`
 * / `iclosedPhone` — not the `name` / `email` / `phone` that Calendly took.
 * Unknown query params are silently ignored by iClosed, so the Calendly names
 * leave the booking form empty with nothing to tell you why. That exact bug
 * shipped once in the source repo.
 *
 * `iclosedName` takes the FULL name; iClosed splits it into its own First/Last
 * fields, so do not pre-split it.
 *
 * Throws on an unparseable base URL rather than returning a broken string: a
 * malformed src would render an empty frame, which looks like "iClosed is down"
 * instead of "this app is misconfigured".
 */
export function buildIClosedBookingUrl(invitee = {}, utm = null, schedulingUrl = DEFAULT_CONSULTATION_URL) {
  const url = new URL(schedulingUrl);
  if (invitee.name) url.searchParams.set('iclosedName', invitee.name);
  if (invitee.email) url.searchParams.set('iclosedEmail', invitee.email);
  if (invitee.phone) url.searchParams.set('iclosedPhone', invitee.phone);
  if (utm) {
    for (const [key, value] of Object.entries(utm)) {
      if (value) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
