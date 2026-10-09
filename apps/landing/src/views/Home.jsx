import { Link } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
import { hideAndTint } from '../lib/imgFallback.js';
import ProductCardsGrid from '../components/ProductCardsGrid.jsx';
import { useDemoRole } from '../contexts/DemoRoleContext.jsx';
import { quoteUrl, scheduleUrl } from '../lib/demoRole.js';
import './Home.css';

import homeHero from '../assets/images/home-hero.jpg';
import heroMachineWebm from '../assets/videos/hero-machine.webm';
import heroMachineMp4 from '../assets/videos/hero-machine.mp4';
import heroMachinePoster from '../assets/videos/hero-machine-poster.jpg';

// [owner directive 2026-09-20, second pass] The "What we make" cards (§3) carry
// the four blank product renders the owner attached directly in chat this
// session — stick packs first, then capsules, sachets, and resealable pouches
// last (the owner's stated order). These replaced the branded Drive creatives
// the same directive had installed earlier that day: the creatives duplicated
// their baked taglines as card body text, which read twice on one card. The
// attachments arrived as 800×600 PNGs on pure-white backgrounds and are
// embedded here padded to seamless 900×900 white squares (no crop, no color
// change). The originals are not in the Creatives Drive folder or either repo
// — the attachments themselves are the source of record (provenance rows in
// IMAGE-CREDITS.md). The three variety popup photos (products/variety-*.jpg)
// remain unused with the popup — credited in IMAGE-CREDITS.md, available for
// reuse.
//
// [owner directive 2026-09-20, third pass] The §5 format carousel keeps the
// branded Drive creatives after all: the blank renders carry no text, and the
// owner wanted the text content there ("choose from the drive the 3.png,
// 4.png, 5.png, 6.png"). So the split is: §3 cards = owner's render pictures
// with the site's own text; §5 carousel = branded creatives with their baked
// headlines/taglines/best-for lists, which is exactly the content §3 no
// longer shows.
import renderStickPacks from '../assets/images/formats/format-render-stick-packs.png';
import renderCapsules from '../assets/images/formats/format-render-capsules.png';
import renderSachets from '../assets/images/formats/format-render-sachets.png';
import renderPouches from '../assets/images/formats/format-render-pouches.png';
// [FEAT-721] Owner 2026-09-24: we do offer tubs, canisters and jars. Padded to
// the same 900x900 white square as its four siblings from `ally-nutra`'s own
// `src/assets/formats/canisters.webp` — the approved imagery authority.
import renderCanisters from '../assets/images/formats/format-render-canisters.png';
// [owner directive 2026-09-28, corrected same day] The two branded creatives
// the owner picked from the Drive: `8.png` (Tubs) and `LINKEDIN ALLYNUTRA
// (7).png` (Canisters) — the two rigid formats FEAT-721 added, whose branded
// cards had no slot until now. First placed under the §4 comparison table per
// the owner's wording; he then ruled that placement "entirely wrong" and
// directed them into the §5 format-showcase carousel ("there should be a 6
// images to see here"), where they join the four existing format creatives.
import driveTubs from '../assets/images/drive-08-tubs.webp';
import driveCanisters from '../assets/images/drive-linkedin-07-canisters.webp';
import driveCapsules from '../assets/images/formats/format-showcase-capsules.png';
import driveSachets from '../assets/images/formats/format-showcase-sachets.png';
import driveStickPacks from '../assets/images/formats/format-showcase-stick-packs.png';
import drivePouches from '../assets/images/formats/format-showcase-pouches.png';

