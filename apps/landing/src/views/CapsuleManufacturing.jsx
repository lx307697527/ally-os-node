import { sx } from '../lib/styleString.js';
import { hideAndTint } from '../lib/imgFallback.js';
import { useDemoRole } from '../contexts/DemoRoleContext.jsx';
import { quoteUrl } from '../lib/demoRole.js';

import capsuleCreative from '../assets/images/drive-03-capsules.webp';
// [BUG-380] Drive `14.png`. The imagery invariant in apps/landing/CLAUDE.md binds
// this page to the Drive pair 3.png + 14.png. BUG-379 p2's copy rewrite dropped
// this import and its slot while moving 3.png up into the hero, so the page has
// rendered half the required pair since 2026-09-20. Decorative on purpose: the
// asset's own subject list names a format FEAT-310 deactivated, so describing it
// would put "tablets" back into a customer-visible string.
import formatsCreative from '../assets/images/drive-14-formats.webp';

// Copy authority: Ally-Nutra-LLC-New/ally-nutra origin/main at 217317d4.
// The unsupported capsule format identified by the owner is intentionally absent.
const CAPSULE_TYPES = [
  ['Vegetarian (Veggie) Capsules', 'HPMC and pullulan-based plant-derived capsules — the clean-label choice for health-conscious consumers. Hypoallergenic and suitable for vegan and vegetarian certifications.'],
  ['Gelatin Capsules', 'Traditional bovine or porcine gelatin capsules offering excellent moisture barrier and broad compatibility with most supplement ingredients.'],
  ['Delayed-Release Capsules', 'Engineered to bypass stomach acid and release ingredients in the small intestine — ideal for probiotics, enzymes, and acid-sensitive actives.'],
  ['Enteric-Coated Capsules', 'Protective polymer coating prevents dissolution in the stomach, protecting the ingredient and the consumer from gastric irritation.'],
  ['Specialty & Patterned Capsules', 'Two-tone, colored, banded, and printed capsules for brand differentiation and product line distinction on shelf.'],
];

const CAPABILITIES = [
  ['Precision Blending', 'Multi-stage powder blending ensures ingredient homogeneity and consistent dosing across every capsule in the batch.'],
  ['High-Speed Encapsulation', 'Our NJP-2500 capsule filling machine processes up to 150,000 capsules per hour with precise fill-weight control.'],
  ['Polishing & Inspection', 'Every batch is polished, de-dusted, and visually inspected before proceeding to the bottling and packaging line.'],
  ['Bottling & Capping', 'Automated bottling line handles HDPE, PET, amber glass, and custom containers with induction sealing and capping.'],
  ['Label Application', 'Automated label application with 100% label presence verification — front panel, back panel, and tamper-evident bands.'],
  ['Case Packing & Fulfillment', 'Retail-ready case packing, Amazon FBA prep, and direct-to-consumer fulfillment from our Dover, DE facility.'],
];

const FORMULATION_SUPPORT = [
  ['Custom Formula Development', 'Our R&D team works with you on ingredient selection, dosing, excipient compatibility, and capsule size optimization.'],
  ['Existing Formula Scale-Up', 'Already have a formula from a lab or previous manufacturer? We scale it to commercial production without reformulating.'],
  ['Bioavailability Optimization', 'We advise on form selection (oxide vs. chelated minerals, free-form vs. esterified vitamins) to maximize efficacy.'],
  ['Regulatory Label Review', 'Our team reviews your supplement facts panel, claims, and labels for FDA 21 CFR Part 111 compliance before printing.'],
];

const QUALITY_ITEMS = [
  ['In-House QC Lab', 'On-site laboratory performs identity, potency, and microbiological testing at incoming raw material and finished product stages.'],
  ['Third-Party Lab Testing', 'All batches sent to accredited third-party laboratories for independent verification. Certificate of Analysis included with every order.'],
  ['FDA-Registered Facility', 'Manufactured under 21 CFR Part 111 in our FDA-registered Dover, DE facility — full documentation available for brand audits.'],
  ['NSF/ANSI 455-2 Certified', 'Third-party certified cGMP compliance — the gold standard for dietary supplement manufacturing quality systems.'],
];

