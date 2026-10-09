import { sx } from '../lib/styleString.js';
import { hideAndTint } from '../lib/imgFallback.js';
import { useDemoRole } from '../contexts/DemoRoleContext.jsx';
import { quoteUrl } from '../lib/demoRole.js';

// AN-DESIGN-001 sweep, Item 5 Step B (2026-08) — ported from ally-nutra's
// StickPackManufacturing.tsx, but NOT its content or layout. Step A's
// claims audit (see apps/landing/CLAUDE.md) found the source page's
// "150 sticks/min, ±2% fill accuracy" spec real but attributed to the
// wrong machine (the NJP-2500 CAPSULE filler, not a stick-pack line), its
// "6-10 weeks" lead time unsupported, its footer address wrong (123
// Ridgely St, STE 3 — corrected here and everywhere else in this app to
// 631 Ridgely St, STE 1), and its FAQ MOQ figures contradicted by
// ally-nutra's own site-wide FAQ. None of that survived. Fill-weight below
// is apps/landing's own existing, already-shipped Stick packs figure
// (Home.jsx/Services.jsx), unchanged.
// (2026-08-23) MOQ: the "10,000 units" figure below was ALSO unsourced —
// it just happened to match Home.jsx/Services.jsx's own invented number,
// not a real one. Investigation across both repos found no operational
// MOQ anywhere; ADR-007-business-reality-alignment.md records the real
// question as still open, owned by Dasi + CTO. Replaced with the sourced
// sales-script position (flexible minimums, volume pricing) — see
// apps/landing/CLAUDE.md's claims section.
//
// Hero structure parity (2026-08-24) — rebuilt to match ally-nutra's
// StickPackManufacturing.tsx hero composition (eyebrow string / single CTA /
// descriptor-chip row / image panel), restyled entirely in our own tokens
// and components, NOT their CSS or layout mechanics. One deliberate
// divergence, reported in the PR body: no full-bleed background photo with
// a gradient overlay — this page uses the same contained image-panel hero
// as the other service pages instead. The former svc-stats block (fill
// weight, min. order qty, USA made) is dropped from the hero — all three
// facts still live on this page in the Format specs section below, so
// nothing is lost, only relocated. "Best Price 30K+ Sticks" (the 4th
// descriptor chip on ally-nutra's page) is excluded — an MOQ claim, same
// territory PR #834 already removed pending ADR-007.
// BUG-380 restores the original, page-specific images from the approved
// AllyNutra source repository; do not substitute generic facility context here.
import stickPackHero from '../assets/images/source-stick-pack-hero.webp';
import stickPackFillingLine from '../assets/images/source-stick-pack-filling-line.webp';

export default function StickPackManufacturing() {
  const { role } = useDemoRole();
  return (
    <section aria-labelledby="stickmfg-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">FDA Registered · NSF/ANSI 455-2 Certified · Dover, DE</span>
            <h1 id="stickmfg-h1" style={sx('margin-top:14px;')}>Stick packs, manufactured in-house.</h1>
            <p style={sx("color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:520px;")}>
              Portable, single-serve packaging for drink mixes, electrolytes, and other powder
              blends — manufactured and custom printed for your brand.
            </p>
            <div className="hero-ctas">
              <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get a stick pack quote →</a>
            </div>
            <div className="hero-chip-row">
              {['Electrolyte Stick Packs', 'Powder Sticks', 'Single-Serve'].map((t) => (
                <span key={t} className="hero-chip">{t}</span>
              ))}
            </div>
          </div>
          <div className="photo ratio-4x3">
            <img
              src={stickPackHero}
              width="1200"
              height="670"
              alt="Three Ally Nutra branded stick packs displayed on a stainless steel production surface"
              /* The photo is 16:9 with the packs right of centre; the 4:3 frame crops from the centre
                 by default and cut the third pack off (owner, 2026-10-01). Anchoring the crop to the
                 right keeps all three packs whole. */
              style={sx('object-position:100% 50%;')}
              loading="eager"
              onError={hideAndTint}
            />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Format specs</span>
            <h2>Built for on-the-go formats.</h2>
          </div>
          <div className="card" style={sx('max-width:560px;margin:0 auto;')}>
            <ul className="svc-spec-list">
              <li><span className="lbl">Minimum order</span><span className="val">Flexible — volume-based pricing</span></li>
              <li><span className="lbl">Product types</span><span className="val">Drink mixes, electrolytes, and functional powder blends</span></li>
              <li><span className="lbl">Packaging</span><span className="val">Custom printed for your brand</span></li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section section-alt">
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
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>Quality checks</h3>
              <p style={sx("font-size:13px;")}>Manufactured with documented quality controls and batch testing.</p>
            </div>
            <div className="card stack-center">
              <h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>100% USA made</h3>
              <p style={sx("font-size:13px;")}>Every batch produced domestically, start to finish.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
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

      <section className="section section-rule">
        <div className="container">
          <div className="photo ratio-4x3" style={sx('max-width:480px;margin:0 auto;')}>
            <img
              src={stickPackFillingLine}
              width="900"
              height="600"
              alt="Stick-pack filling and sealing equipment from the approved AllyNutra source site"
              loading="lazy"
              decoding="async"
              onError={hideAndTint}
            />
          </div>
          <p style={sx("margin-top:12px;font-size:13px;color:hsl(var(--muted-foreground));text-align:center;")}>Stick-pack filling and sealing equipment.</p>
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
          <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get a stick pack quote →</a>
        </div>
      </section>
    </section>
  );
}