// Format showcase slides (§5, replaces the five-photo facility strip). Six
// client-supplied branded format cards — one per confirmed format — sourced from
// the client's Google Drive folder (see IMAGE-CREDITS.md for the full URL and
// per-file notes): the original four as 3.png/4.png/5.png/6.png (3375×3375 PNG,
// 2.5/2.0/1.9/1.2 MB, resized to 900×900 palette-quantized, 119.3/87.1/94.7/64.1 KB)
// plus the 2026-09-28 pair 8.png (Tubs) and LINKEDIN ALLYNUTRA (7).png
// (Canisters), resized 1000×1000 WebP (26.5/28.5 KB). The
// slides carry their own baked-in headline + "Best for" list, sized for
// full-screen viewing — which is why §5 presents them as one-large-slide-at-a-time
// carousel rather than a thumbnail row. The branded slides carried unsupported
// baked-in claims, so this repair preserves the carousel with the four source-backed
// product renders and exact AllyNutra descriptions instead.
//
// The facility photos this replaces: facility-03/04 become unused (kept in the
// repo per convention, credits updated); facility-05/06 remain used by
// Facility.jsx and Services.jsx; about-03 remains used by About.jsx. The
// /facility and /certifications links survive in the credential strip above.
// Work With Us VSL (§6.5). The exact video that opens the company site's
// /work-with-us landing page (Ally-Nutra-LLC-New/ally-nutra, public/lp/assets/
// video/finalized-vsl-*.mp4, served at allynutra.com/work-with-us), copied
// read-only from that repo at origin/main. 720p (38.6 MB) for desktop and 360p
// (10.8 MB) as the narrow-viewport/small-pipe source, selected via <source
// media>; the 64.7 MB 1080p master was deliberately NOT bundled — the player's
// max on-page width is 880px, well under 720p's needs, and it would add more
// than the entire video budget again for no visible gain. Poster frame 93 KB.
// Duration 4:09 (ffprobe: 249.359s) — the caption under the player states it.
import vsl720 from '../assets/videos/work-with-us-vsl-720.mp4';
import vsl360 from '../assets/videos/work-with-us-vsl-360.mp4';
import vslPoster from '../assets/videos/work-with-us-vsl-poster.jpg';

// Final-CTA card (§09): the client's "Your Supplements, Our Expertise" branded card
// (Drive 20.png, 3375×4219, 14.8 MB → 840×1050 palette-quantized, 352.9 KB). Clicking
// it opens the quote flow — same quoteUrl(role) target as the "Start your quote"
// button above it, per the client's request. Alt text describes the baked content
// since the card's own text is pixels.
import readyToBuildCta from '../assets/images/ready-to-build-cta.png';

import { useEffect, useRef, useState } from 'react';

// The hero/final-CTA button used to point at a real, live Calendly link
// (found read-only in the company repo, src/lib/calendlyBooking.ts,
// JOSH_CALENDLY_URL — since retired there in favor of iClosed, per the
// scheduling-flow investigation this session). feature/role-and-links then
// repointed both buttons at the /quote/ static flow instead, under the label
// "Book a call" — a button labelled to book a call that actually opened a
// quote form. feature/nav-restructure fixes both: they now open
// scheduleUrl(role) (the /schedule/ prototype's own booking flow) and read
// "Schedule a call", matching what they do.

// Copy authority: Ally-Nutra-LLC-New/ally-nutra@217317d4 (origin/main,
// fetched 2026-09-20). Every public claim below is copied from that repository.
// The FEAT-590 layout stays intact; unsupported copy is rewritten in place.
const EXPECTATION_LINE = 'cGMP Certified · FDA Compliant · Fast Turnaround · Competitive Pricing';

