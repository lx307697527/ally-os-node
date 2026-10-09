import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
import { hideOnly } from '../lib/imgFallback.js';
import { scrollToId } from '../lib/scrollToId.js';
import CertificatePopup from '../components/CertificatePopup.jsx';

import qcLabWide from '../assets/images/qc-lab-wide.jpg';
// AN-DESIGN-001 sweep, Group C item 7 — real NSF certificate, copied
// read-only from Ally-Nutra-LLC-New/ally-nutra, src/assets/nsf-certificate.jpg.
// Deliberately NOT doing the same for the cGMP card: that repo's sibling
// file, src/assets/cgmp-certificate.jpg, is Dasi Lin's personal training
// certificate, not a company credential — publishing it here as one would be
// a false claim. Only the NSF card gets a popup; the other two (cGMP, FDA)
// stay plain, non-interactive cards, since no other real certificate scan
// was available to pop up honestly. The USDA Organic, Halal, and Kosher
// cards that used to sit here were removed entirely (claims remediation,
// 2026-08) — no source for any of the three anywhere in either repo; see
// apps/landing/CLAUDE.md for the full removal list.
import nsfCertificate from '../assets/images/nsf-certificate.jpg';

export default function Certifications() {
  const [showNsfCert, setShowNsfCert] = useState(false);
  const nsfTriggerRef = useRef(null);
  return (
    <section aria-labelledby="cert-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">Certifications &amp; compliance</span>
            <h1 id="cert-h1" style={sx('color:#fff;margin-top:14px;')}>Audited, verified, trusted.</h1>
            <p style={sx("color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:480px;")}>
              When buyers, retailers, and regulators ask for proof — we have it. Every
              certification we hold is third-party audited, current, and available for
              verification.
            </p>
            <div className="hero-ctas">
              <Link to="/contact" className="btn btn-primary btn-lg">Request documentation →</Link>
              <a href="#cert-grid" className="btn btn-outline-light btn-lg" onClick={scrollToId('cert-grid')}>
                View certifications
              </a>
            </div>
          </div>
          <div style={sx('position:relative;height:300px;')}>
            <div style={sx("position:absolute;width:180px;height:180px;top:20%;left:50%;transform:translate(-50%,-50%);border-radius:50%;background:hsl(var(--ally-orange));color:hsl(var(--ally-navy));display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--font-slab);border:4px solid hsl(0 0% 100% / .3);")}>
              <span style={sx("font-size:9px;letter-spacing:0.15em;opacity:.75;")}>NSF/ANSI</span>
              <span style={sx("font-size:32px;font-weight:600;")}>455-2</span>
              <span style={sx("font-size:8px;letter-spacing:0.1em;opacity:.75;")}>GMP CERTIFIED</span>
            </div>
            <div style={sx("position:absolute;width:110px;height:110px;top:0;left:6%;border-radius:50%;background:#fff;color:hsl(var(--ally-navy));display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--font-slab);transform:rotate(-12deg);")}>
              <span style={sx("font-size:8px;opacity:.6;")}>FDA</span><span style={sx("font-size:18px;font-weight:600;")}>REG</span>
            </div>
            <div style={sx("position:absolute;width:100px;height:100px;bottom:2%;right:4%;border-radius:50%;background:hsl(var(--ally-navy));border:1px solid hsl(var(--ally-orange)/.4);color:hsl(var(--ally-orange));display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--font-slab);transform:rotate(10deg);")}>
              <span style={sx("font-size:8px;opacity:.6;")}>DOVER</span><span style={sx("font-size:16px;font-weight:600;")}>DE</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section-tight section-alt" style={sx('text-align:center;')}>
        <div className="container">
          <div style={sx("display:flex;justify-content:center;gap:36px;flex-wrap:wrap;align-items:center;")}>
            <span className="eyebrow" style={sx('justify-content:center;')}>Current facility credentials</span>
            <div style={sx("display:flex;gap:26px;flex-wrap:wrap;")}>
              <strong style={sx("font-family:var(--font-slab);color:hsl(var(--ally-navy)/.7);")}>FDA</strong>
              <strong style={sx("font-family:var(--font-slab);color:hsl(var(--ally-navy)/.7);")}>NSF/ANSI 455-2</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Why it matters</span>
            <h2>Certifications are more than stickers.</h2>
            <p>They're proof your product is real, your labels are honest, and your business is built on a foundation buyers and regulators can trust.</p>
          </div>
          <div className="grid grid-3">
            <div className="card">
              <div style={sx("width:48px;height:48px;background:hsl(var(--ally-orange)/.14);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:hsl(var(--ally-navy));")}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
              </div>
              <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Buyer confidence</h3>
              <p style={sx("font-size:13.5px;")}>Current facility credentials help buyers understand how and where their products are made.</p>
            </div>
            <div className="card">
              <div style={sx("width:48px;height:48px;background:hsl(var(--ally-orange)/.14);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:hsl(var(--ally-navy));")}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4" /><path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9c2.49 0 4.74 1.01 6.36 2.64" /></svg>
              </div>
              <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Regulatory defensibility</h3>
              <p style={sx("font-size:13.5px;")}>The NSF certificate defines the certified scope and can be reviewed directly on this page.</p>
            </div>
            <div className="card">
              <div style={sx("width:48px;height:48px;background:hsl(var(--ally-orange)/.14);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:hsl(var(--ally-navy));")}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
              </div>
              <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Product integrity</h3>
              <p style={sx("font-size:13.5px;")}>Quality controls and batch testing support finished-product review and release.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="cert-grid">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Our certifications</span>
            <h2>Verified facility credentials.</h2>
            <p>Ally Nutra holds NSF/ANSI 455-2 certification and operates an FDA-registered dietary supplement manufacturing facility.</p>
          </div>
          {/* CLAIMS REMEDIATION — was grid-2 (6 cards: cGMP, FDA, NSF, USDA
              organic, Halal, Kosher). The last three had no source anywhere
              in either repo — no company-held certificate, no badge asset,
              no mention outside a supplier-certification enum and a sales
              script asking prospects whether THEY need them. Removed
              outright, not replaced; grid-3 closes the gap the removal left
              rather than leaving a lone card in a half-empty grid-2 row. */}
          <div className="grid grid-2">
            <div className="cert-card">
              <div className="cert-badge navy"><span className="b-top">U.S.</span><span className="b-main">FDA</span><span className="b-bot">Registered</span></div>
              <div>
                <h3 style={sx("font-size:18px;margin-bottom:4px;")}>FDA facility registration</h3>
                <div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:10px;")}>U.S. Food &amp; Drug Administration</div>
                <p style={sx("font-size:13.5px;")}>The Dover dietary supplement manufacturing facility is registered with the U.S. Food and Drug Administration.</p>
                <div className="cert-meta"><span><strong>Type</strong>Facility registration</span></div>
              </div>
            </div>
            <button
              type="button"
              ref={nsfTriggerRef}
              className="cert-card cert-card-clickable"
              onClick={() => setShowNsfCert(true)}
              aria-haspopup="dialog"
            >
              <div className="cert-badge gold"><span className="b-top">NSF</span><span className="b-main">GMP</span><span className="b-bot">Certified</span></div>
              <div>
                {/* AN-DESIGN-001 sweep, Group C item 7 — this card previously
                    claimed "NSF Certified for Sport® / NSF/ANSI 173" (a
                    banned-substance testing program), which the real
                    certificate now popping up from this card does not
                    support: it's an NSF/ANSI 455-2 GMP certification for
                    dietary supplements, a different NSF program entirely.
                    Rewritten to match what the attached certificate actually
                    shows, rather than leave a claim standing next to its own
                    disproof. */}
                <h3 style={sx("font-size:18px;margin-bottom:4px;")}>NSF/ANSI 455-2 GMP certified</h3>
                <div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:10px;")}>NSF International</div>
                <p style={sx("font-size:13.5px;")}>Third-party GMP audit of our dry formulation, encapsulation, mixing, packaging/labeling, quality unit operations, and warehousing — scoped to capsule products.</p>
                <div className="cert-meta"><span><strong>Standard</strong>NSF/ANSI 455-2</span><span><strong>Expires</strong>Jan 13, 2027</span></div>
                {/* #9A6B12, not hsl(var(--ally-orange)) — brand amber measures
                    ~1.9:1 on white and fails AA at this size; #9A6B12 is the
                    established "amber-ink" fix already used the same way for
                    .area-tag/.product-format/.svc-catalog-cat etc. in this
                    file (see the note above .fac-zone). Verified via alpha
                    compositing during this PR's contrast audit. */}
                <span className="mono-chip" style={sx("color:#9A6B12;margin-top:10px;display:inline-block;")}>View certificate →</span>
              </div>
            </button>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow">What you get</span>
            <h2 style={sx('margin:14px 0 16px;')}>Batch and facility documentation.</h2>
            <p style={sx('margin-bottom:24px;')}>Contact our team when you need a Certificate of Analysis or facility credential for your product.</p>
            <ul style={sx('list-style:none;')}>
              <li style={sx("display:flex;gap:16px;padding:14px 0;border-bottom:1px solid hsl(var(--border));")}>
                <div style={sx("flex-shrink:0;width:34px;height:34px;border-radius:50%;background:hsl(var(--ally-navy));color:hsl(var(--ally-orange));display:flex;align-items:center;justify-content:center;font-family:var(--font-slab);font-weight:600;font-size:14px;")}>1</div>
                <div><h3 style={sx("font-size:14.5px;color:hsl(var(--ally-navy));margin-bottom:4px;")}>Certificate of analysis (COA)</h3><p style={sx("font-size:13px;")}>A Certificate of Analysis documents the testing results for the finished batch.</p></div>
              </li>
              <li style={sx("display:flex;gap:16px;padding:14px 0;border-bottom:1px solid hsl(var(--border));")}>
                <div style={sx("flex-shrink:0;width:34px;height:34px;border-radius:50%;background:hsl(var(--ally-navy));color:hsl(var(--ally-orange));display:flex;align-items:center;justify-content:center;font-family:var(--font-slab);font-weight:600;font-size:14px;")}>2</div>
                <div><h3 style={sx("font-size:14.5px;color:hsl(var(--ally-navy));margin-bottom:4px;")}>NSF certificate</h3><p style={sx("font-size:13px;")}>Review the current NSF/ANSI 455-2 Certificate of Conformity above.</p></div>
              </li>
            </ul>
          </div>
          <div className="photo ratio-4x3">
            <img style={sx('object-fit:contain;background:#fff;')} src={nsfCertificate} width="800" height="1035" alt="Ally Nutra NSF ANSI 455-2 Certificate of Conformity" loading="lazy" onError={hideOnly} />
          </div>
        </div>
      </section>

      <section className="section section-rule">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Testing protocols</span>
            <h2>Testing matched to the product.</h2>
            <p>Testing requirements are defined for each formula and finished product before release.</p>
          </div>
          <div className="grid grid-4" style={sx('margin-bottom:40px;')}>
            <div className="card" style={sx("padding:26px;text-align:center;")}>
              <div style={sx("width:44px;height:44px;background:hsl(var(--ally-orange)/.15);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:hsl(var(--ally-orange));")}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>
              </div>
              <h3 style={sx("color:hsl(var(--ally-navy));font-size:15px;margin-bottom:8px;")}>Identity testing</h3>
              <p style={sx("font-size:12.5px;")}>Identity checks help confirm the ingredients used in the product.</p>
            </div>
            <div className="card" style={sx("padding:26px;text-align:center;")}>
              <div style={sx("width:44px;height:44px;background:hsl(var(--ally-orange)/.15);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:hsl(var(--ally-orange));")}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-5" /></svg>
              </div>
              <h3 style={sx("color:hsl(var(--ally-navy));font-size:15px;margin-bottom:8px;")}>Potency testing</h3>
              <p style={sx("font-size:12.5px;")}>Potency testing can confirm active ingredients against the product specification.</p>
            </div>
            <div className="card" style={sx("padding:26px;text-align:center;")}>
              <div style={sx("width:44px;height:44px;background:hsl(var(--ally-orange)/.15);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:hsl(var(--ally-orange));")}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" /></svg>
              </div>
              <h3 style={sx("color:hsl(var(--ally-navy));font-size:15px;margin-bottom:8px;")}>Purity testing</h3>
              <p style={sx("font-size:12.5px;")}>Purity testing is selected according to the formula and ingredient requirements.</p>
            </div>
            <div className="card" style={sx("padding:26px;text-align:center;")}>
              <div style={sx("width:44px;height:44px;background:hsl(var(--ally-orange)/.15);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:hsl(var(--ally-orange));")}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="12" cy="14" r="3" /></svg>
              </div>
              <h3 style={sx("color:hsl(var(--ally-navy));font-size:15px;margin-bottom:8px;")}>Microbial testing</h3>
              <p style={sx("font-size:12.5px;")}>Microbial testing supports finished-product quality review.</p>
            </div>
          </div>
          <div className="photo ratio-16x9" style={sx('max-width:900px;margin:0 auto;')}>
            <img src={qcLabWide} width="1200" height="675" alt="Ally Nutra's on-site QC laboratory: two HPLC stacks with solvent reservoirs, an analyser and sample-prep bench, and cylinder-fed instrumentation along the wall" loading="lazy" onError={hideOnly} />
          </div>
        </div>
      </section>

      <section className="section" style={sx('text-align:center;')}>
        <div className="container">
          <span className="eyebrow" style={sx('justify-content:center;')}>Documentation library</span>
          <h2 style={sx("margin:14px auto 16px;max-width:560px;")}>Need documentation now?</h2>
          <p style={sx("max-width:560px;margin:0 auto 24px;")}>
            Contact our team to discuss the batch or facility documentation required by your
            buyer, retailer, or marketplace.
          </p>
          <Link to="/contact" className="btn btn-primary btn-lg">Request documentation →</Link>
        </div>
      </section>

      {showNsfCert && (
        <CertificatePopup
          image={nsfCertificate}
          imageAlt="NSF International Certificate of Conformity for Ally Nutra, LLC"
          heading="NSF Certificate of Conformity"
          meta="NSF International — Ally Nutra, LLC. Facility: 631 Ridgely Street, STE 1, Dover, DE, 19904, United States. Scope: NSF/ANSI 455-2 - 2024. Certification number C0871161-HSCDS-1. Initial certification January 6, 2026. Expires January 13, 2027."
          triggerRef={nsfTriggerRef}
          onClose={() => setShowNsfCert(false)}
        />
      )}
    </section>
  );
}