export default function CapsuleManufacturing() {
  const { role } = useDemoRole();

  return (
    <section aria-labelledby="capmfg-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">FDA-Registered · NSF/cGMP Certified · Dover, DE</span>
            <h1 id="capmfg-h1" style={sx('margin-top:14px;')}>Custom <em style={sx('font-style:normal;color:hsl(var(--ally-orange));')}>Capsule Manufacturing</em> for Supplement Brands</h1>
            <p style={sx('color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:620px;')}>
              From veggie caps to enteric-coated specialty capsules — Ally Nutra provides end-to-end capsule encapsulation services for supplement brands across the USA. FDA-registered, cGMP-certified, and committed to quality at every batch.
            </p>
            <div className="hero-ctas">
              <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get a Quote in 5 Minutes</a>
            </div>
          </div>
          <div>
            <div className="photo ratio-4x3">
              <img style={sx('object-fit:contain;background:hsl(var(--muted));')} src={capsuleCreative} width="1000" height="1000" alt="" aria-hidden="true" onError={hideAndTint} />
            </div>
            <div className="svc-stats svc-stats-hero">
              <div className="svc-stat"><div className="svc-stat-label">Veggie &amp; Gelatin Caps</div></div>
              <div className="svc-stat"><div className="svc-stat-label">Delayed-Release</div></div>
              <div className="svc-stat"><div className="svc-stat-label">Enteric-Coated</div></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="cap-types">
        <div className="container">
          <div className="section-header">
            <h2>Capsule Types We Manufacture</h2>
            <p>We manufacture across all major capsule types — from standard vegetarian capsules to specialty delayed-release and enteric-coated formulations.</p>
          </div>
          <div className="grid grid-3">
            {CAPSULE_TYPES.map(([title, description]) => (
              <article className="card" key={title}><h3>{title}</h3><p>{description}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header left">
            <h2>Capsule Encapsulation Capabilities</h2>
            <p>Our fully equipped encapsulation line handles every step in-house — from precision powder blending through high-speed encapsulation, polishing, bottling, labeling, and case packing. No outsourcing, no hand-offs, and full chain-of-custody documentation for every batch.</p>
          </div>
          <div className="grid grid-3">
            {CAPABILITIES.map(([title, description]) => (
              <article className="card" key={title}><h3>{title}</h3><p>{description}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header left">
            <h2>Custom Capsule Formulation Support</h2>
            <p>Whether you're developing a new formula from scratch or scaling an existing one, our in-house R&amp;D team provides the technical support to get your capsule product to market correctly — the first time.</p>
          </div>
          <div className="grid grid-2">
            {FORMULATION_SUPPORT.map(([title, description]) => (
              <article className="card" key={title}><h3>{title}</h3><p>{description}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header">
            <h2>{'Capsule Quality Control & Compliance'}</h2>
            <p>Every capsule batch leaves our facility with full documentation — in-house testing, third-party verification, and a Certificate of Analysis for your records.</p>
          </div>
          <div className="grid grid-4">
            {QUALITY_ITEMS.map(([title, description]) => (
              <article className="card" key={title}><h3>{title}</h3><p>{description}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container" style={sx('max-width:560px;')}>
          <div className="photo ratio-4x3">
            <img style={sx('object-fit:contain;background:hsl(var(--muted));')} src={formatsCreative} width="800" height="1000" alt="" aria-hidden="true" loading="lazy" decoding="async" onError={hideAndTint} />
          </div>
        </div>
      </section>

      <section className="section section-navy" style={sx('text-align:center;')}>
        <div className="container">
          <span className="eyebrow on-dark">FDA-Registered · GMP-Certified · Made in USA</span>
          <h2 style={sx('margin-top:16px;')}>Ready to Manufacture Your Custom Capsule Supplement?</h2>
          <p style={sx('color:hsl(0 0% 100% / .78);max-width:620px;margin:16px auto 24px;')}>
            Get a personalized capsule manufacturing quote in under 5 minutes. Tell us your formula, capsule type, and target quantity — our team responds within 1 business day.
          </p>
          <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get a Quote in 5 Minutes</a>
        </div>
      </section>
    </section>
  );
}