// Home hero encapsulation-machine video: falls back to the built-in SVG line
// drawing under prefers-reduced-motion, or if the video errors out.
function HeroMech() {
  const videoRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setFailed(true);
      video.pause();
      video.removeAttribute('autoplay');
      return;
    }
    function onError() {
      setFailed(true);
    }
    video.addEventListener('error', onError);
    return () => video.removeEventListener('error', onError);
  }, []);

  return (
    <div className={`hero-mech${failed ? ' no-video' : ''}`} aria-hidden="true">
      <div className="hero-video-wrap">
        <video
          ref={videoRef}
          className="hero-video"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={heroMachinePoster}
          aria-hidden="true"
          tabIndex="-1"
        >
          <source src={heroMachineWebm} type="video/webm" />
          <source src={heroMachineMp4} type="video/mp4" />
        </video>
        <div className="hero-video-tint"></div>
      </div>
      <svg
        className="hero-mech-svg"
        viewBox="0 0 400 460"
        width="400"
        height="460"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        role="presentation"
      >
        <g className="mech-struct">
          <line x1="172" y1="178" x2="172" y2="316" className="mech-line-struct" />
          <line x1="398" y1="178" x2="398" y2="316" className="mech-line-struct" />
          <circle cx="290" cy="68" r="4" className="mech-line-struct" />
          <rect x="182" y="344" width="216" height="66" rx="4" className="mech-line-struct" />
          <line x1="290" y1="410" x2="290" y2="420" className="mech-line-struct" />
          <rect x="150" y="420" width="280" height="18" rx="3" className="mech-line-struct" />
          <circle cx="168" cy="429" r="3" className="mech-line-struct" />
          <circle cx="290" cy="429" r="3" className="mech-line-struct" />
          <circle cx="412" cy="429" r="3" className="mech-line-struct" />
        </g>

        <g transform="translate(290,68)">
          <g className="crank-rotor">
            <circle r="62" className="mech-line-move" />
            <line x1="0" y1="0" x2="0" y2="55" className="mech-line-move" />
            <circle cx="0" cy="55" r="6" className="mech-line-move" />
          </g>
        </g>

        <g transform="translate(290,303)">
          <g className="mech-rod">
            <rect x="-2" y="-180" width="4" height="180" rx="2" className="mech-line-move" />
            <circle cx="0" cy="-180" r="5" className="mech-line-move" />
          </g>
        </g>

        <g className="mech-crosshead">
          <rect x="180" y="298" width="220" height="10" rx="2" className="mech-line-move" />
          <g className="pin-1"><line x1="190" y1="308" x2="190" y2="356" className="mech-line-move" /><rect x="185" y="304" width="10" height="8" rx="2" className="mech-line-move" /></g>
          <g className="pin-2"><line x1="228" y1="308" x2="228" y2="356" className="mech-line-move" /><rect x="223" y="304" width="10" height="8" rx="2" className="mech-line-move" /></g>
          <g className="pin-3"><line x1="266" y1="308" x2="266" y2="356" className="mech-line-move" /><rect x="261" y="304" width="10" height="8" rx="2" className="mech-line-move" /></g>
          <g className="pin-4"><line x1="304" y1="308" x2="304" y2="356" className="mech-line-move" /><rect x="299" y="304" width="10" height="8" rx="2" className="mech-line-move" /></g>
          <g className="pin-5"><line x1="342" y1="308" x2="342" y2="356" className="mech-line-move" /><rect x="337" y="304" width="10" height="8" rx="2" className="mech-line-move" /></g>
          <g className="pin-6"><line x1="380" y1="308" x2="380" y2="356" className="mech-line-move" /><rect x="375" y="304" width="10" height="8" rx="2" className="mech-line-move" /></g>
        </g>

        <clipPath id="plateWindow"><rect x="170" y="352" width="230" height="44" /></clipPath>
        <g clipPath="url(#plateWindow)">
          <g className="mech-plate">
            <rect x="177" y="358" width="26" height="30" rx="13" className="mech-line-move" />
            <rect x="215" y="358" width="26" height="30" rx="13" className="mech-line-move" />
            <rect x="253" y="358" width="26" height="30" rx="13" className="mech-line-move" />
            <rect x="291" y="358" width="26" height="30" rx="13" className="mech-line-move" />
            <rect x="329" y="358" width="26" height="30" rx="13" className="mech-line-move" />
            <rect x="367" y="358" width="26" height="30" rx="13" className="mech-line-move" />
            <rect x="405" y="358" width="26" height="30" rx="13" className="mech-line-move" />
          </g>
        </g>

        <rect className="mech-output" x="150" y="368" width="24" height="28" rx="12" fill="hsl(38 87% 55%)" />
      </svg>
      <div className="hero-mech-label">Full-Service Supplement Manufacturer</div>
    </div>
  );
}

// ally-nutra/src/components/landing/CapabilitiesSection.tsx. Keep the FEAT-590
// card design, but do not publish local fill ranges, order minimums, or unsupported capsule capabilities.
// Order is the owner's stated one (2026-09-20): stick packs first, capsules,
// sachets, resealable pouches last. All four descriptions/specs stay verbatim.
const PRODUCTS = [
  {
    img: renderStickPacks,
    alt: 'Two blank white stick packs on a white surface',
    photoSquare: true,
    varietiesKey: 'Stick packs',
    format: 'Stick Packs',
    title: 'Stick Packs',
    desc: 'On-the-go convenience with controlled portions. Perfect for travel.',
    spec: 'STICK PACKS',
  },
  {
    img: renderCapsules,
    alt: 'A plain white supplement bottle with blank two-piece capsules spilling beside it',
    photoSquare: true,
    format: 'Capsules',
    title: 'Capsules',
    desc: 'Fast absorption, easy to swallow. Effectively masks taste and odor.',
    spec: 'CAPSULES',
  },
  {
    img: renderSachets,
    alt: 'A single blank silver foil sachet with crimped edges',
    photoSquare: true,
    format: 'Sachets',
    title: 'Sachets',
    desc: 'Portable single-serve portions. Ideal for powders, granules, and liquids.',
    spec: 'SACHETS',
  },
  {
    img: renderPouches,
    alt: 'Four blank white stand-up resealable pouches in ascending sizes',
    photoSquare: true,
    varietiesKey: 'Resealable Bags',
    format: 'Resealable Pouches',
    title: 'Resealable Pouches',
    desc: 'Flexible sizing with extended freshness. Eco-friendly packaging options.',
    spec: 'RESEALABLE POUCHES',
  },
  {
    img: renderCanisters,
    alt: 'Three blank white tubs, canisters and a clear jar on a white surface',
    photoSquare: true,
    format: 'Tubs / Canisters / Jars',
    title: 'Tubs / Canisters / Jars',
    desc: 'Scoopable powders with a resealable lid. Built for pre-workout and meal replacements.',
    spec: 'TUBS / CANISTERS / JARS',
  },
];

