import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
import { hideAndTint } from '../lib/imgFallback.js';
import { useDemoRole } from '../contexts/DemoRoleContext.jsx';
import { quoteUrl } from '../lib/demoRole.js';
import { OFFERED_FORMAT_COUNT } from '../data/offeredFormats.js';

import productCapsules from '../assets/images/products/product-capsules.png';
import productSachets from '../assets/images/products/product-sachets.png';
// [owner directive 2026-09-20] Stick-pack tile now uses the owner's attached
// render (two blank stick packs) — same image the Home "What we make" cards
// carry; the single-tube photo it replaces stays in the repo, unused.
import productStickPacks from '../assets/images/formats/format-render-stick-packs.png';
import productPouches from '../assets/images/products/product-pouches-placeholder.webp';
// [FEAT-721] Owner 2026-09-24: tubs, canisters and jars are offered.
import productCanisters from '../assets/images/formats/format-render-canisters.png';
import svcHero from '../assets/images/drive-13-services-formulation.webp';

// [owner directive 2026-09-20] Three muted floor videos under the Our Process
// cards, straight from the owner's approved Drive video folder: powder blending
// (IMG_5216.MOV), the stainless mixer (IMG_1221.MOV), and warehouse fulfillment
// (IMG_4754.MOV) — transcribed to silent 720p H.264 (audio dropped: they play
// muted by design, and a muted autoplay loop has no use for a track). Source
// files and per-file notes live in IMAGE-CREDITS.md. Decorative b-roll: no
// captions, no claims — aria-hidden like the Home hero video.
import processBlend from '../assets/videos/process-blend.mp4';
import processMix from '../assets/videos/process-mix.mp4';
import processShip from '../assets/videos/process-ship.mp4';
import processBlendPoster from '../assets/videos/process-blend-poster.jpg';
import processMixPoster from '../assets/videos/process-mix-poster.jpg';
import processShipPoster from '../assets/videos/process-ship-poster.jpg';

const PROCESS_VIDEOS = [
  { src: processBlend, poster: processBlendPoster },
  { src: processMix, poster: processMixPoster },
  { src: processShip, poster: processShipPoster },
];

function ProcessVideo({ src, poster }) {
  const videoRef = useRef(null);

  // prefers-reduced-motion: no autoplay — the poster frame carries the tile.
  // Same guard the Home hero video uses (HeroMech in Home.jsx).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      video.pause();
      video.removeAttribute('autoplay');
    }
  }, []);

  return (
    <video
      ref={videoRef}
      src={src}
      poster={poster}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
      tabIndex={-1}
      onError={() => { if (videoRef.current) videoRef.current.style.display = 'none'; }}
    />
  );
}

// Copy authority: Ally-Nutra-LLC-New/ally-nutra origin/main at 217317d4.
// Presentation may differ, but public capability wording must remain verbatim.
const FORMATS = [
  {
    image: productCapsules,
    name: 'Capsules',
    tagline: 'Flexible formulation, easy to swallow',
    bestFor: 'Botanicals, probiotics, oil-based nutrients, custom blends, sensitive ingredients',
  },
  {
    image: productSachets,
    name: 'Sachets',
    tagline: 'Single-serve convenience, premium presentation',
    bestFor: 'Powdered supplements, drink mixes, travel-friendly products, subscription boxes',
  },
  {
    image: productStickPacks,
    name: 'Stick Packs',
    tagline: 'On-the-go format, portion-controlled',
    bestFor: 'Energy blends, electrolytes, collagen, greens powders, functional beverages',
  },
  {
    image: productPouches,
    name: 'Bags',
    tagline: 'Bulk-friendly, resealable packaging',
    bestFor: 'Protein powders, superfood blends, bulk supplements, refill programs',
  },
  {
    image: productCanisters,
    name: 'Tubs / Canisters / Jars',
    tagline: 'Scoopable servings, resealable and shelf-ready',
    bestFor: 'Pre-workout, meal replacements, greens powders, creatine, bulk scoopable blends',
  },
];

const CORE_SERVICES = [
  {
    title: 'Custom Supplement Manufacturing',
    description: 'Full-service manufacturing for capsules, sachets, stick packs, and resealable pouches. From raw materials to finished products — we handle every step with FDA-compliant precision.',
    features: [
      'Custom formulation development',
      'Ingredient sourcing and testing',
      'Multiple delivery format options',
      'Scalable production runs',
      'Quality assurance and COA testing',
    ],
  },
  {
    title: 'Packaging and Design',
    description: 'Comprehensive packaging solutions for all supplement formats. From bottles to pouches, we provide FDA-compliant labels and premium container options tailored to your brand.',
    features: [
      'FDA-compliant label design',
      'Custom bottles, pouches, and stick packs',
      'Desiccant insertion & moisture control',
      'Tamper-evident seals',
      'Gift set and bundle assembly',
    ],
  },
  {
    title: 'Amazon FBA Preparation',
    description: 'Get your supplement products Amazon-ready. We handle FBA prep, labeling, and shipping so you can focus on selling.',
    features: [
      'FBA-compliant packaging and labeling',
      'Poly bagging and bundling',
      'FNSKU labeling',
      'Carton prep and shipment creation',
      'Direct shipment to Amazon fulfillment centers',
    ],
  },
];

