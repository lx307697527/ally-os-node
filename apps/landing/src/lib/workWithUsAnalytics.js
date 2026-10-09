// [#3556] The ad-attribution event the /work-with-us page fires on its booking CTAs.
//
// ⚠️ THIS MODULE NO LONGER STARTS A META DATASET [FEAT-839 / #5705].
//
// From [FEAT-642 / #4157] until 2026-10-02 it did: `startWorkWithUsPixel()` waited
// for consent, then registered the ad campaign's dataset 2529780757518815 and sent it
// one targeted PageView, from this page only. On 2026-10-02 the HubSpot tracking code
// was added site-wide (`public/shared/tracking.js`), and HubSpot is configured to load
// that SAME dataset on every page — measured that day from HubSpot's own config,
// `{"pixels":{"FACEBOOK":[{"pixelId":"2529780757518815"}]}}`. Keeping this module's
// copy would have registered the dataset twice and sent this page two PageViews, so
// it was removed in the same change, as the requester asked.
//
// So nothing in this app initialises 2529780757518815 any more, and nothing should:
// `views/__tests__/WorkWithUsPixelMount.test.js` mounts both ad pages and fails on any
// `init`, and `lib/__tests__/ad-tracking.test.js` keeps the id out of the loader.
// The full FEAT-642 implementation is in git history (this file before FEAT-839).

/** The custom event name the legacy page fires on a booking CTA. */
export const CTA_CLICK_EVENT = 'work_with_us_cta_click';

/**
 * Report a booking-CTA click.
 *
 * It was written to be a no-op, so that the call sites would be real and reviewed
 * now rather than threaded through the JSX later — the thing that goes wrong when
 * tracking is added last is that one CTA gets missed.
 *
 * Since [FEAT-622] the site-wide loader defines `window.fbq` once a visitor
 * consents, and since [FEAT-839] HubSpot's tracking code defines it for every
 * visitor on production. The guard below is what keeps the call harmless where
 * neither has happened — before consent and before HubSpot has loaded, and off
 * production entirely.
 */
export function trackCtaClick() {
  if (typeof window === 'undefined') return;
  const fbq = window.fbq;
  if (typeof fbq === 'function') fbq('trackCustom', CTA_CLICK_EVENT);
}

/*
 * ⚠️ WHY THE LINE ABOVE IS A BROADCAST, AND MUST STAY ONE [FEAT-642, still true].
 *
 * `trackCustom` goes to every dataset registered on the page — today the two
 * site-wide ones (after consent), the GTM container's 1575674433717890 (after
 * consent) and HubSpot's 2529780757518815. Nobody else sends this event, so a
 * broadcast gives each of them EXACTLY one copy, which is the desired outcome.
 *
 * Switching it to `trackSingleCustom` for one id would REMOVE the event from the
 * others, and which dataset the ads for this page optimise on has not been checked
 * in Meta Ads Manager. Adding a `trackSingleCustom` ON TOP of the broadcast is the
 * one shape that WOULD double-count it.
 */