// ally-nutra/src/components/landing/HowItWorksSection.tsx
const HOW_IT_WORKS = [
  { step: '01', title: 'Share or Create Your Formula', body: "Have a formula? Share it with us. Need one? We'll help develop a custom formula tailored to your product goals.", time: 'START YOUR QUOTE' },
  { step: '02', title: 'We Quote & Manufacture', body: 'Get competitive pricing within minutes. Once approved, we manufacture your capsules with precision.', time: 'GET PRICING' },
  { step: '03', title: 'Receive Finished Capsules', body: 'Your capsules arrive bottled, labeled, tested and ready to sell. Ship direct to Amazon FBA or your warehouse.', time: "LET'S TALK" },
];

// ally-nutra/src/components/landing/WhyChooseUsSection.tsx. The comparison-table
// presentation remains, but the unsupported competitor comparison is gone.
const COMPARISON_ROWS = [
  { notice: '01', withUs: 'We Are All In', usual: "When it's time to get things done, we're all in—no excuses." },
  { notice: '02', withUs: 'Competitive Pricing', usual: 'Premium products at prices that keep you profitable.' },
  { notice: '03', withUs: 'Aggressive Turnaround', usual: 'Speed matters. Your product gets priority treatment.' },
  { notice: '04', withUs: 'Quality. Period.', usual: 'NSF cGMP certified. FDA compliant. Every batch tested.' },
];

const CREDENTIAL_STRIP = [
  { label: 'Made in USA', to: '/certifications' },
  { label: 'cGMP Certified', to: '/certifications' },
  { label: 'FDA Registered', to: '/certifications' },
  { label: 'Lab Tested', to: '/certifications' },
  { label: 'Fast Turnaround', to: '/about' },
  { label: 'Competitive Pricing', to: '/about' },
];

// §5 carousel slides: the branded Drive creatives (Creatives/3–6.png), in the
// owner's listed order — capsules, sachets, stick packs, pouches — followed by
// the two 2026-09-28 additions, Tubs (8.png) and Canisters (LINKEDIN (7).png),
// matching §3's card order where Tubs / Canisters / Jars is last. These carry
// the baked text content (headline, tagline, best-for list) that the blank
// renders in §3 don't have — the two sections now split the job: §3 shows the
// clean product pictures with the site's own copy, §5 shows the branded cards.
// `alt` describes what each baked slide actually shows since the slide text is
// an image and invisible to assistive tech; the active-slide info bar below
// the carousel re-states the spec as real text for the same reason. `spec`
// strings stay verbatim from the PRODUCTS array — the carousel adds no claim
// the cards don't already make.
const FORMAT_SHOWCASE = [
  {
    img: driveCapsules,
    alt: 'Capsules format card, Ally Nutra brand creative',
    title: 'Capsules',
    spec: 'Fast absorption, easy to swallow. Effectively masks taste and odor.',
    to: '/capsule-manufacturing',
    linkLabel: 'Capsule manufacturing',
  },
  {
    img: driveSachets,
    alt: 'Sachets format card, Ally Nutra brand creative',
    title: 'Sachets',
    spec: 'Portable single-serve portions. Ideal for powders, granules, and liquids.',
    to: '/services',
    linkLabel: 'All services',
  },
  {
    img: driveStickPacks,
    alt: 'Stick Packs format card, Ally Nutra brand creative',
    title: 'Stick Packs',
    spec: 'On-the-go convenience with controlled portions. Perfect for travel.',
    to: '/services',
    linkLabel: 'All services',
  },
  {
    img: drivePouches,
    alt: 'Resealable Pouches format card, Ally Nutra brand creative',
    title: 'Resealable Pouches',
    spec: 'Flexible sizing with extended freshness. Eco-friendly packaging options.',
    to: '/services',
    linkLabel: 'All services',
  },
  {
    img: driveTubs,
    alt: 'Tubs format card, Ally Nutra brand creative',
    title: 'Tubs',
    spec: 'Scoopable powders with a resealable lid. Built for pre-workout and meal replacements.',
    to: '/services',
    linkLabel: 'All services',
  },
  {
    img: driveCanisters,
    alt: 'Canisters format card, Ally Nutra brand creative',
    title: 'Canisters',
    spec: 'Scoopable powders with a resealable lid. Built for pre-workout and meal replacements.',
    to: '/services',
    linkLabel: 'All services',
  },
];

