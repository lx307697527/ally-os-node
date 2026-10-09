import { Link } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
import { hideAndTint } from '../lib/imgFallback.js';
import { useDemoRole } from '../contexts/DemoRoleContext.jsx';
import { quoteUrl, scheduleUrl } from '../lib/demoRole.js';
import CheckIcon from '../components/CheckIcon.jsx';

// AN-DESIGN-001 sweep, Item 5 Step B (2026-08) — ported from ally-nutra's
// VitaminManufacturing.tsx, but NOT its content or layout. Step A's claims
// audit (see apps/landing/CLAUDE.md) found the source page's centerpiece
// claim ("No Minimum Order Quantity — 1,000 or 100,000, doesn't matter")
// contradicted by three sources including ally-nutra's own FAQ, its
// standalone "GMP Certified" claim never paired with the real NSF/ANSI
// 455-2 certification, and five of its six hero-carousel images stock or
// stock-adjacent. Nothing unsourced from that page survived — this page is
// built only from claims Step A classified SUPPORTED: FDA-registered,
// NSF/ANSI 455-2, cGMP under 21 CFR Part 111, Dover DE production, 100%
// USA made, FBA prep, in-house QC/COA, dedicated account manager. It is
// deliberately thinner than the source page for exactly that reason.
//
// Hero structure parity (2026-08-24) — rebuilt to match ally-nutra's
// VitaminManufacturing.tsx hero composition (eyebrow string / CTA pair /
// trust-chip row / image panel), restyled entirely in our own tokens and
// components, NOT their CSS or layout mechanics. Three deliberate
// divergences, reported in the PR body: no 4-slide auto-advancing carousel
// (one static image instead — this hero has no state, no interval, no
// prev/next controls); no floating "Quote in 24 Hours" callout card (it
// only restated the subhead, which already exists here); this page never
// had ally-nutra's full-bleed background treatment to begin with (that's
// the stick-pack page's divergence, not this one).
//
// The eyebrow string below repeats "GMP Certified" — already noted
// elsewhere on this page as a loose standalone phrasing (the certifications
// section further down states the more precise "cGMP · 21 CFR Part 111").
// Reproduced verbatim per instruction as ally-nutra's own eyebrow wording;
// not tightened here since the exact string was specified, not left open.
// [owner directive 2026-09-20] Hero photograph is the owner's own production
// shot IMG_7668.jpeg (iPhone 13 Pro Max, 2026-09-17) from the approved Drive
// folder (folder ID and treatment in IMAGE-CREDITS.md), replacing the BUG-380
// citrus still — that was a styled product photo with no production floor in
// frame, while this page's claims are all about verifiable manufacturing.
import vitaminHero from '../assets/images/source-vitamin-hero-7668.webp';

export default function VitaminManufacturing() {
  const { role } = useDemoRole();
  return (
    <section aria-labelledby="vitmfg-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">FDA Registered · NSF/ANSI 455-2 Certified · Made in USA</span>
            <h1 id="vitmfg-h1" style={sx('margin-top:14px;')}>Vitamin and supplement manufacturing you can verify.</h1>
            <p style={sx("color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:520px;")}>
              FDA-registered, NSF/ANSI 455-2 certified production in Dover, Delaware — built for
              brands that need to stand behind every claim on the label.
            </p>
            <div className="hero-ctas">
              <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get a Free Quote →</a>
              <a href={scheduleUrl(role)} className="btn btn-outline-light btn-lg">Schedule a Consultation</a>
            </div>
            <div className="hero-chip-row">
              {['FDA Registered', 'NSF/ANSI 455-2 Certified', 'Made in USA'].map((t) => (
                <span key={t} className="hero-chip">
                  <CheckIcon width={14} height={14} />
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="photo ratio-4x3">
            <img
              src={vitaminHero}
              width="1600"
              height="1200"
              alt="Gloved hands lifting a handful of yellow capsules over a stainless steel vessel of finished capsules on the production floor"
              loading="eager"
              onError={hideAndTint}
            />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Certified &amp; registered</span>
            <h2>Certified, registered, documented.</h2>
            <p className="lede">Every claim below is a real, current credential — not a marketing label.</p>
          </div>
          <div className="grid grid-4">
            <div className="card stack-center">
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>FDA registered</h3>
              <p style={sx("font-size:13px;")}>Our Dover, Delaware production facility is registered with the FDA.</p>
            </div>
            <div className="card stack-center">
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>NSF/ANSI 455-2</h3>
              <p style={sx("font-size:13px;")}>Third-party certified to the NSF/ANSI 455-2 dietary supplement GMP standard.</p>
            </div>
            <div className="card stack-center">
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>cGMP · 21 CFR Part 111</h3>
              <p style={sx("font-size:13px;")}>Manufactured under current Good Manufacturing Practice regulations for dietary supplements.</p>
            </div>
            <div className="card stack-center">
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>100% USA made</h3>
              <p style={sx("font-size:13px;")}>Every batch produced domestically, start to finish.</p>
            </div>
          </div>
          <p style={sx("text-align:center;font-size:13.5px;margin-top:24px;")}>
            Full documentation and certificate details live on our{' '}
            <Link to="/certifications" style={sx('color:hsl(var(--ally-orange-ink));text-decoration:underline;')}>certifications page →</Link>
          </p>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>What you get</span>
            <h2>Support beyond the production line.</h2>
          </div>
          <div className="grid grid-3">
            <div className="card stack-center">
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>In-house QC &amp; COA</h3>
              <p style={sx("font-size:13px;")}>Every batch tested in-house, with a Certificate of Analysis available.</p>
            </div>
            <div className="card stack-center">
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>Amazon FBA prep</h3>
              <p style={sx("font-size:13px;")}>Finished product prepped and labeled to Amazon's FBA specifications.</p>
            </div>
            <div className="card stack-center">
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>A dedicated account manager</h3>
              <p style={sx("font-size:13px;")}>One point of contact for your project, start to finish.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-navy" style={sx('text-align:center;')}>
        <div className="container">
          <h2 style={sx('max-width:640px;margin:0 auto 24px;')}>
            Ready to <em style={sx('font-style:italic;color:hsl(var(--ally-orange));')}>manufacture</em>?
          </h2>
          <p style={sx("color:hsl(0 0% 100% / .78);max-width:520px;margin:0 auto 24px;")}>
            Send us your formula or use one of ours. Get full transparency on cost, lead time, and MOQ.
          </p>
          <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get a vitamin manufacturing quote →</a>
        </div>
      </section>
    </section>
  );
}
