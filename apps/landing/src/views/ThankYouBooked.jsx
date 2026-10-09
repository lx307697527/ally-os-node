import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import VidalyticsVideo from '../components/VidalyticsVideo.jsx';
import { THANK_YOU_VSL } from '../lib/vidalytics.js';
import { reportBookedCall } from '../lib/bookedCall.js';
import { portalLoginUrl } from '../lib/demoRole.js';

import logoWhite from '../assets/images/logo-white.png';

// [FEAT-820 p2 / #5606] Where a visitor lands after booking a call on /work-with-us —
// the old site's /thank-you-booked, restored (owner, 2026-09-30: "after booking they
// should land on thank you booked page … the old system had that"). Until this phase
// the address was a 308 to /contact and the booking section swapped its body in place.
//
// No site header, footer or chat, like /work-with-us (`CHROMELESS_KEYS`): this is the
// last page of an ad funnel, and the minimal footer below is the one that page carries.
//
// [BUG-840 / #6034] THIS PAGE IS WHERE A BOOKING IS COUNTED, and only when one was handed
// over in this page load. From /work-with-us (and page B) and, since FEAT-899, /contact:
// iClosed's booking message there leaves a single-use token in memory, and the in-app move
// brings the visitor here. From the static /schedule/ [FEAT-899]: a full page load to
// /thank-you-booked?previewId=sch_<token>, which `public/shared/booking-redirect.js` hands
// over the same way (as it would iClosed's own redirect, never observed). `reportBookedCall`
// below pushes the one `call_scheduled` for it, and reports it to Google Ads when the
// visitor's last paid click was a Google ad (`src/lib/bookedCall.js`: once per hand-over, no
// personal data). A direct visit, a reload or a shared link hands nothing over, so it counts
// nothing. Tests: `lib/__tests__/bookedCall.test.js`, `lib/__tests__/booking-redirect.test.js`,
// `views/__tests__/WorkWithUsBooked.test.js`, `views/__tests__/BookedCallGoogleAds.test.js`,
// `lib/__tests__/booked-call-google-ads.test.js`, `lib/__tests__/schedule-page-booked-call.test.js`.

// What a visitor sees once they have booked [FEAT-640 / #4156]. Verbatim from the legacy
// confirmation page `ally-nutra:src/pages/ThankYouBooked.tsx:326-328` — the copy is not
// this phase's to reword. Moved here from WorkWithUs.jsx with the confirmation itself.
const BOOKED_STEPS = [
  ['Check your inbox',
   'Your invite has the meeting link — add it to your calendar now so it is not lost.'],
  ['Watch the video above',
   'About 90 seconds on how we work. It makes the call far more useful.'],
  ['Bring your product idea',
   'Format, target volume, timeline — whatever you have. Rough is fine.'],
];

export default function ThankYouBooked() {
  const [videoFailed, setVideoFailed] = useState(false);

  // [BUG-840] Count the booking handed over in this page load, if any. Runs after mount,
  // so tracking.js's consent default is already in the data layer ahead of this event.
  useEffect(() => {
    reportBookedCall();
  }, []);

  // A thank-you page is not a search result: keep it out of the index for as long as it
  // is on screen, and leave the document as it found it.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  return (
    <section className="wwu" aria-labelledby="tyb-h1" data-testid="thank-you-booked">
      <section className="section section-navy">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow on-dark">Work with us</span>
            <h1 id="tyb-h1">Your call is booked</h1>
            <p>A calendar invite is on its way to your inbox with the meeting link and everything you need.</p>
          </div>
          <div className="wwu-booked">
            <p className="wwu-booked-note">Not there in a few minutes? Check spam or promotions.</p>
            {/* The thank-you video plays from Vidalytics (Smart Autoplay is its own
                setting there); if Vidalytics cannot load, the box is left out rather
                than shown empty, as on /work-with-us. */}
            {videoFailed ? null : (
              <div className="wwu-vsl-frame wwu-booked-vsl">
                <VidalyticsVideo embed={THANK_YOU_VSL} onFailed={setVideoFailed} testId="thank-you-vidalytics" />
              </div>
            )}
            <h3 className="wwu-booked-next-h">What happens next</h3>
            <ol className="wwu-booked-steps" data-testid="thank-you-steps">
              {BOOKED_STEPS.map(([title, detail], i) => (
                <li key={title}>
                  <span className="wwu-booked-step-n" aria-hidden="true">{i + 1}</span>
                  <h4>{title}</h4>
                  <p>{detail}</p>
                </li>
              ))}
            </ol>
            {/* [FEAT-820 p3 / #5613] Owner, 2026-09-30: the thank-you page links to the
                customer portal. `portalLoginUrl` is the site's one portal-login address
                (the configured portal, or the prototype when none is set). */}
            <div className="wwu-booked-portal">
              <a className="btn btn-primary btn-lg" href={portalLoginUrl('visitor')} data-testid="thank-you-portal-login">
                Log in to your customer portal
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* The minimal footer /work-with-us carries [FEAT-589 / #3902]: logo, two policy
          links, copyright. The site Footer is withheld by `Layout` (chromeless). */}
      <footer className="wwu-footer" data-testid="thank-you-footer">
        <div className="wwu-footer-inner">
          <img className="wwu-footer-logo" src={logoWhite} alt="Ally Nutra" width="783" height="627" />
          <nav className="wwu-footer-links" aria-label="Legal">
            <Link to="/privacy-policy" target="_blank" rel="noopener noreferrer">
              Privacy Statement
            </Link>
            <Link to="/terms-of-service" target="_blank" rel="noopener noreferrer">
              Terms and Conditions
            </Link>
          </nav>
          <p className="wwu-footer-copyright">
            Copyright © 2026 Ally Nutra LLC. All Rights Reserved.
          </p>
        </div>
      </footer>
    </section>
  );
}
