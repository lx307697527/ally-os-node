import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
import { scrollToId } from '../lib/scrollToId.js';
import IClosedInlineEmbed from '../components/IClosedInlineEmbed.jsx';
// [FEAT-091] `QuoteBqaInlineEmbed` is no longer rendered here — see the note at
// the quote section below. The import is removed rather than left dangling
// (an unused import is a lint error waiting to happen and reads as an
// oversight); the component file itself is deliberately kept, so restoring the
// embed is this import plus the one JSX line.
// [2026-09-20] The branded truck photo that briefly lived in the Visit-us
// section was removed at the owner's direction ("just an alignment is good
// enough") — this page is back to its pre-truck state; the underlying Drive
// assets are documented in IMAGE-CREDITS.md history if ever wanted again.
import { consultationUrl } from '../lib/iclosedBooking.js';
import { useDemoRole } from '../contexts/DemoRoleContext.jsx';
import { quoteUrl } from '../lib/demoRole.js';
import { THANK_YOU_REDIRECT_MS } from './WorkWithUs.jsx';
import { handOverBookedCall } from '../lib/bookedCall.js';

export default function Contact() {
  const { role } = useDemoRole();
  const [booked, setBooked] = useState(false);

  // [FEAT-899 / #6022] A booking here is handed over exactly as /work-with-us hands one
  // over: a single-use token in memory, counted ONCE by the thank-you page after the move
  // (`lib/bookedCall.js` pushes `call_scheduled`, and reports it to Google Ads when the
  // visitor's last paid click was Google). Until this change the booking reached nothing:
  // the iClosed frame's own container (GTM-K66NLG5N) is empty, and Meta hears of bookings
  // from the server (meta-capi-cron), not from this page.
  function handleBooked() {
    handOverBookedCall();
    setBooked(true);
  }

  // [FEAT-820 p3 / #5613] After the short confirmation, on to /thank-you-booked, as
  // /work-with-us does (owner, 2026-09-30). The pause is only for the visitor to read the
  // confirmation: nothing in iClosed's frame reports the booking any more.
  const navigate = useNavigate();
  useEffect(() => {
    if (!booked) return undefined;
    const timer = setTimeout(() => navigate('/thank-you-booked'), THANK_YOU_REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [booked, navigate]);

  // [FEAT-060 p2] Renders only where a scheduling URL is configured
  // (VITE_ICLOSED_CONSULTATION_URL). Unset is the default, and deliberately so:
  // this app is a design prototype (see README.md "Prototype status") whose
  // Contact form never transmits. A live booking widget appearing by default
  // would make one surface on this page real while the form beside it stays
  // fake -- a visitor could book a sales call nobody is expecting. Configuring
  // the URL is the explicit act of making this page book real calls.
  const schedulingUrl = consultationUrl();

  return (
    <section aria-labelledby="contact-h1">
      <section className="hero on-navy" style={sx('text-align:center;')}>
        <div className="container">
          <span className="eyebrow on-dark" style={sx('justify-content:center;')}>Get in touch</span>
          <h1 id="contact-h1" style={sx("color:#fff;margin:14px auto 16px;max-width:640px;")}>Let's build something together.</h1>
          {/* CLAIMS REMEDIATION — "Quote in five business days" (this hero
              line) and "Quote returned in 5 business days" (the quote
              request q-sub below) had no source anywhere in either repo;
              removed rather than replaced. The email q-sub's "Response
              within 1 business day" was removed here too but has since
              been CORRECTED back in — see the sweep-false-negative note on
              RESPONSE_TIME in Home.jsx for the three real ally-nutra
              sources. */}
          <p style={sx("color:hsl(0 0% 100% / .78);max-width:520px;margin:0 auto 32px;")}>
            Have a question about supplement manufacturing? We respond fast — expect to hear
            from us within 24 hours.
          </p>
          <div className="grid grid-3" style={sx('max-width:900px;margin:0 auto;')}>
            <a href="tel:+18887205888" className="quick-tile">
              <div className="q-label">Call</div><div className="q-value">(888) 720-5888</div><div className="q-sub">Mon–Fri · 9 AM–5 PM EST</div>
            </a>
            <a href="mailto:support@allynutra.com" className="quick-tile">
              <div className="q-label">Email</div><div className="q-value">support@allynutra.com</div><div className="q-sub">Response within 24 hours</div>
            </a>
            <a href="#contact-form" className="quick-tile" onClick={scrollToId('contact-form')}>
              <div className="q-label">Quote request</div><div className="q-value">5-minute form</div>
            </a>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="contact-form">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Quote request</span>
            <h2 style={sx('margin-bottom:8px;')}>Tell us about your project.</h2>
            <p>
              Tell us what you need and we&apos;ll come back with a quote.
            </p>
          </div>
          {/* [FEAT-091] Was an inline iframe of public/quote/index.html
              ("no redirect"). That mockup makes ZERO network calls while
              showing a "Submitting…" spinner and an "on its way" line, so the
              embed silently swallowed every enquiry made here. It cannot simply
              be pointed at the real form: the funnel serves
              `X-Frame-Options: DENY` (measured 2026-08-27), so a same-page
              embed of the working form is not available at any price. Between
              an embedded form that loses the submission and a link to one that
              records it, the link wins — the section keeps its heading and
              placement, only the body changes. `QuoteBqaInlineEmbed` is left in
              place, unused, because the choice reverses by restoring one line. */}
          <p style={sx('text-align:center;')}>
            <a href={quoteUrl(role)} className="btn btn-primary btn-lg">
              Start your quote &rarr;
            </a>
          </p>
        </div>
      </section>

      {schedulingUrl && (
        <section className="section" id="book-a-call" aria-labelledby="book-a-call-h2">
          <div className="container">
            <div className="section-header">
              <span className="eyebrow" style={sx('justify-content:center;')}>Book a call</span>
              <h2 id="book-a-call-h2">Pick a time that works for you.</h2>
              <p>Choose a time to speak with our team.</p>
            </div>
            {booked && (
              <p role="status" style={sx('text-align:center;font-weight:600;')}>
                Your call is booked &mdash; a confirmation is on its way by email. Taking you to your next steps&hellip;
              </p>
            )}
            {/* The same width cap /work-with-us puts on its booking card
                [BUG-423 / #4153]. This page has no card, so the wrapper exists
                only to carry it — without one the frame is `.container` wide and
                iClosed centres its ~808px form inside it, leaving the blank
                margins the issue reports. */}
            <div className="iclosed-embed-shell">
              <IClosedInlineEmbed
                schedulingUrl={schedulingUrl}
                onBooked={handleBooked}
              />
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Direct lines</span>
            <h2>Contact Ally Nutra.</h2>
            <p>Questions about a new project or an existing order? Contact our support team.</p>
          </div>
          {/* [alignment fix 2026-09-20] This section holds ONE card, but it sat
              inside .grid.grid-3, which pinned it to the left third of the row
              under a centered heading — the "disaligned" contact-page look.
              A centered single-card column instead; card content untouched. */}
          <div style={sx('max-width:380px;margin:0 auto;')}>
            <div className="dept-card">
              <div style={sx("width:44px;height:44px;background:hsl(var(--ally-orange)/.15);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:hsl(var(--ally-navy));")}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h18l-2 13H5L3 3z" /><circle cx="9" cy="20" r="1" /><circle cx="18" cy="20" r="1" /></svg>
              </div>
              <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Support</h3>
              <p style={sx("font-size:13px;margin-bottom:16px;")}>New projects, existing orders, and account questions.</p>
              <div style={sx("border-top:1px solid hsl(var(--border));padding-top:12px;font-size:13.5px;")}>
                <a href="mailto:support@allynutra.com" style={sx('display:block;color:hsl(var(--ally-navy));font-weight:600;')}>support@allynutra.com</a>
                <a href="tel:+18887205888" style={sx('display:block;color:hsl(var(--ally-navy));font-weight:600;margin-top:4px;')}>(888) 720-5888</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container hero-grid">
          <div className="map-embed">
            <iframe
              src="https://www.google.com/maps?q=631+Ridgely+St+STE+1,+Dover,+DE+19904&output=embed"
              title="Map showing 631 Ridgely St, STE 1, Dover, DE 19904"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            ></iframe>
          </div>
          <div>
            <span className="eyebrow">Visit us</span>
            <h2 style={sx('margin:14px 0 16px;')}>Ally Nutra headquarters.</h2>
            <p className="lede" style={sx('margin-bottom:20px;')}>631 Ridgely St, STE 1<br />Dover, DE 19904<br />United States</p>
            <ul style={sx('list-style:none;margin-bottom:24px;')}>
              <li style={sx("display:flex;gap:14px;padding:12px 0;border-bottom:1px solid hsl(var(--border));")}>
                <div style={sx("flex-shrink:0;width:34px;height:34px;border-radius:var(--radius-sm);background:hsl(var(--ally-orange)/.15);display:flex;align-items:center;justify-content:center;color:hsl(var(--ally-navy));")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
                </div>
                <div><strong style={sx('display:block;font-size:13.5px;color:hsl(var(--ally-navy));')}>Hours of operation</strong><span style={sx("font-size:13px;")}>Monday–Friday · 9:00 AM–5:00 PM EST</span></div>
              </li>
              <li style={sx("display:flex;gap:14px;padding:12px 0;border-bottom:1px solid hsl(var(--border));")}>
                <div style={sx("flex-shrink:0;width:34px;height:34px;border-radius:var(--radius-sm);background:hsl(var(--ally-orange)/.15);display:flex;align-items:center;justify-content:center;color:hsl(var(--ally-navy));")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72" /></svg>
                </div>
                <div><strong style={sx('display:block;font-size:13.5px;color:hsl(var(--ally-navy));')}>Direct phone</strong><span style={sx("font-size:13px;")}>+1 (888) 720-5888</span></div>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container" style={sx('max-width:760px;text-align:center;')}>
          <span className="eyebrow" style={sx('justify-content:center;')}>Frequently asked</span>
          <h2 style={sx('margin:14px 0 12px;')}>Common questions before you reach out.</h2>
          <p style={sx('margin-bottom:24px;')}>
            Read the five questions we get most often.
          </p>
          <Link to="/faq" className="btn btn-primary">Browse all FAQs →</Link>
        </div>
      </section>

      <section className="section section-navy" style={sx('text-align:center;')}>
        <div className="container">
          <h2 style={sx('color:#fff;margin-bottom:12px;')}>Prefer to talk?</h2>
          <p style={sx("max-width:520px;margin:0 auto 24px;")}>
            Call us Monday through Friday, 9:00 AM–5:00 PM EST.
          </p>
          <a href="tel:+18887205888" className="btn btn-primary btn-lg">Call (888) 720-5888 →</a>
        </div>
      </section>
    </section>
  );
}