const PROCESS = [
  ['1', 'Submit Your Quote', 'Tell us what you need. Get an instant AI-powered estimate.'],
  ['2', 'Review & Finalize', 'We nail down the details and lock in final pricing. No surprises.'],
  ['3', 'Production Kicks Off', 'Once components arrive, approximately 2-3 weeks to finished product.'],
  ['4', 'Quality Check & Ship', 'Every batch tested. Every product inspected. Then out the door.'],
];

export default function Services() {
  const { role } = useDemoRole();

  return (
    <section aria-labelledby="services-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <h1 id="services-h1">End-to-End <em style={sx('font-style:normal;color:hsl(var(--ally-orange));')}>Supplement Solutions</em></h1>
            <p style={sx('color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:560px;')}>
              From capsules to pouches — we manufacture your custom supplements with precision, compliance, and speed.
            </p>
            <p style={sx('color:hsl(0 0% 100% / .62);margin:14px 0 0;')}>Capsules • Sachets • Stick Packs • Pouches • Tubs / Canisters / Jars</p>
            <div className="hero-ctas">
              <Link to="/contact" className="btn btn-primary btn-lg">Schedule a Call</Link>
              <a href={quoteUrl(role)} className="btn btn-outline-light btn-lg">Get a Quote</a>
            </div>
          </div>
          <div className="photo services-hero-media">
            <img style={sx('object-fit:cover;')} src={svcHero} width="880" height="1100" alt="" aria-hidden="true" onError={hideAndTint} />
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header">
            <h2>Manufacturing Formats</h2>
            <p>Four delivery formats. One trusted partner. Choose the format that fits your product and market.</p>
          </div>
          {/* [owner directive 2026-09-28] All five format cards in ONE row.
              This switches the section from the shared `.grid-4` utility to
              the page-scoped `.svc-formats-grid` class that already existed in
              global.css for exactly this grid (its comment says Services.jsx
              sets `--svc-format-cols` from OFFERED_FORMAT_COUNT — the wiring
              had been lost to a plain grid-4): 5 columns at desktop, the
              existing 2-column + full-width-5th orphan handling at ≤899px, and
              single column on mobile. Positioning only — cards, copy, and the
              Process grid below are untouched. */}
          <div className="grid svc-formats-grid" style={sx(`--svc-format-cols:${OFFERED_FORMAT_COUNT};`)}>
            {FORMATS.map((format) => (
              <article className="format-card" key={format.name}>
                {/* White slot (not the default muted gray): three of the four
                    format images are square renders on pure white, which
                    letterbox inside this 4:3 frame — gray bars read as a
                    mistake; white makes the letterbox seamless. */}
                <div className="photo ratio-4x3" style={sx('background:hsl(var(--card));')}>
                  <img style={sx('object-fit:contain;background:hsl(var(--card));')} src={format.image} width="700" height="525" alt={format.name} loading="lazy" onError={hideAndTint} />
                </div>
                <div className="format-body">
                  <h3>{format.name}</h3>
                  <p>{format.tagline}</p>
                  <p><strong>Best for:</strong> {format.bestFor}</p>
                  <a href={quoteUrl(role)} className="btn-ghost">Get Quote for {format.name} →</a>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="services">
        <div className="container">
          <div className="section-header">
            <h2>Our Core Services</h2>
            <p>Manufacturing, packaging, and fulfillment — all under one roof.</p>
          </div>
          <div className="grid grid-3">
            {CORE_SERVICES.map((service) => (
              <article className="card" key={service.title}>
                <h3>{service.title}</h3>
                <p>{service.description}</p>
                <h4>What's Included:</h4>
                <ul className="bullet-list">
                  {service.features.map((feature) => <li key={feature}>{feature}</li>)}
                </ul>
                <a href={quoteUrl(role)} className="btn-ghost">Request This Service →</a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt" id="process">
        <div className="container">
          <div className="section-header">
            <h2>Our Process</h2>
            <p>No runaround. No shortcuts. Here's how we work.</p>
          </div>
          <div className="grid grid-4">
            {PROCESS.map(([step, title, description]) => (
              <article className="card stack-center" key={step}>
                <span className="eyebrow">Step {step}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
          {/* [owner directive 2026-09-20] Three muted floor videos, one row of
              three, centered under the step cards — see PROCESS_VIDEOS note. */}
          <div className="process-videos">
            {PROCESS_VIDEOS.map((v) => (
              <ProcessVideo key={v.src} src={v.src} poster={v.poster} />
            ))}
          </div>
        </div>
      </section>

      <section className="section section-navy" style={sx('text-align:center;')}>
        <div className="container">
          <h2>Ready to Manufacture?</h2>
          <p style={sx('color:hsl(0 0% 100% / .78);max-width:620px;margin:16px auto 24px;')}>
            Capsules, sachets, stick packs, or pouches — we've got you covered. Let's get your product on the shelf.
          </p>
          <div className="hero-ctas" style={sx('justify-content:center;')}>
            <Link to="/contact" className="btn btn-primary btn-lg">Schedule a Call</Link>
            <a href={quoteUrl(role)} className="btn btn-outline-light btn-lg">Get a Quote</a>
          </div>
        </div>
      </section>
    </section>
  );
}