// Scroll-snap carousel: native horizontal scrolling (touch, trackpad, keyboard
// when focused) does the paging; the prev/next buttons and dots scroll the
// matching slide into view; the info bar under the track mirrors the centered
// slide as real text. No transform-based slide machinery on purpose — snap
// scrolling keeps dragging native on touch and needs no index math to stay in
// sync with gesture paging (onScroll just reports which slide ended up nearest
// center).
function FormatCarousel() {
  const trackRef = useRef(null);
  const [active, setActive] = useState(0);

  const scrollTo = (index) => {
    const track = trackRef.current;
    if (!track) return;
    const clamped = Math.max(0, Math.min(FORMAT_SHOWCASE.length - 1, index));
    const slide = track.children[clamped];
    if (slide) {
      setActive(clamped);
      slide.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  };

  const onScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const trackRect = track.getBoundingClientRect();
    const mid = trackRect.left + trackRect.width / 2;
    let best = 0;
    let bestDist = Infinity;
    Array.from(track.children).forEach((slide, i) => {
      const slideRect = slide.getBoundingClientRect();
      const dist = Math.abs(slideRect.left + slideRect.width / 2 - mid);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    setActive(best);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); scrollTo(active - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); scrollTo(active + 1); }
  };

  const current = FORMAT_SHOWCASE[active];

  return (
    <div
      className="format-carousel"
      role="group"
      aria-roledescription="carousel"
      aria-label="Format showcase"
      onKeyDown={onKeyDown}
    >
      <div className="format-track" ref={trackRef} onScroll={onScroll} tabIndex={0}>
        {FORMAT_SHOWCASE.map((f, i) => (
          <div
            className="format-slide"
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${FORMAT_SHOWCASE.length}: ${f.title}`}
            key={f.title}
          >
            <img src={f.img} width="900" height="900" alt={f.alt} loading="lazy" onError={hideAndTint} />
          </div>
        ))}
      </div>
      <div className="format-nav">
        <button type="button" className="format-arrow" aria-label="Previous format" onClick={() => scrollTo(active - 1)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <div className="format-dots">
          {FORMAT_SHOWCASE.map((f, i) => (
            <button
              type="button"
              className="format-dot"
              key={f.title}
              aria-current={i === active}
              aria-label={`Show ${f.title}`}
              onClick={() => scrollTo(i)}
            ></button>
          ))}
        </div>
        <button type="button" className="format-arrow" aria-label="Next format" onClick={() => scrollTo(active + 1)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
        </button>
      </div>
      <div className="format-active-info" aria-live="polite">
        <span className="format-active-name">{current.title}</span>
        <span className="mono-chip">{current.spec}</span>
        <Link to={current.to} className="format-active-link">{current.linkLabel} →</Link>
      </div>
    </div>
  );
}

export default function Home() {
  const { role } = useDemoRole();
  return (
    <div className="home-page">
      {/* 01 — HERO: the only job of this section is stating what we do, for whom, and
          giving the visitor a way to act immediately. Everything that used to live here
          (the dosage-form checklist, the sticky-scroll About narrative) either restated
          a disputed claim or belonged on a page a genuinely interested visitor reaches
          second, not first — see docs/PLAN.md for the audit this restructure answers. */}
      <section className="hero hero-home" id="home-hero">
        <img
          className="hero-bg-photo"
          src={homeHero}
          width="1440"
          height="1920"
          alt=""
          loading="eager"
        />
        <div className="hero-bg-tint" aria-hidden="true"></div>
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">Full-Service Supplement Manufacturer</span>
            <h1 style={sx('margin-top:14px;')}>Your Supplements<br />Made and Ready to Sell</h1>
            <p className="hero-expectation">Capsules • Sachets • Stick Packs • Pouches</p>
            <p className="lede" style={sx('margin:18px 0 24px;max-width:520px;')}>
              From capsules to pouches — we manufacture your custom supplements with FDA
              compliance, NSF/cGMP certification, and fast turnaround.
            </p>
            <div className="hero-ctas">
              <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get Instant Quote</a>
              <a href={scheduleUrl(role)} className="btn btn-outline-invert btn-lg">Schedule a Call</a>
            </div>
            <p className="hero-expectation">{EXPECTATION_LINE}</p>
            <div className="qual-bar">
              <div className="qual-cell">
                <span className="qual-value">Made in USA</span>
                <span className="qual-label">Supplement manufacturing</span>
              </div>
              <div className="qual-cell">
                <span className="qual-value">cGMP Certified</span>
                <span className="qual-label">FDA Registered</span>
              </div>
              <div className="qual-cell">
                <span className="qual-value">Lab Tested</span>
                <span className="qual-label">Quality. Period.</span>
              </div>
            </div>
          </div>
          <HeroMech />
        </div>
      </section>

      {/* 02 — PROMISE BAR: answers the ghosting objection at the top of the page, where
          the decision is being made, instead of leaving it buried in FAQ Q.22. One
          line, one amber dot, nothing else — this is a statement, not a pitch. */}
      <section className="promise-bar">
        <div className="container promise-bar-row">
          <span className="promise-bar-dot" aria-hidden="true"></span>
          <p>When it's time to get things done, we're all in—no excuses.</p>
        </div>
      </section>

      {/* 03 — WHAT WE MAKE: exactly the four confirmed formats. Supersedes the old
          text-only trust strip that used to sit here (removed in this restructure) —
          the richer credential + photo proof bar at position 05 covers that job with
          more evidence, so a second, thinner version of the same claim right here
          would have been redundant.
          First section of the light field (03-07, see section-banding fix): its top
          edge meets the navy promise bar, so that edge's padding is trimmed 88px→64px
          per Fix 3 (a full 88px of light plus the navy block's own padding read as a
          gap before a wall). Bottom edge is a within-field boundary against 04, so it
          keeps the standard 88px. */}
      <section className="section" style={sx('padding-top:64px;')}>
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>What we make</span>
            <h2>Our Manufacturing Capabilities</h2>
            <p>Four delivery formats. One trusted partner. All FDA compliant and NSF/cGMP certified.</p>
          </div>
          <ProductCardsGrid products={PRODUCTS} />
        </div>
      </section>

      {/* 04 — COMPARISON: "why brands choose us", framed as what changes, not a features
          list. Right column characterises the industry-wide pattern, never a named
          competitor. Amber check glyph on the middle column only — everywhere else
          on this section is navy and mono. Reflows to stacked cards below 760px.
          No longer section-alt (grey) — see section-banding fix: this section is part
          of the continuous light field now, separated from its neighbours by the
          section-rule hairline instead of a background change. */}
      <section className="section section-rule">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Why Ally Nutra</span>
            <h2>Why Choose Ally Nutra?</h2>
            <p>We manufacture your supplements from scratch — capsules, sachets, stick packs, and pouches. Bring us your formula, we handle everything.</p>
          </div>
          <div className="comparison-table">
            <div className="comparison-row head">
              <div>Reason</div>
              <div>Ally Nutra</div>
              <div>What it means</div>
            </div>
            {COMPARISON_ROWS.map((row) => (
              <div className="comparison-row" key={row.notice}>
                <div className="comparison-notice">{row.notice}</div>
                <div className="comparison-withus">
                  <span className="comparison-mobile-label">Ally Nutra</span>
                  <svg className="comparison-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>{row.withUs}</span>
                </div>
                <div className="comparison-usual">
                  <span className="comparison-mobile-label">What it means</span>
                  <span>{row.usual}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 05 — FORMAT SHOWCASE: was the five-photo facility strip (credential strip +
          five captioned stock photos linking to /facility). Replaced with the six
          client-supplied branded format cards (the original four, plus the owner's
          2026-09-28 Tubs and Canisters picks): the facility photos were stock
          (Unsplash — see IMAGE-CREDITS.md), so they proved nothing about THIS
          factory that the credential strip's linked claims don't already carry;
          the branded cards at least show the real formats in the client's own
          house style. The credential strip row is kept unchanged on top — the
          linked proof (certifications, facility, stats) survives; only the photo
          row below it changed. Light section, slides presented as-is (near-white
          baked backgrounds sit on --background without a seam), no tint. */}
      <section className="section section-rule format-showcase-section">
        <div className="container">
          <div className="credential-strip">
            {CREDENTIAL_STRIP.map((c) => (
              <Link to={c.to} key={c.label}>{c.label}</Link>
            ))}
          </div>
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>What we make</span>
            <h2>Our Manufacturing Capabilities</h2>
            <p className="lede">
              Four delivery formats. One trusted partner. All FDA compliant and NSF/cGMP certified.
            </p>
          </div>
          <FormatCarousel />
        </div>
      </section>

      {/* 06 — WHY BRANDS STAY: unchanged claim-and-receipt rows. */}
      <section className="section section-rule">
        <div className="container">
          <span className="eyebrow">Quality</span>
          <h2 style={sx('margin:14px 0 16px;')}>Certifications &amp; Testing Standards</h2>
          <p className="lede" style={sx('margin-bottom:12px;max-width:640px;')}>
            Quality you can verify — our credentials are independently audited and publicly documented.
          </p>

          <div className="why-row">
            <span className="why-row-num">01</span>
            <div>
              <h3>FDA Registered</h3>
              <p className="why-row-desc">Our facility is registered with the FDA as a dietary supplement manufacturer, ensuring full compliance with federal regulations.</p>
            </div>
            <div className="why-evidence">
              <span className="why-evidence-label">Certification details</span>
              <Link to="/certifications" className="why-evidence-text">View Full Certification Details →</Link>
            </div>
          </div>

          <div className="why-row">
            <span className="why-row-num">02</span>
            <div>
              <h3>NSF/ANSI 455-2</h3>
              <p className="why-row-desc">Third-party certified for cGMP compliance in dietary supplement manufacturing — independently verified quality.</p>
            </div>
            <div className="why-evidence">
              <span className="why-evidence-label">Certification details</span>
              <Link to="/certifications" className="why-evidence-text">View Full Certification Details →</Link>
            </div>
          </div>

          <div className="why-row">
            <span className="why-row-num">03</span>
            <div>
              <h3>cGMP Compliant</h3>
              <p className="why-row-desc">Following Current Good Manufacturing Practices per FDA 21 CFR Part 111 for safety, identity, purity, and potency.</p>
            </div>
            <div className="why-evidence">
              <span className="why-evidence-label">Certification details</span>
              <Link to="/certifications" className="why-evidence-text">View Full Certification Details →</Link>
            </div>
          </div>

          <div className="why-row">
            <span className="why-row-num">04</span>
            <div>
              <h3>In-House &amp; Third-Party Testing</h3>
              <p className="why-row-desc">Every batch undergoes identity, potency, and purity testing — both in-house or through accredited third-party labs. No shortcuts, no exceptions.</p>
            </div>
            <div className="why-evidence">
              <span className="why-evidence-label">Certification details</span>
              <Link to="/certifications" className="why-evidence-text">View Full Certification Details →</Link>
            </div>
          </div>
        </div>
      </section>

      {/* 06.5 — VSL: the same video that opens the company site's /work-with-us
          landing page (allynutra.com/work-with-us), placed after the certification
          section. The h2
          is the video page's own headline, quoted verbatim — it titles the video
          the player below it plays, so it makes no claim this section doesn't
          deliver. Click-to-play with native controls: this is a talking-head
          video with an audio track (AAC), and autoplaying it muted would
          misrepresent it; the poster frame carries the section until pressed
          play. 720p source on viewports ≥700px, 360p below and as fallback. */}
      <section className="section section-rule vsl-section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Work with us</span>
            <h2>Is your manufacturer holding your brand back?</h2>
            <p className="lede">
              Full-service supplement manufacturing — capsules, sachets, stick packs, and pouches.
            </p>
          </div>
          <figure className="vsl-frame">
            <video className="vsl-video" controls preload="metadata" poster={vslPoster}>
              <source src={vsl720} type="video/mp4" media="(min-width: 700px)" />
              <source src={vsl360} type="video/mp4" />
              <a href="https://allynutra.com/work-with-us">Watch the video on allynutra.com</a>
            </video>
            <figcaption className="mono-chip vsl-caption">4:09 · from allynutra.com/work-with-us</figcaption>
          </figure>
        </div>
      </section>

      {/* 08 — HOW IT WORKS: immediately before the final ask (deliberate — removes
          the last hesitation right before the click, rather than being read early
          and forgotten). Mono step/time labels kept, no amber — amber on this page
          marks the action, not the explanation.
          Navy-banding fix: this section and 09 were both navy, making the bottom
          of the page 1,328px of unbroken navy (how-it-works + CTA + footer) with
          no light section between two navy blocks and the footer. Converted to
          light — section-rule hairline (matching 07's own top-edge treatment)
          keeps it visually separate from its now-same-toned neighbours; the step
          cards move from a translucent-white dark-surface treatment to the
          standard card surface (see .how-it-works-card in global.css). */}
      <section className="section section-rule how-it-works">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>How it works</span>
            <h2>How It Works</h2>
            <p>Three simple steps from idea or formula to finished, sellable capsules.</p>
          </div>
          <div className="grid grid-3 how-it-works-grid">
            {HOW_IT_WORKS.map((s) => (
              <div className="how-it-works-card" key={s.step}>
                <span className="how-it-works-num mono-chip">{s.step}</span>
                <h3>{s.title}</h3>
                <p className="how-it-works-body">{s.body}</p>
                <span className="how-it-works-time mono-chip">{s.time}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 09 — FINAL CTA: both actions repeated, plus the same expectation line as the
          hero and the phone number as a fallback.
          Navy-banding fix: converted from section-navy to light (see 08's comment
          for the full rationale — this and 08 were the two navy sections making
          the page bottom 1,328px of unbroken navy). Every hardcoded dark-surface
          color below is reworked for the light background: the `em` emphasis was
          --ally-orange (1.98:1 on light, fails AA) -> --ally-orange-ink (4.56:1);
          .btn-outline-invert (dark-surface outline) -> .btn-outline (its
          light-surface counterpart, already defined in global.css); the three
          white/opacity inline colors -> --muted-foreground / --ally-navy, the
          same tokens the rest of the light-surface site uses for this role
          (matching Contact.jsx:182's tel-link treatment). The h2 needed no
          inline change — removing section-navy lets it fall back to the global
          `h2{color:hsl(var(--ally-navy))}` default automatically. */}
      <section className="section section-rule">
        <div className="container">
          {/* Client-requested layout: copy left, branded card right, side by side
              (stacks text-over-card under 900px). The card still clicks through to
              the quote flow (same destination as the primary button). Text content
              unchanged — placement only. */}
          <div className="cta-split">
            <div className="cta-copy">
              <h2 style={sx('max-width:560px;margin:0 0 24px;')}>
                Ready to Get Started? Call Us Now.
              </h2>
              <p>Speak with an expert in minutes — no bots, no wait.</p>
              {/* [owner directive 2026-09-20] Button stack re-aligned to the
                  company site's CTA format (allynutra.com — the reference the
                  owner supplied): the two actions as one aligned row, and the
                  phone number as a text link beneath instead of a third big
                  button. The "Prefer to talk first?" line is allynutra.com's
                  own CTA wording, quoted verbatim; h2/subcopy unchanged. */}
              <div className="hero-ctas" style={sx('justify-content:flex-start;margin-top:24px;')}>
                <a href={quoteUrl(role)} className="btn btn-primary btn-lg">Get Instant Quote</a>
                <a href={scheduleUrl(role)} className="btn btn-outline btn-lg">Schedule a Call</a>
              </div>
              <p className="cta-phone-line">
                Prefer to talk first?{' '}
                <a href="tel:+18887205888" className="cta-phone-link">Call Now: (888) 720-5888</a>
              </p>
              <p className="hero-expectation" style={sx('color:hsl(var(--muted-foreground));margin-top:20px;')}>{EXPECTATION_LINE}</p>
              <p style={sx('margin-top:12px;font-size:13px;color:hsl(var(--muted-foreground));')}>
                Talk to a real person · No commitment · Same-day response
              </p>
            </div>
            <a href={quoteUrl(role)} className="cta-card-link">
              <img
                src={readyToBuildCta}
                width="840"
                height="1050"
                alt="Ally Nutra card: “Your Supplements, Our Expertise” over stand-up pouch and stick-pack artwork — start your quote"
                className="cta-card"
              />
            </a>
          </div>
        </div>
      </section>

    </div>
  );
}
