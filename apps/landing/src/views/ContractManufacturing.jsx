import { Link } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
import { hideAndTint } from '../lib/imgFallback.js';
import { scrollToId } from '../lib/scrollToId.js';
import { useDemoRole } from '../contexts/DemoRoleContext.jsx';
import { quoteUrl } from '../lib/demoRole.js';

import teamPhoto from '../assets/images/drive-team.webp';
import facilityExterior from '../assets/images/source-facility-exterior.webp';
import rawMaterialWarehouse from '../assets/images/raw-material-warehouse.jpg';

export default function ContractManufacturing() {
  const { role } = useDemoRole();
  return (
    <section aria-labelledby="cm-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">Contract manufacturing</span>
            <h1 id="cm-h1" style={sx('margin-top:14px;')}>From formula to finished product — built to your brand.</h1>
            <p style={sx("color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:520px;")}>
              Full-service supplement manufacturing in Dover, Delaware. We handle formulation,
              blending, encapsulation, packaging, and Amazon FBA prep — so you focus on growing
              your brand.
            </p>
            <div className="hero-ctas">
              <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get a free quote →</a>
              <a href="#cm-capabilities" className="btn btn-outline-invert btn-lg" onClick={scrollToId('cm-capabilities')}>
                View capabilities
              </a>
            </div>
          </div>
          {/* CLAIMS REMEDIATION — "500+ / Brands served" removed (no source
              anywhere in either repo); 3 columns instead of the shared
              .svc-stats default of 4, scoped to this instance only —
              PrivateLabel.jsx's own svc-stats block still has 4 real stats
              and keeps the shared default.
              (2026-08-23) "2,500 / Min. order qty" had no source either —
              no operational MOQ exists in either repo (see Home.jsx's
              PRODUCTS array comment). Value changed to "Flexible"; the
              cell and its label stay, kept at 3 columns since the label
              itself is still real information. */}
          <div className="svc-stats svc-stats-hero">
            <div className="svc-stat"><div className="svc-stat-num">NSF</div><div className="svc-stat-label">ANSI 455-2 certified</div></div>
            <div className="svc-stat"><div className="svc-stat-num">Flexible</div><div className="svc-stat-label">Min. order qty</div></div>
            <div className="svc-stat"><div className="svc-stat-num">4 hr</div><div className="svc-stat-label">Response time</div></div>
          </div>
        </div>
      </section>

      <section className="section" style={sx('padding-bottom:0;')}>
        <div className="container">
          <div className="photo ratio-16x9">
            <img
              src={teamPhoto}
              width="1200"
              height="900"
              alt="The Ally Nutra team together inside the Dover facility"
              loading="lazy"
              decoding="async"
              onError={hideAndTint}
            />
          </div>
        </div>
      </section>

      <section className="section" id="cm-capabilities">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>What we do</span>
            <h2>End-to-end manufacturing capabilities</h2>
            <p className="lede">One partner. One quote. One accountable team — from raw ingredient sourcing to your fulfillment center.</p>
          </div>
          <div className="grid grid-4">
            <div className="svc-num-card"><span className="num">01 · Formulation</span><h3>Formulation</h3><p>Develop a custom formula or customize one of 500+ pre-validated formulas with our R&amp;D team.</p></div>
            <div className="svc-num-card"><span className="num">02 · Manufacturing</span><h3>Manufacturing</h3><p>NSF/ANSI 455-2 certified blending, encapsulation, and powder filling for capsules, sachets, stick packs, and resealable bags.</p></div>
            <div className="svc-num-card"><span className="num">03 · Packaging</span><h3>Packaging</h3><p>Bottles, sachets, stick packs, and resealable bags. Custom labels and shrink wrap included.</p></div>
            <div className="svc-num-card"><span className="num">04 · FBA prep</span><h3>FBA prep</h3><p>Amazon-ready cartons, FNSKU labeling, polybag, bundling — shipped directly to FBA centers.</p></div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Our process</span>
            <h2>From first call to finished pallet</h2>
            <p className="lede">A transparent five-step process designed to get your product to market faster — without compromising quality.</p>
          </div>
          <div className="grid grid-3 svc-process-grid">
            <div className="card stack-center"><div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:12px;")}>Step 1</div><div style={sx("width:44px;height:44px;border-radius:50%;background:hsl(var(--ally-navy));color:hsl(var(--ally-orange));display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:700;margin-bottom:14px;")}>01</div><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>Discovery</h3><p style={sx("font-size:13px;")}>Brief us on your product, formula, and target market.</p></div>
            <div className="card stack-center"><div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:12px;")}>Step 2</div><div style={sx("width:44px;height:44px;border-radius:50%;background:hsl(var(--ally-navy));color:hsl(var(--ally-orange));display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:700;margin-bottom:14px;")}>02</div><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>Quote</h3><p style={sx("font-size:13px;")}>Receive transparent, line-item pricing.</p></div>
            <div className="card stack-center"><div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:12px;")}>Step 3</div><div style={sx("width:44px;height:44px;border-radius:50%;background:hsl(var(--ally-navy));color:hsl(var(--ally-orange));display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:700;margin-bottom:14px;")}>03</div><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>Finalize</h3><p style={sx("font-size:13px;")}>Approve the formula and packaging before production.</p></div>
            <div className="card stack-center"><div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:12px;")}>Step 4</div><div style={sx("width:44px;height:44px;border-radius:50%;background:hsl(var(--ally-navy));color:hsl(var(--ally-orange));display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:700;margin-bottom:14px;")}>04</div><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>Production</h3><p style={sx("font-size:13px;")}>Full QC testing at every stage, cGMP compliant.</p></div>
            <div className="card stack-center"><div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:12px;")}>Step 5</div><div style={sx("width:44px;height:44px;border-radius:50%;background:hsl(var(--ally-orange));color:hsl(var(--ally-navy));display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:700;margin-bottom:14px;")}>05</div><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:8px;")}>Ship</h3><p style={sx("font-size:13px;")}>Direct to your warehouse, FBA, or 3PL of choice.</p></div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Dover, Delaware</span>
            <h2>Built and stocked for production.</h2>
            <p className="lede">A look at the facility exterior and the racking that supports incoming materials and production inventory.</p>
          </div>
          <div className="grid grid-2">
            <div>
              <div className="photo ratio-4x3">
                <img
                  src={facilityExterior}
                  width="1200"
                  height="670"
                  alt="Exterior of Ally Nutra's Dover, Delaware manufacturing facility, the Ally Nutra sign on the warehouse wall"
                  loading="lazy"
                  decoding="async"
                  onError={hideAndTint}
                />
              </div>
              <p style={sx("margin-top:12px;font-size:13px;color:hsl(var(--muted-foreground));text-align:center;")}>Our manufacturing facility in Dover, Delaware.</p>
            </div>
            <div>
              <div className="photo ratio-4x3">
                <img
                  src={rawMaterialWarehouse}
                  width="900"
                  height="675"
                  alt="Blue and orange pallet racking inside Ally Nutra's raw material warehouse"
                  loading="lazy"
                  decoding="async"
                  onError={hideAndTint}
                />
              </div>
              <p style={sx("margin-top:12px;font-size:13px;color:hsl(var(--muted-foreground));text-align:center;")}>Racked materials staged to support manufacturing.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CLAIMS REMEDIATION (2026-08-23) — the whole "MOQs that match your
          stage" section removed, not just the numbers in it. It presented a
          named three-tier structure (Starter/Growth/Scale) × four formats,
          12 specific unit counts — a level of policy detail that implies a
          real, systematized MOQ schedule. No such schedule exists: no
          operational MOQ anywhere in either repo (see Home.jsx's PRODUCTS
          array comment), and ADR-007-business-reality-alignment.md records
          the real question as still open, owned by Dasi + CTO. A table is
          a claim of precision a sentence isn't — there's no honest way to
          fill 12 cells with "flexible minimums," so the section goes
          rather than becoming décor. This page's hero stat bar above
          already carries the sourced position ("Flexible / Min. order
          qty") — no replacement section added here. */}

      <section className="section">
        <div className="container" style={sx('max-width:760px;text-align:center;')}>
          <span className="eyebrow" style={sx('justify-content:center;')}>Quality &amp; compliance</span>
          <h2 style={sx('margin:14px 0 12px;')}>Built on a foundation of trust.</h2>
          <p style={sx('margin-bottom:24px;')}>
            NSF/ANSI 455-2 certified and FDA registered, with quality checks and a Certificate of
            Analysis for every batch — the same standards documented on our certifications page.
          </p>
          <Link to="/certifications" className="btn btn-outline">See our certifications →</Link>
        </div>
      </section>

      <section className="section section-navy" style={sx('text-align:center;')}>
        <div className="container">
          <h2 style={sx('max-width:640px;margin:0 auto 24px;')}>
            Ready to build your <em style={sx('font-style:italic;color:hsl(var(--ally-orange));')}>product</em>?
          </h2>
          <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Start your quote →</a>
        </div>
      </section>
    </section>
  );
}
