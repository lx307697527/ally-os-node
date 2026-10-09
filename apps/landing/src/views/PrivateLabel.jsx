import { Link } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
import { hideAndTint } from '../lib/imgFallback.js';
import { scrollToId } from '../lib/scrollToId.js';

import privateLabelBottles from '../assets/images/source-private-label-bottles.webp';
import productCapsules from '../assets/images/products/product-capsules.png';
import rawMaterialWarehouse from '../assets/images/raw-material-warehouse.jpg';

export default function PrivateLabel() {
  return (
    <section aria-labelledby="pl-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">Private label supplements</span>
            <h1 id="pl-h1" style={sx('margin-top:14px;')}>Launch your own brand — without the wait.</h1>
            <p style={sx("color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:520px;")}>
              Access 500+ pre-validated formulas you can customize. Add your label, your brand,
              and your story — and we handle manufacturing and packaging.
            </p>
            <div className="hero-ctas">
              <Link to="/contact" className="btn btn-primary btn-lg">Browse the catalog →</Link>
              <a href="#pl-how" className="btn btn-outline-invert btn-lg" onClick={scrollToId('pl-how')}>
                How it works
              </a>
            </div>
          </div>
          {/* CLAIMS REMEDIATION (2026-08-23) — "100 / MOQ per SKU" had no
              source: no operational MOQ exists in either repo (see
              Home.jsx's PRODUCTS array comment), and
              ADR-007-business-reality-alignment.md records the real
              question as still open, owned by Dasi + CTO. Value changed
              to "Flexible"; still 4 stats, still the shared .svc-stats
              default grid, since the label is still real information. */}
          <div className="svc-stats svc-stats-hero">
            <div className="svc-stat"><div className="svc-stat-num">500+</div><div className="svc-stat-label">Pre-validated formulas</div></div>
            <div className="svc-stat"><div className="svc-stat-num">Flexible</div><div className="svc-stat-label">MOQ per SKU</div></div>
            <div className="svc-stat"><div className="svc-stat-num">FBA</div><div className="svc-stat-label">Prep available</div></div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Why private label</span>
            <h2>Speed to market, without the risk</h2>
            <p className="lede">Private labeling gives you a faster path to market using pre-validated formulas that can be customized for your brand.</p>
          </div>
          <div className="grid grid-3">
            <div className="svc-num-card"><span className="num">Pre-validated</span><h3>Start with a proven base</h3><p>Choose from 500+ pre-validated formulas and customize the product for your brand.</p></div>
            <div className="svc-num-card"><span className="num">Flexible minimums</span><h3>Scale with your brand</h3><p>Order minimums are based on order value and the product requirements discussed during your call.</p></div>
            <div className="svc-num-card"><span className="num">Retail ready</span><h3>Manufacturing through shipping</h3><p>We manufacture, package, label, and can prepare finished products for Amazon FBA.</p></div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>A blank canvas</span>
            <h2>Every detail, ready for your label.</h2>
            <p className="lede">A blank label means a blank canvas — your brand goes on every bottle, carton, and case.</p>
          </div>
          <div className="grid grid-3">
            <div>
              <div className="photo ratio-4x3">
                <img src={privateLabelBottles} width="1100" height="684" alt="Unlabeled dropper bottles ready for private-label packaging design" loading="lazy" decoding="async" onError={hideAndTint} />
              </div>
            </div>
            <div>
              <div className="photo ratio-4x3">
                <img style={sx('object-fit:contain;background:hsl(var(--muted));')} src={productCapsules} width="700" height="525" alt="Ally Nutra branded capsule product render" loading="lazy" decoding="async" onError={hideAndTint} />
              </div>
            </div>
            <div>
              <div className="photo ratio-4x3">
                <img src={rawMaterialWarehouse} width="900" height="675" alt="Blue and orange pallet racking inside Ally Nutra's raw material warehouse" loading="lazy" decoding="async" onError={hideAndTint} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="pl-how">
        <div className="container hero-grid">
          <ul className="bullet-list" style={sx('list-style:none;')}>
            <li style={sx("padding:16px 0;border-bottom:1px solid hsl(var(--border));")}><strong style={sx('color:hsl(var(--ally-navy));display:block;margin-bottom:4px;')}>1. Pick your formula</strong>Choose from 500+ pre-validated formulas and tell us what you want to customize.</li>
            <li style={sx("padding:16px 0;border-bottom:1px solid hsl(var(--border));")}><strong style={sx('color:hsl(var(--ally-navy));display:block;margin-bottom:4px;')}>2. Prepare your label</strong>Upload your design or work with our in-house design team.</li>
            <li style={sx("padding:16px 0;border-bottom:1px solid hsl(var(--border));")}><strong style={sx('color:hsl(var(--ally-navy));display:block;margin-bottom:4px;')}>3. Choose packaging</strong>Bottles, resealable bags, or jars — match the format to your customer's expectations.</li>
            <li style={sx("padding:16px 0;border-bottom:1px solid hsl(var(--border));")}><strong style={sx('color:hsl(var(--ally-navy));display:block;margin-bottom:4px;')}>4. Approve &amp; produce</strong>Review the product details and packaging before production begins.</li>
            <li style={sx('padding:16px 0;')}><strong style={sx('color:hsl(var(--ally-navy));display:block;margin-bottom:4px;')}>5. Ship anywhere</strong>Direct to your warehouse, 3PL, or Amazon FBA — fully labeled, sealed, and ready to sell.</li>
          </ul>
          <div>
            <span className="eyebrow" style={sx('justify-content:center;')}>How it works</span>
            <h2 style={sx('margin:14px 0 12px;')}>Your brand on every detail.</h2>
            <p>From the label to the bottle to the seal — every touchpoint customized to your brand identity.</p>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Who we serve</span>
            <h2>Built for brands at every stage</h2>
            <p className="lede">Whether you're launching your first product or expanding a successful brand line, private label gets you to market faster.</p>
          </div>
          <div className="grid grid-4">
            <div className="card stack-center"><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:6px;")}>Amazon sellers</h3><p style={sx("font-size:12.5px;")}>Products can be labeled and prepared for Amazon FBA requirements.</p></div>
            <div className="card stack-center"><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:6px;")}>D2C brands</h3><p style={sx("font-size:12.5px;")}>Custom labels and packaging support your direct-to-consumer brand.</p></div>
            <div className="card stack-center"><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:6px;")}>Gyms &amp; coaches</h3><p style={sx("font-size:12.5px;")}>Customize pre-validated formulas for your audience and brand.</p></div>
            <div className="card stack-center"><h3 style={sx("font-size:15px;color:hsl(var(--ally-navy));margin-bottom:6px;")}>Clinics &amp; practitioners</h3><p style={sx("font-size:12.5px;")}>Create practitioner-branded supplements with custom packaging.</p></div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Private label vs custom</span>
            <h2>Which path is right for you?</h2>
            <p className="lede">Both paths lead to a real brand. The difference is whether you start with a pre-validated formula or develop a custom one.</p>
          </div>
          {/* CLAIMS REMEDIATION (2026-08-23) — the "Minimum order" row
              ("100 bottles" vs "2,500+ units") removed, not just re-worded:
              neither number was sourced, and a comparison row needs both
              cells to honestly differentiate the two paths. "Flexible" in
              both columns would be a comparison that compares nothing —
              worse than dropping the row. The other four rows still carry
              the table's real differentiation. */}
          <div className="svc-compare">
            <div className="svc-compare-row head"><div></div><div className="featured">Private label</div><div>Custom formulation</div></div>
            <div className="svc-compare-row body"><div>Starting point</div><div className="featured">Pre-validated formula</div><div>Your product brief</div></div>
            <div className="svc-compare-row body"><div>Formula customization</div><div className="featured">Customize an existing formula</div><div>Develop a custom formula</div></div>
            <div className="svc-compare-row body"><div>Best for</div><div className="featured">Speed to market</div><div>Differentiated formulas</div></div>
          </div>
          <p style={sx("text-align:center;color:hsl(var(--muted-foreground));font-size:13.5px;margin-top:24px;")}>
            Have questions before you choose?{' '}
            <Link to="/faq" style={sx('color:hsl(var(--ally-navy));text-decoration:underline;')}>Browse our FAQ →</Link>
          </p>
        </div>
      </section>

      <section className="section section-navy" style={sx('text-align:center;')}>
        <div className="container">
          <h2 style={sx('max-width:640px;margin:0 auto 24px;')}>
            Ready to launch your <em style={sx('font-style:italic;color:hsl(var(--ally-orange));')}>brand</em>?
          </h2>
          <Link to="/contact" className="btn btn-primary btn-lg">Request the catalog →</Link>
        </div>
      </section>
    </section>
  );
}
