import { useEffect, useRef, useState } from 'react';
import {
  ICLOSED_ORIGIN,
  buildIClosedBookingUrl,
  isIClosedBookingMessage,
  readIClosedWidgetHeight,
} from '../lib/iclosedBooking.js';
import { iclosedAttributionParams, mergeIClosedParams } from '../lib/leadAttribution.js';

/**
 * Inline iClosed booking widget [FEAT-060 p2].
 *
 * Renders iClosed's event page directly in an iframe rather than loading a
 * vendor widget script and letting it hydrate a `<div data-url>`.
 *
 * That is a deliberate departure from what issue #583 prescribes ("inject the
 * vendor's CSS and JS at runtime, set data-url on the container, then call the
 * vendor's inline-widget initialiser"). Those five steps describe the CALENDLY
 * integration the issue points at as a model, and the source repo already tried
 * that shape for iClosed and moved off it: a widget script that marks elements
 * as processed cannot re-initialise them, which produced a blank calendar
 * whenever the URL changed. An iframe has no such lifecycle. iClosed serves
 * `content-security-policy: frame-ancestors *`, so direct framing is supported
 * by them. There is consequently no vendor asset URL and no initialiser
 * function name to settle — the two unknowns the issue lists under those steps
 * do not exist in this approach.
 *
 * ── The src is frozen on mount, on purpose ──────────────────────────────────
 *
 * `src` is computed ONCE, in a lazy initialiser, and never recomputed. This is
 * the fix for a P1 defect in the source repo's version (ally-nutra#1296), where
 * the src was a `useMemo` over live form state: every keystroke in the name or
 * email field produced a new src, which reloaded the iframe and wiped the slot
 * the customer had already picked. The `utm` object made it worse — a fresh
 * object literal from the parent busts the memo on EVERY render, not just on
 * keystrokes.
 *
 * So prefill is a snapshot of what was known when the widget mounted. To
 * re-render with different prefill, give the element a new `key` and let it
 * remount deliberately, rather than having it reload as a side effect of typing.
 *
 * ── The height follows the widget, it is not a constant ─────────────────────
 *
 * `height` is only the height used BEFORE iClosed has said how tall it is, and
 * the height kept if it never does. Once an `iclosed.widget_height` message
 * arrives the frame is resized to match [BUG-423 / #4153, #4154].
 *
 * A fixed height cannot be right for this widget, because the widget has no one
 * height: measured 2026-09-21, the same event page reports 490px laid out
 * side-by-side in a wide frame and 854px stacked in a narrow one, and it
 * changes again as the visitor moves between steps. The old fixed 780px was
 * therefore ~290px too tall on `/work-with-us` (a blank area under the form)
 * and 74px too short on `/schedule/` (the last calendar row clipped out of
 * view) — one constant producing both complaints at once.
 *
 * This does NOT address width. iClosed centres its own content inside whatever
 * width it is given, so a frame wider than the content leaves blank margins
 * that no message reports; that is a layout decision and lives in CSS beside
 * the pages, not here.
 */
export default function IClosedInlineEmbed({
  schedulingUrl,
  prefill,
  utm,
  height = 780,
  onBooked,
  className,
  title = 'Select a date and time',
}) {
  // Lazy initialiser: runs once, on mount. Not useMemo — a memo's deps are a
  // cache hint, not a guarantee, and the whole point here is that later prop
  // changes must NOT rebuild this string.
  // [FEAT-859 / #5775] Every frame carries the visitor's saved attribution (ad tags, first
  // touch, visitor id), so iClosed hands it back in the booking webhook. The page's own
  // `utm` (this address's markers) goes on top. Ids and ad tags only — never a name, email
  // or phone (those travel only in `prefill`, which no public page passes).
  const [src] = useState(() =>
    buildIClosedBookingUrl(prefill ?? {}, mergeIClosedParams(iclosedAttributionParams(), utm ?? null), schedulingUrl),
  );

  // Keep the latest callback without making it a listener dependency: re-adding
  // the listener on every parent render is how a booking arriving mid-render
  // gets missed.
  const onBookedRef = useRef(onBooked);
  onBookedRef.current = onBooked;

  // iClosed repeats messages, so the booking signal is delivered at most once.
  const firedRef = useRef(false);

  // `null` until iClosed reports one; `height` is used meanwhile. Kept as state
  // rather than written onto the node, so a re-render cannot revert the frame
  // to the placeholder height.
  const [measuredHeight, setMeasuredHeight] = useState(null);

  useEffect(() => {
    function handleMessage(event) {
      // EXACT origin. `includes()` would also accept app.iclosed.io.evil.com,
      // and this message is the only booking signal an inline embed has.
      if (event.origin !== ICLOSED_ORIGIN) return;

      // Height first, and it RETURNS: these are ~60 of the ~64 messages a visit
      // produces, so letting them fall through to the booking test below would
      // run that test sixty times for nothing.
      const reported = readIClosedWidgetHeight(event.data);
      if (reported !== null) {
        // Same value re-reported is the common case — iClosed repeats the
        // height it already sent. Bailing on equality keeps that from being a
        // re-render each time.
        setMeasuredHeight((current) => (current === reported ? current : reported));
        return;
      }

      if (!isIClosedBookingMessage(event.data)) return;
      if (firedRef.current) return;
      firedRef.current = true;
      onBookedRef.current?.(event.data);
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <iframe
      src={src}
      title={title}
      className={className}
      style={{
        width: '100%',
        // ⚠️ NO `minWidth`. [BUG-448 / #4402] It used to be 320px, and measured
        // on production at a 320px viewport the shell is 272px — so the frame
        // was pinned 48px wider than its container and overflowed the document
        // by 24px on /contact, unreachable because nothing there scrolls
        // sideways. That is BUG-429's defect exactly; that fix removed this
        // floor from the static /schedule/ page and left this copy in place.
        height: `${measuredHeight ?? height}px`,
        border: '0',
        // The frame is an inline element by default, which gives it a
        // baseline-alignment gap under it — a few px of card showing below the
        // widget, i.e. a smaller copy of the blank area this fix is about.
        display: 'block',
      }}
      data-testid="iclosed-inline-embed"
    />
  );
}
